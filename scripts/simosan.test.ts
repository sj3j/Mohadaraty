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
  COOLDOWN_DURATION_MS,
  COOLDOWN_UNIT_THRESHOLD,
  DEFAULT_MODEL,
  DEFAULT_WEEKLY_UNIT_BUDGET,
  MAX_FREE_OFF_TOPIC_PER_DAY,
  USD_PER_UNIT,
  baghdadDayKey,
  baghdadMonthKey,
  baghdadWeekKey,
  estimateUnits,
  hasAiAccess,
  msUntilBaghdadReset,
  msUntilBaghdadWeeklyReset,
  normaliseSettings,
  reconcileEnergy,
  recordSpendAndCheckCeiling,
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
const usageRef = (uid: string) => db.collection('aiUsage').doc(usageDocId(uid, baghdadWeekKey()));

async function resetState(uid: string, weeklyUnitBudget = 133_333, monthlyCeilingUsd = 50) {
  await settingsRef.set({
    enabled: true,
    model: 'gemini-3.5-flash',
    weeklyUnitBudget,
    dailyUnitBudget: weeklyUnitBudget,
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
  // difference. gemini-3.5-flash: cached input is $0.15/1M vs uncached $1.50/1M (weight 0.10)
  check(
    'unitsFromUsage weights cached input at a tenth (0.10)',
    unitsFromUsage({ promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 100 })
      === 2_000 + 800 + 600,
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
  const est = estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 40 });
  const realWorst = unitsFromUsage({ promptTokenCount: 20_635, candidatesTokenCount: 700 });
  check('reservation covers a real measured lecture', est >= realWorst, `${est} vs ${realWorst}`);

  check(
    'page-token constant matches observed billing',
    estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 0 }) >= 20_026,
    String(estimateUnits({ pageCount: 66, historyChars: 0, questionChars: 0 })),
  );

  check('one unit is $1.50 per million', Math.abs(unitsToUsd(1_000_000) - 1.50) < 1e-9);
  check('weekly budget equals $0.20 USD divided by unit price', DEFAULT_WEEKLY_UNIT_BUDGET === 133_333);
  check('default model is gemini-3.5-flash', DEFAULT_MODEL === 'gemini-3.5-flash');

  // Baghdad is UTC+3, so 22:00 UTC is already tomorrow there.
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
    'weekly reset countdown is under 7 days and positive',
    (() => { const ms = msUntilBaghdadWeeklyReset(new Date('2026-09-06T22:30:00Z')); return ms > 0 && ms <= 7 * 864e5; })(),
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

  check('a multi-page citation marker yields every page',
    JSON.stringify(extractCitedPages('x [[p:7, 8]] y [[p: 3 ]]')) === '[3,7,8]',
    JSON.stringify(extractCitedPages('x [[p:7, 8]] y [[p: 3 ]]')));
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
  check('a request past the weekly budget is denied', !denied.ok && denied.reason === 'insufficient_energy');
  check('a denial reserves nothing', denied.reserved === 0);
  check('a denial reports the weekly reset countdown', denied.resetsInMs > 0);

  await resetState('u4');
  await settingsRef.set({ enabled: false }, { merge: true });
  const off = await reserveEnergy(ctx, { uid: 'u4', stageId: 's', estimatedUnits: 10 });
  check('the kill switch denies everyone', !off.ok && off.reason === 'disabled');

  await resetState('u5', 133_333, 1);
  await settingsRef.set({ monthUsd: 1.5 }, { merge: true });
  const ceiling = await reserveEnergy(ctx, { uid: 'u5', stageId: 's', estimatedUnits: 10 });
  check('the monthly ceiling denies everyone', !ceiling.ok && ceiling.reason === 'ceiling_reached');

  // Reaching the ceiling must latch the switch off, not merely block one call.
  await resetState('u6', 133_333, 0.000001);
  await reserveEnergy(ctx, { uid: 'u6', stageId: 's', estimatedUnits: 1_000 });
  await reconcileEnergy(ctx, { uid: 'u6', reservedUnits: 1_000, actualUnits: 1_000 });
  check('crossing the ceiling disables Simosan', (await settingsRef.get()).data()!.enabled === false);

  // -----------------------------------------------------------------------
  console.log('\nConcurrency');
  // -----------------------------------------------------------------------

  // Reserving inside a transaction bounds concurrency:
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
  console.log('\n2-hour rapid usage cooldown');
  // -----------------------------------------------------------------------
  await resetState('u_cd');
  // First request: 35,000 units within budget and below 60,000 threshold
  const cd1 = await reserveEnergy(ctx, { uid: 'u_cd', stageId: 's', estimatedUnits: 35_000 });
  check('initial reserve below threshold succeeds', cd1.ok);
  await reconcileEnergy(ctx, { uid: 'u_cd', reservedUnits: 35_000, actualUnits: 35_000 });

  // Second request in short period: pushing total past 60,000 threshold triggers cooldown
  const cd2 = await reserveEnergy(ctx, { uid: 'u_cd', stageId: 's', estimatedUnits: 30_000 });
  check('exceeding token threshold in short window triggers cooldown', !cd2.ok && cd2.reason === 'cooldown_active');
  check('cooldown reset reports ~2 hours', cd2.resetsInMs > 0 && cd2.resetsInMs <= 2 * 60 * 60 * 1000);

  // Third request while cooldown active is rejected
  const cd3 = await reserveEnergy(ctx, { uid: 'u_cd', stageId: 's', estimatedUnits: 500 });
  check('subsequent request during cooldown is denied with cooldown_active', !cd3.ok && cd3.reason === 'cooldown_active');

  // Request after 2 hours passes
  const twoHoursLater = new Date(Date.now() + 2 * 60 * 60 * 1000 + 5000);
  const cd4 = await reserveEnergy(ctx, { uid: 'u_cd', stageId: 's', estimatedUnits: 1_000 }, twoHoursLater);
  check('request after 2-hour cooldown window passes succeeds', cd4.ok);

  // Single large lecture test: 65,000 units on first request (> 60k threshold, but within weekly budget)
  await resetState('u_large');
  const large1 = await reserveEnergy(ctx, { uid: 'u_large', stageId: 's', estimatedUnits: 65_000 });
  check('single large request within budget succeeds without premature cooldown', large1.ok);
  await reconcileEnergy(ctx, { uid: 'u_large', reservedUnits: 65_000, actualUnits: 65_000 });
  const large2 = await reserveEnergy(ctx, { uid: 'u_large', stageId: 's', estimatedUnits: 1_000 });
  check('large usage activates 2-hour cooldown after completion', !large2.ok && large2.reason === 'cooldown_active');

  // Saturday rollover cooldown carryover test:
  // Triggered Friday 23:50 Baghdad time (2026-10-02T20:50:00Z), checked Saturday 00:05 Baghdad time (2026-10-02T21:05:00Z)
  await resetState('u_roll');
  const fridayNight = new Date('2026-10-02T20:50:00Z');
  const satMorning = new Date('2026-10-02T21:05:00Z');
  await reserveEnergy(ctx, { uid: 'u_roll', stageId: 's', estimatedUnits: 35_000 }, fridayNight);
  await reconcileEnergy(ctx, { uid: 'u_roll', reservedUnits: 35_000, actualUnits: 35_000 }, fridayNight);
  const rollCd = await reserveEnergy(ctx, { uid: 'u_roll', stageId: 's', estimatedUnits: 30_000 }, fridayNight);
  check('Friday night burst triggers cooldown', !rollCd.ok && rollCd.reason === 'cooldown_active');

  const satReq = await reserveEnergy(ctx, { uid: 'u_roll', stageId: 's', estimatedUnits: 500 }, satMorning);
  check('Friday night cooldown carries over across Saturday midnight rollover', !satReq.ok && satReq.reason === 'cooldown_active');
  check('Saturday morning cooldown remaining is ~105 minutes', satReq.resetsInMs > 100 * 60 * 1000 && satReq.resetsInMs <= 110 * 60 * 1000);

  const satExpire = new Date('2026-10-02T23:05:00Z'); // Saturday 02:05 Baghdad time
  const satAfter = await reserveEnergy(ctx, { uid: 'u_roll', stageId: 's', estimatedUnits: 500 }, satExpire);
  check('request passes once Saturday morning rollover cooldown expires', satAfter.ok);

  // Rollover burst window carryover test:
  // User used 50,000 units on Friday at 23:56 (not in cooldown, threshold is 60k).
  // At Saturday 00:02 (6 min later, within 10-min window), user asks for 20,000 units.
  // Cooldown MUST trigger (50k + 20k = 70k >= 60k).
  await resetState('u_roll_burst');
  const friTime = new Date('2026-10-02T20:56:00Z'); // 23:56 Baghdad
  const satTime = new Date('2026-10-02T21:02:00Z'); // 00:02 Baghdad
  await reserveEnergy(ctx, { uid: 'u_roll_burst', stageId: 's', estimatedUnits: 50_000 }, friTime);
  await reconcileEnergy(ctx, { uid: 'u_roll_burst', reservedUnits: 50_000, actualUnits: 50_000 }, friTime);
  const rollBurstReq = await reserveEnergy(ctx, { uid: 'u_roll_burst', stageId: 's', estimatedUnits: 20_000 }, satTime);
  check('rapid burst across Saturday midnight triggers burst cooldown via carried window', !rollBurstReq.ok && rollBurstReq.reason === 'cooldown_active');

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
  await usageRef('u9').set({ uid: 'u9', week: baghdadWeekKey(), day: baghdadWeekKey(), offTopicCount: MAX_FREE_OFF_TOPIC_PER_DAY });
  await reserveEnergy(ctx, { uid: 'u9', stageId: 's', estimatedUnits: 8_000 });
  const ot2 = await settleOffTopic(ctx, { uid: 'u9', reservedUnits: 8_000, actualUnits: 8_000 });
  check('refunds stop after the daily cap', !ot2.refunded);
  check('a capped refusal is charged', (await read('u9')).unitsUsed === 8_000);

  // settleOffTopic clears stale expired cooldownUntil
  await resetState('u_ot_cd');
  await usageRef('u_ot_cd').set({
    uid: 'u_ot_cd',
    week: baghdadWeekKey(),
    day: baghdadWeekKey(),
    unitsUsed: 10_000,
    unitsReserved: 5_000,
    cooldownUntil: Date.now() - 3600_000, // expired 1 hour ago
    offTopicCount: 0,
  });
  await settleOffTopic(ctx, { uid: 'u_ot_cd', reservedUnits: 5_000, actualUnits: 5_000 });
  const otCdRead = await read('u_ot_cd');
  check('settleOffTopic clears expired cooldown timestamp to null', otCdRead.cooldownUntil === null);

  // -----------------------------------------------------------------------
  console.log('\nCross-Saturday midnight rollover reconciliation');
  // -----------------------------------------------------------------------
  await resetState('u_cross_midnight');
  const friNightTime = new Date('2026-10-02T20:59:50Z'); // 23:59:50 Baghdad
  const satMornTime = new Date('2026-10-02T21:00:15Z'); // 00:00:15 Baghdad (new week!)
  const friWeek = baghdadWeekKey(friNightTime);
  const satWeek = baghdadWeekKey(satMornTime);
  check('Friday and Saturday belong to different academic weeks', friWeek !== satWeek);

  const crossReserve = await reserveEnergy(ctx, { uid: 'u_cross_midnight', stageId: 's', estimatedUnits: 15_000 }, friNightTime);
  check('cross-midnight reserve returns week', crossReserve.week === friWeek);

  // Reconcile on Saturday morning passing the reserved week
  await reconcileEnergy(ctx, { uid: 'u_cross_midnight', reservedUnits: 15_000, actualUnits: 12_000, week: crossReserve.week }, satMornTime);

  const friDoc = (await db.collection('aiUsage').doc(usageDocId('u_cross_midnight', friWeek)).get()).data()!;
  check('Friday document hold is cleared (unitsReserved === 0)', friDoc.unitsReserved === 0);
  check('Friday document records actual usage (unitsUsed === 12000)', friDoc.unitsUsed === 12_000);

  const satSnap = await db.collection('aiUsage').doc(usageDocId('u_cross_midnight', satWeek)).get();
  check('Saturday new week document is untouched', !satSnap.exists);

  // Cross-Saturday release on aborted request
  await resetState('u_cross_abort');
  const abortReserve = await reserveEnergy(ctx, { uid: 'u_cross_abort', stageId: 's', estimatedUnits: 8_000 }, friNightTime);
  await releaseEnergy(ctx, { uid: 'u_cross_abort', reservedUnits: 8_000, week: abortReserve.week }, satMornTime);
  const friAbortDoc = (await db.collection('aiUsage').doc(usageDocId('u_cross_abort', friWeek)).get()).data()!;
  check('Friday document hold is completely released after abort on Saturday', friAbortDoc.unitsReserved === 0 && (friAbortDoc.unitsUsed || 0) === 0);

  // -----------------------------------------------------------------------
  console.log('\nMonthly spend & ceiling enforcement');
  // -----------------------------------------------------------------------
  await resetState('u_ceiling', 133_333, 10);
  const ceilingRes = await recordSpendAndCheckCeiling(ctx, 70_000_000); // ~$105 USD spend
  check('recordSpendAndCheckCeiling trips kill switch when ceiling is crossed', ceilingRes.enabled === false);
  const reReadSettings = (await settingsRef.get()).data()!;
  check('settings document is disabled in Firestore', reReadSettings.enabled === false);

  // Verify recordSpendAndCheckCeiling clears alertsSent in Firestore on month rollover
  await settingsRef.set({
    month: '2026-09',
    monthUsd: 45,
    alertsSent: [0.5, 0.8],
    enabled: true,
    monthlyCeilingUsd: 50,
  }, { merge: true });
  await recordSpendAndCheckCeiling(ctx, 1_000, new Date('2026-10-01T12:00:00Z'));
  const octSettings = (await settingsRef.get()).data()!;
  check('recordSpendAndCheckCeiling clears alertsSent in Firestore document on month rollover', Array.isArray(octSettings.alertsSent) && octSettings.alertsSent.length === 0);

  // -----------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
