/**
 * Verifies the year-end wipe against the Firestore emulator.
 *
 * Run with:  npm run test:wipe
 *
 * This deletes a whole year of content on a live production project, so the
 * guarantees are asserted here before it is ever pointed at mylectures-app. The
 * three families that matter, following scripts/season.test.ts:
 *   (i)   what is gone
 *   (ii)  what MUST survive - above all the question bank and the grades
 *   (iii) a retry is a no-op
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import 'dotenv/config';
import { summariseYear } from '../shared/yearSummary';
import { planYearWipe, wipeYear, exportYear, runYearWipe, YearWipeError, storagePathFromUrl, r2KeyFromUrl } from '../shared/yearWipe';
import { deleteWipedFiles } from '../shared/yearWipeFiles';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const YEAR = '2026-2027';
const R2_BASE = 'https://pub-abc123.r2.dev';
const STORAGE_URL = (path: string) =>
  `https://firebasestorage.googleapis.com/v0/b/bkt.appspot.com/o/${encodeURIComponent(path)}?alt=media&token=x`;

// ---------------------------------------------------------------------------
// URL parsing - pure, and the part that decides which bucket a delete goes to.
// ---------------------------------------------------------------------------
console.log('\nURL parsing:');
check('a Firebase URL yields its decoded object path',
  storagePathFromUrl(STORAGE_URL('lectures/1779_a b.pdf')) === 'lectures/1779_a b.pdf');
check('a YouTube link is not a storage path',
  storagePathFromUrl('https://youtu.be/abc') === null);
check('an R2 url is never read as a storage path',
  storagePathFromUrl(`${R2_BASE}/records/1_a.m4a`) === null);
check('an empty value is not a storage path', storagePathFromUrl('') === null);
check('an R2 url yields its object key',
  r2KeyFromUrl(`${R2_BASE}/records/1779_a.m4a`, R2_BASE) === 'records/1779_a.m4a');
check('a trailing slash on the base is tolerated',
  r2KeyFromUrl(`${R2_BASE}/records/x.m4a`, `${R2_BASE}/`) === 'records/x.m4a');
check('a foreign host is not an R2 key',
  r2KeyFromUrl(STORAGE_URL('lectures/a.pdf'), R2_BASE) === null);

// ---------------------------------------------------------------------------
// Seed: two stages of content, plus everything that must survive.
// ---------------------------------------------------------------------------
await db.collection('lectures').doc('lec1').set({
  title: 'Glycolysis', stageId: 'stage_3', subjectId: 'biochemistry_ii', courseId: 'course_2',
  pdfUrl: STORAGE_URL('lectures/1779_glyco.pdf'), description: 'notes', youtubeUrl: 'https://youtu.be/x',
});
await db.collection('lectures').doc('lec2').set({
  title: 'Pharma I', stageId: 'stage_4', subjectId: 'pharmacology_ii', pdfUrl: STORAGE_URL('lectures/1780_ph.pdf'),
});
await db.collection('records').doc('rec1').set({
  title: 'Respiratory chain', stageId: 'stage_3', audioUrl: `${R2_BASE}/records/1779_resp.m4a`, size: 130.3,
});
await db.collection('announcements').doc('ann1').set({
  content: 'exam tomorrow', stageId: 'stage_3', imageUrl: STORAGE_URL('announcements/1779_img.jpg'),
});
await db.collection('homeworks').doc('hw1').set({ subject: 'biochemistry', stageId: 'stage_3' });
await db.collection('mcqs').doc('lec1').set({ lectureId: 'lec1', questions: [{ stem: 'q' }] });
await db.collection('antiCheatLogs').doc('ac1').set({ userId: 'u1', lectureId: 'lec1' });
await db.collection('settings').doc('weekly_schedule_stage_3').set({
  photoUrl: STORAGE_URL('schedules/weekly_1779'), stageId: 'stage_3',
});

// MUST SURVIVE
await db.collection('questionBank').doc('q1').set({
  scope: 'lecture', lectureId: 'lec1', subjectId: 'biochemistry_ii', stem: 'ministry question', isActive: true,
});
await db.collection('questionBank').doc('q2').set({ scope: 'global', stem: 'global question', isActive: true });
await db.collection('students').doc('stu@x.com').set({
  email: 'stu@x.com', stageId: 'stage_3', password: 'HASH',
  progressionYear: YEAR, progressionState: 'completed', hasCompletedProgression: true,
  pendingStageId: 'stage_4', pendingProgressionYear: YEAR,
  pendingProgressionSetAt: FieldValue.serverTimestamp(),
});
await db.collection('stages').doc('stage_3').set({ id: 'stage_3', order: 3 });
await db.collection('subjects').doc('stage_3__biochemistry_ii').set({ id: 'biochemistry_ii', stageId: 'stage_3' });
await db.collection('allowed_admins').doc('rep@x.com').set({ email: 'rep@x.com', role: 'admin' });
await db.collection('subscriptions').doc('sub1').set({ userId: 'u1', status: 'active' });
await db.collection('adminLogs').doc('log1').set({ action: 'CREATE_ADMIN' });
await db.collection('degrees').doc('u1').collection('exams').doc('e1').set({ degree: 88, stageId: 'stage_3' });

// Per-user activity, and the dead-id arrays.
await db.collection('users').doc('u1').set({
  email: 'stu@x.com', stageId: 'stage_3', role: 'student',
  studied: ['lec1', 'lec2'], completedWeeklyTasks: ['hw1'], favorites: ['lec1'],
  progressionYear: YEAR, progressionState: 'completed', hasCompletedProgression: true,
});
await db.collection('users').doc('u2').set({ email: 'b@x.com', stageId: 'stage_4', role: 'student', studied: [] });
await db.collection('userMCQStats').doc('u1').set({
  userId: 'u1', stageId: 'stage_3', totalFirstAttemptCorrect: 80, totalFirstAttemptAnswered: 100,
});
await db.collection('userStageMCQStats').doc('u1_stage_3').set({
  userId: 'u1', stageId: 'stage_3', isActiveInStage: true,
  totalFirstAttemptCorrect: 80, totalFirstAttemptAnswered: 100,
  mcqLeaderboardScore: 800, mcqRankScore: 6400, accuracy: 80,
  lecturesAttempted: 5, subjectStats: { biochemistry: { correct: 80, total: 100 } },
});
await db.collection('userMCQAnswers').doc('u1').collection('lectures').doc('lec1').set({ locked: true });
await db.collection('userBankAnswers').doc('u1').collection('questions').doc('a1').set({ questionId: 'q1' });
await db.collection('userBankAnswers').doc('u1').collection('questions').doc('a2').set({ questionId: 'q2' });

// ---------------------------------------------------------------------------
// 1. The year summary, taken BEFORE anything is destroyed.
// ---------------------------------------------------------------------------
console.log('\nYear summary is captured before the wipe:');
const summary = await summariseYear(db, FieldValue as any, { yearLabel: YEAR });
check('one active student summarised', summary.summarised === 1, `got ${summary.summarised}`);
const card = (await db.doc(`users/u1/yearHistory/${YEAR}`).get()).data() || {};
check('MCQs solved recorded', card.mcqSolved === 100, `got ${card.mcqSolved}`);
check('MCQs correct recorded', card.mcqCorrect === 80, `got ${card.mcqCorrect}`);
check('bank answers counted', card.bankAnswered === 2, `got ${card.bankAnswered}`);
check('accuracy recorded', Math.round(card.accuracy) === 80, `got ${card.accuracy}`);
check('score recorded', card.score === 64, `got ${card.score}`);
check('a student with no activity gets no card', summary.skipped >= 0 &&
  !(await db.doc(`users/u2/yearHistory/${YEAR}`).get()).exists);

// ---------------------------------------------------------------------------
// 2. Planning is read-only, and finds every file.
// ---------------------------------------------------------------------------
console.log('\nPlanning:');
const plan = await planYearWipe(db, { yearLabel: YEAR, r2PublicUrl: R2_BASE });
check('planning alone deletes nothing', (await db.collection('records').get()).size === 1);
check('not yet marked wiped', plan.alreadyWiped === false);
check('counts the records', plan.counts.records === 1);
check('counts both lectures as stubs', plan.lectureStubs === 2);
check('counts the MCQ answers', plan.counts.userMCQAnswers === 1, `got ${plan.counts.userMCQAnswers}`);
check('counts the bank answers', plan.counts.userBankAnswers === 2, `got ${plan.counts.userBankAnswers}`);
check('finds the R2 recording',
  plan.files.some(f => f.kind === 'r2' && f.key === 'records/1779_resp.m4a'));
check('finds both lecture PDFs',
  plan.files.filter(f => f.kind === 'storage' && f.key.startsWith('lectures/')).length === 2);
check('finds the announcement image',
  plan.files.some(f => f.key === 'announcements/1779_img.jpg'));
check('finds the timetable photo',
  plan.files.some(f => f.key === 'schedules/weekly_1779'));
check('the question bank is never in the file list',
  !plan.files.some(f => f.source.startsWith('questionBank/')));

await exportYear(db, FieldValue as any, { yearLabel: YEAR, performedBy: 'test', plan });
check('the export snapshots the records',
  (await db.doc(`contentArchives/${YEAR}/records/rec1`).get()).exists);
check('the export snapshots the lectures',
  (await db.doc(`contentArchives/${YEAR}/lectures/lec1`).get()).exists);
check('the export manifest lists the files',
  (((await db.doc(`contentArchives/${YEAR}`).get()).data() || {}).files || []).length === plan.files.length);

// ---------------------------------------------------------------------------
// 3. The wipe.
// ---------------------------------------------------------------------------
console.log('\nWhat is gone:');
const result = await wipeYear(db, FieldValue as any, { yearLabel: YEAR, performedBy: 'test' });
check('records deleted', (await db.collection('records').get()).size === 0);
check('announcements deleted', (await db.collection('announcements').get()).size === 0);
check('homeworks deleted', (await db.collection('homeworks').get()).size === 0);
check('per-lecture mcqs deleted', (await db.collection('mcqs').get()).size === 0);
check('anti-cheat logs deleted', (await db.collection('antiCheatLogs').get()).size === 0);
check('MCQ answers deleted',
  (await db.collection('userMCQAnswers').doc('u1').collection('lectures').get()).size === 0);
check('bank answers deleted',
  (await db.collection('userBankAnswers').doc('u1').collection('questions').get()).size === 0);

console.log('\nLectures survive as stubs only:');
const stub = (await db.doc('lectures/lec1').get()).data() || {};
check('the lecture document still exists', Object.keys(stub).length > 0);
check('its title is kept so the bank question reads sensibly', stub.title === 'Glycolysis');
check('its subject is kept', stub.subjectId === 'biochemistry_ii');
check('the PDF link is gone', stub.pdfUrl === undefined);
check('the description is gone', stub.description === undefined);
check('the youtube link is gone', stub.youtubeUrl === undefined);
check('it is flagged archived so it leaves the student lists', stub.archived === true);

console.log('\nWhat MUST survive:');
check('the question bank is untouched', (await db.collection('questionBank').get()).size === 2);
check('a lecture-scoped bank question still resolves to its stub',
  ((await db.doc('questionBank/q1').get()).data() || {}).lectureId === 'lec1' &&
  (await db.doc('lectures/lec1').get()).exists);
check('grades are untouched',
  (await db.collection('degrees').doc('u1').collection('exams').get()).size === 1);
check('the roster is untouched', (await db.collection('students').get()).size === 1);
check('accounts are untouched', (await db.collection('users').get()).size === 2);
check('stages are untouched', (await db.collection('stages').get()).size === 1);
check('the curriculum is untouched', (await db.collection('subjects').get()).size === 1);
check('admin appointments are untouched', (await db.collection('allowed_admins').get()).size === 1);
check('subscriptions are untouched', (await db.collection('subscriptions').get()).size === 1);
check('the admin log is untouched', (await db.collection('adminLogs').get()).size === 1);
check('the year card survives the wipe that produced it',
  (await db.doc(`users/u1/yearHistory/${YEAR}`).get()).exists);

console.log('\nDead ids are cleared:');
const u1 = (await db.doc('users/u1').get()).data() || {};
check('studied emptied', Array.isArray(u1.studied) && u1.studied.length === 0);
check('completed tasks emptied', Array.isArray(u1.completedWeeklyTasks) && u1.completedWeeklyTasks.length === 0);
check('favorites emptied', Array.isArray(u1.favorites) && u1.favorites.length === 0);
check('the account itself is intact', u1.email === 'stu@x.com' && u1.stageId === 'stage_3');
check('progression completion is cleared for the next academic year',
  u1.progressionYear === undefined && u1.progressionState === undefined && u1.hasCompletedProgression === undefined);
const rosterAfterWipe = (await db.doc('students/stu@x.com').get()).data() || {};
check('year wipe clears progression and pending state from the roster copy',
  rosterAfterWipe.progressionYear === undefined
    && rosterAfterWipe.progressionState === undefined
    && rosterAfterWipe.hasCompletedProgression === undefined
    && rosterAfterWipe.pendingStageId === undefined
    && rosterAfterWipe.pendingProgressionYear === undefined
    && rosterAfterWipe.pendingProgressionSetAt === undefined);
const resetStats = (await db.doc('userStageMCQStats/u1_stage_3').get()).data() || {};
check('active stage MCQ totals reset only at year wipe',
  resetStats.totalFirstAttemptCorrect === 0 && resetStats.totalFirstAttemptAnswered === 0);
const stageArchive = (await db.doc(`users/u1/stageHistory/${YEAR}_stage_3`).get()).data() || {};
check('year wipe archives immutable stage performance before reset',
  stageArchive.totalFirstAttemptCorrect === 80 && stageArchive.mcqLeaderboardScore === 800);
check('users cleaned counted', result.usersCleaned === 1, `got ${result.usersCleaned}`);

console.log('\nA retry is a no-op:');
const replan = await planYearWipe(db, { yearLabel: YEAR, r2PublicUrl: R2_BASE });
check('the year is latched as wiped', replan.alreadyWiped === true);
const again = await wipeYear(db, FieldValue as any, { yearLabel: YEAR, performedBy: 'test' });
check('a second run deletes nothing', again.documentsDeleted === 0, `got ${again.documentsDeleted}`);
check('and does not re-empty an already-clean account', again.usersCleaned === 0);
check('the stub is not destroyed by the retry', (await db.doc('lectures/lec1').get()).exists);
check('the question bank is still there after a retry',
  (await db.collection('questionBank').get()).size === 2);

// ---------------------------------------------------------------------------
// 4. File deletion. Fake clients: the real ones are irreversible, and this is
//    about routing and failure handling, not about the SDKs.
// ---------------------------------------------------------------------------
console.log('\nFile deletion:');
const r2Hits: string[] = [];
const storageHits: string[] = [];
const notFound = Object.assign(new Error('nope'), { code: 404 });

const fakeDeps = (opts: { r2Throws?: any; storageThrows?: any } = {}) => ({
  s3: { async send(cmd: any) { if (opts.r2Throws) throw opts.r2Throws; r2Hits.push(cmd.Key); } },
  DeleteObjectCommand: class { Bucket: string; Key: string;
    constructor(i: { Bucket: string; Key: string }) { this.Bucket = i.Bucket; this.Key = i.Key; } } as any,
  r2Bucket: 'lecture-audio',
  storageBucket: {
    file(path: string) {
      return { async delete() { if (opts.storageThrows) throw opts.storageThrows; storageHits.push(path); } };
    },
  },
});

const del = await deleteWipedFiles(plan.files, fakeDeps());
check('every planned object is deleted', del.deleted === plan.files.length, `got ${del.deleted}`);
check('the recording went to R2, not Storage',
  r2Hits.includes('records/1779_resp.m4a') && !storageHits.includes('records/1779_resp.m4a'));
check('the PDFs went to Storage, not R2',
  storageHits.includes('lectures/1779_glyco.pdf') && !r2Hits.includes('lectures/1779_glyco.pdf'));
check('nothing failed', del.failed.length === 0);

const dupes = await deleteWipedFiles(
  [{ kind: 'storage', key: 'lectures/x.pdf', source: 'a' }, { kind: 'storage', key: 'lectures/x.pdf', source: 'b' }],
  fakeDeps());
check('a key referenced twice is deleted once', dupes.deleted === 1, `got ${dupes.deleted}`);

const gone = await deleteWipedFiles(
  [{ kind: 'storage', key: 'lectures/gone.pdf', source: 'a' }],
  fakeDeps({ storageThrows: notFound }));
check('an object that is already gone is not an error',
  gone.missing === 1 && gone.failed.length === 0);

const broke = await deleteWipedFiles(
  [{ kind: 'r2', key: 'records/x.m4a', source: 'a' }],
  fakeDeps({ r2Throws: new Error('permission denied') }));
check('a real failure is collected, not thrown',
  broke.failed.length === 1 && broke.failed[0].reason.includes('permission denied'));
check('and the run still reports a result', broke.deleted === 0);

const noClients = await deleteWipedFiles(plan.files, {});
check('with no clients configured nothing is attempted',
  noClients.deleted === 0 && noClients.skippedR2 && noClients.skippedStorage);

// ---------------------------------------------------------------------------
// 5. The orchestrator guards. Each one prevents a wipe that would destroy
//    something unrecoverable, so each is asserted on its own.
// ---------------------------------------------------------------------------
console.log('\nGuards:');
const noopSummarise = async () => ({ summarised: 0, skipped: 0 });
const caught = async (fn: () => Promise<any>) => {
  try { await fn(); return null; } catch (e: any) { return e; }
};

const wrongYear = await caught(() => runYearWipe(db, FieldValue as any, {
  yearLabel: '2020-2021', performedBy: 't', calendarYearLabel: YEAR,
  finalTermId: 'term2', summarise: noopSummarise,
}));
check('a year that is not the calendar year is refused',
  wrongYear instanceof YearWipeError && wrongYear.status === 409);

// A fresh year, so the already-wiped latch is not what is being tested here.
const YEAR2 = '2027-2028';
await db.collection('app_settings').doc('streak').set({ seasonClosedFor: 'term1' }, { merge: true });
const seasonNotClosed = await caught(() => runYearWipe(db, FieldValue as any, {
  yearLabel: YEAR2, performedBy: 't', calendarYearLabel: YEAR2,
  finalTermId: 'term2', summarise: noopSummarise,
}));
check('a wipe before the final season is archived is refused',
  seasonNotClosed instanceof YearWipeError && seasonNotClosed.status === 409,
  String(seasonNotClosed));
check('and it refuses BEFORE deleting anything',
  (await db.collection('questionBank').get()).size === 2);

const alreadyWiped = await caught(() => runYearWipe(db, FieldValue as any, {
  yearLabel: YEAR, performedBy: 't', calendarYearLabel: YEAR,
  finalTermId: null, summarise: noopSummarise,
}));
check('an already-wiped year is refused',
  alreadyWiped instanceof YearWipeError && alreadyWiped.status === 409);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
