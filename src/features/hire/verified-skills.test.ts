/**
 * T-241 / TC-R-021 — skill labelling and the evidence tie-break. Run with:
 *   npm run test:verified-skills
 *
 * No network, no database.
 *
 * The requirement this guards is mostly a NEGATIVE one: evidence may reorder
 * candidates and must never remove one, and it must never move a score. Those
 * are exactly the failures that look fine on screen — a recruiter cannot tell
 * that the pool quietly shrank, or that a number drifted, by looking at it. So
 * the checks below compare whole result sets and whole score objects rather
 * than spot-checking a field.
 *
 * The drift suite is a source scan, in the style of `visibility.test.ts`: the
 * eligibility rule lives in another module's file (`get-verified-skills.ts`,
 * candidate profile) where the constants are private. Restating them in
 * `repositories/verified-skills.ts` is the only way to reuse the rule without editing that
 * module, and this is what stops the two copies disagreeing about who counts
 * as verified.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { labelSkillNames } from "@/features/hire/verified-skills";
import { rankCandidates, scoreCandidate } from "@/features/hire/score-candidate";
import type { JobSpec, ScoreableMember } from "@/features/hire/types";

let passed = 0;
let failed = 0;

function assert(cond: boolean | undefined, msg: string) {
  if (!cond) throw new Error(msg);
}

function suite(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
  }
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

console.log("\nT-241 skill labelling and evidence tie-break");

/* ── the label itself ──────────────────────────────────────────────────────── */

suite("a skill with no source reads self-declared", () => {
  const out = labelSkillNames(["React", "Go"], undefined);
  assert(out.length === 2, "every skill must survive labelling");
  assert(out.every((s) => s.sources.length === 0), "no source = self-declared");
});

suite("an evidence-backed skill names its source", () => {
  const out = labelSkillNames(
    ["Python", "React"],
    [{ name: "Python", sources: ["60-Day Claude AI Mastery Challenge"] }],
  );
  const python = out.find((s) => s.name === "Python");
  const react = out.find((s) => s.name === "React");
  assert(python?.sources[0] === "60-Day Claude AI Mastery Challenge", "source must be named");
  assert(react?.sources.length === 0, "an unearned skill stays self-declared");
});

suite("labelling is case-insensitive but never invents a match", () => {
  const out = labelSkillNames(["python"], [{ name: "Python", sources: ["X"] }]);
  assert(out[0]?.sources.length === 1, "casing must not lose a real match");
  const none = labelSkillNames(["Pythonic"], [{ name: "Python", sources: ["X"] }]);
  assert(none[0]?.sources.length === 0, "a prefix is not a match — never over-claim");
});

suite("labelling never adds, drops or reorders a skill", () => {
  const names = ["C", "A", "B"];
  const out = labelSkillNames(names, [{ name: "A", sources: ["X"] }]);
  assert(
    out.map((s) => s.name).join(",") === names.join(","),
    "the list must come back identical in length and order",
  );
});

/* ── ranking: a tie-break, never a filter ──────────────────────────────────── */

function member(over: Partial<ScoreableMember>): ScoreableMember {
  return {
    id: "m",
    userId: "m",
    fullName: "M",
    jobRole: "Engineer",
    company: "",
    yearsExperience: 3,
    skills: ["Python"],
    labelledSkills: [{ name: "Python", sources: [] }],
    missionPoints: 0,
    missionsPassed: 0,
    missionsAttempted: 0,
    cleanPassCount: 0,
    totalScore: 0,
    commitDayCount: 0,
    projectScores: [],
    interview: null,
    hasVisibilityConsent: true,
    cohortPublished: true,
    status: "ENROLLED",
    cohortDay: 30,
    availability: null,
    ...over,
  } as unknown as ScoreableMember;
}

const backed = (sources: string[]) => [{ name: "Python", sources }];
const spec = {} as unknown as JobSpec;

suite("a candidate with zero evidence still appears in the results", () => {
  const none = member({ id: "none", userId: "none", fullName: "None" });
  const some = member({
    id: "some",
    userId: "some",
    fullName: "Some",
    labelledSkills: backed(["60-Day Claude AI Mastery Challenge"]),
  });
  const ranked = rankCandidates([none, some], spec);
  const refs = ranked.map((r) => r.fullName).sort();
  assert(ranked.length === 2, "evidence must never shrink the result set");
  assert(refs.join(",") === "None,Some", "the zero-evidence candidate must be present");
});

suite("among equal scores, more evidence ranks higher", () => {
  // Identical inputs but for the label, so the scores are necessarily equal.
  const plain = member({ id: "a", userId: "a", fullName: "Zed" });
  const evidenced = member({
    id: "b",
    userId: "b",
    fullName: "Abe",
    labelledSkills: backed(["60-Day Claude AI Mastery Challenge"]),
  });
  const ranked = rankCandidates([plain, evidenced], spec);
  assert(
    ranked[0]?.score === ranked[1]?.score,
    "fixture is only meaningful while the two scores tie",
  );
  assert(
    ranked[0]?.fullName === "Abe",
    "the evidence-backed candidate must come first",
  );
  // "Abe" also sorts before "Zed" by name, so prove the tie-break is the
  // reason by flipping the names and checking it still wins.
  const flipped = rankCandidates(
    [
      member({ id: "a", userId: "a", fullName: "Abe" }),
      member({
        id: "b",
        userId: "b",
        fullName: "Zed",
        labelledSkills: backed(["60-Day Claude AI Mastery Challenge"]),
      }),
    ],
    spec,
  );
  assert(
    flipped[0]?.fullName === "Zed",
    "evidence must outrank the alphabetical tiebreak, not coincide with it",
  );
});

suite("evidence never overrides a higher score", () => {
  const strongNoEvidence = member({
    id: "a",
    userId: "a",
    fullName: "Strong",
    yearsExperience: 9,
    missionsPassed: 40,
    missionsAttempted: 40,
    cleanPassCount: 30,
    commitDayCount: 40,
    projectScores: [90, 95],
  });
  const weakWithEvidence = member({
    id: "b",
    userId: "b",
    fullName: "Weak",
    labelledSkills: backed(["60-Day Claude AI Mastery Challenge"]),
  });
  const ranked = rankCandidates([weakWithEvidence, strongNoEvidence], spec);
  assert(
    ranked[0]!.score > ranked[1]!.score,
    "fixture must actually produce different scores",
  );
  assert(
    ranked[0]?.fullName === "Strong",
    "a higher score must win regardless of evidence — it is a TIE-break",
  );
});

/* ── the score itself must not move ────────────────────────────────────────── */

suite("scoring is identical with and without evidence", () => {
  const plain = scoreCandidate(member({}), spec);
  const evidenced = scoreCandidate(
    member({ labelledSkills: backed(["60-Day Claude AI Mastery Challenge"]) }),
    spec,
  );
  assert(plain.score === evidenced.score, "score must not move");
  assert(plain.tier === evidenced.tier, "tier must not move");
  assert(
    JSON.stringify(plain.scoreBreakdown) === JSON.stringify(evidenced.scoreBreakdown),
    "every dimension, weight and dimensionsUsed entry must be unchanged — a score the recruiter cannot see explained is the thing TC-R-021 forbids",
  );
});

/* ── no filtering, anywhere ────────────────────────────────────────────────── */

suite("no recruiter query filters on verified or evidenceScore", () => {
  for (const rel of [
    "src/repositories/verified-skills.ts",
    "src/repositories/talent.ts",
    "src/features/hire/score-candidate.ts",
  ]) {
    const src = read(rel);
    assert(
      !/verified:\s*true/.test(src),
      `${rel} must not require verified=true anywhere — that would hide candidates`,
    );
    assert(
      !/evidenceScore:\s*\{\s*gt:/.test(src),
      `${rel} must not filter on a minimum evidenceScore`,
    );
  }
});

suite("the stack filter still matches on every skill, labelled or not", () => {
  const src = read("src/features/hire/score-candidate.ts");
  const at = src.indexOf("export function pickSearchMatches");
  const body = src.slice(at, at + 1200);
  assert(
    body.includes("const skills = r.evidence.skills ?? [];"),
    "pickSearchMatches must keep matching on the FULL skill list; narrowing it to labelled/backed skills would drop candidates from results",
  );
  assert(
    !body.includes("labelledSkills"),
    "the result filter must not read the label at all",
  );
});

suite("the tie-break sits after score and before name", () => {
  const src = read("src/features/hire/score-candidate.ts");
  const at = src.indexOf("export function rankCandidates");
  const body = src.slice(at, at + 1600);
  const score = body.indexOf("b.score - a.score");
  const tie = body.indexOf("backed.get(b.candidateRef)");
  const name = body.indexOf("localeCompare");
  assert(score !== -1 && tie !== -1 && name !== -1, "all three sort clauses must exist");
  assert(score < tie, "score must be compared before evidence");
  assert(tie < name, "evidence must be compared before the name tiebreak");
});

/* ── drift guard against the candidate-profile copy of the rule ────────────── */

suite("the eligibility rule matches features/profile/get-verified-skills.ts", () => {
  const theirs = read("src/features/profile/get-verified-skills.ts");
  const ours = read("src/repositories/verified-skills.ts");

  const day = /CHALLENGE_ELIGIBLE_DAYS = (\d+)/;
  const t = theirs.match(day)?.[1];
  const o = ours.match(day)?.[1];
  assert(Boolean(t) && t === o, `challenge day bar drifted: profile=${t} hire=${o}`);

  for (const slug of [
    "software-engineering-challenge",
    "data-science-challenge",
    "ai-engineering-challenge",
    "claude-challenge",
  ]) {
    assert(theirs.includes(slug), `profile rule no longer lists ${slug}`);
    assert(ours.includes(slug), `hire rule no longer lists ${slug}`);
  }

  assert(
    theirs.includes("`legacy-${d.toLowerCase()}`") &&
      ours.includes("`legacy-${d.toLowerCase()}`"),
    "both must exclude the legacy-<domain> challenge mirror cohorts, or a challenge sneaks in under the cohort bar",
  );
  assert(
    theirs.includes("EnrollmentStatusV2.COMPLETED") &&
      ours.includes("EnrollmentStatusV2.COMPLETED"),
    "both must require a COMPLETED cohort run",
  );
});

suite("the hire reader is set-based, not per candidate", () => {
  const ours = read("src/repositories/verified-skills.ts");
  assert(
    ours.includes("userId: { in: ids }"),
    "enrolments must be loaded for the whole page in one query",
  );
  // A CALL, not a mention — the header comment names this function to explain
  // why this reader exists, and that prose must not fail the test.
  assert(
    !/getChallengeProgressStats\s*\(/.test(ours),
    "the per-enrolment progress call belongs to the single-candidate reader; using it here is a query per candidate per enrolment",
  );
  assert(
    ours.includes("overlayChallengeProgressFields"),
    "progress must come from the shared batch overlay, not a second derivation",
  );
});

suite("no skill evidence is written, and the stub is untouched", () => {
  // T-241 is display + ranking. emitSkillEvidence is T-146 and must stay a stub.
  const stub = read("src/repositories/skill-evidence.ts");
  assert(stub.includes("void input;"), "emitSkillEvidence must remain a no-op stub");
  const ours = read("src/repositories/verified-skills.ts");
  assert(
    !/prisma\.(skillEvidence|candidateSkill)\.(create|update|upsert|delete)/.test(ours),
    "the label is derived on read; it must never write CandidateSkill or SkillEvidence",
  );
});

suite("source labels are program titles, never employer identity", () => {
  const ours = read("src/repositories/verified-skills.ts");
  assert(
    !/company/i.test(ours),
    "company must never reach the source label — identity waits on an accepted introduction",
  );
  assert(
    ours.includes("program.title") || ours.includes("title: true"),
    "the label must come from the PROGRAM title",
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
