/**
 * Verifies what إدارة الاشتراكات actually counts.
 *
 * Run with:  npm run test:subscriptions
 *
 * Pure functions only - no Firestore. One invariant is the point of this file,
 * and it was the bug:
 *
 *   إجمالي المشتركين COUNTS PEOPLE, NOT ROWS. It was `subscriptions.length`,
 *   so a student who abandoned two ZainCash attempts before paying was three
 *   subscribers, and a rejected Super Qi request was one. A dashboard that
 *   inflates with every failed attempt cannot be used to decide anything.
 *
 * The second invariant is quieter but easier to reintroduce: the breakdown
 * panels do not share a denominator with the cards. byPlan counts PEOPLE and
 * must sum to المشتركون الفعالون; byPayment counts TRANSACTIONS because it sits
 * next to a revenue figure. Mixing them is what let توزيع المشتركين exceed its
 * own total.
 */
import { PLAN_CONFIG, planAnchorPrice, type Subscription, type SubscriptionPlan } from '../src/types';
import { PLAN_CONFIG as SERVER_PLAN_CONFIG } from '../shared/subscriptions';
import {
  computeSubscriptionStats,
  distinctUsers,
  isRealSubscription,
  needsManualApproval,
} from '../src/lib/subscriptionStats';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail !== '' ? ' -> ' + String(detail) : ''}`); failed++; }
};

/** Firestore hands these back as Timestamps; only toMillis is ever read. */
const ts = (iso: string) => ({ toMillis: () => Date.parse(iso) });

let seq = 0;
const sub = (over: Partial<Subscription>): Subscription => ({
  id: `sub_${++seq}`,
  userId: 'u1',
  userEmail: 'u1@student.alsafwa.edu.iq',
  plan: 'monthly',
  status: 'active',
  startDate: ts('2026-01-01'),
  endDate: ts('2026-02-01'),
  paymentMethod: 'zaincash',
  amount: 1000,
  createdAt: ts('2026-01-01'),
  ...over,
} as Subscription);

console.log('Which rows are a real subscription:');
check('active counts', isRealSubscription({ status: 'active' } as Subscription));
check('inactive counts - it is an expired or superseded real one',
  isRealSubscription({ status: 'inactive' } as Subscription));
check('pending does not - nobody has confirmed the money',
  !isRealSubscription({ status: 'pending' } as Subscription));
check('cancelled does not - failed, refunded or rejected',
  !isRealSubscription({ status: 'cancelled' } as Subscription));

console.log('\nWhich rows are somebody\'s queue item:');
check('a pending Super Qi request is',
  needsManualApproval({ status: 'pending', paymentMethod: 'superkey' } as Subscription));
check('a pending ZainCash payment is NOT - it settles against the Inquiry API',
  !needsManualApproval({ status: 'pending', paymentMethod: 'zaincash' } as Subscription));
check('a cancelled Super Qi request is not',
  !needsManualApproval({ status: 'cancelled', paymentMethod: 'superkey' } as Subscription));

console.log('\nDistinct users:');
check('the same student twice is one person',
  distinctUsers([{ userId: 'u1' }, { userId: 'u1' }]) === 1);
check('an empty userId is not a person',
  distinctUsers([{ userId: 'u1' }, { userId: '' }]) === 1);

// The reported dashboard, reconstructed. One student who tried ZainCash three
// times before it worked, one whose Super Qi request was rejected, one who was
// granted a subscription, and one whose paid month has since expired.
console.log('\nThe reported dashboard (8 rows, 4 students):');
const ledger: Subscription[] = [
  // u1 - two failed ZainCash attempts, then a paid one.
  sub({ userId: 'u1', status: 'cancelled', amount: 1000 }),
  sub({ userId: 'u1', status: 'cancelled', amount: 1000 }),
  sub({ userId: 'u1', status: 'active', amount: 1000 }),
  // u2 - a rejected Super Qi request, and an abandoned ZainCash attempt still
  // sitting as pending.
  sub({ userId: 'u2', status: 'cancelled', paymentMethod: 'superkey', amount: 3000 }),
  sub({ userId: 'u2', status: 'pending', paymentMethod: 'zaincash', amount: 3000 }),
  // u3 - a free grant, which carries no money.
  sub({ userId: 'u3', status: 'active', paymentMethod: 'admin_grant', plan: 'seasonal', amount: 0 }),
  // u4 - paid last term, expired since.
  sub({ userId: 'u4', status: 'inactive', paymentMethod: 'superkey', plan: 'semi_annual', amount: 5000 }),
  // u5 - a Super Qi request waiting on a human right now.
  sub({ userId: 'u5', status: 'pending', paymentMethod: 'superkey', amount: 1000 }),
];
const s = computeSubscriptionStats(ledger);

check('إجمالي المشتركين counts students, not rows (was 8)',
  s.totalSubscribers === 3, s.totalSubscribers);
check('a student who failed three times before paying counts once',
  computeSubscriptionStats(ledger.filter(r => r.userId === 'u1')).totalSubscribers === 1);
check('a student whose only rows are a rejection and an abandoned attempt does not count',
  computeSubscriptionStats(ledger.filter(r => r.userId === 'u2')).totalSubscribers === 0);
check('a منحة إدارية student counts - they are a subscriber, just not a payer',
  computeSubscriptionStats(ledger.filter(r => r.userId === 'u3')).totalSubscribers === 1);
check('an expired subscriber still counts toward the lifetime total',
  computeSubscriptionStats(ledger.filter(r => r.userId === 'u4')).totalSubscribers === 1);

check('المشتركون الفعالون counts live students', s.activeSubscribers === 2, s.activeSubscribers);
check('مدفوعات معلقة counts only what a human must act on', s.pendingApprovals === 1, s.pendingApprovals);
check('إجمالي الإيرادات ignores pending and cancelled rows',
  s.totalRevenue === 1000 + 0 + 5000, s.totalRevenue);

console.log('\nBreakdowns:');
check('توزيع المشتركين sums to المشتركون الفعالون',
  s.byPlan.monthly + s.byPlan.seasonal + s.byPlan.semi_annual === s.activeSubscribers,
  JSON.stringify(s.byPlan));
check('a cancelled منحة إدارية is not counted - it used to be, unfiltered',
  computeSubscriptionStats([
    sub({ userId: 'u9', status: 'cancelled', paymentMethod: 'admin_grant', amount: 0 }),
  ]).byPayment.admin_grant.count === 0);
check('byPayment counts transactions, so two payments by one student are two',
  computeSubscriptionStats([
    sub({ userId: 'u1', status: 'inactive', paymentMethod: 'superkey', amount: 1000 }),
    sub({ userId: 'u1', status: 'active', paymentMethod: 'superkey', amount: 1000 }),
  ]).byPayment.superkey.count === 2);

// activateSubscription only supersedes existingSubs.docs[0], so a user who
// somehow holds two active rows is a real shape, not a hypothetical.
console.log('\nOne student holding two active rows:');
const doubled = computeSubscriptionStats([
  sub({ userId: 'u1', status: 'active', plan: 'monthly', startDate: ts('2026-01-01') }),
  sub({ userId: 'u1', status: 'active', plan: 'seasonal', startDate: ts('2026-03-01') }),
]);
check('counts as one active subscriber', doubled.activeSubscribers === 1, doubled.activeSubscribers);
check('is filed under the newer plan only',
  doubled.byPlan.seasonal === 1 && doubled.byPlan.monthly === 0, JSON.stringify(doubled.byPlan));
check('and توزيع المشتركين still sums to the total',
  doubled.byPlan.monthly + doubled.byPlan.seasonal + doubled.byPlan.semi_annual +
  doubled.byPlan.annual === 1);

console.log('\nEmpty ledger:');
const empty = computeSubscriptionStats([]);
check('every card reads zero rather than NaN',
  empty.totalSubscribers === 0 && empty.activeSubscribers === 0 &&
  empty.pendingApprovals === 0 && empty.totalRevenue === 0 &&
  empty.byPayment.zaincash.count === 0 && empty.byPlan.monthly === 0);

/*
 * The plan ladder.
 *
 * The two PLAN_CONFIG tables are the whole reason this block exists. The server
 * one is what the gateway amount is validated against - shared/subscriptions.ts
 * cancels the row when paid !== expected - and the client one is what the card
 * advertises. Let them drift and every purchase of the drifted plan dies as an
 * amount_mismatch AFTER the student has already paid.
 */
console.log('\nThe plan ladder:');
const PLANS = Object.keys(PLAN_CONFIG) as SubscriptionPlan[];

check('client and server tables hold the same plans',
  PLANS.length === Object.keys(SERVER_PLAN_CONFIG).length &&
  PLANS.every(p => SERVER_PLAN_CONFIG[p] !== undefined), PLANS.join(','));

check('and agree on every price and duration',
  PLANS.every(p => SERVER_PLAN_CONFIG[p].price === PLAN_CONFIG[p].price &&
                   SERVER_PLAN_CONFIG[p].days === PLAN_CONFIG[p].days));

check('prices are 2000 / 5000 / 9000 / 12000',
  PLAN_CONFIG.monthly.price === 2000 && PLAN_CONFIG.seasonal.price === 5000 &&
  PLAN_CONFIG.semi_annual.price === 9000 && PLAN_CONFIG.annual.price === 12000);

// A month is 30 days here, not a calendar month. That is what keeps the anchor
// exact - 360 gives 24,000 and a clean 1,000/month, where 365 gives 24,333.
check('a month is 30 days, so the ladder is 30/90/180/360',
  PLAN_CONFIG.monthly.days === 30 && PLAN_CONFIG.seasonal.days === 90 &&
  PLAN_CONFIG.semi_annual.days === 180 && PLAN_CONFIG.annual.days === 360);

check('the anchor is the term priced at the monthly rate',
  planAnchorPrice('seasonal') === 6000 && planAnchorPrice('semi_annual') === 12000 &&
  planAnchorPrice('annual') === 24000);

// Striking it on the monthly card would cross out the price itself.
check('the monthly card has no anchor to strike',
  planAnchorPrice('monthly') === PLAN_CONFIG.monthly.price);

// Every longer plan must really be a discount, or the struck-through figure is
// advertising an increase.
check('every longer plan beats the monthly rate',
  PLANS.filter(p => p !== 'monthly').every(p => planAnchorPrice(p) > PLAN_CONFIG[p].price));

// bestValue is pinned to annual in both purchase surfaces; this is that claim.
const perMonthOf = (p: SubscriptionPlan) => PLAN_CONFIG[p].price / (PLAN_CONFIG[p].days / 30);
check('annual is the cheapest per month',
  PLANS.every(p => perMonthOf('annual') <= perMonthOf(p)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
