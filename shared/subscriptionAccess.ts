/**
 * Does this account have paid access right now, and what does a client need to
 * hold in order to answer that.
 *
 * This file exists because the rule was written twice - `hasMCQAccess()` in
 * src/App.tsx and `hasAiAccess()` in shared/simosan.ts, whose docblock called
 * itself a "mirror" of the other. They never disagreed on the logic. They
 * disagreed on the INPUT: App.tsx builds its UserProfile as an explicit
 * field-by-field projection of `users/{uid}` and simply omitted the three
 * subscription fields, so the client copy read `undefined` for every account in
 * the app while the server copy read the real document. A paying student got
 * Simosan (server-gated) and a paywall on the question bank (client-gated), and
 * their profile said "لا يوجد اشتراك فعال".
 *
 * So the predicate is shared, and SUBSCRIPTION_PROFILE_FIELDS names what has to
 * be hydrated for it to mean anything client-side. `npm run test:access` checks
 * both - including that App.tsx still copies all three.
 *
 * Deliberately NOT in shared/subscriptions.ts: that one imports ./zaincash.js,
 * which is JWT and server credentials, and must never reach the browser bundle.
 * This file has no imports at all.
 */

/**
 * The fields on `users/{uid}` that carry subscription state - written only by
 * the Admin SDK (`activateSubscription`), frozen against self-edit in
 * firestore.rules, and required by the predicates below.
 *
 * Any client that wants to gate on access must copy ALL of these out of the
 * snapshot. Copying none of them is exactly the bug this file documents.
 */
export const SUBSCRIPTION_PROFILE_FIELDS = [
  'isSubscribed',
  'subscriptionEnd',
  'subscriptionPlan',
] as const;

/**
 * Does this account hold a live paid subscription right now?
 *
 * Staff are NOT folded in here. "Has access" and "is a subscriber" are
 * different statements and the UI makes both: a representative has access to
 * everything and has bought nothing, so a SUBSCRIBED crown on their profile
 * would be a false claim about their account.
 *
 * `subscriptionEnd` arrives as a Firestore Timestamp from the Admin SDK and the
 * web SDK, and as a plain Date or ISO string from tests and from any caller that
 * has already unwrapped it - hence the duck-typed toDate().
 *
 * A subscription with no end date is open-ended, not expired: the cancel, refund
 * and expiry paths all clear `isSubscribed` alongside `subscriptionEnd`, so a
 * null end only ever means "no expiry recorded".
 */
export function hasLiveSubscription(userData: any, now: Date = new Date()): boolean {
  if (!userData?.isSubscribed) return false;
  const end = userData.subscriptionEnd;
  if (!end) return true;
  const endDate = typeof end?.toDate === 'function' ? end.toDate() : new Date(end);
  return endDate > now;
}

/**
 * May this account use paid features? The gate, for client and server alike.
 *
 * Staff pass without a subscription, but note what that does NOT buy them:
 * Simosan still meters admins against the same daily allowance students get, on
 * purpose - the point is that staff experience the flow students do.
 */
export function hasSubscriptionAccess(userData: any, now: Date = new Date()): boolean {
  if (!userData) return false;
  if (userData.role === 'admin' || userData.isMasterAdmin) return true;
  return hasLiveSubscription(userData, now);
}
