/**
 * Verifies /api/record-activity against the Firestore emulator.
 *
 * Run with:  npm run test:streak
 *
 * The handler lives in shared/streakApi.ts and is mounted by BOTH server.ts and
 * api/index.ts, so this covers production and dev at once - which is the point
 * of it being shared at all.
 *
 * The case it exists for: on the opening day of a term, every preceding day is
 * `preseason` and therefore PAUSED, and activeDaysBetween deliberately skips
 * paused days. So a lastActiveDate from months earlier reported a gap of
 * exactly one, record-activity took its `daysDiff === 1` arm, and a stale
 * counter was incremented instead of restarting - one student opened the season
 * on 2 while every other student was on 1. Nothing else would have caught it:
 * closableTerm() can never close a calendar's FIRST term, so startNewSeason
 * never ran to zero anything.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import admin from 'firebase-admin';
import { createStreakHandlers } from '../shared/streakApi.js';
import 'dotenv/config';


if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
initializeApp({ credential: cert({ projectId: FIREBASE_PROJECT_ID!, clientEmail: FIREBASE_CLIENT_EMAIL!, privateKey: FIREBASE_PRIVATE_KEY!.replace(/\\n/g,'\n') }), projectId: FIREBASE_PROJECT_ID });

let pass = 0, fail = 0;
const chk = (n: string, ok: boolean, d = '') => { console.log(`  ${ok?'PASS':'FAIL'}  ${n}${ok?'':' -> '+d}`); ok ? pass++ : fail++; };

async function main() {
  const db = admin.firestore();
  const streak = createStreakHandlers({ admin });

  // A calendar whose term 1 opens TODAY, whatever today is - the live shape.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' });
  const longAgo = '2020-01-01';
  await db.doc('app_settings/academicCalendar').set({
    yearLabel: 'test', timezone: 'Asia/Baghdad',
    terms: [{ id: 'term1', nameAr: 'x', nameEn: 'x',
      startDate: today, endDate: '2099-12-31', examsStart: null, examsEnd: null }],
  });

  const call = async (uid: string) => {
    let body: any = null;
    const res: any = { json: (b: any) => { body = b; return res; }, status: () => res, send: () => res };
    await streak.recordActivity({ user: { uid, email: `${uid}@x.com` }, params: {}, body: {}, headers: {} }, res);
    return body;
  };

  // The exact reported shape: a student carrying a pre-season streak.
  await db.doc('users/carryover').set({
    name: 'carryover', role: 'student', streakCount: 1, longestStreak: 1,
    bestStreakAllTime: 0, freezeTokens: 1, lastActiveDate: longAgo,
  });
  // And a brand-new student with nothing.
  await db.doc('users/fresh').set({
    name: 'fresh', role: 'student', streakCount: 0, longestStreak: 0,
    bestStreakAllTime: 0, freezeTokens: 3, lastActiveDate: null,
  });

  const a = await call('carryover');
  const b = await call('fresh');

  chk('a pre-season streak does NOT become 2 on opening day', a?.streakCount === 1, String(a?.streakCount));
  chk('a brand-new student gets 1', b?.streakCount === 1, String(b?.streakCount));

  const c = (await db.doc('users/carryover').get()).data();
  chk('the stale per-season peak was zeroed then re-set from today',
    c?.longestStreak === 1, String(c?.longestStreak));
  chk('their old peak was BANKED into bestStreakAllTime',
    c?.bestStreakAllTime === 1, String(c?.bestStreakAllTime));
  chk('shields were restored for the new season', c?.freezeTokens === 3, String(c?.freezeTokens));

  const log = (await db.doc(`streakLog/carryover/days/${today}`).get()).data();
  chk('the audit trail names the branch that ran', log?.method === 'new_season', String(log?.method));
  chk('and records the counters either side',
    log?.streakBefore === 1 && log?.streakAfter === 1, `${log?.streakBefore}->${log?.streakAfter}`);

  // Idempotence: a second call the same day must not double-count.
  const again = await call('carryover');
  chk('a second visit the same day does not increment', again?.streakCount === 1, String(again?.streakCount));

  // A genuine consecutive day continues normally - but only once the term has
  // actually been running, so switch to a calendar that opened long ago. Under
  // the opening-day calendar above, "yesterday" IS preseason and resetting to 1
  // is the correct answer, which is what this originally asserted wrongly.
  await db.doc('app_settings/academicCalendar').set({
    yearLabel: 'test', timezone: 'Asia/Baghdad',
    terms: [{ id: 'running', nameAr: 'x', nameEn: 'x',
      startDate: '2020-01-01', endDate: '2099-12-31', examsStart: null, examsEnd: null }],
  });
  await db.doc('users/consecutive').set({
    name: 'consecutive', role: 'student', streakCount: 4, longestStreak: 4,
    bestStreakAllTime: 4, freezeTokens: 3,
    lastActiveDate: new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Baghdad' }),
  });
  const d = await call('consecutive');
  chk('an ordinary consecutive day INSIDE a running term still increments',
    d?.streakCount === 5, String(d?.streakCount));

  // And the guard must not fire on a gap inside that running term either.
  await db.doc('users/gap_inside_term').set({
    name: 'gap', role: 'student', streakCount: 6, longestStreak: 6,
    bestStreakAllTime: 6, freezeTokens: 3, lastActiveDate: '2024-05-05',
  });
  const e = await call('gap_inside_term');
  const eLog = (await db.doc(`streakLog/gap_inside_term/days/${today}`).get()).data();
  chk('a long gap inside a running term is a LOST streak, not a new season',
    e?.streakCount === 1 && eLog?.method === 'pending_loss',
    `${e?.streakCount} / ${eLog?.method}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
