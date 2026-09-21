/**
 * The Apple IAP HTTP surface, built once and mounted by both route files.
 *
 * Same factory shape as shared/simosanApi.ts, shared/mcqApi.ts and
 * shared/timetableApi.ts, for the same reason: vercel.json sends production
 * /api/* to api/index.ts while npm run dev runs server.ts, and the two have
 * already drifted by 14 routes once.
 *
 * Three routes:
 *
 *   POST /api/iap/identity  mint the opaque App User ID + its reverse link
 *   POST /api/iap/sync      pull the truth from RevenueCat and apply it
 *   POST /api/iap/webhook   push from RevenueCat, same application path
 *
 * The client never asserts entitlement. It can tell us a purchase happened;
 * what grants access is this file asking RevenueCat with the secret key.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  type AppleEntitlement,
  type IapCtx,
  actionForEvent,
  applyAppleEntitlement,
  readSubscriberEntitlement,
} from './iap.js';

export interface IapDeps {
  admin: any;
  notify?: (userId: string, event: string, plan?: string) => Promise<void>;
  /** Overridable for tests; defaults to the real REST API. */
  fetchSubscriber?: (rcAppUserId: string) => Promise<any>;
}

const RC_API = 'https://api.revenuecat.com/v1/subscribers';
/** RevenueCat signs "<timestamp>.<raw body>"; reject a stale replay. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The RevenueCat App User ID for a Firebase uid.
 *
 * A hash, never the uid itself. A roster student's uid IS their college email
 * (see CLAUDE.md, "two identity spaces"), and RevenueCat's own guidance is to
 * keep PII out of App User IDs - so using the uid would ship ~400 real student
 * addresses into a third party's dashboard, exports and webhook payloads.
 *
 * Deterministic, so it can always be recomputed from the uid and never has to
 * be stored to be trusted; rcLinks exists only for the reverse direction, which
 * a hash cannot give us.
 */
export function rcAppUserIdFor(uid: string): string {
  return createHash('sha256').update(String(uid)).digest('hex');
}

/** Constant-time compare that cannot throw on a length mismatch. */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function createIapHandlers(deps: IapDeps) {
  const { admin } = deps;

  const ctx = (): IapCtx => ({
    db: admin.firestore(),
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
    notify: deps.notify,
  });

  async function raiseAlert(reason: string, detail: any) {
    try {
      await admin.firestore().collection('adminAlerts').add({
        type: 'iap_problem',
        reason,
        source: 'iap',
        detail: detail ?? null,
        resolved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[iap] could not write adminAlerts', e);
    }
  }

  /**
   * Ensure users/{uid}.rcAppUserId and rcLinks/{rcAppUserId} both exist.
   *
   * Called before any purchase can happen, which is the point: the webhook
   * resolves an app_user_id through rcLinks, so a payment that arrived before
   * the link existed would be unattributable. Idempotent - a set() of the same
   * values costs one write and removes a whole class of repair work.
   */
  async function ensureLink(uid: string): Promise<string> {
    const db = admin.firestore();
    const rcAppUserId = rcAppUserIdFor(uid);
    await db.collection('rcLinks').doc(rcAppUserId).set({
      uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await db.collection('users').doc(uid).set({ rcAppUserId }, { merge: true });
    return rcAppUserId;
  }

  const defaultFetchSubscriber = async (rcAppUserId: string) => {
    const key = process.env.REVENUECAT_SECRET_KEY;
    if (!key) throw new Error('not_configured');
    const res = await fetch(`${RC_API}/${encodeURIComponent(rcAppUserId)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`revenuecat_${res.status}`);
    return res.json();
  };
  const fetchSubscriber = deps.fetchSubscriber || defaultFetchSubscriber;

  // ─── POST /api/iap/identity ───────────────────────────────────────────────
  async function identity(req: any, res: any) {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: 'unauthenticated' });
    try {
      const rcAppUserId = await ensureLink(uid);
      return res.json({ rcAppUserId });
    } catch (err) {
      console.error('[iap] identity failed', err);
      return res.status(500).json({ error: 'identity_failed' });
    }
  }

  // ─── POST /api/iap/sync ───────────────────────────────────────────────────
  /**
   * Ask RevenueCat what this account holds, and write it.
   *
   * This is what makes the client's own CustomerInfo irrelevant to access, and
   * it also closes the window between a purchase completing on the device and
   * the webhook arriving - which is most of the time a student is watching a
   * spinner.
   */
  async function sync(req: any, res: any) {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: 'unauthenticated' });

    let rcAppUserId: string;
    try {
      // Repairs a missing link as a side effect, so a lost rcLinks document is
      // recoverable rather than an orphaned payment.
      rcAppUserId = await ensureLink(uid);
    } catch (err) {
      console.error('[iap] sync could not ensure link', err);
      return res.status(500).json({ error: 'link_failed' });
    }

    let subscriber: any;
    try {
      const body = await fetchSubscriber(rcAppUserId);
      subscriber = body?.subscriber ?? body;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg === 'not_configured') {
        await raiseAlert('not_configured', { note: 'REVENUECAT_SECRET_KEY is unset' });
        return res.status(503).json({ error: 'not_configured' });
      }
      // A 404 is a customer RevenueCat has never seen - a student who has not
      // bought anything. That is a valid answer, not a failure.
      if (msg === 'revenuecat_404') {
        return res.json({ active: false, expiresAt: null, plan: null });
      }
      console.error('[iap] sync upstream failed', err);
      return res.status(502).json({ error: 'upstream_failed' });
    }

    const entitlementId = process.env.REVENUECAT_ENTITLEMENT_ID || 'premium';
    const found = readSubscriberEntitlement(subscriber, entitlementId);
    if (!found) return res.json({ active: false, expiresAt: null, plan: null });

    const ent: AppleEntitlement = {
      rcAppUserId,
      productId: found.productId,
      expiresAtMs: found.expiresAtMs,
      // Derived from the STATE, not the moment: re-syncing an unchanged
      // entitlement hits the same iapEvents doc and no-ops, while a renewal
      // changes expires_date and therefore the id.
      eventId: `sync_${rcAppUserId}_${found.productId ?? 'none'}_${found.expiresAtMs ?? 'never'}`,
      store: 'APP_STORE',
    };

    try {
      await applyAppleEntitlement(ctx(), ent, {
        action: found.active ? 'grant' : 'revoke',
        alert: raiseAlert,
      });
    } catch (err) {
      console.error('[iap] sync could not apply', err);
      return res.status(500).json({ error: 'apply_failed' });
    }

    return res.json({
      active: found.active,
      expiresAt: found.expiresAtMs ? new Date(found.expiresAtMs).toISOString() : null,
      plan: found.productId,
    });
  }

  // ─── POST /api/iap/webhook ────────────────────────────────────────────────
  /**
   * Verify, then apply.
   *
   * FAILS CLOSED. With REVENUECAT_WEBHOOK_AUTH unset this answers 503 rather
   * than trusting the delivery: a guard written `header !== SECRET && SECRET`
   * is a no-op when the secret is missing, which is the shape PITFALLS.md
   * records under "Dual API surfaces".
   *
   * The raw body arrives via the `verify` hook on the global express.json() in
   * both route files. Mounting express.raw() on this path instead would put an
   * ordering requirement in two files that must not drift, which is the exact
   * hazard this factory exists to avoid.
   */
  async function webhook(req: any, res: any) {
    const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!expected) {
      await raiseAlert('not_configured', { note: 'REVENUECAT_WEBHOOK_AUTH is unset' });
      return res.status(503).json({ error: 'not_configured' });
    }
    const presented = String(req.headers?.authorization || '');
    if (!secretsMatch(presented, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // Optional second factor. Only enforced when configured, because RevenueCat
    // sends the signature header only for integrations that enable it - so a
    // hard requirement would reject every delivery until someone noticed.
    const signingSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (signingSecret) {
      const header = String(req.headers?.['x-revenuecat-webhook-signature'] || '');
      const parts = Object.fromEntries(
        header.split(',').map(kv => kv.split('=').map(x => x.trim())) as [string, string][],
      );
      const ts = Number(parts.t);
      const v1 = String(parts.v1 || '');
      const raw: Buffer | undefined = req.rawBody;
      if (!ts || !v1 || !raw) return res.status(401).json({ error: 'bad_signature' });
      if (Math.abs(Date.now() - ts * 1000) > SIGNATURE_TOLERANCE_MS) {
        return res.status(401).json({ error: 'stale_signature' });
      }
      const mac = createHmac('sha256', signingSecret)
        .update(`${ts}.`)
        .update(raw)
        .digest('hex');
      if (!secretsMatch(mac, v1)) return res.status(401).json({ error: 'bad_signature' });
    }

    const event = req.body?.event;
    if (!event || typeof event !== 'object') {
      // Malformed, but authenticated. 200 so RevenueCat stops retrying
      // something a retry cannot fix.
      return res.status(200).json({ ok: true, ignored: 'no_event' });
    }

    const action = actionForEvent(event.type);
    if (action === 'ignore') return res.status(200).json({ ok: true, ignored: event.type });

    // TEST events from the dashboard carry a fabricated app_user_id and must
    // not be looked up or applied - answering 200 is what the dashboard's
    // "send test event" button is checking for.
    const rcAppUserId = String(event.app_user_id || '');
    if (!rcAppUserId) return res.status(200).json({ ok: true, ignored: 'no_app_user_id' });

    const ent: AppleEntitlement = {
      rcAppUserId,
      productId: event.product_id ?? null,
      expiresAtMs: typeof event.expiration_at_ms === 'number' ? event.expiration_at_ms : null,
      eventId: String(event.id || `${rcAppUserId}_${event.type}_${event.event_timestamp_ms ?? ''}`),
      store: event.store ?? null,
      periodType: event.period_type ?? null,
      environment: event.environment ?? null,
    };

    try {
      const outcome = await applyAppleEntitlement(ctx(), ent, { action, alert: raiseAlert });
      if (outcome === 'unknown_user') {
        // The payment is real and we cannot attribute it. 200, because a retry
        // will not create the link either - but loud, because someone paid.
        await raiseAlert('unknown_app_user_id', {
          appUserId: rcAppUserId, type: event.type, productId: ent.productId,
        });
        return res.status(200).json({ ok: true, ignored: 'unknown_user' });
      }
      return res.status(200).json({ ok: true, outcome });
    } catch (err) {
      // 500 so RevenueCat retries: this one a retry CAN fix.
      console.error('[iap] webhook apply failed', err);
      return res.status(500).json({ error: 'apply_failed' });
    }
  }

  return { identity, sync, webhook };
}
