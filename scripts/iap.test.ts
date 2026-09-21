/**
 * Apple IAP entitlement, against the Firestore emulator.
 *
 * Run with:  npm run test:iap
 *
 * The pure half (product map, event actions) needs no emulator and is asserted
 * first. The half that matters most does: applyAppleEntitlement writes into the
 * same `subscriptions` collection and the same users/{uid} access cache that
 * the ZainCash rail uses, and the guarantee worth pinning is that the two
 * cannot shorten each other.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import 'dotenv/config';
import {
  actionForEvent,
  applyAppleEntitlement,
  appleSubscriptionId,
  planForProduct,
  readSubscriberEntitlement,
  recomputeUserAccess,
  PRODUCT_PLAN_MAP,
} from '../shared/iap';
import { rcAppUserIdFor } from '../shared/iapApi';
import { hasLiveSubscription } from '../shared/subscriptionAccess';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}

/**
 * Credentials are OPTIONAL here, unlike the older emulator suites in this
 * folder. FIRESTORE_EMULATOR_HOST makes the Admin SDK talk to the emulator and
 * skip token minting entirely, so requiring a real service account only means
 * this suite cannot run in CI or on a fresh clone - which is where it is most
 * worth running. The service account is still used when it is present, so a
 * developer's existing .env keeps behaving the same way.
 */
const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
const projectId = FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'mylectures-rules-test';
initializeApp(
  FIREBASE_PRIVATE_KEY && FIREBASE_CLIENT_EMAIL
    ? {
        credential: cert({
          projectId,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        projectId,
      }
    : { projectId },
);
const db = getFirestore();
const ctx = { db, FieldValue, Timestamp } as any;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const DAY = 24 * 60 * 60 * 1000;
const future = (days: number) => Date.now() + days * DAY;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------
console.log('\n--- product map ---');
check('all four App Store Connect products map',
  planForProduct('com.mohadaraty.app.1month') === 'monthly' &&
  planForProduct('com.mohadaraty.app.3months') === 'seasonal' &&
  planForProduct('com.mohadaraty.app.6months') === 'semi_annual' &&
  planForProduct('com.mohadaraty.app.1year') === 'annual');
check('the map holds exactly the four live products', Object.keys(PRODUCT_PLAN_MAP).length === 4);
check('an unknown product is null, not a guess', planForProduct('com.mohadaraty.app.lifetime') === null);
check('null/undefined do not throw', planForProduct(null) === null && planForProduct(undefined) === null);

console.log('\n--- event actions ---');
check('a purchase grants', actionForEvent('INITIAL_PURCHASE') === 'grant');
check('a renewal grants', actionForEvent('RENEWAL') === 'grant');
// The one that costs money to get wrong: Apple's CANCELLATION means auto-renew
// was turned off, not that access ends now.
check('CANCELLATION is a grant, not a revoke', actionForEvent('CANCELLATION') === 'grant');
check('EXPIRATION revokes', actionForEvent('EXPIRATION') === 'revoke');
// Apple retries a failed charge for up to 60 days with access intact.
check('BILLING_ISSUE is ignored, not a revoke', actionForEvent('BILLING_ISSUE') === 'ignore');
check('the dashboard TEST ping is ignored', actionForEvent('TEST') === 'ignore');
check('an unknown event type is ignored', actionForEvent('SOMETHING_NEW') === 'ignore');

console.log('\n--- subscriber payload ---');
const iso = (ms: number) => new Date(ms).toISOString();
check('reads the configured entitlement', (() => {
  const r = readSubscriberEntitlement(
    { entitlements: { premium: { expires_date: iso(future(10)), product_identifier: 'com.mohadaraty.app.1month' } } },
    'premium');
  return r?.active === true && r?.productId === 'com.mohadaraty.app.1month';
})());
check('falls back to any entitlement when the name differs', (() => {
  const r = readSubscriberEntitlement(
    { entitlements: { pro: { expires_date: iso(future(5)), product_identifier: 'com.mohadaraty.app.1year' } } },
    'premium');
  return r?.active === true;
})());
check('a past expiry is not active', (() => {
  const r = readSubscriberEntitlement(
    { entitlements: { premium: { expires_date: iso(Date.now() - DAY), product_identifier: 'x' } } }, 'premium');
  return r?.active === false;
})());
check('no entitlements at all is null', readSubscriberEntitlement({ entitlements: {} }, 'premium') === null);

console.log('\n--- app user id ---');
check('is a sha256 hex digest, not the uid',
  /^[0-9a-f]{64}$/.test(rcAppUserIdFor('ph2023099@student.alsafwa.edu.iq')));
check('does not contain the email it was derived from',
  !rcAppUserIdFor('ph2023099@student.alsafwa.edu.iq').includes('alsafwa'));
check('is deterministic', rcAppUserIdFor('abc') === rcAppUserIdFor('abc'));
check('differs per uid', rcAppUserIdFor('abc') !== rcAppUserIdFor('abd'));

// ---------------------------------------------------------------------------
// Emulator
// ---------------------------------------------------------------------------
async function reset(uid: string) {
  const rc = rcAppUserIdFor(uid);
  await db.collection('users').doc(uid).set({ email: `${uid}@x.test`, name: uid, isSubscribed: false });
  await db.collection('rcLinks').doc(rc).set({ uid });
  for (const c of ['iapEvents', 'subscriptions']) {
    const snap = await db.collection(c).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
  return rc;
}

const ent = (rc: string, over: any = {}) => ({
  rcAppUserId: rc,
  productId: 'com.mohadaraty.app.1month',
  expiresAtMs: future(30),
  eventId: 'evt_1',
  store: 'APP_STORE',
  ...over,
});

async function main() {
  console.log('\n--- applying an entitlement ---');
  let uid = 'iap_basic';
  let rc = await reset(uid);

  check('a purchase grants access',
    (await applyAppleEntitlement(ctx, ent(rc), { action: 'grant' })) === 'granted');
  let user = (await db.collection('users').doc(uid).get()).data()!;
  check('users/{uid} reads as subscribed', hasLiveSubscription(user));
  check('the plan is read from the product id', user.subscriptionPlan === 'monthly');
  let row = (await db.collection('subscriptions').doc(appleSubscriptionId(rc)).get()).data()!;
  check('the row is paymentMethod apple_iap', row.paymentMethod === 'apple_iap');
  check('the row carries amount 0, not a made-up IQD figure', row.amount === 0);
  check('the row is owned by the right uid', row.userId === uid);

  console.log('\n--- idempotency ---');
  check('the same event id a second time is a no-op',
    (await applyAppleEntitlement(ctx, ent(rc), { action: 'grant' })) === 'already_applied');
  check('and leaves exactly one subscription row',
    (await db.collection('subscriptions').get()).size === 1);

  console.log('\n--- renewal ---');
  const newEnd = future(60);
  await applyAppleEntitlement(ctx, ent(rc, { eventId: 'evt_2', expiresAtMs: newEnd }), { action: 'grant' });
  check('still one row - a renewal is not a new subscription',
    (await db.collection('subscriptions').get()).size === 1);
  row = (await db.collection('subscriptions').doc(appleSubscriptionId(rc)).get()).data()!;
  // The bug this pins: activateSubscription would have ADDED 30 more days to an
  // expiry Apple already owns.
  check('endDate MOVES to Apple\'s date rather than stacking onto it',
    Math.abs(row.endDate.toDate().getTime() - newEnd) < 2000,
    `${row.endDate.toDate().toISOString()} vs ${new Date(newEnd).toISOString()}`);

  console.log('\n--- expiry and refund ---');
  await applyAppleEntitlement(ctx, ent(rc, { eventId: 'evt_3' }), { action: 'revoke' });
  user = (await db.collection('users').doc(uid).get()).data()!;
  check('EXPIRATION removes access', !hasLiveSubscription(user));
  // A refund arrives as CANCELLATION with a past expiry; the same
  // grant-to-stored-expiry rule has to revoke it with no special case.
  await applyAppleEntitlement(
    ctx, ent(rc, { eventId: 'evt_4', expiresAtMs: Date.now() - DAY }),
    { action: actionForEvent('CANCELLATION') });
  user = (await db.collection('users').doc(uid).get()).data()!;
  check('a refund (CANCELLATION with a past expiry) revokes', !hasLiveSubscription(user));

  console.log('\n--- an unmapped product ---');
  uid = 'iap_unmapped'; rc = await reset(uid);
  let alerted = '';
  const outcome = await applyAppleEntitlement(
    ctx, ent(rc, { productId: 'com.mohadaraty.app.lifetime' }),
    { action: 'grant', alert: async (reason) => { alerted = reason; } });
  user = (await db.collection('users').doc(uid).get()).data()!;
  check('access still granted - it fails OPEN', outcome === 'granted' && hasLiveSubscription(user));
  check('and it alerts, so the map gets fixed', alerted === 'unmapped_product');
  row = (await db.collection('subscriptions').doc(appleSubscriptionId(rc)).get()).data()!;
  check('the row names the product it could not map', String(row.notes || '').includes('lifetime'));

  console.log('\n--- coexistence with the web rail ---');
  uid = 'iap_both'; rc = await reset(uid);
  // A live ZainCash subscription running well past what Apple will grant.
  const zainEnd = future(200);
  await db.collection('subscriptions').add({
    userId: uid, plan: 'annual', status: 'active', paymentMethod: 'zaincash',
    amount: 12000, endDate: Timestamp.fromDate(new Date(zainEnd)),
    startDate: Timestamp.now(), createdAt: Timestamp.now(),
  });
  await recomputeUserAccess(ctx, uid);
  await applyAppleEntitlement(ctx, ent(rc, { expiresAtMs: future(30) }), { action: 'grant' });
  user = (await db.collection('users').doc(uid).get()).data()!;
  check('a shorter Apple purchase does NOT shorten a live ZainCash subscription',
    Math.abs(user.subscriptionEnd.toDate().getTime() - zainEnd) < 2000,
    user.subscriptionEnd.toDate().toISOString());
  // And the reverse: Apple expiring must not revoke access the other rail still
  // grants. This is the case functions/index.js's blanket clear gets wrong.
  await applyAppleEntitlement(ctx, ent(rc, { eventId: 'evt_x' }), { action: 'revoke' });
  user = (await db.collection('users').doc(uid).get()).data()!;
  check('Apple expiring leaves the ZainCash subscription intact',
    hasLiveSubscription(user) &&
    Math.abs(user.subscriptionEnd.toDate().getTime() - zainEnd) < 2000);

  console.log('\n--- an unknown app_user_id ---');
  check('a payment we cannot attribute is reported, not applied',
    (await applyAppleEntitlement(ctx, ent('deadbeef'), { action: 'grant' })) === 'unknown_user');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
