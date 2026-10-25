/**
 * Server-only attendance configuration and readiness validation.
 *
 * IMPORTANT: This module must NEVER be imported by anything under `src/`.
 * It accesses `process.env` and Node crypto APIs that are not available
 * (and must not be bundled) in the browser.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSupabaseAdmin } from './supabaseClient.js';
import { AL_SAFWA_CAMPUS } from './campusLocation.js';

/* ------------------------------------------------------------------ */
/*  Public safe types                                                  */
/* ------------------------------------------------------------------ */

export type AttendanceCheckStatus =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'unreachable'
  | 'schema_missing'
  | 'disabled';

export interface AttendanceReadinessResult {
  ready: boolean;
  checks: {
    supabase: AttendanceCheckStatus;
    schema: AttendanceCheckStatus;
    rpcSurface: AttendanceCheckStatus;
    qrSigning: AttendanceCheckStatus;
    installationSecret: AttendanceCheckStatus;
    campusBoundary: AttendanceCheckStatus;
  };
  missingTables?: string[];
  missingRpcs?: string[];
}

/* ------------------------------------------------------------------ */
/*  Typed configuration error codes                                    */
/* ------------------------------------------------------------------ */

export type AttendanceConfigErrorCode =
  | 'attendance_supabase_not_configured'
  | 'attendance_supabase_invalid'
  | 'attendance_qr_not_configured'
  | 'attendance_qr_invalid'
  | 'attendance_qr_key_mismatch'
  | 'attendance_installation_secret_not_configured'
  | 'attendance_installation_secret_invalid'
  | 'attendance_campus_boundary_invalid';

export class AttendanceConfigError extends Error {
  readonly configCode: AttendanceConfigErrorCode;
  constructor(code: AttendanceConfigErrorCode) {
    super(code);
    this.configCode = code;
  }
}

/**
 * Maps any typed configuration error to the client-safe response.
 * All config errors return the same generic message to prevent
 * information leakage about the server's configuration state.
 */
export function mapConfigErrorToResponse(error: unknown): { status: number; error: string } | null {
  if (error instanceof AttendanceConfigError) {
    return { status: 503, error: 'attendance_not_configured' };
  }
  const message = error instanceof Error ? error.message : '';
  // Legacy message-based detection for backwards compatibility
  if (message.includes('not_configured') || message.includes('Supabase')) {
    return { status: 503, error: 'attendance_not_configured' };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  PEM normalisation                                                  */
/* ------------------------------------------------------------------ */

const normalizePem = (value: string | undefined) =>
  (value || '').replace(/\\n/g, '\n').trim();

/* ------------------------------------------------------------------ */
/*  Key ID validation                                                  */
/* ------------------------------------------------------------------ */

const KEY_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/* ------------------------------------------------------------------ */
/*  QR key configuration with current-key override prevention          */
/* ------------------------------------------------------------------ */

export interface QrKeyConfig {
  privateKey: string;
  keyId: string;
  publicKeys: Record<string, string>;
}

export function validateQrKeyConfig(): QrKeyConfig {
  const privateKeyPem = normalizePem(process.env.ATTENDANCE_QR_PRIVATE_KEY);
  const keyId = (process.env.ATTENDANCE_QR_KEY_ID || 'attendance-v1').trim();

  if (!keyId || !KEY_ID_PATTERN.test(keyId)) {
    throw new AttendanceConfigError('attendance_qr_not_configured');
  }

  if (!privateKeyPem) {
    throw new AttendanceConfigError('attendance_qr_not_configured');
  }

  // Parse and validate the private key is P-256
  let privateKeyObj: crypto.KeyObject;
  try {
    privateKeyObj = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new AttendanceConfigError('attendance_qr_invalid');
  }

  const detail = privateKeyObj.asymmetricKeyType;
  if (detail !== 'ec') {
    throw new AttendanceConfigError('attendance_qr_invalid');
  }

  // Verify it's P-256 by exporting as JWK and checking curve
  const jwk = privateKeyObj.export({ format: 'jwk' });
  if (jwk.crv !== 'P-256') {
    throw new AttendanceConfigError('attendance_qr_invalid');
  }

  // Derive the current active public key from the private key
  const derivedPublicKey = crypto.createPublicKey(privateKeyObj)
    .export({ type: 'spki', format: 'pem' }).toString();

  // Verify signing actually works
  try {
    const testPayload = { test: true };
    const token = jwt.sign(testPayload, privateKeyPem, { algorithm: 'ES256', keyid: keyId });
    jwt.verify(token, derivedPublicKey, { algorithms: ['ES256'] });
  } catch {
    throw new AttendanceConfigError('attendance_qr_invalid');
  }

  // Parse retained verification keys
  const publicKeys: Record<string, string> = {};
  publicKeys[keyId] = derivedPublicKey;

  const configuredJson = process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON;
  if (configuredJson) {
    let configured: Record<string, unknown>;
    try {
      configured = JSON.parse(configuredJson);
    } catch {
      throw new AttendanceConfigError('attendance_qr_invalid');
    }

    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new AttendanceConfigError('attendance_qr_invalid');
    }

    for (const [kid, value] of Object.entries(configured)) {
      if (typeof value !== 'string' || !kid) continue;
      const pem = normalizePem(value);
      if (!pem) continue;

      // Validate that each public key is a valid P-256 key
      try {
        const keyObj = crypto.createPublicKey(pem);
        const keyJwk = keyObj.export({ format: 'jwk' });
        if (keyJwk.crv !== 'P-256') {
          throw new AttendanceConfigError('attendance_qr_invalid');
        }
      } catch (err) {
        if (err instanceof AttendanceConfigError) throw err;
        throw new AttendanceConfigError('attendance_qr_invalid');
      }

      if (kid === keyId) {
        // Current key ID: must match the derived public key
        const configuredNormalized = normalizePem(pem);
        const derivedNormalized = normalizePem(derivedPublicKey);
        if (configuredNormalized !== derivedNormalized) {
          throw new AttendanceConfigError('attendance_qr_key_mismatch');
        }
        // Already set, skip
      } else {
        // Older retained key: accept
        publicKeys[kid] = pem;
      }
    }
  }

  return { privateKey: privateKeyPem, keyId, publicKeys };
}

/* ------------------------------------------------------------------ */
/*  Installation secret validation                                     */
/* ------------------------------------------------------------------ */

export function validateInstallationSecret(): string {
  const secret = process.env.ATTENDANCE_INSTALLATION_SECRET;
  if (!secret) {
    throw new AttendanceConfigError('attendance_installation_secret_not_configured');
  }
  // At least 32 bytes of high-entropy material
  if (secret.length < 32) {
    throw new AttendanceConfigError('attendance_installation_secret_invalid');
  }
  return secret;
}

/* ------------------------------------------------------------------ */
/*  Campus boundary validation                                         */
/* ------------------------------------------------------------------ */

export interface CampusBoundaryConfig {
  status: 'ok' | 'disabled' | 'invalid';
  boundary?: { latitude: number; longitude: number; radiusMeters: number };
}

export function validateCampusBoundary(): CampusBoundaryConfig {
  return {
    status: 'ok',
    boundary: {
      latitude: AL_SAFWA_CAMPUS.lat,
      longitude: AL_SAFWA_CAMPUS.lng,
      radiusMeters: AL_SAFWA_CAMPUS.radiusMeters,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Supabase URL validation                                            */
/* ------------------------------------------------------------------ */

export function validateSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new AttendanceConfigError('attendance_supabase_not_configured');
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new AttendanceConfigError('attendance_supabase_invalid');
    }
  } catch (err) {
    if (err instanceof AttendanceConfigError) throw err;
    throw new AttendanceConfigError('attendance_supabase_invalid');
  }
  return url;
}

/* ------------------------------------------------------------------ */
/*  Required attendance tables                                         */
/* ------------------------------------------------------------------ */

export const REQUIRED_TABLES = [
  'attendance_terms',
  'attendance_occurrences',
  'attendance_sessions',
  'attendance_session_roster',
  'attendance_challenges',
  'attendance_records',
  'attendance_receipts',
  'attendance_audit_events',
  'attendance_device_claims',
  'attendance_enrolled_devices',
  'attendance_commands',
  'attendance_offline_grants',
  'attendance_key_rotation_challenges',
  'attendance_key_aliases',
] as const;

/* ------------------------------------------------------------------ */
/*  Required RPCs                                                      */
/* ------------------------------------------------------------------ */

export const REQUIRED_RPCS = [
  'attendance_claim_command',
  'attendance_create_session',
  'attendance_create_session_v2',
  'attendance_import_offline_session',
  'attendance_manual_record',
  'attendance_receipt_result',
  'attendance_resolve_review',
  'attendance_set_record_status',
  'attendance_submit_receipt',
  'attendance_update_session',
  'attendance_update_session_v2',
  'attendance_create_key_rotation_challenge',
  'attendance_commit_key_rotation',
] as const;

/* ------------------------------------------------------------------ */
/*  Readiness check (cached per process, max 30s)                      */
/* ------------------------------------------------------------------ */

let cachedReadiness: { result: AttendanceReadinessResult; expiresAt: number } | null = null;

export async function checkAttendanceReadiness(forceRefresh = false): Promise<AttendanceReadinessResult> {
  if (!forceRefresh && cachedReadiness && cachedReadiness.expiresAt > Date.now()) {
    return cachedReadiness.result;
  }

  const checks: AttendanceReadinessResult['checks'] = {
    supabase: 'missing',
    schema: 'missing',
    rpcSurface: 'missing',
    qrSigning: 'missing',
    installationSecret: 'missing',
    campusBoundary: 'missing',
  };
  const missingTables: string[] = [];
  const missingRpcs: string[] = [];

  // 1. Validate Supabase URL
  try {
    validateSupabaseUrl();
    checks.supabase = 'ok';
  } catch (err) {
    if (err instanceof AttendanceConfigError) {
      checks.supabase = err.configCode.includes('invalid') ? 'invalid' : 'missing';
    }
  }

  // 2. Validate Supabase service key via read-only probe
  if (checks.supabase === 'ok') {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      checks.supabase = 'missing';
    } else {
      const client = getSupabaseAdmin();
      if (!client) {
        checks.supabase = 'invalid';
      } else {
        try {
          // Try a simple read-only query to verify credentials
          const { error } = await client.from('attendance_terms').select('id').limit(0);
          if (error) {
            const code = String(error.code || '');
            const msg = String(error.message || '');
            if (code === 'PGRST205' || code === '42P01' || /does not exist/i.test(msg)) {
              // Table doesn't exist but credentials work
              checks.supabase = 'ok';
            } else if (/auth|invalid|key|jwt/i.test(msg)) {
              checks.supabase = 'invalid';
            } else {
              checks.supabase = 'unreachable';
            }
          }
        } catch {
          checks.supabase = 'unreachable';
        }
      }
    }
  }

  // 3. Check required tables (schema check)
  if (checks.supabase === 'ok') {
    const client = getSupabaseAdmin();
    if (client) {
      try {
        for (const table of REQUIRED_TABLES) {
          const { error } = await client.from(table).select('*').limit(0);
          if (error) {
            const code = String(error.code || '');
            const msg = String(error.message || '');
            if (code === 'PGRST205' || code === '42P01' || /does not exist|schema cache/i.test(msg)) {
              missingTables.push(table);
            } else if (/auth|jwt/i.test(msg)) {
              checks.schema = 'invalid';
              break;
            } else {
              checks.schema = 'unreachable';
              break;
            }
          }
        }
        if (checks.schema === 'missing') {
          checks.schema = missingTables.length ? 'schema_missing' : 'ok';
        }
      } catch {
        checks.schema = 'unreachable';
      }
    }
  }

  // 4. Check required RPCs via OpenAPI document
  if (checks.supabase === 'ok') {
    try {
      const supabaseUrl = process.env.SUPABASE_URL!;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
      const restUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/`;
      const response = await fetch(restUrl, {
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Accept': 'application/openapi+json',
        },
      });
      if (response.ok) {
        const openApi = await response.json() as { paths?: Record<string, unknown> };
        const paths = openApi.paths || {};
        for (const rpc of REQUIRED_RPCS) {
          if (!paths[`/rpc/${rpc}`]) {
            missingRpcs.push(rpc);
          }
        }
        checks.rpcSurface = missingRpcs.length ? 'schema_missing' : 'ok';
      } else {
        checks.rpcSurface = 'unreachable';
      }
    } catch {
      checks.rpcSurface = 'unreachable';
    }
  }

  // 5. QR signing validation
  try {
    validateQrKeyConfig();
    checks.qrSigning = 'ok';
  } catch (err) {
    if (err instanceof AttendanceConfigError) {
      if (err.configCode === 'attendance_qr_key_mismatch') {
        checks.qrSigning = 'invalid';
      } else if (err.configCode === 'attendance_qr_invalid') {
        checks.qrSigning = 'invalid';
      } else {
        checks.qrSigning = 'missing';
      }
    }
  }

  // 6. Installation secret
  try {
    validateInstallationSecret();
    checks.installationSecret = 'ok';
  } catch (err) {
    if (err instanceof AttendanceConfigError) {
      checks.installationSecret = err.configCode.includes('invalid') ? 'invalid' : 'missing';
    }
  }

  // 7. Campus boundary
  try {
    const campus = validateCampusBoundary();
    checks.campusBoundary = campus.status;
  } catch (err) {
    if (err instanceof AttendanceConfigError) {
      checks.campusBoundary = 'invalid';
    }
  }

  // Campus coordinates are compiled into the shared attendance implementation.
  const requiredChecks: (keyof AttendanceReadinessResult['checks'])[] = [
    'supabase', 'schema', 'rpcSurface', 'qrSigning', 'installationSecret',
  ];
  const ready = requiredChecks.every(k => checks[k] === 'ok')
    && checks.campusBoundary === 'ok';

  const result: AttendanceReadinessResult = {
    ready,
    checks,
    ...(missingTables.length ? { missingTables } : {}),
    ...(missingRpcs.length ? { missingRpcs } : {}),
  };

  // Cache for 30 seconds
  cachedReadiness = { result, expiresAt: Date.now() + 30_000 };

  return result;
}

/** Clear the cached readiness result (useful for testing) */
export function clearReadinessCache(): void {
  cachedReadiness = null;
}

/**
 * Verify that the readiness result contains no secret values.
 * Returns true if the result is safe to send to a client.
 */
export function isReadinessResultSafe(result: AttendanceReadinessResult): boolean {
  const serialized = JSON.stringify(result);
  // Check for common secret patterns
  const dangerousPatterns = [
    /-----BEGIN/i,
    /-----END/i,
    /PRIVATE KEY/i,
    /eyJ[A-Za-z0-9_-]{10,}/,  // JWT-like tokens
    /supabase.*key/i,
  ];
  return !dangerousPatterns.some(pattern => pattern.test(serialized));
}
