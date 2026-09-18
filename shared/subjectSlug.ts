/**
 * The subject slug a document points at - the one primitive both sides need.
 *
 * Lives in `shared/` rather than `src/lib/` only because of the direction of
 * dependency: `shared/mcqApi.ts` and `shared/simosanApi.ts` run on the server
 * and must not pull `src/types.ts` (and with it the whole TRANSLATIONS table)
 * into the Vercel function. The browser-side label resolver
 * `src/lib/subjectDisplay.ts` re-exports this, so there is still exactly one
 * copy of the chain.
 */

/**
 * Any document that names a subject. Deliberately loose: callers hold raw
 * Firestore data, a typed `RecordItem`, or a degree row whose subject field is
 * called `material` for historical reasons.
 */
export interface SubjectTaggedDoc {
  subjectId?: string | null;
  subjectName?: string | null;
  subjectNameAr?: string | null;
  /** Grades name the subject `material`; the denormalized pair follows it. */
  material?: string | null;
  materialName?: string | null;
  materialNameAr?: string | null;
  /** Legacy taxonomy - one of the five stage-3 CATEGORIES. */
  category?: string | null;
}

export const cleanSubjectField = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

/**
 * Order is `subjectId` -> `material` -> `category`, and it is unambiguous in
 * practice: a lecture or record never carries `material`, a degree never
 * carries `subjectId` or `category`. `category` is last because it is the
 * legacy field - a document that has both was written after the migration and
 * its `subjectId` is the better answer.
 */
export function subjectSlugOf(doc: SubjectTaggedDoc | null | undefined): string {
  if (!doc) return '';
  return (
    cleanSubjectField(doc.subjectId) ||
    cleanSubjectField(doc.material) ||
    cleanSubjectField(doc.category)
  );
}

/**
 * The best name available WITHOUT a curriculum to join against - tier 1 and
 * tier 4 of `resolveSubjectLabel`, which is all a server-side caller can do.
 *
 * Prefers Arabic: every consumer of this (push notification bodies, staff
 * alerts) renders into an Arabic UI.
 */
export function denormalizedSubjectName(doc: SubjectTaggedDoc | null | undefined): string {
  if (!doc) return '';
  return (
    cleanSubjectField(doc.subjectNameAr) ||
    cleanSubjectField(doc.materialNameAr) ||
    cleanSubjectField(doc.subjectName) ||
    cleanSubjectField(doc.materialName) ||
    subjectSlugOf(doc)
  );
}
