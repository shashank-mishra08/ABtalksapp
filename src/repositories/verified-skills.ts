import "server-only";

import { Domain, EnrollmentStatusV2 } from "@prisma/client";
import { prisma } from "@/lib/db";
import { overlayChallengeProgressFields } from "@/repositories/progress";

/**
 * Which of a candidate's skills the platform can vouch for, in bulk (T-241).
 *
 * The rule is the one `features/profile/get-verified-skills.ts` already applies
 * on /profile — a skill is evidence-backed when the candidate COMPLETED a
 * program whose curriculum teaches it:
 *
 *   LearningProgram → ProgramSkill → the user's completion of a run of it
 *
 * Nothing is stored and nothing is copied. There is no write path, so a
 * candidate cannot mark their own skill as backed.
 *
 * WHY A SECOND READER EXISTS. `getVerifiedSkills(userId)` answers for one
 * person and issues a `getChallengeProgressStats` call per enrolment. The
 * recruiter surface asks about a whole result page at once, where that shape is
 * a query per candidate per enrolment. This is the same rule, set-based.
 *
 * WHY NOT `CandidateSkill.verified`. That column is the intended long-term
 * home, but its only writer — `emitSkillEvidence` in
 * `repositories/skill-evidence.ts` — is still a no-op stub (T-146). Every
 * `CandidateSkill` row therefore reads `verified = false`, and labelling from
 * it would mark every skill on the platform self-declared. When T-146 lands,
 * this reader is where the two sources get reconciled.
 */

/**
 * The bar, restated from `features/profile/get-verified-skills.ts` because
 * these are module-private there and that file belongs to another module.
 * `features/hire/verified-skills.test.ts` reads that file and fails if these drift, so the
 * two surfaces cannot disagree about who is verified.
 */
const CHALLENGE_ELIGIBLE_DAYS = 50;

const PROGRAM_SLUG_BY_DOMAIN: Record<Domain, string> = {
  [Domain.SE]: "software-engineering-challenge",
  [Domain.DS]: "data-science-challenge",
  [Domain.AI]: "ai-engineering-challenge",
  [Domain.CLAUDE]: "claude-challenge",
};

/**
 * Challenge enrolments are mirrored into `ProgramEnrollment` against a
 * `legacy-<domain>` cohort. Counting the mirror as a cohort completion would
 * let a challenge in under the cohort bar instead of the 50-day one.
 */
const CHALLENGE_MIRROR_COHORT_SLUGS = Object.values(Domain).map(
  (d) => `legacy-${d.toLowerCase()}`,
);

/** skill name (lower-cased) → the programs that earned it, in order found. */
export type VerifiedSkillMap = Map<string, string[]>;

/** Empty map, shared. Callers must not mutate what they get back. */
const EMPTY: VerifiedSkillMap = new Map();

function addSource(into: VerifiedSkillMap, name: string, label: string): void {
  const key = name.trim().toLowerCase();
  if (!key) return;
  const existing = into.get(key);
  if (!existing) {
    into.set(key, [label]);
    return;
  }
  if (!existing.includes(label)) existing.push(label);
}

type SkillRow = { skill: { name: string } };

/**
 * Evidence-backed skills for many candidates at once.
 *
 * Returns a map keyed by userId; a candidate with no completed program is
 * simply absent, which callers read as "everything they claim is
 * self-declared". Absence is never an error and never removes anyone.
 */
export async function listVerifiedSkillsForUsers(
  userIds: string[],
): Promise<Map<string, VerifiedSkillMap>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, VerifiedSkillMap>();
  if (ids.length === 0) return out;

  const [enrollments, completedCohorts] = await Promise.all([
    prisma.enrollment.findMany({
      where: { userId: { in: ids } },
      // The four progress fields are the shape `overlayChallengeProgressFields`
      // requires; it rewrites daysCompleted from attempts when the 078 progress
      // read is on and hands the rows straight back when it is not.
      select: {
        id: true,
        userId: true,
        domain: true,
        daysCompleted: true,
        currentStreak: true,
        longestStreak: true,
        lastSubmittedDay: true,
      },
    }),
    prisma.programEnrollment.findMany({
      where: {
        userId: { in: ids },
        OR: [
          { status: EnrollmentStatusV2.COMPLETED },
          { completedAt: { not: null } },
        ],
        cohort: { slug: { notIn: CHALLENGE_MIRROR_COHORT_SLUGS } },
      },
      select: {
        userId: true,
        cohort: {
          select: {
            programVersion: {
              select: {
                program: {
                  select: {
                    title: true,
                    skills: { select: { skill: { select: { name: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  /* ── Challenges: 50+ days completed ───────────────────────────────────── */
  const scored = await overlayChallengeProgressFields(enrollments);

  // userId → the challenge program slugs they cleared the bar on.
  const slugsByUser = new Map<string, Set<string>>();
  const allSlugs = new Set<string>();
  for (const row of scored) {
    if (row.daysCompleted < CHALLENGE_ELIGIBLE_DAYS) continue;
    const slug = PROGRAM_SLUG_BY_DOMAIN[row.domain];
    if (!slug) continue;
    allSlugs.add(slug);
    const set = slugsByUser.get(row.userId) ?? new Set<string>();
    set.add(slug);
    slugsByUser.set(row.userId, set);
  }

  // One query for every challenge program any of these candidates cleared,
  // rather than one per candidate.
  const programBySlug = new Map<string, { title: string; skills: SkillRow[] }>();
  if (allSlugs.size > 0) {
    const programs = await prisma.learningProgram.findMany({
      where: { slug: { in: [...allSlugs] } },
      select: {
        slug: true,
        title: true,
        skills: { select: { skill: { select: { name: true } } } },
      },
    });
    for (const p of programs) {
      programBySlug.set(p.slug, { title: p.title, skills: p.skills });
    }
  }

  for (const [userId, slugs] of slugsByUser) {
    const map = out.get(userId) ?? new Map<string, string[]>();
    for (const slug of slugs) {
      const program = programBySlug.get(slug);
      if (!program) continue;
      for (const row of program.skills) {
        addSource(map, row.skill.name, program.title);
      }
    }
    out.set(userId, map);
  }

  /* ── Cohorts: the whole run finished ──────────────────────────────────── */
  for (const row of completedCohorts) {
    const program = row.cohort.programVersion.program;
    const map = out.get(row.userId) ?? new Map<string, string[]>();
    for (const s of program.skills) {
      addSource(map, s.skill.name, program.title);
    }
    out.set(row.userId, map);
  }

  return out;
}

/** A candidate's map, or an empty one. Never null, so callers need no guard. */
export function verifiedSkillsFor(
  all: Map<string, VerifiedSkillMap>,
  userId: string | null | undefined,
): VerifiedSkillMap {
  return (userId && all.get(userId)) || EMPTY;
}
