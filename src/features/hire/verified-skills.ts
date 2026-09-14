/**
 * Pure skill-label helpers (T-241). No database: the READ lives in
 * `repositories/verified-skills.ts`, because `features/hire/` must not touch a
 * table the 078 migration owns — `visibility.test.ts` enforces that seam.
 */

/**
 * Re-label a skill list after `splitSkills` has tokenised it.
 *
 * The dossier builders split compound entries ("React, Node" → two tokens), so
 * the labels computed against the ORIGINAL names no longer line up one-to-one.
 * Each token is matched by exact name; a token with no match reads
 * self-declared.
 *
 * That direction is deliberate. Failing to label something that IS backed
 * understates a candidate — annoying. Labelling something backed that is NOT
 * would put a claim in front of a recruiter that the platform cannot stand
 * behind, which is the one outcome this ticket exists to prevent.
 */
export function labelSkillNames(
  names: string[],
  labelled: readonly { name: string; sources: string[] }[] | undefined,
): { name: string; sources: string[] }[] {
  if (!labelled?.length) return names.map((name) => ({ name, sources: [] }));
  const byName = new Map(
    labelled.map((s) => [s.name.trim().toLowerCase(), s.sources]),
  );
  return names.map((name) => ({
    name,
    sources: byName.get(name.trim().toLowerCase()) ?? [],
  }));
}
