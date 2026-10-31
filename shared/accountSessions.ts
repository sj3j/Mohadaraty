import crypto from 'node:crypto';
import { isMasterAdminEmail, isObserverEmail } from './masterAdmins.js';

export const ACCOUNT_SESSION_COLLECTION = 'accountSessions';
export const ACCOUNT_SESSION_STATE_COLLECTION = 'accountSessionState';
export const ACCOUNT_SESSION_POLICY_PATH = 'app_settings/sessionPolicy';

export type AccountSessionDevice = {
  kind: 'mobile' | 'web' | 'desktop' | 'unknown';
  name: string;
  platform: string;
  operatingSystem: string;
  browser: string;
  appVersion: string;
  userAgent?: string;
};

export type AccountSessionClaims = {
  app_session: true;
  app_session_id: string;
  app_session_generation: number;
};

const clean = (value: unknown, maximum = 160): string =>
  typeof value === 'string' ? value.trim().slice(0, maximum) : '';

export function normalizeSessionDevice(raw: unknown, userAgent?: unknown): AccountSessionDevice {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const kind = ['mobile', 'web', 'desktop'].includes(String(input.kind))
    ? String(input.kind) as AccountSessionDevice['kind'] : 'unknown';
  return {
    kind,
    name: clean(input.name) || 'Unknown device',
    platform: clean(input.platform) || 'Unknown',
    operatingSystem: clean(input.operatingSystem) || 'Unknown',
    browser: clean(input.browser) || 'Unknown',
    appVersion: clean(input.appVersion, 40) || 'Unknown',
    ...(clean(userAgent, 500) ? { userAgent: clean(userAgent, 500) } : {}),
  };
}

function decodedHeader(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try { return decodeURIComponent(value).trim().slice(0, 120); }
  catch { return value.trim().slice(0, 120); }
}

export function requestSessionLocation(headers: Record<string, unknown>): { city: string; country: string } {
  const city = decodedHeader(headers['x-vercel-ip-city'])
    || decodedHeader(headers['cf-ipcity'])
    || decodedHeader(headers['x-city']);
  const country = decodedHeader(headers['x-vercel-ip-country'])
    || decodedHeader(headers['cf-ipcountry'])
    || decodedHeader(headers['x-country-code']);
  return { city: city || 'Unknown', country: country || 'Unknown' };
}

export function isPrivateIp(rawIp: string): boolean {
  if (!rawIp) return true;
  let ip = rawIp.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith('fc00:') || ip.startsWith('fd00:') || ip.startsWith('fe80:')) return true;
  return false;
}

export function extractClientIp(headers: Record<string, unknown>, fallbackIp?: string): string {
  const forwarded = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : '';
  if (forwarded) {
    const list = forwarded.split(',').map(s => s.trim().replace(/^::ffff:/, '')).filter(Boolean);
    const publicCandidate = list.find(ip => !isPrivateIp(ip));
    if (publicCandidate) return publicCandidate;
    if (list[0]) return list[0];
  }
  const realIp = typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'].trim().replace(/^::ffff:/, '') : '';
  if (realIp) return realIp;
  const cfConnectingIp = typeof headers['cf-connecting-ip'] === 'string' ? headers['cf-connecting-ip'].trim().replace(/^::ffff:/, '') : '';
  if (cfConnectingIp) return cfConnectingIp;
  if (fallbackIp) return fallbackIp.trim().replace(/^::ffff:/, '');
  return '';
}

const locationCache = new Map<string, { city: string; country: string; expiresAt: number }>();

export function clearSessionLocationCacheForTests(): void {
  locationCache.clear();
}

export async function fetchGeoIpLocation(ip: string): Promise<{ city: string; country: string } | null> {
  if (typeof fetch === 'undefined') return null;
  const fetchWithTimeout = async (url: string, timeoutMs: number) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      if (timer) clearTimeout(timer);
      return null;
    }
  };

  try {
    const data = await fetchWithTimeout(`https://ipwho.is/${encodeURIComponent(ip)}`, 2500);
    if (data && data.success !== false && (data.country_code || data.city)) {
      return {
        city: clean(data.city, 80) || clean(data.region, 80) || 'Unknown',
        country: clean(data.country_code, 20) || clean(data.country, 40) || 'Unknown',
      };
    }
  } catch { /* try next */ }

  try {
    const data = await fetchWithTimeout(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, 2000);
    if (data && (data.countryCode || data.cityName)) {
      return {
        city: clean(data.cityName, 80) || clean(data.regionName, 80) || 'Unknown',
        country: clean(data.countryCode, 20) || clean(data.countryName, 40) || 'Unknown',
      };
    }
  } catch { /* ignore */ }

  return null;
}

export async function resolveSessionLocation(params: {
  headers?: Record<string, unknown>;
  clientLocation?: unknown;
  fallbackIp?: string;
}): Promise<{ city: string; country: string }> {
  const headers = params.headers || {};
  const headerLocation = requestSessionLocation(headers);
  if (headerLocation.city !== 'Unknown' && headerLocation.country !== 'Unknown') {
    return headerLocation;
  }

  if (params.clientLocation && typeof params.clientLocation === 'object') {
    const rawClient = params.clientLocation as Record<string, unknown>;
    const cCity = clean(rawClient.city, 80);
    const cCountry = clean(rawClient.country, 80);
    if (cCity && cCity !== 'Unknown' && cCountry && cCountry !== 'Unknown') {
      return { city: cCity, country: cCountry };
    }
  }

  const clientIp = extractClientIp(headers, params.fallbackIp);
  if (!clientIp) {
    return headerLocation;
  }

  if (isPrivateIp(clientIp)) {
    return { city: 'Local Development', country: 'Dev' };
  }

  const cached = locationCache.get(clientIp);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      city: headerLocation.city !== 'Unknown' ? headerLocation.city : cached.city,
      country: headerLocation.country !== 'Unknown' ? headerLocation.country : cached.country,
    };
  }

  const resolved = await fetchGeoIpLocation(clientIp);
  if (resolved) {
    if (locationCache.size >= 5000) {
      const firstKey = locationCache.keys().next().value;
      if (firstKey) locationCache.delete(firstKey);
    }
    locationCache.set(clientIp, {
      city: resolved.city,
      country: resolved.country,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return {
      city: headerLocation.city !== 'Unknown' ? headerLocation.city : resolved.city,
      country: headerLocation.country !== 'Unknown' ? headerLocation.country : resolved.country,
    };
  }

  return headerLocation;
}

export async function createAccountSession(params: {
  db: any;
  FieldValue: any;
  uid: string;
  device: unknown;
  headers?: Record<string, unknown>;
  userAgent?: unknown;
  sessionId?: string;
  role?: string;
  fallbackIp?: string;
  clientLocation?: unknown;
}): Promise<{ sessionId: string; generation: number; claims: AccountSessionClaims }> {
  const sessionId = clean(params.sessionId, 80) || crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    const error: any = new Error('invalid_session_id'); error.status = 400; throw error;
  }
  const stateRef = params.db.collection(ACCOUNT_SESSION_STATE_COLLECTION).doc(params.uid);
  const sessionRef = params.db.collection(ACCOUNT_SESSION_COLLECTION).doc(sessionId);
  const device = normalizeSessionDevice(params.device, params.userAgent);
  const rawClientLocation = (params.device && typeof params.device === 'object') ? (params.device as any).location : undefined;
  const location = await resolveSessionLocation({
    headers: params.headers || {},
    clientLocation: params.clientLocation || rawClientLocation,
    fallbackIp: params.fallbackIp,
  });
  let generation = 1;

  await params.db.runTransaction(async (transaction: any) => {
    const stateSnap = await transaction.get(stateRef);
    const existing = await transaction.get(sessionRef);
    if (existing.exists) {
      if (existing.data()?.uid !== params.uid || existing.data()?.status !== 'active') {
        const error: any = new Error('session_nonce_conflict'); error.status = 409; throw error;
      }
      generation = Math.max(1, Number(existing.data()?.generation || 1));
      return;
    }
    generation = Math.max(1, Number(stateSnap.data()?.generation || 1));
    if (!stateSnap.exists) {
      transaction.set(stateRef, {
        uid: params.uid,
        generation,
        preservedSessionId: null,
        updatedAt: params.FieldValue.serverTimestamp(),
      });
    }
    transaction.set(sessionRef, {
      uid: params.uid,
      generation,
      status: 'active',
      roleAtSignIn: clean(params.role, 40) || 'unknown',
      device,
      location,
      signedInAt: params.FieldValue.serverTimestamp(),
      lastSeenAt: params.FieldValue.serverTimestamp(),
      revokedAt: null,
      revokedReason: null,
    });
  });

  return {
    sessionId,
    generation,
    claims: {
      app_session: true,
      app_session_id: sessionId,
      app_session_generation: generation,
    },
  };
}

export function sessionClaimsFromToken(token: Record<string, unknown>): AccountSessionClaims | null {
  const sessionId = clean(token.app_session_id, 80);
  const generation = Number(token.app_session_generation);
  if (token.app_session !== true || !sessionId || !Number.isInteger(generation) || generation < 1) return null;
  return { app_session: true, app_session_id: sessionId, app_session_generation: generation };
}

export function isAccountSessionAuthorized(
  session: Record<string, any>,
  state: Record<string, any>,
  uid: string,
  sessionId: string,
  generation: number,
): boolean {
  const minimumGeneration = Math.max(1, Number(state.generation || 1));
  return session.uid === uid
    && session.status === 'active'
    && Number(session.generation) === generation
    && (generation >= minimumGeneration || state.preservedSessionId === sessionId);
}

async function effectiveSessionState(db: any, uid: string, sessionId: string, generation: number) {
  const [sessionSnap, stateSnap] = await Promise.all([
    db.collection(ACCOUNT_SESSION_COLLECTION).doc(sessionId).get(),
    db.collection(ACCOUNT_SESSION_STATE_COLLECTION).doc(uid).get(),
  ]);
  const session = sessionSnap.data() || {};
  const state = stateSnap.data() || {};
  const minimumGeneration = Math.max(1, Number(state.generation || 1));
  const active = sessionSnap.exists
    && isAccountSessionAuthorized(session, state, uid, sessionId, generation);
  return { active, session, state, minimumGeneration };
}

async function isManagedAccount(db: any, token: Record<string, any>): Promise<boolean> {
  if (!token.uid) return false;
  const email = clean(token.email).toLowerCase();
  if (isMasterAdminEmail(email) || isObserverEmail(email)) return true;
  const userSnap = await db.collection('users').doc(token.uid).get();
  if (userSnap.exists && userSnap.data()?.disabled !== true && userSnap.data()?.staffDisabled !== true) return true;
  if (email) {
    if ((await db.collection('allowed_admins').doc(email).get()).exists) return true;
    const student = await db.collection('students').doc(email).get();
    if (student.exists) return true;
  }
  return (await db.collection('students').doc(token.uid).get()).exists;
}

export async function enforceAccountSession(params: {
  db: any;
  FieldValue: any;
  token: Record<string, any>;
  headers?: Record<string, unknown>;
  fallbackIp?: string;
}): Promise<{ managed: boolean; sessionId?: string }> {
  const claims = sessionClaimsFromToken(params.token);
  if (!claims) {
    if (!await isManagedAccount(params.db, params.token)) return { managed: false };
    const policy = await params.db.doc(ACCOUNT_SESSION_POLICY_PATH).get();
    if (policy.data()?.enforceLegacySessions === true) {
      const error: any = new Error('app_session_required');
      error.code = 'app_session_required';
      throw error;
    }
    return { managed: false };
  }

  const checked = await effectiveSessionState(
    params.db, params.token.uid, claims.app_session_id, claims.app_session_generation,
  );
  if (!checked.active) {
    const error: any = new Error('app_session_revoked');
    error.code = 'app_session_revoked';
    throw error;
  }

  const lastSeen = checked.session.lastSeenAt?.toMillis?.() || 0;
  const curLoc = checked.session.location;
  const isUnknownLocation = !curLoc || (curLoc.city === 'Unknown' && curLoc.country === 'Unknown');
  if (Date.now() - lastSeen > 5 * 60 * 1000 || isUnknownLocation) {
    const location = await resolveSessionLocation({
      headers: params.headers || {},
      fallbackIp: params.fallbackIp,
    });
    if (location.city !== 'Unknown' || location.country !== 'Unknown') {
      void params.db.collection(ACCOUNT_SESSION_COLLECTION).doc(claims.app_session_id).update({
        lastSeenAt: params.FieldValue.serverTimestamp(),
        location,
      }).catch(() => undefined);
    } else if (Date.now() - lastSeen > 5 * 60 * 1000) {
      void params.db.collection(ACCOUNT_SESSION_COLLECTION).doc(claims.app_session_id).update({
        lastSeenAt: params.FieldValue.serverTimestamp(),
      }).catch(() => undefined);
    }
  }
  return { managed: true, sessionId: claims.app_session_id };
}

function iso(value: any): string | null {
  const date = value?.toDate?.() || (value ? new Date(value) : null);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function createAccountSessionHandlers({ admin }: { admin: any }) {
  const db = admin.firestore();

  const guarded = (handler: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try { return await handler(req, res); }
    catch (error: any) {
      console.error('Account session request failed:', error);
      return res.status(Number(error?.status) || 500).json({ error: error?.message || 'session_request_failed' });
    }
  };

  const list = guarded(async (req: any, res: any) => {
    const claims = sessionClaimsFromToken(req.user || {});
    if (!claims) return res.status(428).json({ error: 'app_session_required' });
    const [snapshot, stateSnap] = await Promise.all([
      db.collection(ACCOUNT_SESSION_COLLECTION).where('uid', '==', req.user.uid).get(),
      db.collection(ACCOUNT_SESSION_STATE_COLLECTION).doc(req.user.uid).get(),
    ]);
    const state = stateSnap.data() || {};
    const minimumGeneration = Math.max(1, Number(state.generation || 1));
    const fallbackIp = req.ip || req.socket?.remoteAddress;
    const sessions = await Promise.all(snapshot.docs.map(async (doc: any) => {
      const value = doc.data() || {};
      const authorized = value.status === 'active'
        && (Number(value.generation) >= minimumGeneration || state.preservedSessionId === doc.id);
      let sessionLocation = value.location || { city: 'Unknown', country: 'Unknown' };
      if (doc.id === claims.app_session_id && (sessionLocation.city === 'Unknown' && sessionLocation.country === 'Unknown')) {
        const resolved = await resolveSessionLocation({
          headers: req.headers || {},
          fallbackIp,
        });
        if (resolved.city !== 'Unknown' || resolved.country !== 'Unknown') {
          sessionLocation = resolved;
          void doc.ref.update({ location: resolved }).catch(() => undefined);
        }
      }
      return {
        id: doc.id,
        current: doc.id === claims.app_session_id,
        authorized,
        device: value.device || normalizeSessionDevice(null),
        location: sessionLocation,
        signedInAt: iso(value.signedInAt),
        lastSeenAt: iso(value.lastSeenAt),
      };
    }));
    const filtered = sessions.filter((item: any) => item.authorized || item.current)
      .sort((a: any, b: any) => Number(b.current) - Number(a.current)
        || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    return res.json({ currentSessionId: claims.app_session_id, sessions: filtered });
  });

  const terminate = guarded(async (req: any, res: any) => {
    const claims = sessionClaimsFromToken(req.user || {});
    if (!claims) return res.status(428).json({ error: 'app_session_required' });
    const targetId = clean(req.params.sessionId, 80);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      return res.status(400).json({ error: 'invalid_session_id' });
    }
    const targetRef = db.collection(ACCOUNT_SESSION_COLLECTION).doc(targetId);
    await db.runTransaction(async (transaction: any) => {
      const snap = await transaction.get(targetRef);
      if (!snap.exists || snap.data()?.uid !== req.user.uid) {
        const error: any = new Error('session_not_found'); error.status = 404; throw error;
      }
      transaction.update(targetRef, {
        status: 'revoked',
        revokedAt: admin.firestore.FieldValue.serverTimestamp(),
        revokedReason: targetId === claims.app_session_id ? 'terminated_current' : 'terminated_by_account',
      });
    });
    return res.json({ ok: true, terminatedCurrent: targetId === claims.app_session_id });
  });

  const terminateOthers = guarded(async (req: any, res: any) => {
    const claims = sessionClaimsFromToken(req.user || {});
    if (!claims) return res.status(428).json({ error: 'app_session_required' });
    const stateRef = db.collection(ACCOUNT_SESSION_STATE_COLLECTION).doc(req.user.uid);
    // No limit: a successful response must never leave an older session active.
    // Firestore will fail the transaction (500-write ceiling) rather than
    // silently report success with unrevoked devices.
    const sessionsQuery = db.collection(ACCOUNT_SESSION_COLLECTION).where('uid', '==', req.user.uid);
    let terminated = 0;
    await db.runTransaction(async (transaction: any) => {
      const stateSnap = await transaction.get(stateRef);
      const sessions = await transaction.get(sessionsQuery);
      const nextGeneration = Math.max(1, Number(stateSnap.data()?.generation || 1)) + 1;
      transaction.set(stateRef, {
        uid: req.user.uid,
        generation: nextGeneration,
        preservedSessionId: claims.app_session_id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      sessions.docs.forEach((doc: any) => {
        if (doc.id === claims.app_session_id || doc.data()?.status !== 'active') return;
        terminated++;
        transaction.update(doc.ref, {
          status: 'revoked',
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          revokedReason: 'terminate_all_others',
        });
      });
    });
    return res.json({ ok: true, terminated });
  });

  return { list, terminate, terminateOthers };
}

const ACCOUNT_ROLES = new Set(['student', 'admin', 'moderator', 'support', 'observer', 'doctor', 'master_admin']);

export async function resolveManagedAccountRole(db: any, token: Record<string, any>): Promise<string> {
  const uid = clean(token.uid, 180);
  const email = clean(token.email, 320).toLowerCase();
  if (!uid) { const error: any = new Error('unauthorized'); error.status = 401; throw error; }

  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.data() || {};
  if (user.disabled === true || user.staffDisabled === true) {
    const error: any = new Error('account_disabled'); error.status = 403; throw error;
  }
  if (isMasterAdminEmail(email)) return 'master_admin';
  if (isObserverEmail(email)) return 'observer';
  if (ACCOUNT_ROLES.has(String(user.role || ''))) return String(user.role);

  if (email) {
    const allowed = await db.collection('allowed_admins').doc(email).get();
    if (allowed.exists) return clean(allowed.data()?.role, 40) || 'admin';
    const student = await db.collection('students').doc(email).get();
    if (student.exists) {
      if (student.data()?.isActive === false) {
        const error: any = new Error('account_disabled'); error.status = 403; throw error;
      }
      return 'student';
    }
  }
  const studentByUid = await db.collection('students').doc(uid).get();
  if (studentByUid.exists) {
    if (studentByUid.data()?.isActive === false) {
      const error: any = new Error('account_disabled'); error.status = 403; throw error;
    }
    return 'student';
  }

  const error: any = new Error('account_not_registered'); error.status = 403; throw error;
}

export function createAccountSessionRegistrationHandler({ admin }: { admin: any }) {
  return async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const user = req.user || {};
      const db = admin.firestore();
      const role = await resolveManagedAccountRole(db, user);
      const authUser = await admin.auth().getUser(user.uid);
      if (authUser.disabled) {
        const err: any = new Error('account_disabled');
        err.status = 403;
        throw err;
      }
      const session = await createAccountSession({
        db,
        FieldValue: admin.firestore.FieldValue,
        uid: user.uid,
        role,
        sessionId: req.body?.sessionNonce,
        device: req.body?.device,
        headers: req.headers as Record<string, unknown>,
        userAgent: req.headers?.['user-agent'],
        fallbackIp: req.ip || req.socket?.remoteAddress,
        clientLocation: req.body?.location || req.body?.device?.location,
      });
      const customToken = await admin.auth().createCustomToken(user.uid, {
        ...(authUser.customClaims || {}),
        ...session.claims,
      });
      return res.json({ token: customToken, sessionId: session.sessionId });
    } catch (error: any) {
      console.error('Account session registration failed:', error);
      return res.status(Number(error?.status) || 500).json({ error: error?.message || 'session_registration_failed' });
    }
  };
}
