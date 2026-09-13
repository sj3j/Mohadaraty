import type { PaymentMethod, Subscription, SubscriptionPlan } from '../types';

/**
 * The numbers behind إدارة الاشتراكات.
 *
 * Pure on purpose - no React, no Firestore - so `npm run test:subscriptions`
 * can pin them. Imported only by SubscriptionManagement.tsx, which
 * vite.config.ts stubs for `mode === 'native'`, so this module leaves the
 * native graph with it (the same arrangement as src/lib/paymentContact.ts).
 *
 * The cards used to be a straight `subscriptions.length`, which counted
 * DOCUMENTS: a student who abandoned two ZainCash attempts before paying was
 * three subscribers, and a rejected Super Qi request was one. Two denominators
 * are in play here and they are deliberately different - say which one you mean
 * before changing any of this:
 *
 *   PEOPLE       - totalSubscribers, activeSubscribers, byPlan. Distinct userId.
 *   TRANSACTIONS - totalRevenue, byPayment. One row is one payment, and the
 *                  count sits next to a revenue figure, so rows are right.
 */

/**
 * A row that represents a subscription the student actually got.
 *
 * 'inactive' is not a failure state. It is written when a subscription expires
 * (functions/index.js, expireSubscriptions) and when one is superseded by an
 * early renewal (shared/subscriptions.ts, activateSubscription), so it is the
 * tail of a real subscription and belongs in every lifetime total. 'pending' is
 * an attempt nobody has paid for yet; 'cancelled' is one that failed, was
 * refunded, or was rejected.
 */
export const isRealSubscription = (s: Pick<Subscription, 'status'>): boolean =>
  s.status === 'active' || s.status === 'inactive';

/** Still waiting on a human. ZainCash is excluded because it settles itself -
 *  an in-flight or abandoned gateway payment is nobody's queue item. */
export const needsManualApproval = (
  s: Pick<Subscription, 'status' | 'paymentMethod'>,
): boolean => s.status === 'pending' && s.paymentMethod !== 'zaincash';

/**
 * How many distinct people these rows belong to.
 *
 * userId is a mixed identity space - a roster student's uid IS their college
 * email while a Google user's is opaque, and the same human can hold both
 * documents (CLAUDE.md, "two identity spaces"). This counts ACCOUNTS, which is
 * the only thing that can be counted correctly here; merging two accounts is
 * shared/adminUsers.ts's job, not a dashboard's.
 */
export const distinctUsers = (subs: readonly Pick<Subscription, 'userId'>[]): number =>
  new Set(subs.map(s => s.userId).filter(Boolean)).size;

/** Firestore Timestamp | Date | millis | undefined -> millis, 0 when unusable. */
const millis = (value: any): number => {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
};

const PLANS: readonly SubscriptionPlan[] = ['monthly', 'seasonal', 'semi_annual'];
const METHODS: readonly PaymentMethod[] = ['zaincash', 'superkey', 'admin_grant'];

export interface SubscriptionStats {
  /** Distinct students who ever reached a real subscription - paid or granted. */
  totalSubscribers: number;
  /** Distinct students holding one right now. */
  activeSubscribers: number;
  /** Rows an admin still has to approve or reject. ZainCash never appears. */
  pendingApprovals: number;
  totalRevenue: number;
  /** Distinct students per plan. Sums to activeSubscribers. */
  byPlan: Record<SubscriptionPlan, number>;
  /** Transactions per method, with what they brought in. */
  byPayment: Record<PaymentMethod, { count: number; revenue: number }>;
}

export function computeSubscriptionStats(
  subscriptions: readonly Subscription[],
): SubscriptionStats {
  const real = subscriptions.filter(isRealSubscription);
  const active = subscriptions.filter(s => s.status === 'active');

  // One row per person, the newest they hold. Without this a student with two
  // active rows - which activateSubscription can leave behind, since it only
  // supersedes docs[0] - counts twice, and byPlan can exceed its own total.
  const newestActivePerUser = new Map<string, Subscription>();
  for (const sub of active) {
    if (!sub.userId) continue;
    const seen = newestActivePerUser.get(sub.userId);
    if (!seen || millis(sub.startDate ?? sub.createdAt) > millis(seen.startDate ?? seen.createdAt)) {
      newestActivePerUser.set(sub.userId, sub);
    }
  }
  const activeRows = [...newestActivePerUser.values()];

  const byPlan = Object.fromEntries(
    PLANS.map(plan => [plan, activeRows.filter(s => s.plan === plan).length]),
  ) as Record<SubscriptionPlan, number>;

  const byPayment = Object.fromEntries(
    METHODS.map(method => {
      // admin_grant used to be counted with no status filter at all, so a
      // cancelled grant still showed under منحة إدارية while the other two
      // rows excluded theirs. All three read the same rows now.
      const rows = real.filter(s => s.paymentMethod === method);
      return [method, {
        count: rows.length,
        revenue: rows.reduce((sum, s) => sum + (s.amount || 0), 0),
      }];
    }),
  ) as Record<PaymentMethod, { count: number; revenue: number }>;

  return {
    totalSubscribers: distinctUsers(real),
    activeSubscribers: activeRows.length,
    pendingApprovals: subscriptions.filter(needsManualApproval).length,
    totalRevenue: real.reduce((sum, s) => sum + (s.amount || 0), 0),
    byPlan,
    byPayment,
  };
}
