/**
 * Subscription lifecycle: activation, settlement of ZainCash payments, and the
 * plan table the server trusts.
 *
 * Shared by server.ts and api/index.ts for the usual reason — vercel.json routes
 * production /api/* to api/index.ts, so anything defined in only one of them
 * silently never runs where it matters.
 *
 * Follows the shared/ convention of taking `db` and `FieldValue`/`Timestamp` as
 * parameters rather than importing firebase-admin, so this stays testable
 * against the emulator. FCM is injected the same way, via `notify`.
 */
import {
  ZainCashConfig,
  ZainCashEvent,
  ZainCashStatus,
  inquireTransaction,
  parseOrderId,
  tagOrderId,
} from './zaincash.js';

/**
 * Server-side plan table. Mirrors PLAN_CONFIG in src/types.ts, which is the
 * client's copy — the client's is for display, this one is what money is
 * checked against, so never trust a plan or amount sent by the browser.
 *
 * A month here is 30 days, not a calendar month: 30/90/180/360. That is what
 * makes the struck-through anchor on the plan cards exact — it is derived as
 * monthly.price * (days / 30), so the annual card reads 24,000 crossed out
 * against 12,000. Setting annual to 365 would print 24,333 and a 986/month
 * hint, both of which read as arithmetic noise rather than a discount.
 */
export const PLAN_CONFIG: Record<string, { days: number; price: number }> = {
  monthly: { days: 30, price: 2000 },
  seasonal: { days: 90, price: 5000 },
  semi_annual: { days: 180, price: 9000 },
  annual: { days: 360, price: 12000 },
};

export type SubscriptionEvent = 'activated' | 'expired' | 'approved' | 'rejected';

export type NotifyFn = (
  userId: string,
  event: SubscriptionEvent,
  plan?: string,
) => Promise<void>;

export interface SubscriptionCtx {
  db: FirebaseFirestore.Firestore;
  FieldValue: { serverTimestamp(): any; delete(): any };
  Timestamp: { now(): any; fromDate(d: Date): any };
  /** Optional: omitted in tests, supplied by the route files in production. */
  notify?: NotifyFn;
}

/** Activate a subscription and refresh the denormalised cache on the user doc. */
export async function activateSubscription(
  ctx: SubscriptionCtx,
  subId: string,
  userId: string,
  plan: string,
  approvedBy?: string,
): Promise<void> {
  const { db, FieldValue, Timestamp } = ctx;
  const config = PLAN_CONFIG[plan];
  if (!config) throw new Error(`Invalid plan: ${plan}`);

  // Stack time: if an active subscription exists, extend from its end date
  // rather than from now, so renewing early never costs the customer days.
  const existingSubs = await db
    .collection('subscriptions')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .get();

  const startDate = Timestamp.now();
  let endBaseDate = new Date();

  if (!existingSubs.empty) {
    const activeSub = existingSubs.docs[0];
    const activeEndDate = activeSub.data().endDate?.toDate();
    if (activeEndDate && activeEndDate > new Date()) {
      endBaseDate = activeEndDate;
    }
    await activeSub.ref.update({
      status: 'inactive',
      updatedAt: FieldValue.serverTimestamp(),
      notes: `Replaced by subscription ${subId}`,
    });
  }

  const endDate = new Date(endBaseDate.getTime() + config.days * 24 * 60 * 60 * 1000);

  const updateData: any = {
    status: 'active',
    startDate,
    endDate: Timestamp.fromDate(endDate),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (approvedBy) updateData.approvedBy = approvedBy;

  await db.collection('subscriptions').doc(subId).update(updateData);

  await db.collection('users').doc(userId).update({
    isSubscribed: true,
    subscriptionEnd: Timestamp.fromDate(endDate),
    subscriptionPlan: plan,
  });

  await ctx.notify?.(userId, 'activated', plan);
}

// ─── ZainCash settlement ────────────────────────────────────────────────────

export type SettlementOutcome =
  | 'activated'
  | 'already_settled'
  | 'duplicate_event'
  | 'failed'
  | 'refunded'
  | 'still_pending'
  | 'not_found'
  | 'amount_mismatch'
  | 'reference_mismatch';

export interface SettlementResult {
  outcome: SettlementOutcome;
  subscriptionId: string;
  status?: ZainCashStatus;
  detail?: string;
}

/**
 * Atomically claim a pending subscription for settlement.
 *
 * The redirect and the webhook can arrive for the same payment at the same
 * moment; without this both would activate it and the customer would get two
 * plans' worth of days from one payment. Returns null if someone else won.
 */
async function claimForSettlement(
  ctx: SubscriptionCtx,
  subId: string,
  eventId: string,
): Promise<{ data: FirebaseFirestore.DocumentData } | { conflict: SettlementOutcome } | null> {
  const ref = ctx.db.collection('subscriptions').doc(subId);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data()!;

    if (data.lastEventId === eventId) return { conflict: 'duplicate_event' as const };
    if (data.settling || data.status !== 'pending') {
      return { conflict: 'already_settled' as const };
    }

    tx.update(ref, { settling: true, lastEventId: eventId });
    return { data };
  });
}

/** Release the claim so a later, valid callback can still settle the payment. */
async function releaseClaim(ctx: SubscriptionCtx, subId: string): Promise<void> {
  await ctx.db.collection('subscriptions').doc(subId).update({ settling: false });
}

/**
 * Forget the payment this user had in flight.
 *
 * The pointer only exists to stop a second payment opening while one is live,
 * so the moment this one reaches a terminal state it has to go — otherwise the
 * customer's next purchase is blocked by a record that can no longer be paid.
 */
async function clearPendingPointer(ctx: SubscriptionCtx, userId: string): Promise<void> {
  await ctx.db
    .collection('users')
    .doc(userId)
    .update({ pendingZainCashRef: ctx.FieldValue.delete() })
    .catch(() => undefined);
}

/** A subscription payment of this user's that is still open at the gateway. */
export interface LiveZainCashPayment {
  subscriptionId: string;
  plan: string;
  amount: number;
  redirectUrl: string;
  minutesLeft: number;
}

/**
 * Find this user's in-flight payment, or null.
 *
 * ZainCash refuses to settle while another transaction is open on the same
 * wallet ("System - Duplicate Transaction Exist") and a transaction lives about
 * fifteen minutes, so opening a second one locks the customer out of both. This
 * is what lets /init hand back the first instead.
 *
 * Reached through a pointer on the user document rather than a query on
 * subscriptions, which would need a composite index for two equality filters
 * plus an ordering.
 *
 * Anything the gateway has already finished is settled on the way through —
 * routed via settleZainCashPayment so there is exactly one settlement path,
 * with its claim, its idempotency and its amount check.
 */
export async function findLiveZainCashPayment(
  ctx: SubscriptionCtx,
  cfg: ZainCashConfig,
  userId: string,
): Promise<LiveZainCashPayment | null> {
  const { db } = ctx;

  const ref = (await db.collection('users').doc(userId).get()).data()?.pendingZainCashRef;
  if (!ref || typeof ref !== 'string') return null;

  const snap = await db.collection('subscriptions').doc(ref).get();
  const sub = snap.exists ? snap.data()! : null;

  // Missing, already resolved, or written before the gateway answered.
  if (!sub || sub.status !== 'pending' || !sub.redirectUrl || !sub.transactionId) {
    await clearPendingPointer(ctx, userId);
    return null;
  }

  // Ask the gateway BEFORE looking at expiryTime. The order matters: this used
  // to bail out on an expired window without probing, so a payment that
  // SUCCEEDED but whose redirect and webhook were both lost - a closed tab, a
  // dropped webhook - stayed 'pending' for ever and could only be delivered by
  // an admin pressing Approve. The inquiry is authoritative either way: a paid
  // one activates here, and a genuinely dead one comes back EXPIRED and is
  // written 'cancelled' instead of leaking as a pending row for ever.
  const outcome = await probeSettlement(ctx, cfg, ref, sub);

  if (outcome !== 'still_pending') {
    // Finished, and now delivered. Let a new payment through.
    await clearPendingPointer(ctx, userId);
    return null;
  }

  // Open at the gateway, but past the window the customer could pay in. Nothing
  // to resume, so forget it and let a fresh payment be opened.
  const expiresAt = Date.parse(sub.expiryTime ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await clearPendingPointer(ctx, userId);
    return null;
  }

  return {
    subscriptionId: ref,
    plan: sub.plan,
    amount: Number(sub.amount) || 0,
    redirectUrl: sub.redirectUrl,
    minutesLeft: Math.max(1, Math.ceil((expiresAt - Date.now()) / 60000)),
  };
}

/**
 * Re-ask the gateway about one pending row, through the ordinary settlement
 * path so there is exactly one of those - with its claim, its idempotency and
 * its amount check.
 *
 * settleZainCashPayment always inquires and ignores the status carried in the
 * event, so this synthetic one is only a carrier for the identifiers.
 *
 * The eventId MUST be unique per attempt. It used to be `inquiry-${txId}`, and
 * claimForSettlement writes lastEventId when it takes the claim while the
 * still_pending path releases only `settling` - so the second probe of a row
 * short-circuited as 'duplicate_event' and never reached the gateway again.
 * Every re-check after the first was silently a no-op, and findLive read that
 * non-'still_pending' outcome as "finished" and dropped the pointer. Replaying
 * a real gateway event is still caught: lastEventId keeps the gateway's own
 * ids, and double settlement is prevented by the `status !== 'pending'` arm of
 * the claim, not by this id.
 */
async function probeSettlement(
  ctx: SubscriptionCtx,
  cfg: ZainCashConfig,
  subId: string,
  sub: FirebaseFirestore.DocumentData,
): Promise<SettlementOutcome> {
  const probe: ZainCashEvent = {
    eventType: 'STATUS_CHANGED',
    eventId: `inquiry-${sub.transactionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    data: {
      transactionId: sub.transactionId,
      merchantReferenceId: sub.externalReferenceId,
      orderId: tagOrderId(subId),
      currentStatus: 'PENDING',
    },
  };

  try {
    return (await settleZainCashPayment(ctx, cfg, probe, 'redirect')).outcome;
  } catch (err) {
    // Gateway unreachable. Treat the payment as live: opening a second one
    // while the first may still be open is the failure being prevented here.
    return 'still_pending';
  }
}

export interface ReconcileResult {
  checked: number;
  activated: number;
  cancelled: number;
  stillPending: number;
}

/**
 * Settle every ZainCash payment the gateway has already finished.
 *
 * ZainCash is supposed to settle itself, and on the happy path it does - the
 * redirect or the webhook arrives and settleZainCashPayment runs. Neither is
 * guaranteed: the redirect comes back through the customer's browser, and the
 * webhook "does not fire in the test environment". Nothing else ever moved a
 * row out of 'pending', so a lost callback meant a student who really paid had
 * to be approved by hand - and abandoned attempts piled up in the queue for
 * ever, one per retry.
 *
 * Deliberately NOT routed through users/{uid}.pendingZainCashRef the way
 * findLiveZainCashPayment is: that pointer is cleared on several paths, and a
 * row whose pointer is gone is exactly the one nothing can reach.
 *
 * The query carries ONE equality filter on purpose - `subscriptions` has no
 * composite index (it is absent from firestore.indexes.json), so the
 * paymentMethod narrowing is done in memory rather than adding a second filter.
 */
export async function reconcilePendingZainCash(
  ctx: SubscriptionCtx,
  cfg: ZainCashConfig,
  opts: { userId?: string; limit?: number; minAgeMs?: number } = {},
): Promise<ReconcileResult> {
  const limit = opts.limit ?? 25;
  // Rows younger than this are still legitimately in flight - the customer is
  // on the gateway page right now - and the inquiry would cost a round trip to
  // be told 'PENDING'.
  const minAgeMs = opts.minAgeMs ?? 2 * 60 * 1000;
  const cutoff = Date.now() - minAgeMs;

  let query: FirebaseFirestore.Query = ctx.db
    .collection('subscriptions')
    .where('status', '==', 'pending');
  if (opts.userId) query = query.where('userId', '==', opts.userId);

  const snap = await query.get();

  const rows = snap.docs
    .filter((d) => {
      const data = d.data();
      if (data.paymentMethod !== 'zaincash') return false;
      // Written before the gateway answered, so there is nothing to inquire on.
      if (!data.transactionId) return false;
      const created = data.createdAt?.toMillis?.() ?? 0;
      return created === 0 || created <= cutoff;
    })
    // Oldest first: those are the ones that have been stuck longest, and the
    // cap must not starve them in favour of rows that are about to settle
    // themselves anyway.
    .sort((a, b) => (a.data().createdAt?.toMillis?.() ?? 0) - (b.data().createdAt?.toMillis?.() ?? 0))
    .slice(0, limit);

  const result: ReconcileResult = { checked: 0, activated: 0, cancelled: 0, stillPending: 0 };

  for (const row of rows) {
    const data = row.data();
    const outcome = await probeSettlement(ctx, cfg, row.id, data);
    result.checked += 1;
    if (outcome === 'still_pending') {
      result.stillPending += 1;
      continue;
    }
    if (outcome === 'activated') result.activated += 1;
    // failed / refunded / amount_mismatch are terminal and now 'cancelled'.
    // already_settled and duplicate_event land here too; both mean the row is
    // no longer this function's business.
    else result.cancelled += 1;
    // Guarded: .doc(undefined) throws synchronously, ahead of the .catch inside
    // clearPendingPointer, which would abort the whole sweep over one bad row.
    if (data.userId) await clearPendingPointer(ctx, data.userId);
  }

  return result;
}

/**
 * Settle a ZainCash payment from a verified redirect or webhook event.
 *
 * The event's JWT signature is verified by the caller, but the event itself is
 * only a hint: the redirect arrives through the customer's browser and is
 * therefore attacker-reachable. Access is granted strictly on what the Inquiry
 * API says, and only when the amount paid matches the plan's price.
 */
export async function settleZainCashPayment(
  ctx: SubscriptionCtx,
  cfg: ZainCashConfig,
  event: ZainCashEvent,
  source: 'redirect' | 'webhook',
): Promise<SettlementResult> {
  const { db, FieldValue } = ctx;
  // orderId carries a tenant prefix so a shared merchant webhook can be routed;
  // the document id is what is left after it.
  const subId = parseOrderId(event.data.orderId).id;
  const transactionId = event.data.transactionId;

  const claim = await claimForSettlement(ctx, subId, event.eventId);
  if (claim === null) return { outcome: 'not_found', subscriptionId: subId };
  if ('conflict' in claim) return { outcome: claim.conflict, subscriptionId: subId };

  const sub = claim.data;

  // The redirect leg arrives through the customer's browser, so orderId is
  // attacker-reachable. The signature check catches forgeries; this stops a
  // *validly signed* event for one transaction being replayed against a
  // different subscription. Skipped for documents predating externalReferenceId.
  const expectedRef = sub.externalReferenceId;
  const gotRef = event.data.merchantReferenceId;
  if (expectedRef && gotRef && expectedRef !== gotRef) {
    await releaseClaim(ctx, subId).catch(() => undefined);
    return {
      outcome: 'reference_mismatch',
      subscriptionId: subId,
      detail: `event referenced ${gotRef}, subscription holds ${expectedRef}`,
    };
  }

  try {
    // Authoritative check. Never trust the callback's own currentStatus.
    const inquiry = await inquireTransaction(cfg, transactionId);
    const status = inquiry.status;

    if (status === 'SUCCESS') {
      const expected = PLAN_CONFIG[sub.plan]?.price;
      const paid = Number(inquiry.transactionDetails?.amount?.value);

      if (expected === undefined || !Number.isFinite(paid) || paid !== expected) {
        await db.collection('subscriptions').doc(subId).update({
          settling: false,
          status: 'cancelled',
          updatedAt: FieldValue.serverTimestamp(),
          notes: `Amount mismatch: paid ${paid}, expected ${expected} for plan ${sub.plan}`,
        });
        await clearPendingPointer(ctx, sub.userId);
        return {
          outcome: 'amount_mismatch',
          subscriptionId: subId,
          status,
          detail: `paid ${paid}, expected ${expected}`,
        };
      }

      await db.collection('subscriptions').doc(subId).update({
        settling: false,
        transactionId,
        settledVia: source,
      });

      await activateSubscription(ctx, subId, sub.userId, sub.plan);

      // Remember the wallet the customer actually paid from, refreshed every
      // time: the spec notes it may differ from their registered number and
      // may change between payments.
      const msisdn = event.data.customerMsisdn || inquiry.customer?.phone;
      if (msisdn) {
        await db
          .collection('users')
          .doc(sub.userId)
          .update({ zaincashMsisdn: msisdn })
          .catch(() => undefined);
      }

      await clearPendingPointer(ctx, sub.userId);
      return { outcome: 'activated', subscriptionId: subId, status };
    }

    if (status === 'FAILED' || status === 'EXPIRED') {
      await db.collection('subscriptions').doc(subId).update({
        settling: false,
        status: 'cancelled',
        updatedAt: FieldValue.serverTimestamp(),
        notes: `ZainCash ${status}${event.data.errorMessage ? `: ${event.data.errorMessage}` : ''}`,
      });
      await clearPendingPointer(ctx, sub.userId);
      return { outcome: 'failed', subscriptionId: subId, status };
    }

    if (status === 'REFUNDED') {
      await db.collection('subscriptions').doc(subId).update({
        settling: false,
        status: 'cancelled',
        updatedAt: FieldValue.serverTimestamp(),
        notes: 'ZainCash REFUNDED',
      });
      await db
        .collection('users')
        .doc(sub.userId)
        .update({ isSubscribed: false, subscriptionEnd: null, subscriptionPlan: null })
        .catch(() => undefined);
      await clearPendingPointer(ctx, sub.userId);
      return { outcome: 'refunded', subscriptionId: subId, status };
    }

    // PENDING / OTP_SENT / CUSTOMER_AUTHENTICATION_REQUIRED — not final yet.
    // Leave it pending so the webhook (or a later inquiry) can still settle it.
    await releaseClaim(ctx, subId);
    return { outcome: 'still_pending', subscriptionId: subId, status };
  } catch (err) {
    // Never leave a claim stuck: an inquiry outage would otherwise permanently
    // block the webhook from settling a payment the customer already made.
    await releaseClaim(ctx, subId).catch(() => undefined);
    throw err;
  }
}
