/**
 * One place to turn a subject SLUG into something a human can read.
 *
 * Four independent copies of the same fallback chain had grown up across the
 * repo - `contentArchive.ts` (`subjectName || subjectId || category`),
 * `shared/mcqApi.ts` and `shared/simosanApi.ts` (`subjectId || category`), plus
 * an inline `CATEGORIES.find(...)` in every screen that renders a badge. They
 * disagreed about which tier wins, so the same record could be filed under
 * "Biochemistry II" in the archive and "فارما" on its own card.
 *
 * Pure: no Firestore, no React. Unit-tested by `npm run test:subject-display`.
 *
 * ## Two traps this module exists to absorb
 *
 * **`subject.id` is the BARE SLUG, not the document id.** `migrateToStages.js`
 * writes document `stage_3__biochemistry_ii` carrying field
 * `id: 'biochemistry_ii'`, and `useStageSubjects` maps `d.data()` without
 * spreading `d.id` - so the in-memory `Subject.id` is the bare slug, and that
 * is what lands in `records.subjectId` and what `firestore.rules`'s
 * `hasStageAccess(..., subjectId)` compares. Lookups here accept the prefixed
 * form too, because a caller holding a raw Firestore document may have either.
 *
 * **Tier 2 cannot cover history.** `useStageSubjects` filters
 * `isActive !== false` and loads ONE stage, while a representative may hide a
 * subject and a student's grade tabs span every stage they have been promoted
 * through. So the live `subjects` list is a convenience, not the source of
 * truth - the denormalized name written onto the document at save time (tier 1)
 * is what actually names historical and cross-stage content.
 */
import { CATEGORIES, TRANSLATIONS, DEFAULT_COURSE_ID } from '../types';
import type { Subject, CourseId, Language } from '../types';
import { subjectSlugOf, cleanSubjectField as clean } from '../../shared/subjectSlug';
import type { SubjectTaggedDoc } from '../../shared/subjectSlug';

// The slug chain itself lives in shared/ so the server can reach it without
// dragging TRANSLATIONS into the Vercel function. Re-exported here so browser
// code has a single import to reach for.
export { subjectSlugOf, denormalizedSubjectName } from '../../shared/subjectSlug';
export type { SubjectTaggedDoc } from '../../shared/subjectSlug';

/** The denormalized block written onto any subject-tagged document. */
export interface SubjectMeta {
  subjectId: string;
  courseId: CourseId;
  subjectName: string;
  subjectNameAr: string;
}

/**
 * Find a subject by slug, accepting either the bare slug (`biochemistry_ii`) or
 * the document id it is stored under (`stage_3__biochemistry_ii`).
 */
export function findSubject(
  subjects: readonly Subject[] | null | undefined,
  subjectId: string | null | undefined,
): Subject | null {
  const slug = clean(subjectId);
  if (!slug || !subjects?.length) return null;
  return (
    subjects.find(s => s.id === slug) ??
    subjects.find(s => `${s.stageId}__${s.id}` === slug) ??
    null
  );
}

/**
 * The block to denormalize onto a document being saved.
 *
 * Returns null when the slug names no live subject, so a caller can spread
 * `subjectMetaFrom(...) ?? {}` and write nothing rather than writing empties -
 * `undefined` fields are what Firestore rejects, and blank ones would overwrite
 * a good label on an edit.
 */
export function subjectMetaFrom(
  subjects: readonly Subject[] | null | undefined,
  subjectId: string | null | undefined,
): SubjectMeta | null {
  const sub = findSubject(subjects, subjectId);
  if (!sub) return null;
  return {
    subjectId: sub.id,
    courseId: sub.courseId || DEFAULT_COURSE_ID,
    subjectName: sub.nameEn,
    subjectNameAr: sub.nameAr,
  };
}

/**
 * The five legacy categories, mapped to the curriculum slug each one became.
 *
 * Mirrors LEGACY_TO_SUBJECT in scripts/migrateToStages.js, which is where the
 * mapping was decided: all pre-migration content was uploaded during Third
 * Stage / Course II, so those five are a 1:1 cover of that course's subjects.
 *
 * Needed because both spellings now coexist in live data - a سعي uploaded last
 * year carries `material: 'biochemistry'` while one uploaded today carries
 * `biochemistry_ii`, and they are the SAME subject. Grouping on the raw slug
 * renders it as two sections in one year.
 */
export const LEGACY_SUBJECT_ALIASES: Record<string, string> = {
  pharmacology: 'pharmacology_i',
  cosmetics: 'pharmaceutical_and_cosmetic_preparations',
  pharmacognosy: 'pharmacognocy_iii',
  biochemistry: 'biochemistry_ii',
  organic_chemistry: 'organic_pharm_chemistry_i',
};

/**
 * The slug to GROUP on - legacy spellings folded into their curriculum
 * equivalent. Not for display: resolveSubjectLabel still reads the document's
 * own fields, so a legacy row keeps whatever name it resolves to.
 */
export function canonicalSubjectSlug(slug: string | null | undefined): string {
  const s = clean(slug);
  return LEGACY_SUBJECT_ALIASES[s] || s;
}

/** The legacy five-category label, or '' if the slug is not one of them. */
export function legacyCategoryLabel(slug: string, lang: Language): string {
  const cat = CATEGORIES.find(c => c.value === slug);
  if (!cat) return '';
  const table = TRANSLATIONS[lang] as Record<string, string>;
  return clean(table?.[cat.labelKey as string]);
}

/**
 * The label to show for a subject-tagged document, in `lang`.
 *
 * Tiers, in order:
 *   1. the denormalized name on the document itself (survives renames, hidden
 *      subjects, other stages and the year-end wipe);
 *   2. the live `subjects` list for the current stage;
 *   3. the legacy `CATEGORIES` + `TRANSLATIONS` pair, for pre-migration rows;
 *   4. the raw slug - wrong-looking, but never silently mislabelled as a
 *      different subject, which is what the old `|| 'pharmacology'` fallbacks
 *      did.
 */
export function resolveSubjectLabel(
  doc: SubjectTaggedDoc | null | undefined,
  subjects: readonly Subject[] | null | undefined,
  lang: Language,
): string {
  const ar = lang === 'ar';

  // Tier 1 - denormalized. Falls back across LANGUAGES before dropping to tier
  // 2: a name stored only in English still names the right subject, while tier
  // 2 may not know this subject at all.
  const denormalized = ar
    ? clean(doc?.subjectNameAr) || clean(doc?.materialNameAr) || clean(doc?.subjectName) || clean(doc?.materialName)
    : clean(doc?.subjectName) || clean(doc?.materialName) || clean(doc?.subjectNameAr) || clean(doc?.materialNameAr);
  if (denormalized) return denormalized;

  const slug = subjectSlugOf(doc);
  if (!slug) return '';

  // Tier 2 - live curriculum.
  const sub = findSubject(subjects, slug);
  if (sub) return (ar ? sub.nameAr : sub.nameEn) || sub.nameEn || sub.nameAr || slug;

  // Tier 3 - legacy taxonomy.
  const legacy = legacyCategoryLabel(slug, lang);
  if (legacy) return legacy;

  // Tier 4 - the slug itself.
  return slug;
}

export interface SubjectAccent {
  emoji: string;
  color: string;
  border: string;
  bg: string;
  badge: string;
}

/**
 * Written out in full rather than composed from a colour name, because
 * Tailwind resolves classes by scanning source text - a template-built
 * `text-${c}-500` is not in the built stylesheet and renders unstyled.
 */
const ACCENTS: SubjectAccent[] = [
  { emoji: '💊', color: 'text-red-500', border: 'border-red-500', bg: 'bg-red-50 dark:bg-red-900/20', badge: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  { emoji: '🌿', color: 'text-emerald-500', border: 'border-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20', badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  { emoji: '⚗️', color: 'text-blue-500', border: 'border-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', badge: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  { emoji: '🧬', color: 'text-purple-500', border: 'border-purple-500', bg: 'bg-purple-50 dark:bg-purple-900/20', badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' },
  { emoji: '💄', color: 'text-pink-500', border: 'border-pink-500', bg: 'bg-pink-50 dark:bg-pink-900/20', badge: 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300' },
  { emoji: '🫀', color: 'text-rose-500', border: 'border-rose-500', bg: 'bg-rose-50 dark:bg-rose-900/20', badge: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' },
  { emoji: '🧪', color: 'text-cyan-500', border: 'border-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-900/20', badge: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300' },
  { emoji: '🦠', color: 'text-lime-600', border: 'border-lime-600', bg: 'bg-lime-50 dark:bg-lime-900/20', badge: 'bg-lime-100 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300' },
  { emoji: '📊', color: 'text-amber-500', border: 'border-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  { emoji: '🧠', color: 'text-violet-500', border: 'border-violet-500', bg: 'bg-violet-50 dark:bg-violet-900/20', badge: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  { emoji: '📖', color: 'text-teal-500', border: 'border-teal-500', bg: 'bg-teal-50 dark:bg-teal-900/20', badge: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300' },
  { emoji: '🖥️', color: 'text-slate-500', border: 'border-slate-500', bg: 'bg-slate-50 dark:bg-slate-900/20', badge: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300' },
];

/**
 * A stable colour for a subject.
 *
 * Keyed on a hash of the SLUG, never on the subject's position in the list:
 * `SubjectsSettings` lets a representative reorder subjects, and an
 * index-keyed palette would recolour every card on the screen when one is
 * dragged.
 *
 * FNV-1a, `>>> 0` after each step so the intermediate stays an unsigned 32-bit
 * value - JavaScript bitwise operators would otherwise hand back a negative
 * number and `% length` would index off the front of the array.
 */
export function subjectAccent(subjectId: string | null | undefined): SubjectAccent {
  const slug = clean(subjectId);
  if (!slug) return ACCENTS[0];
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ACCENTS[h % ACCENTS.length];
}

/** Subjects for one course, in display order. */
export function subjectsForCourse(
  subjects: readonly Subject[] | null | undefined,
  courseId: CourseId,
): Subject[] {
  return (subjects ?? [])
    .filter(s => (s.courseId || DEFAULT_COURSE_ID) === courseId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
