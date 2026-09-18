import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import 'dotenv/config';

// Backfills the multi-stage architecture onto an existing database.
//
// Every collection listed in BACKFILL_COLLECTIONS is now filtered by `stageId`
// in the client. Any document missing that field is invisible to every user, so
// this script must run once before the stage-filtered build is deployed.
//
// Credentials: either pass a service account JSON path as the first argument,
// or leave it out to use FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY from .env (the same vars server.ts authenticates with).
//
// Usage: node migrateToStages.js [serviceAccountKey.json] [defaultStageId]
// Example: node migrateToStages.js --env stage_3
//          node migrateToStages.js ./serviceAccountKey.json stage_3

// Must stay identical to DEFAULT_STAGES in src/contexts/StageContext.tsx —
// whichever seeds first wins, and mismatched names produce duplicate-looking stages.
const DEFAULT_STAGES = [
  { id: 'stage_1', nameEn: 'First Stage', nameAr: 'المرحلة الأولى', order: 1 },
  { id: 'stage_2', nameEn: 'Second Stage', nameAr: 'المرحلة الثانية', order: 2 },
  { id: 'stage_3', nameEn: 'Third Stage', nameAr: 'المرحلة الثالثة', order: 3 },
  { id: 'stage_4', nameEn: 'Fourth Stage', nameAr: 'المرحلة الرابعة', order: 4 },
  { id: 'stage_5', nameEn: 'Fifth Stage', nameAr: 'المرحلة الخامسة', order: 5 },
];

// The five legacy pharmacy categories. Only still referenced to (a) delete the
// incorrect subject docs seeded from them and (b) map old lectures onto real subjects.
const LEGACY_CATEGORIES = [
  'pharmacology', 'pharmacognosy', 'organic_chemistry', 'biochemistry', 'cosmetics',
];

/**
 * Real curriculum. Each stage runs two courses with their own subject lists.
 *
 * nameAr is intentionally left equal to nameEn - the curriculum was supplied in
 * English only, and inventing 40+ Arabic names would be worse than showing the
 * English one until a representative renames it in the المواد tab.
 */
const CURRICULUM = {
  stage_2: {
    course_1: [
      ['Medical Microbiology I', 'الأحياء المجهرية الطبية ١'],
      // The college timetable prints "Baathist crimes + Arabic Language" and
      // "Physiology I + Computer Science" on one line each, because the pair
      // shares a slot. They are four separate subjects with four separate
      // lecture lists, and seeding them as two documents gave each pair one
      // card, one folder and one progress bar. See src/lib/subjectSplit.ts;
      // databases already seeded from the combined form are repaired by
      // scripts/splitCombinedSubjects.mjs or the split button in المواد.
      ['Baathist crimes',         'جرائم حزب البعث'],
      ['Arabic Language',         'اللغة العربية'],
      ['Physical Pharmacy I',     'الصيدلة الفيزيائية ١'],
      ['Physiology I',            'علم وظائف الأعضاء ١'],
      ['Computer Science',        'الحاسوب'],
      ['Organic Chemistry II',    'الكيمياء العضوية ٢'],
    ],
    course_2: [
      ['Physiology II',           'علم وظائف الأعضاء ٢'],
      ['Physical Pharmacy II',    'الصيدلة الفيزيائية ٢'],
      ['Organic Chemistry III',   'الكيمياء العضوية ٣'],
      ['Medical Microbiology II', 'الأحياء المجهرية الطبية ٢'],
      ['Pharmacognocy I',         'العقاقير ١'],
    ],
  },
  stage_3: {
    course_1: [
      ['Pharmacognosy II',                   'العقاقير ٢'],
      ['Pharmacy Ethics',                    'أخلاقيات مهنة الصيدلة'],
      ['Inorganic Pharmaceutical Chemistry', 'الكيمياء الصيدلانية اللاعضوية'],
      ['Pathophysiology',                    'فسلجة الأمراض'],
      ['Biochemistry I',                     'الكيمياء الحياتية ١'],
      ['Pharmaceutical Technology I',        'التكنولوجيا الصيدلانية ١'],
    ],
    course_2: [
      ['Pharmacology I',                          'علم الأدوية ١'],
      ['Pharmaceutical and Cosmetic Preparations','المستحضرات الصيدلانية والتجميلية'],
      ['Pharmacognocy III',                       'العقاقير ٣'],
      ['Biochemistry II',                         'الكيمياء الحياتية ٢'],
      ['Organic Pharm. Chemistry I',              'الكيمياء الصيدلانية العضوية ١'],
    ],
  },
  stage_4: {
    course_1: [
      ['Pharmacology II',            'علم الأدوية ٢'],
      ['Communication Skills',       'مهارات التواصل'],
      ['Public Health',              'الصحة العامة'],
      ['Organic Pharm. Chemistry II','الكيمياء الصيدلانية العضوية ٢'],
      ['Clinical Pharmacy I',        'الصيدلة السريرية ١'],
      ['Biopharmaceutics',           'الصيدلانيات الحيوية'],
    ],
    course_2: [
      ['Clinical Pharmacy II',        'الصيدلة السريرية ٢'],
      ['Pharmacology III',            'علم الأدوية ٣'],
      ['General Toxicology',          'علم السموم العام'],
      ['Organic Pharm. Chemistry III','الكيمياء الصيدلانية العضوية ٣'],
      ['Industrial Pharmacy I',       'الصيدلة الصناعية ١'],
    ],
  },
  stage_5: {
    course_1: [
      ['Clinical Chemistry',                   'الكيمياء السريرية'],
      ['Lab. Training',                        'التدريب المختبري'],
      ['Applied Therapeutics-I',               'المعالجات التطبيقية ١'],
      ['Clinical Toxicology',                  'علم السموم السريري'],
      ['Industrial Pharmacy-II',               'الصيدلة الصناعية ٢'],
      ['Organic Pharmaceutical Chemistry IV',  'الكيمياء الصيدلانية العضوية ٤'],
      ['Pharmaceutical Biotechnology',         'التقانة الحيوية الصيدلانية'],
    ],
    course_2: [
      ['Applied Therapeutics- II',            'المعالجات التطبيقية ٢'],
      ['Advanced chemical analysis',          'التحليل الكيميائي المتقدم'],
      ['Drug Delivery',                       'أنظمة إيصال الدواء'],
      ['Hospital training',                   'التدريب في المستشفى'],
      ['TDM (Therapeutic Drug Monitoring)',   'مراقبة الأدوية العلاجية'],
      ['Pharmacoeconomic',                    'الاقتصاد الدوائي'],
    ],
  },
  // stage_1 is deliberately empty - its representative adds subjects in-app.
};

const slugify = (name) =>
  name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

/**
 * All existing content was uploaded during Third Stage / Course II, so the five
 * legacy categories are a 1:1 cover of that course's subjects. This makes the
 * backfill deterministic rather than a guess.
 */
const LEGACY_TO_SUBJECT = {
  pharmacology:      slugify('Pharmacology I'),
  cosmetics:         slugify('Pharmaceutical and Cosmetic Preparations'),
  pharmacognosy:     slugify('Pharmacognocy III'),
  biochemistry:      slugify('Biochemistry II'),
  organic_chemistry: slugify('Organic Pharm. Chemistry I'),
};
const LEGACY_CONTENT_STAGE = 'stage_3';
const LEGACY_CONTENT_COURSE = 'course_2';

// Top-level collections the client now filters by stageId.
const BACKFILL_COLLECTIONS = [
  'users',
  'students',
  'lectures',
  'records',
  'announcements',
  'homeworks',
  'degreeBatches',
  'userMCQStats',
];

const BATCH_LIMIT = 500;

/** Mirrors computeMcqRankScore in src/types/mcq.types.ts - keep the two in step. */
function computeMcqRankScore(correct, answered) {
  if (!answered || answered <= 0) return null;
  return Math.round((correct * correct * 100) / answered);
}

async function backfill(db, label, docs, defaultStage) {
  let batch = db.batch();
  let pending = 0;
  let total = 0;

  for (const doc of docs) {
    if (doc.data().stageId) continue;

    batch.update(doc.ref, { stageId: defaultStage });
    pending++;
    total++;

    if (pending === BATCH_LIMIT) {
      await batch.commit();
      console.log(`  ${label}: committed ${total}...`);
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();
  console.log(`  ${label}: ${total} document(s) stamped with ${defaultStage}.`);
  return total;
}

async function migrate() {
  const args = process.argv.slice(2);
  const useEnv = args.length === 0 || args[0] === '--env';
  const serviceAccountPath = useEnv ? null : args[0];
  const defaultStage = args[1] || 'stage_3';

  if (!DEFAULT_STAGES.some(s => s.id === defaultStage)) {
    console.error(`Unknown stage "${defaultStage}". Expected one of: ${DEFAULT_STAGES.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  let credential;
  if (serviceAccountPath) {
    credential = cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8')));
  } else {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
      console.error("No service account path given and .env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.");
      process.exit(1);
    }
    credential = cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    console.log(`Authenticating as ${FIREBASE_CLIENT_EMAIL} (project ${FIREBASE_PROJECT_ID}).`);
  }

  initializeApp({ credential });
  const db = getFirestore();

  console.log(`Starting migration to Multi-Stage Architecture (default stage: ${defaultStage})...\n`);

  // 1. Stage documents
  console.log("Seeding stage documents...");
  for (const stage of DEFAULT_STAGES) {
    await db.collection('stages').doc(stage.id).set(stage, { merge: true });
  }
  console.log(`  ${DEFAULT_STAGES.length} stage(s) seeded.\n`);

  // 2. Subjects. The previous seed cloned the five legacy pharmacy categories to
  //    every stage, which matches no real curriculum - remove those first.
  console.log("Removing incorrect legacy subject docs...");
  let removed = 0;
  for (const stage of DEFAULT_STAGES) {
    for (const legacy of LEGACY_CATEGORIES) {
      const ref = db.collection('subjects').doc(`${stage.id}__${legacy}`);
      if ((await ref.get()).exists) {
        await ref.delete();
        removed++;
      }
    }
  }
  console.log(`  ${removed} obsolete subject doc(s) deleted.`);

  console.log("Seeding curriculum...");
  let created = 0;
  let preserved = 0;
  for (const [stageId, courses] of Object.entries(CURRICULUM)) {
    for (const [courseId, entries] of Object.entries(courses)) {
      for (let i = 0; i < entries.length; i++) {
        const [nameEn, nameAr] = entries[i];
        const id = slugify(nameEn);
        // Doc id deliberately omits courseId: moving a subject between courses is
        // then a plain field update rather than a delete + recreate.
        const ref = db.collection('subjects').doc(`${stageId}__${id}`);

        // Create-only. These documents are admin-editable (name, order, course,
        // visibility), so re-running the migration must never clobber those edits.
        if ((await ref.get()).exists) { preserved++; continue; }

        await ref.set({
          id,
          stageId,
          courseId,
          nameEn,
          nameAr,
          types: ['theoretical', 'practical'],
          order: i,
          isActive: true,
        });
        created++;
      }
      console.log(`  ${stageId} / ${courseId}: ${entries.length} subject(s)`);
    }
  }
  console.log(`  ${created} subject(s) created` + (preserved ? `, ${preserved} left untouched (already exist)` : '') + '.');

  // 2b. Tag pre-course content. Everything currently in the app was uploaded
  //     during Third Stage / Course II, so this mapping is exact, not a guess.
  console.log("Tagging existing content with course + subject...");
  for (const name of ['lectures', 'records']) {
    const snap = await db.collection(name)
      .where('stageId', '==', LEGACY_CONTENT_STAGE).get();

    let batch = db.batch();
    let pending = 0;
    let tagged = 0;
    let skipped = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      if (data.courseId) continue; // already tagged

      const subjectId = LEGACY_TO_SUBJECT[data.category];
      if (!subjectId) { skipped++; continue; }

      batch.update(docSnap.ref, { courseId: LEGACY_CONTENT_COURSE, subjectId });
      pending++;
      tagged++;

      if (pending === BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await batch.commit();
    console.log(`  ${name}: ${tagged} tagged` + (skipped ? `, ${skipped} skipped (unrecognised category)` : ''));
  }

  // tahmeelSubjects stores subject ids, and those ids just changed. Report rather
  // than silently rewrite - the right remap depends on which subject was carried.
  const tahmeelSnap = await db.collection('users').get();
  const carrying = tahmeelSnap.docs.filter(d => (d.data().tahmeelSubjects || []).length > 0);
  if (carrying.length > 0) {
    console.log(`  WARNING: ${carrying.length} user(s) hold tahmeelSubjects with old subject ids:`);
    carrying.forEach(d => console.log(`    ${d.id}: ${JSON.stringify(d.data().tahmeelSubjects)}`));
    console.log('  These need remapping by hand.');
  } else {
    console.log('  No users carry tahmeelSubjects - nothing to remap.');
  }
  console.log('');

  // ---------------------------------------------------------------------------
  // MCQ leaderboard ordering key. The board is labelled "accuracy" but used to
  // sort on raw volume; mcqRankScore encodes accuracy-then-volume plus the
  // qualifying threshold. Absent field = not qualified = excluded by orderBy.
  // ---------------------------------------------------------------------------
  console.log("Backfilling MCQ rank scores...");
  {
    const snap = await db.collection('userMCQStats').get();
    let batch = db.batch();
    let pending = 0;
    let ranked = 0;
    let unranked = 0;

    for (const docSnap of snap.docs) {
      const d = docSnap.data();
      const correct = d.totalFirstAttemptCorrect || 0;
      const answered = d.totalFirstAttemptAnswered || 0;
      const score = computeMcqRankScore(correct, answered);

      batch.update(docSnap.ref, {
        mcqRankScore: score === null ? FieldValue.delete() : score,
      });
      if (score === null) unranked++; else ranked++;
      pending++;

      if (pending === BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await batch.commit();
    console.log(`  ${ranked} scored, ${unranked} with no answers yet.`);
  }
  console.log('');


  // 3. Backfill stageId on every stage-filtered collection
  console.log("Backfilling stageId on existing documents...");
  let grandTotal = 0;
  for (const name of BACKFILL_COLLECTIONS) {
    const snapshot = await db.collection(name).get();
    grandTotal += await backfill(db, name, snapshot.docs, defaultStage);
  }

  // 4. Degrees live in a subcollection (degrees/{studentId}/exams/{examId})
  const examsSnapshot = await db.collectionGroup('exams').get();
  grandTotal += await backfill(db, 'degrees/*/exams', examsSnapshot.docs, defaultStage);

  console.log(`\nMigration complete. ${grandTotal} document(s) updated.`);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
