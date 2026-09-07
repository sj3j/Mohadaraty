/**
 * Verifies Simosan's energy accounting against the Firestore emulator.
 *
 * Run with:  npm run test:simosan
 *
 * The daily allowance and the monthly ceiling are the only things standing
 * between this feature and an unbounded Gemini bill, and every one of them is
 * arithmetic that runs inside a transaction. The concurrency case in
 * particular cannot be checked by reading the code — it either holds under ten
 * simultaneous requests or it does not.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import 'dotenv/config';
import {
  MAX_FREE_OFF_TOPIC_PER_DAY,
  baghdadDayKey,
  baghdadMonthKey,
  estimateUnits,
  hasAiAccess,
  msUntilBaghdadReset,
  normaliseSettings,
  reconcileEnergy,
  releaseEnergy,
  reserveEnergy,
  settleOffTopic,
  unitsFromUsage,
  unitsToUsd,
  usageDocId,
  type SimosanCtx,
} from '../shared/simosan';
import { estimatePageCount, extractCitedPages } from '../shared/simosanChat';

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

const ctx: SimosanCtx = { db, FieldValue: FieldValue as any, Timestamp: Timestamp as any };

const settingsRef = db.collection('app_settings').doc('simosan');
const usageRef = (uid: string) => db.collection('aiUsage').doc(usageDocId(uid, baghdadDayKey()));

async function resetState(uid: string, dailyUnitBudget = 55_000, monthlyCeilingUsd = 50) {
  await settingsRef.set({
    enabled: true,
    model: 'gemini-3.1-flash-lite',
    dailyUnitBudget,
    monthlyCeilingUsd,
    month: baghdadMonthKey(),
    monthUsd: 0,
    alertsSent: [],
  });
  await usageRef(uid).delete().catch(() => {});
}

const read = async (uid: string) => (await usageRef(uid).get()).data() || {};

async function main() {
  console.log('\nSimosan energy accounting\n');

  // -----------------------------------------------------------------------
  console.log('Pure arithmetic');
  // -----------------------------------------------------------------------

  // promptTokenCount includes the cached portion, so the uncached part is the
  // difference. Getting this backwards would double-charge every cache hit.
  check(
    'unitsFromUsage weights cached input at a quarter',
    unitsFromUsage({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 100 })
      === 2_000 + 2_000 + 600,
    String(unitsFromUsage({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 100 })),
  );

  check(
    'unitsFromUsage bills thinking tokens as output',
    unitsFromUsage({ promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 10 }) === 100 + 120,
  );

  check('unitsFromUsage tolerates missing usage', unitsFromUsage(null) === 0);

  // A cache hit must never cost more than a miss, or the incentive inverts.
  const miss = unitsFromUsage({ promptTokenCount: 8_000, candidatesTokenCount: 400 });
  const hit = unitsFromUsage({ promptTokenCount: 8_000, cachedContentTokenCount: 7_740, candidatesTokenCount: 400 });
  check('a cache hit is cheaper than a miss', hit < miss, `${hit} vs ${miss}`);

  // The reservation must not undershoot what a real call of that size costs.
  //
  // These are MEASURED numbers, not modelled ones: a live 66-page lecture billed
  // promptTokenCount 20,635 (of which 20,026 were IMAGE - about 303 tokens/page,
  // not the 258 Google documents). Sizing the reservation off the documented
  // figure cleared actual spend by only 5%, and only because that answer came
  // back short; at the assumed 700-token answer it would have UNDER-reserved.
  // Under-reserving is the one direction that overruns the budget.
  const est = estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 40 });
  const realWorst = unitsFromUsage({ promptTokenCount: 20_635, candidatesTokenCount: 700 });
  check('reservation covers a real measured lecture', est >= realWorst, `${est} vs ${realWorst}`);

  // Guards the constant itself: if someone "corrects" TOKENS_PER_PDF_PAGE back
  // to the documented 258 on the strength of the docs, this fails.
  check(
    'page-token constant matches observed billing',
    estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 0 }) >= 20_026,
    String(estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 0 })),
  );

  check('one unit is a quarter-dollar per million', Math.abs(unitsToUsd(4_000_000) - 1) < 1e-9);

  // Baghdad is UTC+3, so 22:00 UTC is already tomorrow there. A UTC day key
  // would roll over mid-afternoon for every student in the app.
  check(
    'day key is Baghdad-local, not UTC',
    baghdadDayKey(new Date('2026-09-06T22:00:00Z')) === '2026-09-07',
    baghdadDayKey(new Date('2026-09-06T22:00:00Z')),
  );
  check(
    'day key holds before Baghdad midnight',
    baghdadDayKey(new Date('2026-09-06T20:59:00Z')) === '2026-09-06',
  );
  check(
    'reset countdown is under 24h and positive',
    (() => { const ms = msUntilBaghdadReset(new Date('2026-09-06T22:30:00Z')); return ms > 0 && ms <= 864e5; })(),
  );

  // A new month zeroes spend on read, so no cron is needed to roll the budget.
  check(
    'settings roll over when the month changes',
    normaliseSettings({ month: '2026-08', monthUsd: 49.9, alertsSent: [0.5, 0.8] }, new Date('2026-09-06T12:00:00Z')).monthUsd === 0,
  );
  check(
    'rollover also clears the alert log',
    normaliseSettings({ month: '2026-08', alertsSent: [0.5] }, new Date('2026-09-06T12:00:00Z')).alertsSent.length === 0,
  );

  check('admins have access', hasAiAccess({ role: 'admin' }));
  check('expired subscription has no access',
    !hasAiAccess({ isSubscribed: true, subscriptionEnd: new Date('2020-01-01') }));
  check('open-ended subscription has access', hasAiAccess({ isSubscribed: true }));
  check('plain student has no access', !hasAiAccess({ role: 'student' }));

  check('citations are parsed and de-duplicated',
    JSON.stringify(extractCitedPages('a [[p:14]] b [[p:3]] c [[p:14]]')) === '[3,14]');
  check('page estimate never returns zero', estimatePageCount(Buffer.from('not a pdf')) >= 1);

  // -----------------------------------------------------------------------
  console.log('\nReserve / reconcile / release');
  // -----------------------------------------------------------------------

  await resetState('u1');
  const r1 = await reserveEnergy(ctx, { uid: 'u1', stageId: 'stage_3', estimatedUnits: 10_000 });
  check('reserve succeeds within budget', r1.ok && r1.reserved === 10_000);
  check('reserve holds the units', (await read('u1')).unitsReserved === 10_000);
  check('reserve stamps the stage from the server', (await read('u1')).stageId === 'stage_3');

  // Reserving high and settling low must hand the difference back.
  await reconcileEnergy(ctx, { uid: 'u1', reservedUnits: 10_000, actualUnits: 3_000 });
  const afterRec = await read('u1');
  check('reconcile clears the hold', afterRec.unitsReserved === 0);
  check('reconcile charges only what was used', afterRec.unitsUsed === 3_000);
  check('reconcile counts the request', afterRec.requestCount === 1);
  check('reconcile records spend against the ceiling',
    Math.abs(((await settingsRef.get()).data()!.monthUsd) - unitsToUsd(3_000)) < 1e-12);

  await resetState('u2');
  const r2 = await reserveEnergy(ctx, { uid: 'u2', stageId: 's', estimatedUnits: 9_000 });
  await releaseEnergy(ctx, { uid: 'u2', reservedUnits: r2.reserved });
  const afterRel = await read('u2');
  check('release returns the whole hold', afterRel.unitsReserved === 0);
  check('release charges nothing', (afterRel.unitsUsed || 0) === 0);

  // -----------------------------------------------------------------------
  console.log('\nLimits');
  // -----------------------------------------------------------------------

  await resetState('u3', 10_000);
  await reserveEnergy(ctx, { uid: 'u3', stageId: 's', estimatedUnits: 9_000 });
  const denied = await reserveEnergy(ctx, { uid: 'u3', stageId: 's', estimatedUnits: 5_000 });
  check('a request past the daily budget is denied', !denied.ok && denied.reason === 'insufficient_energy');
  check('a denial reserves nothing', denied.reserved === 0);
  check('a denial reports the reset countdown', denied.resetsInMs > 0);

  await resetState('u4');
  await settingsRef.set({ enabled: false }, { merge: true });
  const off = await reserveEnergy(ctx, { uid: 'u4', stageId: 's', estimatedUnits: 10 });
  check('the kill switch denies everyone', !off.ok && off.reason === 'disabled');

  await resetState('u5', 55_000, 1);
  await settingsRef.set({ monthUsd: 1.5 }, { merge: true });
  const ceiling = await reserveEnergy(ctx, { uid: 'u5', stageId: 's', estimatedUnits: 10 });
  check('the monthly ceiling denies everyone', !ceiling.ok && ceiling.reason === 'ceiling_reached');

  // Reaching the ceiling must latch the switch off, not merely block one call.
  await resetState('u6', 55_000, 0.000001);
  await reserveEnergy(ctx, { uid: 'u6', stageId: 's', estimatedUnits: 1_000 });
  await reconcileEnergy(ctx, { uid: 'u6', reservedUnits: 1_000, actualUnits: 1_000 });
  check('crossing the ceiling disables Simosan', (await settingsRef.get()).data()!.enabled === false);

  // -----------------------------------------------------------------------
  console.log('\nConcurrency');
  // -----------------------------------------------------------------------

  // The whole point of reserving inside a transaction. Without it all ten of
  // these read a full bar, all ten pass, and the daily limit means nothing.
  await resetState('u7', 50_000);
  const bursts = await Promise.all(
    Array.from({ length: 10 }, () =>
      reserveEnergy(ctx, { uid: 'u7', stageId: 's', estimatedUnits: 10_000 })
        .catch(() => ({ ok: false, reserved: 0 } as any)),
    ),
  );
  const granted = bursts.filter((b) => b.ok).length;
  const held = (await read('u7')).unitsReserved;
  check('ten parallel requests cannot overdraw', held <= 50_000, `held ${held}`);
  check('exactly the affordable number are granted', granted === 5, `granted ${granted}`);

  // -----------------------------------------------------------------------
  console.log('\nOff-topic refunds');
  // -----------------------------------------------------------------------

  await resetState('u8');
  await reserveEnergy(ctx, { uid: 'u8', stageId: 's', estimatedUnits: 8_000 });
  const ot = await settleOffTopic(ctx, { uid: 'u8', reservedUnits: 8_000, actualUnits: 8_000 });
  check('a refused question is refunded', ot.refunded);
  check('a refund leaves the bar untouched', (await read('u8')).unitsUsed === 0);
  // The call still happened, so the money is still tracked globally.
  check('a refund still records real spend',
    ((await settingsRef.get()).data()!.monthUsd) > 0);

  // Past the cap the refund stops, or the refund is an infinite-spend hole.
  await resetState('u9');
  await usageRef('u9').set({ uid: 'u9', day: baghdadDayKey(), offTopicCount: MAX_FREE_OFF_TOPIC_PER_DAY });
  await reserveEnergy(ctx, { uid: 'u9', stageId: 's', estimatedUnits: 8_000 });
  const ot2 = await settleOffTopic(ctx, { uid: 'u9', reservedUnits: 8_000, actualUnits: 8_000 });
  check('refunds stop after the daily cap', !ot2.refunded);
  check('a capped refusal is charged', (await read('u9')).unitsUsed === 8_000);

  // -----------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
