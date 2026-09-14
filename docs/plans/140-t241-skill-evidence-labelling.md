# 140 — T-241 / TC-R-021: label every recruiter-visible skill, and rank evidence higher

## 1. Goal

Every skill a recruiter sees says whether it is **self-declared** or
**evidence-backed**; a backed skill **names the program that earned it**; and where
candidates are otherwise comparable, the one with more evidence ranks first — without
removing anyone from results and without adding anything to a score the recruiter
cannot see explained.

## 2. Current behavior (before this change)

Skills reached the recruiter as bare `string[]`. `repositories/talent.ts` already
ordered them by `evidenceScore desc` but selected only `skill.name`, flattening the
distinction away. `match-card.tsx` styled a chip by whether it matched the *search*,
never by verification, and a blanket line claimed **all** skills were self-declared.

### Why not `CandidateSkill.verified`

The schema already models this properly — `CandidateSkill.{claimedByCandidate,
verified, evidenceScore}` and `SkillEvidence.sourceLabel` ("Human-readable provenance
shown to recruiters"). **But it holds no data.** `emitSkillEvidence` in
`repositories/skill-evidence.ts` is still a no-op stub (`void input;`, T-146), so
`SkillEvidence` has **0 rows** and all **8,578** `CandidateSkill` rows read
`verified = false, evidenceScore = 0` across 2,232 candidates. Labelling from those
columns would mark every skill on the platform self-declared forever.

So the label is derived from **curriculum + completion** — the rule
`features/profile/get-verified-skills.ts` already applies on `/profile`, which
produces real labels on real data today and already names its source. When T-146
lands, `repositories/verified-skills.ts` is where the two sources reconcile.

## 3. Files touched

- `src/repositories/verified-skills.ts` `[new]` — set-based reader; the rule for a
  whole result page in a handful of queries.
- `src/features/hire/verified-skills.ts` `[new]` — `labelSkillNames`, pure, no DB.
- `src/features/hire/verified-skills.test.ts` `[new]` — see §6.
- `src/repositories/talent.ts` `[edit]` — `RecruiterSkill`; `labelledSkills` beside
  the untouched `skills`.
- `src/repositories/hire.ts` `[edit]` — carry the label on `ProgramCandidateRow`;
  legacy rows label as self-declared.
- `src/features/hire/types.ts` `[edit]` — `labelledSkills` on `CandidateDossier`,
  `CandidateEvidence`, `ScoreableMember`.
- `src/features/hire/{dossier,challenge-dossier,hackathon-dossier,profile-dossier}.ts`
  `[edit]` — label after `splitSkills`.
- `src/features/hire/track-loaders.ts` `[edit]` — dossier → `ScoreableMember` (4 sites).
- `src/features/hire/score-candidate.ts` `[edit]` — `evidenceBacked` helper + **one**
  sort clause.
- `src/features/hire/to-public-match.ts` `[edit]` — whitelist entry.
- `src/components/hire/match-card.tsx`, `candidate-inspector.tsx` `[edit]` — the labels.
- `package.json` `[edit]` — `test:verified-skills`.

## 4. Server vs Client

`repositories/*` and the dossier builders are `server-only`. `score-candidate.ts` and
`features/hire/verified-skills.ts` are pure. `match-card.tsx` and
`candidate-inspector.tsx` are Client Components and receive only strings, booleans and
arrays — no functions, icons or class instances cross the boundary.

## 5. Key decisions

**The seam.** The first cut put the reader in `src/features/hire/`, and
`visibility.test.ts` failed it: `/hire` may not read a table 078 migrates. The reader
moved to `src/repositories/verified-skills.ts` and only the pure helper stayed behind.
The guard was right; the code was wrong.

**Batching.** `getVerifiedSkills(userId)` issues a `getChallengeProgressStats` call per
enrolment — a query per candidate per enrolment across a result page. The new reader is
set-based and takes progress from the existing `overlayChallengeProgressFields` batch
overlay rather than deriving it a second way.

**Constants are restated, not imported.** `CHALLENGE_ELIGIBLE_DAYS`,
`PROGRAM_SLUG_BY_DOMAIN` and `CHALLENGE_MIRROR_COHORT_SLUGS` are module-private in
`get-verified-skills.ts`, which belongs to another module (candidate skills, Shivansh).
Exporting them would mean editing that file. Instead they are restated **and** a drift
suite reads that file and fails if the two copies disagree. If the owner would rather
export them, the duplication and that suite both collapse into an import.

**Failing conservative.** `splitSkills` tokenises compound entries, so labels are
re-matched per token by exact name. A token that does not match reads self-declared.
Understating a candidate is a nuisance; over-claiming evidence in front of a recruiter
is the failure this ticket exists to prevent.

## 6. Guardrails held

- **No schema change, no migration, no seed, no write query.** `git status -- prisma/`
  empty; `schema.prisma` byte-identical to master.
- `emitSkillEvidence` untouched, still a stub. `CandidateSkill.verified` /
  `evidenceScore` never written. No emitter implemented (T-146 remains separate).
- **Evidence never filters.** `pickSearchMatches`' `must.every(...)` still matches on
  the full skill list; no `verified` / `evidenceScore` predicate was added anywhere.
- **Pure tie-break.** `scoreCandidate`'s `dims`, `weights`, `total` and `tierFor` are
  untouched; `score`, `tier` and the whole `ScoreBreakdown` are identical with and
  without evidence.
- Source labels are program titles only — never employer identity.

## 7. Verification

`npm run test:verified-skills` — 15 checks, no DB: the label itself; a zero-evidence
candidate still present in `rankCandidates`; equal scores ordered by evidence (proved
by flipping the names so it cannot coincide with the alphabetical tiebreak); a higher
score beating more evidence; `scoreBreakdown` byte-identical with and without evidence;
no `verified: true` in any recruiter query; `pickSearchMatches` still reading the full
skill list; the sort clause ordered score → evidence → name; the drift guard; the
batching guard; the stub-untouched guard; and no `company` in the label path.

Results: `tsc --noEmit` 0 · build compiles 53s · hire-score 25 · visibility 26 ·
match-persistence 5 · project-state 10 · navbar-shortlist 16 · verified-skills 15.
`project-sessions` is 12/1 — pre-existing on master (a stale slice window in that
test), unchanged here. eslint identical to master's baseline.

**Manual:** search a stack on `/hire`; candidates from a completed challenge show green
evidence-backed chips naming the program, everything else stays outlined and
self-declared; the inspector splits them into two groups with sources as text; and the
**result count and candidate set for the same query are identical before and after** —
the acceptance proof for "never removes anyone".

## 8. Known limits

- Dev pool: 184 candidates clear the bar, **20** of them recruiter-searchable; the
  cohort path contributes **0**, so every label on dev comes from the 60-day challenge.
  Mixed pairs exist — Python (2 backed vs 56 declared), Claude (20 vs 1), Generative AI
  (20 vs 2).
- `ENABLE_NEW_PROGRESS` is unset on dev but ON in production, so `daysCompleted` is
  read from the legacy snapshot here and derived from attempts there. The qualified pool
  will differ between environments.

## 9. Commit message

See the commit on `feat/t241-skill-evidence-labelling`.
