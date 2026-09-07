/**
 * Simosan — the in-reader AI tutor's server-side budget, quota and access logic.
 *
 * Shared by server.ts and api/index.ts for the usual reason — vercel.json routes
 * production /api/* to api/index.ts, so anything defined in only one of them
 * silently never runs where it matters.
 *
 * Follows the shared/ convention of taking `db` and `FieldValue`/`Timestamp` as
 * parameters rather than importing firebase-admin, so this stays testable
 * against the emulator. FCM is injected the same way, via `notify`.
 *
 * WHY THIS FILE EXISTS AT ALL: the app's existing Gemini integration
 * (src/services/mcqGenerationService.ts) runs in the browser with the API key
 * inlined into the bundle by vite.config.ts. There is no limit that a student
 * cannot remove with devtools. Simosan is server-only precisely so that the
 * daily allowance and the monthly ceiling are enforced somewhere the student
 * does not control. Nothing in this module may ever trust a number that arrived
 * in a request body.
 */

/* ------------------------------------------------------------------ *
 * Pricing and the energy unit
 * ------------------------------------------------------------------ */

/**
 * Energy is denominated in "units", normalised so that one unit is one
 * uncached input token. That choice is what keeps the student's energy bar and
 * the Google invoice from ever diverging: every weight below is a real price
 * ratio, not a product guess.
 *
 * gemini-3.1-flash-lite: $0.25/1M input, $1.50/1M output.
 *   uncached input token = 1     ($0.25/1M)
 *   cached input token   = 0.25  (Gemini's implicit-cache discount)
 *   output token         = 6     ($1.50 / $0.25)
 *
 * If the model changes, these MUST change with it, or the ceiling stops
 * meaning dollars. Keep USD_PER_UNIT in step with the input price.
 */
export const UNIT_WEIGHT_UNCACHED_INPUT = 1;
export const UNIT_WEIGHT_CACHED_INPUT = 0.25;
export const UNIT_WEIGHT_OUTPUT = 6;

/** One unit == one uncached input token == $0.25 per million. */
export const USD_PER_UNIT = 0.25 / 1_000_000;

export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Tokens billed per PDF page. Natively embedded text is not charged on Gemini 3
 * models, which is why full-PDF grounding is cheaper than shipping extracted
 * text.
 *
 * Google documents 258. A real 66-page lecture measured **303**
 * (`promptTokensDetails` IMAGE = 20,026), so the documented figure under-counts
 * and the reservation it produced cleared actual spend by only 5% - and only
 * because the answer came back short. Do not "correct" this back to 258 on the
 * strength of the docs; 310 is what the invoice does.
 */
export const TOKENS_PER_PDF_PAGE = 310;

/** Files API entries live 48h. Refresh early so a request never races expiry. */
export const FILE_TTL_MS = 48 * 60 * 60 * 1000;
export const FILE_REFRESH_MS = 44 * 60 * 60 * 1000;

/** Gemini's hard limits on a single PDF. Beyond these the lecture has no tutor. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 1000;

/** Student questions per chat thread. The assistant's replies do not count, so
 *  a full thread is up to 50 messages. Its job is bounding how large a single
 *  request can grow, not limiting usage — daily energy does that. */
export const MAX_QUESTIONS_PER_CHAT = 25;

/**
 * Sized against a REAL lecture, not a hypothetical one. 55,000 assumed a
 * 30-page deck at 258 tokens/page; lectures here run to 66 pages at 303, so a
 * fresh question costs ~22,700 units and 55,000 bought about 2.4 questions a
 * day rather than the ~6 that was intended. Follow-ups in the same chat cost
 * roughly half, because the PDF prefix hits Gemini's implicit cache.
 */
export const DEFAULT_DAILY_UNIT_BUDGET = 140_000;
export const DEFAULT_MONTHLY_CEILING_USD = 50;

/** Fractions of the monthly ceiling that raise an admin alert. 1.0 also trips
 *  the kill switch. */
export const ALERT_THRESHOLDS = [0.5, 0.8, 1.0];

/** Assumed answer length when reserving, before real usage is known. Reserving
 *  is deliberately pessimistic; the difference is refunded on reconcile. */
export const ASSUMED_OUTPUT_TOKENS = 700;

/**
 * Off-topic questions are refunded so a student is not punished for asking
 * something Simosan declines — but only this many times a day.
 *
 * Without the cap the refund is an infinite-spend hole: every refusal still
 * costs real money (the whole PDF is in the prompt before the model decides to
 * decline), so an unlimited refund would let one student drain the monthly
 * ceiling at no cost to their own bar. Past the cap, refusals bill normally.
 */
export const MAX_FREE_OFF_TOPIC_PER_DAY = 5;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface SimosanSettings {
  enabled: boolean;
  model: string;
  dailyUnitBudget: number;
  monthlyCeilingUsd: number;
  month: string;
  monthUsd: number;
  alertsSent: number[];
}

export type SimosanAlert = 'budget_50' | 'budget_80' | 'budget_100';

export type AlertFn = (
  alert: SimosanAlert,
  detail: { monthUsd: number; ceilingUsd: number; month: string },
) => Promise<void>;

export interface SimosanCtx {
  db: FirebaseFirestore.Firestore;
  FieldValue: { serverTimestamp(): any; increment(n: number): any };
  Timestamp: { now(): any; fromDate(d: Date): any };
  /** Optional: omitted in tests, supplied by the route files in production. */
  alert?: AlertFn;
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export type DenyReason =
  | 'not_subscribed'
  | 'disabled'
  | 'ceiling_reached'
  | 'insufficient_energy'
  | 'chat_full';

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/**
 * Baghdad is UTC+3 all year — Iraq abolished DST in 2008 — so a fixed offset is
 * correct here, not a simplification. Reset at Baghdad midnight rather than UTC
 * because a UTC reset lands mid-afternoon for every student in the app.
 */
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

export function baghdadDayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

export function baghdadMonthKey(now: Date = new Date()): string {
  return new Date(now.getTime() + BAGHDAD_OFFSET_MS).toISOString().slice(0, 7);
}

/** Milliseconds until the next Baghdad midnight, for the "resets in" message. */
export function msUntilBaghdadReset(now: Date = new Date()): number {
  const shifted = new Date(now.getTime() + BAGHDAD_OFFSET_MS);
  const nextMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return nextMidnight - shifted.getTime();
}

export function usageDocId(uid: string, day: string): string {
  return `${uid}_${day}`;
}

/* ------------------------------------------------------------------ *
 * Energy arithmetic
 * ------------------------------------------------------------------ */

/**
 * Convert real Gemini usage into energy units.
 *
 * `promptTokenCount` INCLUDES cached tokens, so the uncached portion is the
 * difference. Thinking tokens are billed at the output rate, so they are
 * weighted as output.
 */
export function unitsFromUsage(usage: GeminiUsage | undefined | null): number {
  if (!usage) return 0;
  const prompt = usage.promptTokenCount ?? 0;
  const cached = usage.cachedContentTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const uncached = Math.max(0, prompt - cached);
  return Math.ceil(
    uncached * UNIT_WEIGHT_UNCACHED_INPUT +
      cached * UNIT_WEIGHT_CACHED_INPUT +
      output * UNIT_WEIGHT_OUTPUT,
  );
}

/**
 * Headroom applied to every reservation.
 *
 * The two errors here are not symmetric. Over-reserving is refunded on
 * reconcile a few seconds later and the student never sees it; under-reserving
 * lets a request through that the budget could not actually afford, which is
 * the exact failure the daily allowance exists to prevent. The system-prompt
 * and tokens-per-character terms below are both approximations, so a margin
 * keeps their combined error on the safe side of that asymmetry.
 */
export const RESERVE_SAFETY_FACTOR = 1.1;

/**
 * What to reserve before the call, when the real usage is not yet known.
 * Assumes a full cache miss on purpose — see RESERVE_SAFETY_FACTOR.
 */
export function estimateUnits(input: {
  pageCount: number;
  historyChars: number;
  questionChars: number;
}): number {
  const pdfTokens = Math.max(0, input.pageCount) * TOKENS_PER_PDF_PAGE;
  // ~4 chars/token is the usual English approximation; Arabic runs denser, so
  // dividing by 3 errs high, which is the safe direction for a reservation.
  const textTokens = Math.ceil((input.historyChars + input.questionChars) / 3);
  const systemTokens = 500;
  const raw =
    (pdfTokens + textTokens + systemTokens) * UNIT_WEIGHT_UNCACHED_INPUT +
    ASSUMED_OUTPUT_TOKENS * UNIT_WEIGHT_OUTPUT;
  return Math.ceil(raw * RESERVE_SAFETY_FACTOR);
}

export function unitsToUsd(units: number): number {
  return units * USD_PER_UNIT;
}

/* ------------------------------------------------------------------ *
 * Access
 * ------------------------------------------------------------------ */

/**
 * Server-side mirror of hasMCQAccess() in src/App.tsx.
 *
 * The client's copy decides what to render; this one decides what is spent, so
 * it reads the user document with the Admin SDK and never accepts a
 * subscription claim from the request body.
 *
 * Admins pass the access check but are deliberately NOT exempt from the daily
 * allowance — the point is that staff experience the same flow students do.
 */
export function hasAiAccess(userData: any, now: Date = new Date()): boolean {
  if (!userData) return false;
  if (userData.role === 'admin' || userData.isMasterAdmin) return true;
  if (!userData.isSubscribed) return false;
  const end = userData.subscriptionEnd;
  if (!end) return true;
  const endDate = typeof end?.toDate === 'function' ? end.toDate() : new Date(end);
  return endDate > now;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function normaliseSettings(raw: any, now: Date = new Date()): SimosanSettings {
  const month = baghdadMonthKey(now);
  const storedMonth = raw?.month;
  // A new month zeroes the accumulator and clears the alert log. Doing it on
  // read means no cron is required to roll the budget over.
  const rolled = storedMonth !== month;
  return {
    enabled: raw?.enabled !== false,
    model: raw?.model || DEFAULT_MODEL,
    dailyUnitBudget: Number(raw?.dailyUnitBudget) > 0
      ? Number(raw.dailyUnitBudget)
      : DEFAULT_DAILY_UNIT_BUDGET,
    monthlyCeilingUsd: Number(raw?.monthlyCeilingUsd) > 0
      ? Number(raw.monthlyCeilingUsd)
      : DEFAULT_MONTHLY_CEILING_USD,
    month,
    monthUsd: rolled ? 0 : Number(raw?.monthUsd) || 0,
    alertsSent: rolled ? [] : (Array.isArray(raw?.alertsSent) ? raw.alertsSent : []),
  };
}

export async function readSettings(
  ctx: SimosanCtx,
  now: Date = new Date(),
): Promise<SimosanSettings> {
  const snap = await ctx.db.collection('app_settings').doc('simosan').get();
  return normaliseSettings(snap.exists ? snap.data() : null, now);
}

/* ------------------------------------------------------------------ *
 * Reserve / reconcile / release
 * ------------------------------------------------------------------ */

export interface ReserveResult {
  ok: boolean;
  reason?: DenyReason;
  /** Units actually held. Pass this back to reconcile or release. */
  reserved: number;
  remaining: number;
  dailyBudget: number;
  resetsInMs: number;
}

/**
 * Hold energy before calling Gemini.
 *
 * This runs in a transaction and it is the only thing standing between the
 * budget and a student firing ten requests at once — without it, all ten read
 * a full bar, all ten pass, and the daily allowance is meaningless.
 */
export async function reserveEnergy(
  ctx: SimosanCtx,
  input: { uid: string; stageId: string; estimatedUnits: number },
  now: Date = new Date(),
): Promise<ReserveResult> {
  const { db, FieldValue } = ctx;
  const day = baghdadDayKey(now);
  const usageRef = db.collection('aiUsage').doc(usageDocId(input.uid, day));
  const settingsRef = db.collection('app_settings').doc('simosan');

  return db.runTransaction(async (t) => {
    const [settingsSnap, usageSnap] = await Promise.all([
      t.get(settingsRef),
      t.get(usageRef),
    ]);
    const settings = normaliseSettings(settingsSnap.exists ? settingsSnap.data() : null, now);
    const resetsInMs = msUntilBaghdadReset(now);

    const deny = (reason: DenyReason, spent = 0): ReserveResult => ({
      ok: false,
      reason,
      reserved: 0,
      remaining: Math.max(0, settings.dailyUnitBudget - spent),
      dailyBudget: settings.dailyUnitBudget,
      resetsInMs,
    });

    if (!settings.enabled) return deny('disabled');
    if (settings.monthUsd >= settings.monthlyCeilingUsd) return deny('ceiling_reached');

    const data = usageSnap.exists ? usageSnap.data() : null;
    const sameDay = !data || data.day === day;
    const used = sameDay ? Number(data?.unitsUsed) || 0 : 0;
    const held = sameDay ? Number(data?.unitsReserved) || 0 : 0;
    const spent = used + held;

    if (spent + input.estimatedUnits > settings.dailyUnitBudget) {
      return deny('insufficient_energy', spent);
    }

    t.set(
      usageRef,
      {
        uid: input.uid,
        // Stamped from the caller's user document, never from the request body
        // — the rule userMCQStats was forced into after the leaderboard leak.
        stageId: input.stageId,
        day,
        unitsUsed: used,
        unitsReserved: held + input.estimatedUnits,
        requestCount: sameDay ? Number(data?.requestCount) || 0 : 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      ok: true,
      reserved: input.estimatedUnits,
      remaining: Math.max(0, settings.dailyUnitBudget - spent - input.estimatedUnits),
      dailyBudget: settings.dailyUnitBudget,
      resetsInMs,
    };
  });
}

/**
 * Replace a reservation with what the call actually cost, and roll the monthly
 * spend forward. Returns the post-write state so the caller can fire alerts.
 */
export async function reconcileEnergy(
  ctx: SimosanCtx,
  input: { uid: string; reservedUnits: number; actualUnits: number },
  now: Date = new Date(),
): Promise<{ remaining: number; dailyBudget: number; monthUsd: number; ceilingUsd: number }> {
  const { db, FieldValue } = ctx;
  const day = baghdadDayKey(now);
  const month = baghdadMonthKey(now);
  const usageRef = db.collection('aiUsage').doc(usageDocId(input.uid, day));
  const settingsRef = db.collection('app_settings').doc('simosan');
  const spendUsd = unitsToUsd(input.actualUnits);

  const result = await db.runTransaction(async (t) => {
    const [settingsSnap, usageSnap] = await Promise.all([
      t.get(settingsRef),
      t.get(usageRef),
    ]);
    const settings = normaliseSettings(settingsSnap.exists ? settingsSnap.data() : null, now);
    const data = usageSnap.exists ? usageSnap.data() : null;

    const used = Number(data?.unitsUsed) || 0;
    const held = Number(data?.unitsReserved) || 0;
    const nextUsed = used + input.actualUnits;
    // Floor at zero: a release that raced this reconcile must not push the
    // held total negative and hand the student free budget.
    const nextHeld = Math.max(0, held - input.reservedUnits);

    t.set(
      usageRef,
      {
        uid: input.uid,
        day,
        unitsUsed: nextUsed,
        unitsReserved: nextHeld,
        requestCount: (Number(data?.requestCount) || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const nextMonthUsd = settings.monthUsd + spendUsd;
    t.set(
      settingsRef,
      {
        month,
        monthUsd: nextMonthUsd,
        // Writing these back materialises the defaults on first use, so an
        // admin editing the doc sees real values rather than an empty object.
        enabled: nextMonthUsd >= settings.monthlyCeilingUsd ? false : settings.enabled,
        model: settings.model,
        dailyUnitBudget: settings.dailyUnitBudget,
        monthlyCeilingUsd: settings.monthlyCeilingUsd,
        alertsSent: settings.alertsSent,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      remaining: Math.max(0, settings.dailyUnitBudget - nextUsed - nextHeld),
      dailyBudget: settings.dailyUnitBudget,
      monthUsd: nextMonthUsd,
      ceilingUsd: settings.monthlyCeilingUsd,
      alertsSent: settings.alertsSent,
      month,
    };
  });

  await maybeAlert(ctx, result);
  return result;
}

/**
 * Hand a reservation back untouched.
 *
 * Called on every path where the student did not get an answer — network
 * failure, safety block, a stream that died halfway. Losing budget to an
 * outage would be the app's bug charged to the student.
 */
export async function releaseEnergy(
  ctx: SimosanCtx,
  input: { uid: string; reservedUnits: number },
  now: Date = new Date(),
): Promise<void> {
  const { db, FieldValue } = ctx;
  const day = baghdadDayKey(now);
  const usageRef = db.collection('aiUsage').doc(usageDocId(input.uid, day));

  await db.runTransaction(async (t) => {
    const snap = await t.get(usageRef);
    if (!snap.exists) return;
    const held = Number(snap.data()?.unitsReserved) || 0;
    t.set(
      usageRef,
      {
        unitsReserved: Math.max(0, held - input.reservedUnits),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

/**
 * Settle a request Simosan declined as off-topic.
 *
 * The student's energy comes back — declining to answer is not a service they
 * asked for — but the money is still recorded against the monthly ceiling,
 * because the call really did happen. Past MAX_FREE_OFF_TOPIC_PER_DAY the
 * refund stops and the request bills like any other; see the constant for why.
 *
 * Returns whether the refund was granted, so the caller can tell the student.
 */
export async function settleOffTopic(
  ctx: SimosanCtx,
  input: { uid: string; reservedUnits: number; actualUnits: number },
  now: Date = new Date(),
): Promise<{ refunded: boolean; remaining: number; dailyBudget: number }> {
  const { db, FieldValue } = ctx;
  const day = baghdadDayKey(now);
  const month = baghdadMonthKey(now);
  const usageRef = db.collection('aiUsage').doc(usageDocId(input.uid, day));
  const settingsRef = db.collection('app_settings').doc('simosan');
  const spendUsd = unitsToUsd(input.actualUnits);

  const result = await db.runTransaction(async (t) => {
    const [settingsSnap, usageSnap] = await Promise.all([
      t.get(settingsRef),
      t.get(usageRef),
    ]);
    const settings = normaliseSettings(settingsSnap.exists ? settingsSnap.data() : null, now);
    const data = usageSnap.exists ? usageSnap.data() : null;

    const used = Number(data?.unitsUsed) || 0;
    const held = Number(data?.unitsReserved) || 0;
    const offTopic = Number(data?.offTopicCount) || 0;
    const refunded = offTopic < MAX_FREE_OFF_TOPIC_PER_DAY;

    const nextUsed = refunded ? used : used + input.actualUnits;
    const nextHeld = Math.max(0, held - input.reservedUnits);

    t.set(
      usageRef,
      {
        uid: input.uid,
        day,
        unitsUsed: nextUsed,
        unitsReserved: nextHeld,
        offTopicCount: offTopic + 1,
        requestCount: (Number(data?.requestCount) || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // The spend is real either way, so the ceiling always sees it.
    const nextMonthUsd = settings.monthUsd + spendUsd;
    t.set(
      settingsRef,
      {
        month,
        monthUsd: nextMonthUsd,
        enabled: nextMonthUsd >= settings.monthlyCeilingUsd ? false : settings.enabled,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      refunded,
      remaining: Math.max(0, settings.dailyUnitBudget - nextUsed - nextHeld),
      dailyBudget: settings.dailyUnitBudget,
      monthUsd: nextMonthUsd,
      ceilingUsd: settings.monthlyCeilingUsd,
      alertsSent: settings.alertsSent,
      month,
    };
  });

  await maybeAlert(ctx, result);
  return {
    refunded: result.refunded,
    remaining: result.remaining,
    dailyBudget: result.dailyBudget,
  };
}

/** Fire admin alerts for any ceiling threshold newly crossed this month. */
async function maybeAlert(
  ctx: SimosanCtx,
  state: { monthUsd: number; ceilingUsd: number; alertsSent: number[]; month: string },
): Promise<void> {
  if (!ctx.alert || state.ceilingUsd <= 0) return;
  const pct = state.monthUsd / state.ceilingUsd;
  const crossed = ALERT_THRESHOLDS.filter(
    (th) => pct >= th && !state.alertsSent.includes(th),
  );
  if (!crossed.length) return;

  for (const th of crossed) {
    const name = (`budget_${Math.round(th * 100)}`) as SimosanAlert;
    try {
      await ctx.alert(name, {
        monthUsd: state.monthUsd,
        ceilingUsd: state.ceilingUsd,
        month: state.month,
      });
    } catch (e) {
      // An alert that fails must never fail the student's request.
      console.warn('[simosan] alert failed', name, e);
    }
  }

  await ctx.db.collection('app_settings').doc('simosan').set(
    { alertsSent: [...state.alertsSent, ...crossed] },
    { merge: true },
  );
}
