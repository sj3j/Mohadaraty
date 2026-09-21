/**
 * Apple In-App Purchase entitlement, as written into this app's own data model.
 *
 * Pure apart from the injected `ctx`, exactly like shared/subscriptions.ts and
 * for the same reason: server.ts and api/index.ts both mount it, and it has to
 * be testable against the emulator without importing firebase-admin.
 *
 * Deliberately NOT part of shared/subscriptions.ts: that file imports
 * ./zaincash.js, which is JWT and gateway credentials. Nothing here needs them,
 * and an Apple entitlement must never acquire a reason to pull that in.
 */

/** The four auto-renewable subscriptions in App Store Connect. */
export const PRODUCT_PLAN_MAP: Record<string, string> = {
  'com.mohadaraty.app.1month': 'monthly',
  'com.mohadaraty.app.3months': 'seasonal',
  'com.mohadaraty.app.6months': 'semi_annual',
  'com.mohadaraty.app.1year': 'annual',
};

/**
 * Which plan a product is, or null if we have never heard of it.
 *
 * null is a real answer, not an error: a product added in App Store Connect
 * before this map is updated will reach the webhook, and the caller's job is
 * then to grant access anyway and say so loudly. See applyAppleEntitlement.
 *
 * Apple strips nothing, but RevenueCat's `product_id` for a subscription can
 * carry a `:base-plan` suffix on Google Play. Harmless here - iOS never does -
 * but split on ':' so the map still resolves if this is ever reused.
 */
export function planForProduct(productId: string | null | undefined): string | null {
  if (!productId) return null;
  return PRODUCT_PLAN_MAP[String(productId).split(':')[0]] ?? null;
}

/** What a webhook event should do to the account's access. */
export type EntitlementAction = 'grant' | 'revoke' | 'ignore';

/**
 * Map a RevenueCat event type onto an action.
 *
 * The one that catches people out is CANCELLATION. In Apple's vocabulary it
 * means "auto-renew was turned off", NOT "access ends now" - the student has
 * paid for the current period and keeps it to the end. Revoking on the event
 * would take away time that was bought. So CANCELLATION is a GRANT whose
 * expiry happens to be already known; the EXPIRATION event, or the expiry date
 * passing, is what actually ends access.
 *
 * A refund arrives as CANCELLATION too, but with expiration_at_ms in the past,
 * so the same grant-to-the-stored-expiry rule revokes it correctly without a
 * special case.
 *
 * BILLING_ISSUE is ignored on purpose: Apple retries for up to 60 days in a
 * grace period during which the student still has access, and EXPIRATION
 * follows if it never succeeds. Cutting access off at the first failed charge
 * would punish an expired card.
 */
export function actionForEvent(type: string | null | undefined): EntitlementAction {
  switch (String(type || '').toUpperCase()) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'SUBSCRIPTION_EXTENDED':
    case 'NON_RENEWING_PURCHASE':
    case 'REFUND_REVERSED':
    case 'TRANSFER':
    // Access runs to the stored expiry; see the note above.
    case 'CANCELLATION':
      return 'grant';

    case 'EXPIRATION':
    case 'SUBSCRIPTION_PAUSED':
      return 'revoke';

    // TEST is the dashboard's ping. BILLING_ISSUE is a grace period, not an end.
    // The rest carry no entitlement change.
    default:
      return 'ignore';
  }
}

/** One account's Apple entitlement, however we learned about it. */
export interface AppleEntitlement {
  /** RevenueCat App User ID - the opaque hash, never the Firebase uid. */
  rcAppUserId: string;
  productId: string | null;
  /** Apple's own expiry. Authoritative; null means non-expiring. */
  expiresAtMs: number | null;
  /** RevenueCat's event id, or a synthetic one for a /api/iap/sync pull. */
  eventId: string;
  store?: string | null;
  periodType?: string | null;
  environment?: string | null;
}

/**
 * Read the entitlement out of a RevenueCat REST v1 subscriber payload.
 *
 * `entitlementId` is the configured identifier. If it is absent from the
 * payload we fall back to ANY entitlement present, because a dashboard whose
 * entitlement is named something else would otherwise deny access to a student
 * who has genuinely paid - and a wrong label is cheaper than a wrong refusal.
 */
export function readSubscriberEntitlement(
  subscriber: any,
  entitlementId: string,
): { expiresAtMs: number | null; productId: string | null; active: boolean } | null {
  const all = subscriber?.entitlements;
  if (!all || typeof all !== 'object') return null;

  const chosen = all[entitlementId] ?? Object.values(all)[0];
  if (!chosen || typeof chosen !== 'object') return null;

  const raw = (chosen as any).expires_date;
  // A null expires_date is a non-expiring entitlement, not a missing one.
  const expiresAtMs = raw ? Date.parse(raw) : null;
  if (raw && Number.isNaN(expiresAtMs as number)) return null;

  return {
    expiresAtMs,
    productId: (chosen as any).product_identifier ?? null,
    active: expiresAtMs === null || (expiresAtMs as number) > Date.now(),
  };
}

export interface IapCtx {
  db: FirebaseFirestore.Firestore;
  FieldValue: { serverTimestamp(): any; delete(): any };
  Timestamp: { now(): any; fromDate(d: Date): any };
  notify?: (userId: string, event: string, plan?: string) => Promise<void>;
}

/**
 * The document id of an account's Apple row.
 *
 * Deterministic, and one row per account rather than one per renewal. Apple
 * auto-renew is ONE continuous subscription: a row per renewal would make
 * توزيع المشتركين count the same student once per month, and would need the
 * "newest active row" tie-break that src/lib/subscriptionStats.ts already has
 * to apply for a different reason.
 */
export function appleSubscriptionId(rcAppUserId: string): string {
  return `apple_${rcAppUserId}`;
}

export type ApplyOutcome =
  | 'granted'
  | 'revoked'
  | 'already_applied'
  | 'unknown_user'
  | 'ignored';

/**
 * Recompute users/{uid}'s denormalised access cache from the subscription rows
 * that actually exist.
 *
 * This is the union rule, and it is why applyAppleEntitlement is a SIBLING of
 * activateSubscription rather than a caller of it. activateSubscription stacks
 * PLAN_CONFIG.days onto an existing end date and overwrites the three user
 * fields unconditionally - correct for a one-off ZainCash payment, wrong for a
 * renewing Apple subscription whose expiry Apple already knows and moves every
 * period. Worse, it would let an Apple row SHORTEN a longer live ZainCash one.
 *
 * Taking max(endDate) over every active row can only ever raise access, never
 * lower it, so the two rails coexist without either having to know about the
 * other.
 */
export async function recomputeUserAccess(ctx: IapCtx, uid: string): Promise<void> {
  const { db, Timestamp } = ctx;
  const snap = await db
    .collection('subscriptions')
    .where('userId', '==', uid)
    .where('status', '==', 'active')
    .get();

  let bestEnd: Date | null = null;
  let bestPlan: string | null = null;
  let openEnded = false;

  for (const doc of snap.docs) {
    const data = doc.data() as any;
    const end = data.endDate?.toDate ? data.endDate.toDate() : (data.endDate ? new Date(data.endDate) : null);
    if (!end) {
      // No expiry recorded means open-ended, which outranks any date.
      openEnded = true;
      bestPlan = data.plan ?? bestPlan;
      continue;
    }
    if (end.getTime() <= Date.now()) continue;
    if (!bestEnd || end > bestEnd) {
      bestEnd = end;
      bestPlan = data.plan ?? bestPlan;
    }
  }

  const live = openEnded || bestEnd !== null;
  await db.collection('users').doc(uid).update({
    isSubscribed: live,
    subscriptionEnd: live && bestEnd && !openEnded ? Timestamp.fromDate(bestEnd) : null,
    subscriptionPlan: live ? bestPlan : null,
  });
}

/**
 * Apply an Apple entitlement to an account, idempotently.
 *
 * `eventId` is the idempotency key. RevenueCat retries a failed delivery with
 * the SAME event.id, so a doc at iapEvents/{eventId} is what stops a retry
 * double-counting. A /api/iap/sync pull passes a synthetic id derived from the
 * state it read, so re-syncing an unchanged entitlement is also a no-op.
 */
export async function applyAppleEntitlement(
  ctx: IapCtx,
  ent: AppleEntitlement,
  opts: { action: EntitlementAction; alert?: (reason: string, detail: any) => Promise<void> },
): Promise<ApplyOutcome> {
  const { db, FieldValue, Timestamp } = ctx;
  if (opts.action === 'ignore') return 'ignored';

  const linkSnap = await db.collection('rcLinks').doc(ent.rcAppUserId).get();
  const uid: string | undefined = linkSnap.exists ? (linkSnap.data() as any)?.uid : undefined;
  if (!uid) return 'unknown_user';

  const eventRef = db.collection('iapEvents').doc(ent.eventId);
  if ((await eventRef.get()).exists) return 'already_applied';

  const plan = planForProduct(ent.productId);
  if (!plan && ent.productId) {
    // Fails OPEN on access, LOUD on the label. A student who paid for a product
    // this map has not been taught about still gets in; the mislabelled plan is
    // a reporting problem, and denying them is a refund and a support ticket.
    await opts.alert?.('unmapped_product', { productId: ent.productId, uid });
  }
  const effectivePlan = plan || 'monthly';

  const expires = ent.expiresAtMs !== null ? new Date(ent.expiresAtMs) : null;
  // A grant whose expiry has already passed is a revoke - which is exactly how
  // a refund arrives (CANCELLATION with a past expiration_at_ms).
  const live = opts.action === 'grant' && (!expires || expires.getTime() > Date.now());

  const subRef = db.collection('subscriptions').doc(appleSubscriptionId(ent.rcAppUserId));
  const existing = await subRef.get();
  const userSnap = await db.collection('users').doc(uid).get();
  const userData = (userSnap.data() as any) || {};

  const row: any = {
    userId: uid,
    userEmail: userData.email || '',
    userName: userData.name || '',
    plan: effectivePlan,
    status: live ? 'active' : 'inactive',
    paymentMethod: 'apple_iap',
    // Apple settles in the buyer's own currency, net of Apple's commission, and
    // the ledger's totalRevenue is denominated in IQD. Folding one into the
    // other would make the dashboard lie, so Apple rows carry 0 and App Store
    // Connect stays the place Apple revenue is read. See CLAUDE.md.
    amount: 0,
    endDate: expires ? Timestamp.fromDate(expires) : null,
    transactionId: ent.eventId,
    updatedAt: FieldValue.serverTimestamp(),
    appleProductId: ent.productId || null,
    appleStore: ent.store || null,
    applePeriodType: ent.periodType || null,
    appleEnvironment: ent.environment || null,
    rcAppUserId: ent.rcAppUserId,
  };
  if (!plan && ent.productId) {
    row.notes = `Unmapped product ${ent.productId} - plan defaulted to monthly`;
  }
  if (!existing.exists) {
    row.createdAt = FieldValue.serverTimestamp();
    row.startDate = Timestamp.now();
  }

  await subRef.set(row, { merge: true });
  await recomputeUserAccess(ctx, uid);
  await eventRef.set({
    rcAppUserId: ent.rcAppUserId,
    uid,
    productId: ent.productId || null,
    action: opts.action,
    appliedAt: FieldValue.serverTimestamp(),
  });

  if (live && !existing.exists) await ctx.notify?.(uid, 'activated', effectivePlan);
  return live ? 'granted' : 'revoked';
}
