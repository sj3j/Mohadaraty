/**
 * Verifies the shared subject-label resolver.
 *
 * Run with:  npm run test:subject-display
 *
 * Pure functions only - no Firestore. What this pins down is the ORDER of the
 * four fallback tiers, because the four hand-rolled copies this module replaced
 * disagreed about it, and two production details that make naive fixtures pass
 * while production resolves nothing:
 *
 *   - `Subject.id` is the BARE SLUG (`biochemistry_ii`), not the document id
 *     (`stage_3__biochemistry_ii`). `useStageSubjects` maps `d.data()` and never
 *     spreads `d.id`, so a fixture keyed on the document id would be testing a
 *     shape that never reaches the screen.
 *   - The live `subjects` list cannot cover history: it holds ONE stage and
 *     drops `isActive: false`. A hidden or cross-stage subject must still be
 *     named, which is the whole reason tier 1 is denormalized onto the document.
 */
import { readFileSync } from 'node:fs';
import {
  subjectSlugOf,
  canonicalSubjectSlug,
  LEGACY_SUBJECT_ALIASES,
  findSubject,
  subjectMetaFrom,
  legacyCategoryLabel,
  resolveSubjectLabel,
  subjectAccent,
  subjectsForCourse,
} from '../src/lib/subjectDisplay';
import type { Subject } from '../src/types';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const subject = (over: Partial<Subject> = {}): Subject => ({
  // Bare slug, exactly as migrateToStages.js writes the `id` FIELD.
  id: 'biochemistry_ii',
  stageId: 'stage_3',
  courseId: 'course_2',
  nameEn: 'Biochemistry II',
  nameAr: 'الكيمياء الحياتية ٢',
  types: ['theoretical', 'practical'],
  order: 0,
  isActive: true,
  ...over,
});

const curriculum: Subject[] = [
  subject(),
  subject({ id: 'pharmacology_i', nameEn: 'Pharmacology I', nameAr: 'علم الأدوية ١', order: 1 }),
  subject({ id: 'physiology_i', stageId: 'stage_2', nameEn: 'Physiology I', nameAr: 'علم وظائف الأعضاء ١', courseId: 'course_1', order: 2 }),
];

console.log('\nSlug resolution:');

check('subjectId wins over the legacy category',
  subjectSlugOf({ subjectId: 'biochemistry_ii', category: 'biochemistry' }) === 'biochemistry_ii');
check('a pre-migration record falls back to category',
  subjectSlugOf({ category: 'pharmacology' }) === 'pharmacology');
check('a degree names its subject `material`',
  subjectSlugOf({ material: 'biochemistry_ii' }) === 'biochemistry_ii');
check('blank fields are not slugs', subjectSlugOf({ subjectId: '   ', category: 'cosmetics' }) === 'cosmetics');
check('an untagged document has no slug', subjectSlugOf({}) === '');
check('null is tolerated', subjectSlugOf(null) === '');

console.log('\nLookup by slug:');

check('the BARE slug matches', findSubject(curriculum, 'biochemistry_ii')?.nameEn === 'Biochemistry II');
check('the prefixed document id matches too',
  findSubject(curriculum, 'stage_3__biochemistry_ii')?.nameEn === 'Biochemistry II');
check('an unknown slug matches nothing', findSubject(curriculum, 'nonesuch') === null);
check('an empty curriculum matches nothing', findSubject([], 'biochemistry_ii') === null);

console.log('\nDenormalized block:');
{
  const meta = subjectMetaFrom(curriculum, 'biochemistry_ii');
  check('carries the bare slug, not the document id', meta?.subjectId === 'biochemistry_ii');
  check('carries both languages', meta?.subjectName === 'Biochemistry II' && meta?.subjectNameAr === 'الكيمياء الحياتية ٢');
  check('carries the course', meta?.courseId === 'course_2');
  check('an unknown subject writes nothing rather than empties',
    subjectMetaFrom(curriculum, 'nonesuch') === null);
}

console.log('\nLabel tiers:');

check('tier 1 - denormalized Arabic beats the live list',
  resolveSubjectLabel({ subjectId: 'biochemistry_ii', subjectNameAr: 'اسم محفوظ' }, curriculum, 'ar') === 'اسم محفوظ');
check('tier 1 - a degree row uses materialName',
  resolveSubjectLabel({ material: 'pharmacology_i', materialNameAr: 'علم الأدوية ١' }, [], 'ar') === 'علم الأدوية ١');
check('tier 1 - an English-only name still names the subject in Arabic',
  resolveSubjectLabel({ subjectId: 'x', subjectName: 'Only English' }, [], 'ar') === 'Only English');
check('tier 2 - the live curriculum names an untagged document',
  resolveSubjectLabel({ subjectId: 'pharmacology_i' }, curriculum, 'en') === 'Pharmacology I');
check('tier 2 - in Arabic', resolveSubjectLabel({ subjectId: 'pharmacology_i' }, curriculum, 'ar') === 'علم الأدوية ١');
check('tier 3 - a pre-migration category still has a translated label',
  legacyCategoryLabel('organic_chemistry', 'ar').length > 0 &&
  resolveSubjectLabel({ category: 'organic_chemistry' }, curriculum, 'ar') === legacyCategoryLabel('organic_chemistry', 'ar'));
check('tier 4 - an unknown slug renders as itself, never as another subject',
  resolveSubjectLabel({ subjectId: 'hidden_subject' }, curriculum, 'ar') === 'hidden_subject');
check('nothing to name renders as empty, not as pharmacology',
  resolveSubjectLabel({}, curriculum, 'ar') === '');

console.log('\nHistory the live list cannot cover:');
{
  // A representative hid this subject, so useStageSubjects drops it.
  const visible = curriculum.filter(s => s.id !== 'biochemistry_ii');
  check('a hidden subject is still named from the document',
    resolveSubjectLabel({ subjectId: 'biochemistry_ii', subjectNameAr: 'الكيمياء الحياتية ٢' }, visible, 'ar') === 'الكيمياء الحياتية ٢');
  check('without the denormalized name it degrades to the slug, not to a wrong subject',
    resolveSubjectLabel({ subjectId: 'biochemistry_ii' }, visible, 'ar') === 'biochemistry_ii');
  // A student promoted out of stage 2 still has stage-2 grade tabs.
  check('a cross-stage degree is named from the document',
    resolveSubjectLabel({ material: 'physiology_i', materialName: 'Physiology I' }, [], 'en') === 'Physiology I');
}

console.log('\nAccent colours:');
{
  const a = subjectAccent('biochemistry_ii');
  check('is stable across calls', a.badge === subjectAccent('biochemistry_ii').badge);
  check('does not depend on list position - reordering cannot recolour',
    subjectAccent(curriculum[0].id).badge === subjectAccent([...curriculum].reverse()[2].id).badge);
  check('different subjects generally differ',
    new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(s => subjectAccent(s).badge)).size > 1);
  check('always lands inside the palette',
    ['biochemistry_ii', 'z', '', 'طويل جدا', 'x'.repeat(200)].every(s => !!subjectAccent(s)?.badge));
  check('a blank slug still gets an accent', !!subjectAccent(undefined).emoji);
}

console.log('\nCourse grouping:');
{
  const c1 = subjectsForCourse(curriculum, 'course_1');
  const c2 = subjectsForCourse(curriculum, 'course_2');
  check('splits by course', c1.length === 1 && c2.length === 2);
  check('sorts by order', c2[0].order <= c2[1].order);
  check('an empty list is tolerated', subjectsForCourse(null, 'course_1').length === 0);
}

console.log('');
console.log('Legacy aliases stay in step with the seed script:');
{
  // Pinned against scripts/migrateToStages.js rather than restated, because a
  // drifted alias is invisible on screen: grades just quietly split into two
  // sections per subject. That file is where the mapping was DECIDED - all
  // pre-migration content was uploaded during Third Stage / Course II, so the
  // five legacy categories are a 1:1 cover of that course's subjects.
  const seed = readFileSync(new URL('./migrateToStages.js', import.meta.url), 'utf8');

  // The seed's slugify, rewritten without regex literals but equivalent:
  // lowercase, every non-alphanumeric run becomes one underscore, ends trimmed.
  const slugify = (name: string) => {
    let out = '';
    for (const ch of name.toLowerCase()) {
      out += (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ? ch : '_';
    }
    return out.split('_').filter(Boolean).join('_');
  };

  const start = seed.indexOf('const LEGACY_TO_SUBJECT');
  const body = seed.slice(start, seed.indexOf('};', start));
  // Walked with indexOf rather than a regex or a line split: this file is
  // edited by tooling that mangles backslash escapes, and a silently broken
  // parser here would report "0 categories" instead of a real drift.
  const seedMap: Record<string, string> = {};
  const CALL = "slugify('";
  let cursor = 0;
  for (;;) {
    const call = body.indexOf(CALL, cursor);
    if (call < 0) break;
    const nameStart = call + CALL.length;
    const nameEnd = body.indexOf("'", nameStart);
    const colon = body.lastIndexOf(':', call);
    const keyStart = Math.max(body.lastIndexOf(',', colon), body.lastIndexOf('{', colon)) + 1;
    seedMap[body.slice(keyStart, colon).trim()] = slugify(body.slice(nameStart, nameEnd));
    cursor = nameEnd + 1;
  }

  check('the seed still declares all five legacy categories',
    Object.keys(seedMap).length === 5, JSON.stringify(seedMap));
  check('every alias matches the slug migrateToStages.js backfilled',
    Object.entries(seedMap).every(([k, v]) => LEGACY_SUBJECT_ALIASES[k] === v),
    'ours ' + JSON.stringify(LEGACY_SUBJECT_ALIASES) + ' vs seed ' + JSON.stringify(seedMap));
  check('no alias exists that the seed does not know about',
    Object.keys(LEGACY_SUBJECT_ALIASES).every(k => k in seedMap));

  check('a legacy slug folds onto its curriculum equivalent',
    canonicalSubjectSlug('biochemistry') === 'biochemistry_ii');
  check('a curriculum slug is already canonical',
    canonicalSubjectSlug('biochemistry_ii') === 'biochemistry_ii');
  check('both spellings group together - one section per subject, not two',
    canonicalSubjectSlug('biochemistry') === canonicalSubjectSlug('biochemistry_ii'));
  check('a slug the table does not know passes through untouched',
    canonicalSubjectSlug('public_health') === 'public_health');
  check('blank stays blank, so a caller can fall back to its own key',
    canonicalSubjectSlug(undefined) === '' && canonicalSubjectSlug('  ') === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
