/**
 * ZainCash Merchant Payment Gateway — API v2 client.
 *
 * Spec: docs.zaincash.iq, "ZainCash Merchant Payment Gateway - Integration
 * Guide", Payment Gateway v2, doc version 1.0 (updated 22 Jan 2026).
 *
 * Lives in shared/ so server.ts (dev) and api/index.ts (production) run the
 * same implementation instead of drifting — see CLAUDE.md.
 *
 * v2 differs from v1 in every meaningful way: OAuth2 client-credentials instead
 * of a body-signed JWT, a gateway-supplied redirectUrl instead of one we build,
 * and JWT callbacks verified with a dedicated API key rather than the client
 * secret.
 */
import jwt from "jsonwebtoken";

/** Values appearing in `status` (inquiry) and `currentStatus`/`previousStatus` (callbacks). */
export type ZainCashStatus =
  | "SUCCESS"
  | "FAILED"
  | "PENDING"
  | "OTP_SENT"
  | "CUSTOMER_AUTHENTICATION_REQUIRED"
  | "EXPIRED"
  | "REFUNDED";

export interface ZainCashConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** HS256 secret for verifying redirect + webhook JWTs. NOT clientSecret. */
  apiKey: string;
  /** ZainCash-issued service identifier. Not free text. */
  serviceType: string;
}

/** Decoded redirect / webhook JWT. */
export interface ZainCashEvent {
  eventType: string;
  eventId: string;
  timestamp: string;
  data: {
    transactionId: string;
    merchantReferenceId: string;
    customerMsisdn?: string;
    orderId: string;
    operationId?: number;
    serviceType?: string;
    language?: string;
    errorMessage?: string | null;
    previousStatus?: ZainCashStatus;
    currentStatus: ZainCashStatus;
    amount?: { currency: string; value: number; feeValue?: number };
  };
}

/**
 * Normalised init result. The gateway nests the identifiers under
 * `transactionDetails` and returns `redirectUrl` at the top level; this is
 * flattened so callers do not have to know that.
 */
export interface ZainCashInitResult {
  transactionId: string;
  externalReferenceId?: string;
  orderId?: string;
  redirectUrl: string;
  expiryTime?: string;
  createdAt?: string;
  amount?: { currency: string; value: number };
}

export interface ZainCashInquiryResult {
  status: ZainCashStatus;
  transactionDetails?: {
    transactionId: string;
    operationId?: number | null;
    externalReferenceId?: string;
    orderId?: string;
    amount?: { currency: string; value: number; feeValue?: number };
  };
  /** Sibling of transactionDetails in the response, not nested inside it. */
  customer?: { phone?: string };
  timeStamps?: Record<string, string | null>;
}

/** Thrown for any non-2xx gateway response, carrying enough to debug with support. */
export class ZainCashError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ZainCashError";
  }
}

/**
 * Written into ZAINCASH_JWT_SECRET while we wait on ZainCash for the API Secret
 * Key. Collapsed to "" so it can never be handed to jwt.verify as a literal
 * key — a token would then have to be signed with the string
 * "PENDING_FROM_SUPPORT" to pass.
 *
 * It no longer blocks /init: verifyGatewayToken falls back to the client
 * secret, so callbacks are verifiable either way. The go-live gate is
 * ZAINCASH_ENV, which stays "uat" until a sandbox payment proves which secret
 * actually signs.
 */
export const JWT_SECRET_PLACEHOLDER = "PENDING_FROM_SUPPORT";

/**
 * Resolve config from the environment. Throws if anything required is missing,
 * so a misconfigured deploy fails loudly at the first payment rather than
 * silently posting to the wrong host — the v1 failure mode.
 *
 * The HS256 callback secret is accepted under two names. The spec is not
 * self-consistent about it — the integration guide calls it the "API Secret
 * Key", ZainCash's own Node sample calls it ZAINCASH_SECRET — so there is no
 * canonical name to match. ZAINCASH_JWT_SECRET is ours and wins;
 * ZAINCASH_API_KEY stays honoured so a deploy that already has it set does not
 * break, and so pasting the secret under either name works.
 */
export type ZainCashEnv = "uat" | "production";

/**
 * Resolve ZAINCASH_ENV. Deliberately has NO default.
 *
 * It used to fall back to "uat", and that is exactly how a production deploy
 * ended up sending production credentials to the sandbox host: the variable was
 * simply never set, and nothing said so. The mismatch then surfaces as a bare
 * 401 from the gateway, three layers below anything that names a cause.
 */
function resolveEnv(): ZainCashEnv {
  const raw = (process.env.ZAINCASH_ENV || "").trim().toLowerCase();
  if (raw === "uat" || raw === "production") return raw;
  throw new Error(
    raw
      ? `ZAINCASH_ENV is "${process.env.ZAINCASH_ENV}"; expected "uat" or "production"`
      : 'ZAINCASH_ENV is not set; expected "uat" or "production"',
  );
}

/**
 * Reject a base URL that disagrees with the environment.
 *
 * ZainCash credentials are bound to their host — verified against the live
 * gateway: our production pair answers 401 at the UAT host, and the published
 * sandbox pair answers 401 at production. So a mismatched pair can never work,
 * and saying so here costs far less than debugging an opaque gateway 401.
 *
 * Only the UAT hostname is checked, never production's. The docs say the
 * production host is "provided during onboarding" and may differ per merchant,
 * so hardcoding ours would reject a legitimate future one.
 */
function assertHostMatchesEnv(env: ZainCashEnv, baseUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`ZainCash base URL is not a valid URL: ${baseUrl}`);
  }

  const isUatHost = hostname.includes("-uat");
  if (env === "uat" && !isUatHost) {
    throw new Error(
      `ZAINCASH_ENV=uat but the base URL is ${hostname}, which is not a UAT host. ` +
        "Credentials are host-bound, so this pair can only ever return 401.",
    );
  }
  if (env === "production" && isUatHost) {
    throw new Error(
      `ZAINCASH_ENV=production but the base URL is ${hostname}, a UAT host. ` +
        "Credentials are host-bound, so this pair can only ever return 401.",
    );
  }
}

export function loadZainCashConfig(): ZainCashConfig {
  const env = resolveEnv();
  const baseUrl = (
    env === "production"
      ? process.env.ZAINCASH_BASE_URL_PRODUCTION
      : process.env.ZAINCASH_BASE_URL_UAT
  )?.replace(/\/+$/, "");

  // Credentials are per environment. The docs say so explicitly, and the
  // published UAT sandbox pair must never be reachable from a production
  // deploy. The unsuffixed name stays honoured as a fallback.
  //
  // Which name won is recorded, because "clientId is present" was never the
  // useful fact — "clientId came from the unsuffixed slot while the host is
  // UAT" is.
  const pickedFrom: Record<string, string> = {};
  const trimmedNames: string[] = [];
  const pick = (name: string): string => {
    const suffixed = `${name}_${env.toUpperCase()}`;
    const from = process.env[suffixed] ? suffixed : process.env[name] ? name : null;
    if (!from) return "";
    pickedFrom[name] = from === name ? `${name} (unsuffixed)` : from;

    // Surrounding whitespace is stripped rather than passed on. A tab or
    // newline pasted into a dashboard field is invisible there, and the OAuth
    // endpoint answers it with 400 invalid_request — which surfaces as a
    // rejected *payment* several layers up and looks nothing like a typo.
    const raw = process.env[from]!;
    const value = raw.trim();
    if (value !== raw) trimmedNames.push(from);
    return value;
  };

  // The HS256 callback secret, under any of the names it goes by.
  const rawApiKey = pick("ZAINCASH_JWT_SECRET") || pick("ZAINCASH_API_KEY");

  const cfg: ZainCashConfig = {
    baseUrl: baseUrl || "",
    clientId: pick("ZAINCASH_CLIENT_ID"),
    clientSecret: pick("ZAINCASH_CLIENT_SECRET"),
    scopes: process.env.ZAINCASH_SCOPES || "payment:read payment:write",
    // The placeholder is never handed out as a literal key.
    apiKey: rawApiKey === JWT_SECRET_PLACEHOLDER ? "" : rawApiKey,
    serviceType: process.env.ZAINCASH_SERVICE_TYPE || "",
  };

  // apiKey is deliberately NOT required. verifyGatewayToken falls back to the
  // client secret, which is always present, so "nothing to verify with" is not
  // a reachable state. Which secret ZainCash actually signs with is still
  // unconfirmed — see verifyGatewayToken.
  const missing = (["baseUrl", "clientId", "clientSecret", "serviceType"] as const)
    .filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(
      `ZainCash not configured (env=${env}, host=${cfg.baseUrl || "unset"}, ` +
        `clientId from ${pickedFrom.ZAINCASH_CLIENT_ID || "nowhere"}); ` +
        `missing: ${missing.join(", ")}`,
    );
  }

  assertHostMatchesEnv(env, cfg.baseUrl);

  if (trimmedNames.length) {
    console.warn(
      `[ZainCash] stripped surrounding whitespace from ${trimmedNames.join(", ")}. ` +
        "Worth removing at the source: it is invisible in a dashboard field.",
    );
  }

  // Interior whitespace cannot be part of an OAuth credential, so it is always
  // a paste accident — and one that only shows up as a gateway error.
  const malformed = (["clientId", "clientSecret"] as const).filter((k) => /\s/.test(cfg[k]));
  if (malformed.length) {
    throw new Error(
      `ZainCash credentials contain whitespace: ${malformed
        .map((k) => pickedFrom[k === "clientId" ? "ZAINCASH_CLIENT_ID" : "ZAINCASH_CLIENT_SECRET"] ?? k)
        .join(", ")}. The gateway answers these with 400 invalid_request.`,
    );
  }

  // The id and the secret are different credentials; identical values mean one
  // was pasted into both fields, which authenticates as nobody.
  if (cfg.clientId === cfg.clientSecret) {
    throw new Error(
      "ZainCash client id and client secret are identical — the same value is in both fields.",
    );
  }

  return cfg;
}

// ─── Public origin ──────────────────────────────────────────────────────────

/** Value APP_URL ships with before anyone sets it. Never a valid origin. */
const APP_URL_PLACEHOLDER = "MY_APP_URL";

/**
 * The origin ZainCash returns the customer to, and the origin our webhook URL
 * is registered under.
 *
 * Derived rather than stored per-URL because dotenv does not expand ${APP_URL},
 * so separate successUrl/failureUrl variables would only drift. Throws rather
 * than falling back: an unset APP_URL used to produce
 * "MY_APP_URL/api/zaincash/success", which the gateway accepts at init and
 * which then strands every paying customer on a dead redirect.
 */
export function resolveAppOrigin(): string {
  const raw = (process.env.APP_URL || "").trim().replace(/\/+$/, "");

  if (!raw || raw === APP_URL_PLACEHOLDER) {
    throw new Error(
      "APP_URL is not set (still the MY_APP_URL placeholder). ZainCash redirect " +
        "URLs cannot be built without a real public origin.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_URL is not a valid URL: ${raw}`);
  }

  // Plain http is allowed only for local development. The spec requires HTTPS
  // for every redirect and notification URL.
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error(`APP_URL must be https:// (got ${url.protocol}//${url.host})`);
  }

  return raw;
}

/** Where the gateway sends the customer back on success. */
export const successUrlFor = (origin = resolveAppOrigin()) => `${origin}/api/zaincash/success`;
/** Where the gateway sends the customer back on failure or cancel. */
export const failureUrlFor = (origin = resolveAppOrigin()) => `${origin}/api/zaincash/failure`;
// ─── Tenant tagging ─────────────────────────────────────────────────────────

/**
 * Prefix stamped onto every orderId this app sends to the gateway.
 *
 * One merchant account can serve more than one app, but ZainCash registers a
 * single webhook URL for it. Tagging orderId lets whichever app receives the
 * webhook tell whose payment it is and forward the ones that are not its own.
 * externalReferenceId cannot carry this — the spec types it as a UUID — but
 * orderId is explicitly "your internal order identifier", free-form.
 */
export const TENANT_PREFIX = "ml_";

/** Stamp our tenant prefix onto a local id before sending it to the gateway. */
export function tagOrderId(localId: string): string {
  return `${TENANT_PREFIX}${localId}`;
}

/**
 * Split a gateway orderId back into tenant + local id.
 *
 * An untagged id is returned unchanged with `tenant: null` so payments created
 * before tagging existed still settle.
 */
export function parseOrderId(orderId: string): { tenant: string | null; id: string } {
  const match = /^([a-z]{2}_)(.+)$/.exec(orderId || "");
  return match ? { tenant: match[1], id: match[2] } : { tenant: null, id: orderId };
}

// ─── Transport ──────────────────────────────────────────────────────────────

/**
 * Read a gateway response body, distinguishing "the gateway is down" from "the
 * gateway said no".
 *
 * When ZainCash is unavailable it answers with an HTML error page rather than
 * JSON. Parsing that as JSON yields an empty object and a misleading generic
 * failure, which sent us hunting for credential bugs during a v1 outage. The
 * HTML is detected and surfaced as such instead.
 */
async function readGatewayBody(res: any): Promise<{ data: any; html: string | null }> {
  if (typeof res?.text !== "function") {
    // Test doubles and shims that implement only json().
    const data = await res?.json?.().catch(() => undefined);
    return { data: data ?? {}, html: null };
  }

  const text: string = await res.text().catch(() => "");
  if (/^s*(<!doctype html|<html)/i.test(text)) {
    return { data: {}, html: text.slice(0, 200) };
  }
  try {
    return { data: text ? JSON.parse(text) : {}, html: null };
  } catch {
    return { data: {}, html: null };
  }
}

// ─── OAuth2 ─────────────────────────────────────────────────────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;

/** Discard the cached token. Exported for tests and for 401 recovery. */
export function resetTokenCache(): void {
  tokenCache = null;
}

/**
 * POST {base}/oauth2/token — client_credentials grant, form-urlencoded.
 * Cached until 60s before expiry.
 */
export async function getAccessToken(cfg: ZainCashConfig, forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: cfg.scopes,
  });

  const res = await fetch(`${cfg.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const { data, html } = await readGatewayBody(res);
  if (html) {
    throw new ZainCashError(
      `ZainCash is unavailable (HTML error page, HTTP ${res.status})`,
      res.status,
      html,
    );
  }
  if (!res.ok || !data?.access_token) {
    throw new ZainCashError("ZainCash token request failed", res.status, data);
  }

  // expires_in is seconds; fall back to 5 minutes if the gateway omits it.
  const ttlMs = (Number(data.expires_in) || 300) * 1000;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
  return data.access_token;
}

/** Authenticated request that retries once with a fresh token on a 401. */
async function authedFetch(
  cfg: ZainCashConfig,
  path: string,
  init: { method: string; body?: string },
): Promise<any> {
  const call = async (token: string) =>
    fetch(`${cfg.baseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(init.body ? { body: init.body } : {}),
    });

  let res = await call(await getAccessToken(cfg));
  if (res.status === 401) {
    res = await call(await getAccessToken(cfg, true));
  }

  const { data, html } = await readGatewayBody(res);
  if (html) {
    throw new ZainCashError(
      `ZainCash is unavailable (HTML error page, HTTP ${res.status})`,
      res.status,
      html,
    );
  }
  if (!res.ok) {
    throw new ZainCashError(`ZainCash ${init.method} ${path} failed`, res.status, data);
  }
  return data;
}

// ─── Transactions ───────────────────────────────────────────────────────────

export interface InitTransactionInput {
  /** Unique per payment attempt. Idempotency + reconciliation key. */
  externalReferenceId: string;
  /** Our own identifier — the Firestore subscription document id. */
  orderId: string;
  amount: number;
  /** Must match the caller's app locale. */
  language: "en" | "ar" | "ku";
  successUrl: string;
  failureUrl: string;
  /**
   * Omit on a customer's first payment: the gateway then prompts for the wallet
   * number, which we capture from the success callback for reuse.
   */
  customerPhone?: string;
}

/** POST /api/v2/payment-gateway/transaction/init — scope: payment:write */
export async function initTransaction(
  cfg: ZainCashConfig,
  input: InitTransactionInput,
): Promise<ZainCashInitResult> {
  const body: Record<string, unknown> = {
    language: input.language,
    externalReferenceId: input.externalReferenceId,
    orderId: input.orderId,
    serviceType: cfg.serviceType,
    amount: { value: String(input.amount), currency: "IQD" },
    redirectUrls: {
      successUrl: input.successUrl,
      failureUrl: input.failureUrl,
    },
  };
  if (input.customerPhone) {
    body.customer = { phone: input.customerPhone };
  }

  const data = await authedFetch(cfg, "/api/v2/payment-gateway/transaction/init", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // The id lives under transactionDetails; tolerate a top-level one too in case
  // the gateway ever flattens it.
  const transactionId = data?.transactionDetails?.transactionId ?? data?.transactionId;
  if (!data?.redirectUrl || !transactionId) {
    throw new ZainCashError("ZainCash init returned no redirectUrl/transactionId", 502, data);
  }

  return {
    transactionId,
    externalReferenceId:
      data.transactionDetails?.externalReferenceId ?? data.externalReferenceId,
    orderId: data.transactionDetails?.orderId ?? data.orderId,
    redirectUrl: data.redirectUrl,
    expiryTime: data.expiryTime,
    createdAt: data.createdAt,
    amount: data.transactionDetails?.amount ?? data.amount,
  };
}

/** GET /api/v2/payment-gateway/transaction/inquiry/{id} — scope: payment:read */
export async function inquireTransaction(
  cfg: ZainCashConfig,
  transactionId: string,
): Promise<ZainCashInquiryResult> {
  return (await authedFetch(
    cfg,
    `/api/v2/payment-gateway/transaction/inquiry/${encodeURIComponent(transactionId)}`,
    { method: "GET" },
  )) as ZainCashInquiryResult;
}

// ─── Callback verification ──────────────────────────────────────────────────

/**
 * Verify a redirect or webhook JWT.
 *
 * The algorithm is pinned to HS256 on every attempt, as the spec requires:
 * leaving it open would let a forged token select "none" and bypass
 * verification entirely.
 *
 * WHICH secret ZainCash signs with is only half settled. A completed UAT
 * payment on 2026-08-31 verified with the **client secret** — but that is
 * weaker evidence than it looks, because ZainCash issue no API key for the
 * sandbox at all, so it was the only candidate. It tells us their scheme uses
 * the client secret where no separate key exists; it does not tell us what a
 * production merchant with an API key would do.
 *
 * So both stay. The order is what makes this self-resolving: an API key, if one
 * is ever issued and set, wins automatically; absent one, the client secret
 * carries it. Only a real production callback can narrow this further, and
 * there is nothing to gain by guessing early.
 *
 * Accepting either is not a weakening. Both are our own secrets, neither is
 * derivable by an attacker, and a token signed with anything else still fails.
 */
/** Reported once per cold start, not once per payment. */
let fallbackReported = false;

export function verifyGatewayToken(cfg: ZainCashConfig, token: string): ZainCashEvent {
  const candidates = [
    { label: "apiKey", secret: cfg.apiKey },
    { label: "clientSecret", secret: cfg.clientSecret },
  ].filter((c) => !!c.secret);

  let lastError: unknown;
  for (const { label, secret } of candidates) {
    try {
      const event = jwt.verify(token, secret, {
        algorithms: ["HS256"],
      }) as unknown as ZainCashEvent;
      if (label !== "apiKey" && !fallbackReported) {
        fallbackReported = true;
        console.warn(
          `[ZainCash] callbacks verify with the ${label}; no API key is in use.`,
        );
      }
      return event;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("ZainCash callback token could not be verified");
}
