import {
  canonicalAttendanceState,
  parseUnverifiedAttendanceQr,
  type AttendanceBootstrap,
  type AttendanceMine,
  type AttendanceSessionSnapshot,
  type LocalAttendanceReceipt,
  type AttendanceOfflinePack,
  type AttendanceDoctorWorkspace,
} from '../../shared/attendance';
import { apiUrl } from '../lib/apiBase';
import { auth } from '../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { attendanceRequestId } from './attendanceCrypto';
import type { AttendanceScanLocationEvidence } from '../../shared/attendanceSecurity';
import {
  getAttendanceState,
  saveAttendanceState,
} from '../lib/localDb';
import { getAttendanceRepository, getAttendanceSigner } from './attendanceRepositoryFactory';
import type { StorageHealth } from './attendanceRepository';
import { ensureAttendanceInitialized } from './attendanceMigration';
import { matchEmergencyOccurrence, matchEmergencyStudent, type EmergencyAttendanceInput } from '../../shared/attendanceEmergency';

const ATTENDANCE_EVENT = 'simosan-attendance-changed';
const activeSync = new Map<string, Promise<void>>();
const capturedMonotonic = new Map<string, number>();
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(ATTENDANCE_EVENT) : null;
if (channel) channel.onmessage = () => window.dispatchEvent(new Event(ATTENDANCE_EVENT));

type CachedAttendanceState = { ownerUid: string; data: AttendanceMine; updatedAt: number };

function emitAttendanceChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ATTENDANCE_EVENT));
  channel?.postMessage('changed');
}

export function subscribeAttendanceChanges(listener: () => void): () => void {
  window.addEventListener(ATTENDANCE_EVENT, listener);
  return () => window.removeEventListener(ATTENDANCE_EVENT, listener);
}

async function token(forceRefresh = false, ownerUid?: string): Promise<string> {
  const current = auth.currentUser;
  if (!current || (ownerUid && current.uid !== ownerUid)) throw Object.assign(new Error('login_required'), { status: 401 });
  let timeout: ReturnType<typeof setTimeout>;
  const value = await Promise.race([
    current.getIdToken(forceRefresh),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('attendance_auth_timeout')), 20000); }),
  ]).finally(() => clearTimeout(timeout));
  if (auth.currentUser?.uid !== current.uid) throw Object.assign(new Error('login_required'), { status: 401 });
  return value;
}

export async function attendanceApiRequest<T>(path: string, init: RequestInit = {}, forceRefresh = false, ownerUid = auth.currentUser?.uid): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('attendance_offline');
  const authorization = await token(forceRefresh, ownerUid);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authorization}`,
        ...(init.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error || `attendance_http_${response.status}`), { status: response.status });
    return data as T;
  } finally {
    clearTimeout(timeout);
  }
}
const apiRequest = attendanceApiRequest;

export async function captureAttendanceQr(
  rawQrToken: string,
  cachedOwnerUid: string | undefined,
  scanLocation: AttendanceScanLocationEvidence,
): Promise<{
  receipt: LocalAttendanceReceipt;
  alreadySaved: boolean;
}> {
  await ensureAttendanceInitialized();
  const current = auth.currentUser;
  const ownerUid = current?.uid || cachedOwnerUid;
  if (!ownerUid || (current && cachedOwnerUid && current.uid !== cachedOwnerUid)) throw new Error('login_required');
  const qrToken = rawQrToken.trim();
  const claims = parseUnverifiedAttendanceQr(qrToken);
  if (!claims) throw new Error('invalid_attendance_qr');

  const now = Date.now();
  try {
    const signer = getAttendanceSigner();
    const repo = getAttendanceRepository();
    const identity = await signer.getPublicIdentity();
    const receipt: LocalAttendanceReceipt = {
      requestId: attendanceRequestId(),
      ownerUid,
      qrToken,
      sessionId: claims.sessionId,
      occurrenceId: claims.occurrenceId,
      stageId: claims.stageId,
      occurrence: {
        id: claims.occurrenceId,
        stageId: claims.stageId,
        lectureDate: claims.lectureDate,
        title: claims.title,
        startTime: claims.startTime,
        endTime: claims.endTime,
      },
      installationId: identity.installationId,
      devicePublicKey: identity.publicKey,
      deviceProofVersion: 2,
      locationProof: scanLocation,
      capturedAtClient: new Date(now).toISOString(),
      savedAt: now,
      updatedAt: now,
      status: 'pending',
      attemptCount: 0,
      telemetry: {
        capturedOffline: navigator.onLine === false,
        location: scanLocation,
        scanTime: {
          capturedAt: new Date(now).toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Baghdad',
          utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
          formattedLocalTime: new Intl.DateTimeFormat('ar-IQ', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
          }).format(new Date(now)),
        },
      },
    };
    const [normalSignature, conflictSignature] = await Promise.all([
      signer.signReceipt(receipt),
      signer.signReceipt({ ...receipt, localDeviceConflict: true }),
    ]);
    receipt.deviceSignature = normalSignature;
    const result = await repo.capture({ receipt, conflictSignature });
    try {
      emitAttendanceChange();
      if (!result.alreadySaved) {
        capturedMonotonic.set(receipt.requestId, performance.now());
        void navigator.storage?.persist?.().catch(() => false);
      }
    } catch {}
    return result;
  } catch {
    throw new Error('attendance_not_saved');
  }
}

export async function listLocalAttendanceReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  const receipts = await repo.listReceipts(ownerUid);
  return receipts.sort((a, b) => b.savedAt - a.savedAt);
}

async function updateReceipt(requestId: string, patch: Partial<LocalAttendanceReceipt>) {
  const repo = getAttendanceRepository();
  await repo.updateReceipt(requestId, current => {
    if (patch.recordRevision && (current.recordRevision || 0) > patch.recordRevision) return current;
    if (['pending', 'syncing', 'waiting_for_login'].includes(patch.status || '') && ['confirmed', 'review', 'invalid'].includes(current.status)) return current;
    const fields: Partial<LocalAttendanceReceipt> = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (current.recordRevision && !patch.recordRevision) {
      delete fields.recordId;
      delete fields.recordStatus;
      delete fields.recordRevision;
    }
    return { ...current, ...fields, requestId, updatedAt: Date.now() };
  });
  emitAttendanceChange();
}

async function markBatch(receipts: LocalAttendanceReceipt[], patch: Partial<LocalAttendanceReceipt>) {
  for (const receipt of receipts) await updateReceipt(receipt.requestId, patch);
}

async function runSync(ownerUid?: string): Promise<void> {
  await ensureAttendanceInitialized();
  const current = auth.currentUser;
  const uid = ownerUid || current?.uid;
  if (!uid) return;
  await syncDoctorAttendanceCommands(uid);
  if (!current || current.uid !== uid) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const repo = getAttendanceRepository();
  const { leaseId, receipts: batch } = await repo.acquireUploadLease(uid, 25, 60000);
  if (!batch.length) return;

  const payload = batch.map(receipt => ({
    requestId: receipt.requestId,
    ownerUid: receipt.ownerUid,
    qrToken: receipt.qrToken,
    sessionId: receipt.sessionId,
    occurrenceId: receipt.occurrenceId,
    installationId: receipt.installationId,
    capturedAtClient: receipt.capturedAtClient,
    localDeviceConflict: receipt.localDeviceConflict,
    devicePublicKey: receipt.devicePublicKey,
    deviceSignature: receipt.deviceSignature,
    deviceProofVersion: receipt.deviceProofVersion,
    locationProof: receipt.locationProof,
    telemetry: { ...receipt.telemetry, sameRuntimeElapsedSeconds: capturedMonotonic.has(receipt.requestId) ? Math.max(0, (performance.now() - capturedMonotonic.get(receipt.requestId)!) / 1000) : undefined },
  }));

  let response: { results: any[] };
  try {
    response = await apiRequest('/api/attendance/receipts/sync', {
      method: 'POST',
      body: JSON.stringify({ receipts: payload }),
    }, false, uid);
  } catch (error: any) {
    if (error?.status === 401) {
      try {
        response = await apiRequest('/api/attendance/receipts/sync', {
          method: 'POST',
          body: JSON.stringify({ receipts: payload }),
        }, true, uid);
      } catch (retryError: any) {
        await markBatch(batch, {
          status: retryError?.status === 401 ? 'waiting_for_login' : 'pending',
          reason: retryError?.status === 401 ? 'login_required' : 'retry_later',
        });
        await repo.releaseUploadLease(leaseId);
        return;
      }
    } else {
      const authFailure = typeof error?.code === 'string' && error.code.startsWith('auth/')
        && error.code !== 'auth/network-request-failed';
      await markBatch(batch, {
        status: authFailure ? 'waiting_for_login' : 'pending',
        reason: authFailure ? 'login_required' : 'retry_later',
      });
      await repo.releaseUploadLease(leaseId);
      return;
    }
  }

  const byRequest = new Map(response.results.map(result => [result.requestId, result]));
  const acks: Array<{ requestId: string; resolution: string; reason?: string; recordId?: string; recordRevision?: number }> = [];

  for (const receipt of batch) {
    const result = byRequest.get(receipt.requestId);
    if (!result) {
      await updateReceipt(receipt.requestId, { status: 'pending', reason: 'missing_acknowledgement' });
      continue;
    }
    acks.push({
      requestId: receipt.requestId,
      resolution: result.resolution,
      reason: result.reason,
      recordId: result.recordId || undefined,
      recordRevision: Number(result.revision) || undefined,
    });
  }

  if (acks.length > 0) {
    await repo.acknowledgeBatch(leaseId, acks);
    emitAttendanceChange();
  } else {
    await repo.releaseUploadLease(leaseId);
  }
}

export function syncAttendanceReceipts(ownerUid?: string): Promise<void> {
  const uid = ownerUid || auth.currentUser?.uid;
  if (!uid) return Promise.resolve();
  if (!activeSync.has(uid)) activeSync.set(uid, runSync(uid).finally(() => { activeSync.delete(uid); }));
  return activeSync.get(uid)!;
}

export function startAttendanceSync(ownerUid: string): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout>;
  let delay = 5000;
  const sync = () => {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    void syncAttendanceReceipts(ownerUid).catch(() => undefined).finally(() => {
      running = false;
      if (!stopped) { timer = setTimeout(sync, delay + Math.random() * 1000); delay = Math.min(delay * 2, 60000); }
    });
  };
  const visible = () => { if (document.visibilityState === 'visible') sync(); };
  window.addEventListener('online', sync);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', visible);
  const stopAuth = onAuthStateChanged(auth, current => {
    if (current?.uid === ownerUid) sync();
  });
  sync();
  return () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('online', sync);
    window.removeEventListener('focus', sync);
    document.removeEventListener('visibilitychange', visible);
    stopAuth();
  };
}

export async function getAttendanceBootstrap(stageId?: string, ownerUid = auth.currentUser?.uid): Promise<AttendanceBootstrap> {
  const query = stageId ? `?stageId=${encodeURIComponent(stageId)}` : '';
  try { return await apiRequest(`/api/attendance/bootstrap${query}`, {}, false, ownerUid); }
  catch (error: any) {
    if (error?.status === 403) throw error;
    const pack = ownerUid && stageId ? await getOfflineAttendancePack(ownerUid, stageId) : undefined;
    if (pack) return pack.bootstrap;
    throw error;
  }
}

export async function getOfflineAttendancePack(ownerUid: string, stageId: string): Promise<AttendanceOfflinePack | undefined> {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  const pack = await repo.getMetadata<AttendanceOfflinePack>(`attendance-pack:${ownerUid}:${stageId}`, ownerUid);
  return pack || undefined;
}

export function isOfflineAttendancePackReady(pack: AttendanceOfflinePack | undefined): boolean {
  return !!pack?.expiresAt && Date.parse(pack.expiresAt) > Date.now();
}

const offlinePreparationFlights = new Map<string, Promise<AttendanceOfflinePack | undefined>>();
async function packMatchesCurrentSigner(pack: AttendanceOfflinePack): Promise<boolean> {
  try {
    const payload = JSON.parse(atob(pack.permit.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { publicKey?: JsonWebKey };
    const current = (await getAttendanceSigner().getPublicIdentity()).publicKey;
    return payload.publicKey?.kty === current.kty && payload.publicKey?.crv === current.crv
      && payload.publicKey?.x === current.x && payload.publicKey?.y === current.y;
  } catch { return false; }
}

/** Refreshes silently while online. A still-valid local pack is never discarded on failure. */
export async function ensureOfflineAttendancePrepared(stageId: string, ownerUid: string, forceRefresh = false): Promise<AttendanceOfflinePack | undefined> {
  const key = `${ownerUid}:${stageId}`;
  const inFlight = offlinePreparationFlights.get(key);
  if (inFlight) return inFlight;
  const flight = (async () => {
    const cached = await getOfflineAttendancePack(ownerUid, stageId);
    const validCached = isOfflineAttendancePackReady(cached) && await packMatchesCurrentSigner(cached!);
    const expiresAt = cached?.expiresAt ? Date.parse(cached.expiresAt) : 0;
    if ((!forceRefresh && validCached && expiresAt > Date.now() + 24 * 60 * 60 * 1000)
      || (typeof navigator !== 'undefined' && navigator.onLine === false)) return validCached ? cached : undefined;
    try { return await prepareOfflineAttendance(stageId, ownerUid); }
    catch { return validCached ? cached : undefined; }
  })();
  offlinePreparationFlights.set(key, flight);
  try { return await flight; } finally { offlinePreparationFlights.delete(key); }
}

export async function getDoctorAttendanceWorkspace(ownerUid: string, stageId?: string): Promise<AttendanceDoctorWorkspace> {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  const key = `attendance-workspace:${ownerUid}:${stageId || ''}`;
  try {
    const data = await apiRequest<AttendanceDoctorWorkspace>(`/api/attendance/doctor/workspace${stageId ? `?stageId=${encodeURIComponent(stageId)}` : ''}`, {}, false, ownerUid);
    await repo.setMetadata(key, data, ownerUid);
    return data;
  } catch (error: any) {
    if (error.status === 403) throw error;
    const cached = await repo.getMetadata<AttendanceDoctorWorkspace>(key, ownerUid);
    if (cached) return { ...cached, offline: true };
    const pack = stageId ? await getOfflineAttendancePack(ownerUid, stageId) : undefined;
    if (!pack) throw error;
    const subjects = [...new Map(pack.bootstrap.occurrences.map(item => [item.timetableSessionId, {
      id: item.timetableSessionId, nameAr: item.title, nameEn: item.title,
      type: item.mode === 'practical' ? 'practical' as const : 'theoretical' as const,
      timetableSessionIds: [item.timetableSessionId],
    }])).values()];
    return {
      offline: true, stageId: pack.bootstrap.stageId, bootstrap: pack.bootstrap,
      subjects, roster: pack.roster, sessions: [], records: [],
    };
  }
}

export async function prepareOfflineAttendance(stageId: string, ownerUid: string): Promise<AttendanceOfflinePack> {
  await ensureAttendanceInitialized();
  const signer = getAttendanceSigner();
  const identity = await signer.getPublicIdentity();
  const pack = await apiRequest<AttendanceOfflinePack>('/api/attendance/offline/prepare', {
    method: 'POST', body: JSON.stringify({ stageId, publicKey: identity.publicKey }),
  }, false, ownerUid);
  if (pack.ownerUid !== ownerUid || pack.bootstrap.stageId !== stageId) throw new Error('invalid_permit_owner');
  if (!isOfflineAttendancePackReady(pack)) throw new Error('invalid_offline_permit');
  const repo = getAttendanceRepository();
  await repo.setMetadata(`attendance-pack:${ownerUid}:${stageId}`, pack, ownerUid);
  return pack;
}

export async function createOfflineAttendanceSession(input: { stageId: string; occurrenceId: string; physicalHeadcount?: number | null }, ownerUid: string) {
  await ensureAttendanceInitialized();
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const pack = await getOfflineAttendancePack(ownerUid, input.stageId);
  const occurrence = pack?.bootstrap.occurrences.find(item => item.id === input.occurrenceId);
  if (!pack || !occurrence) throw new Error('offline_setup_required');
  if (!isOfflineAttendancePackReady(pack) || !await packMatchesCurrentSigner(pack)) throw new Error('offline_setup_required');
  if (input.physicalHeadcount != null && (!Number.isInteger(input.physicalHeadcount) || input.physicalHeadcount < 0 || input.physicalHeadcount > 10000)) throw new Error('invalid_headcount');
  const sessionId = pack.sessions[occurrence.id];
  if (!sessionId) throw new Error('offline_setup_required');
  const repo = getAttendanceRepository();
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  const previous = await repo.getMetadata<AttendanceSessionSnapshot>(key, ownerUid);
  const existingToken = (await repo.listDoctorCommands(ownerUid)).find(command => command.kind === 'import' && command.sessionId === sessionId)?.input?.qrToken;
  if (previous) {
    if (previous.session.status !== 'active') throw new Error('session_not_editable');
    if (typeof existingToken !== 'string') throw new Error('offline_session_qr_missing');
    return { sessionId, qrToken: existingToken, revision: previous.session.revision, status: 'active' };
  }
  const signer = getAttendanceSigner();
  const qrToken = await signer.signDoctorQr({
    permit: pack.permit,
    claims: {
      v: 2, typ: 'simosan-attendance', sessionId, challengeId: attendanceRequestId(), occurrenceId: occurrence.id,
      stageId: occurrence.stageId, lectureDate: occurrence.lectureDate, title: occurrence.title, startTime: occurrence.startTime,
      endTime: occurrence.endTime,
    },
  });
  const snapshot: AttendanceSessionSnapshot = {
    offline: true, serverNow: pack.bootstrap.serverNow,
    session: { id: sessionId, occurrenceId: occurrence.id, occurrence, physicalHeadcount: null, notes: '', status: 'active',
      createdAt: new Date().toISOString(), reconciliationDeadline: new Date(Date.parse(occurrence.endAt) + 36 * 3600000).toISOString(), revision: 0 },
    roster: pack.roster.map(student => ({ ...student, expectedAttendee: !occurrence.audienceGroups.length || occurrence.audienceGroups.includes(student.subgroup) })),
    records: [], reviewReceipts: [], counts: { confirmed: 0, voided: 0, review: 0, discrepancy: 0 },
  };
  const command: DoctorAttendanceCommand = { kind: 'import', requestId: attendanceRequestId(), ownerUid, sessionId, input: { qrToken }, status: 'pending' };
  await repo.commitDoctorSession({ meta: { key, data: snapshot }, command });
  if (input.physicalHeadcount != null) await updateAttendanceSession(sessionId, { physicalHeadcount: input.physicalHeadcount, requestId: attendanceRequestId(), reason: '' }, ownerUid);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return { sessionId, qrToken, revision: snapshot.session.revision, status: 'active' };
}

export async function getMyAttendance(ownerUid: string): Promise<AttendanceMine> {
  await ensureAttendanceInitialized();
  try {
    const data = await apiRequest<AttendanceMine>('/api/attendance/mine', {}, false, ownerUid);
    await saveAttendanceState<CachedAttendanceState>({ ownerUid, data, updatedAt: Date.now() }).catch(() => undefined);
    await Promise.all(data.receipts.map(result => updateReceipt(result.requestId, {
      resolution: result.resolution, reason: result.reason, recordId: result.recordId,
      recordStatus: result.recordStatus, recordRevision: Number(result.revision) || undefined,
      status: result.resolution === 'confirmed' || result.resolution === 'already_recorded' ? 'confirmed' : result.resolution === 'invalid_evidence' ? 'invalid' : 'review',
    }))).catch(() => undefined);
    return data;
  } catch (error) {
    const cached = await getAttendanceState<CachedAttendanceState>(ownerUid);
    if (cached?.data) return { ...cached.data, offline: true };
    throw error;
  }
}

export async function createAttendanceSession(input: {
  stageId: string;
  occurrenceId: string;
  physicalHeadcount?: number | null;
  notes: string;
  requestId: string;
}): Promise<{ sessionId: string; qrToken: string; revision: number; status: string; existing: boolean; rosterCount: number }> {
  await ensureAttendanceInitialized();
  const result = await apiRequest<{ sessionId: string; qrToken: string; revision: number; status: string; existing: boolean; rosterCount: number }>('/api/attendance/sessions', { method: 'POST', body: JSON.stringify(input) });
  const repo = getAttendanceRepository();
  await repo.setMetadata(`attendance-doctor-qr:${auth.currentUser?.uid}:${result.sessionId}`, result.qrToken, auth.currentUser?.uid);
  return result;
}

export async function getAttendanceSessionQr(sessionId: string, ownerUid: string): Promise<string> {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  const command = (await repo.listDoctorCommands(ownerUid)).find(item => item.kind === 'import' && item.sessionId === sessionId);
  const local = command?.input?.qrToken || await repo.getMetadata<string>(`attendance-doctor-qr:${ownerUid}:${sessionId}`, ownerUid);
  if (typeof local === 'string' && local) return local;
  const result = await apiRequest<{ qrToken: string }>(`/api/attendance/sessions/${encodeURIComponent(sessionId)}/qr`, {}, false, ownerUid);
  await repo.setMetadata(`attendance-doctor-qr:${ownerUid}:${sessionId}`, result.qrToken, ownerUid);
  return result.qrToken;
}

export async function getAttendanceSessionSnapshot(sessionId: string, ownerUid = auth.currentUser?.uid): Promise<AttendanceSessionSnapshot> {
  await ensureAttendanceInitialized();
  if (!ownerUid) throw new Error('login_required');
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  const repo = getAttendanceRepository();
  try {
    const data = await apiRequest<AttendanceSessionSnapshot>(`/api/attendance/sessions/${encodeURIComponent(sessionId)}`, {}, false, ownerUid);
    await repo.setMetadata(key, data, ownerUid).catch(() => undefined);
    return overlayDoctorCommands(data, ownerUid);
  } catch (error: any) {
    if (error.status === 403) throw error;
    const cached = await repo.getMetadata<AttendanceSessionSnapshot>(key, ownerUid);
    if (!cached) throw error;
    return overlayDoctorCommands({ ...cached, offline: true }, ownerUid);
  }
}

export async function updateAttendanceSession(sessionId: string, input: Record<string, unknown>, ownerUid = auth.currentUser?.uid): Promise<any> {
  await ensureAttendanceInitialized();
  if (!ownerUid || (auth.currentUser && auth.currentUser.uid !== ownerUid)) throw new Error('login_required');
  if (Object.prototype.hasOwnProperty.call(input, 'physicalHeadcount') && input.physicalHeadcount != null
    && (!Number.isInteger(input.physicalHeadcount) || Number(input.physicalHeadcount) < 0 || Number(input.physicalHeadcount) > 10000)) throw new Error('invalid_headcount');
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  const repo = getAttendanceRepository();
  const cached = await repo.getMetadata<AttendanceSessionSnapshot>(key, ownerUid);
  if (!cached) throw new Error('offline_session_not_cached');
  const snapshot = await overlayDoctorCommands(cached, ownerUid);
  const basis = { notes: snapshot.session.notes, physicalHeadcount: snapshot.session.physicalHeadcount };
  const command: DoctorAttendanceCommand = { kind: 'session_update', requestId: String(input.requestId || attendanceRequestId()), ownerUid, sessionId, input: { ...input, basis }, status: 'pending' };
  await repo.commitDoctorSession({ meta: { key, data: cached }, command });
  await repo.setMetadata(key, cached, ownerUid);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return command;
}

async function overlayDoctorCommands(snapshot: AttendanceSessionSnapshot, ownerUid: string): Promise<AttendanceSessionSnapshot> {
  const commands = (await listDoctorAttendanceCommands(ownerUid)).filter(command => command.sessionId === snapshot.session.id && command.kind === 'session_update' && command.status === 'pending').sort((first, second) => (first.localOrder || 0) - (second.localOrder || 0));
  const session = { ...snapshot.session };
  for (const command of commands) {
    if (typeof command.input.notes === 'string') session.notes = command.input.notes;
    if (command.input.physicalHeadcount === null || typeof command.input.physicalHeadcount === 'number') session.physicalHeadcount = command.input.physicalHeadcount as number | null;
    if (command.input.status === 'ended') session.status = 'ended';
  }
  return { ...snapshot, session };
}

export async function markAttendanceManually(sessionId: string, input: Record<string, unknown>, ownerUid = auth.currentUser?.uid): Promise<DoctorAttendanceCommand> {
  await ensureAttendanceInitialized();
  if (!ownerUid) throw new Error('login_required');
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const command: DoctorAttendanceCommand = { requestId: String(input.requestId || attendanceRequestId()), ownerUid, sessionId, input, status: 'pending' };
  const repo = getAttendanceRepository();
  await repo.enqueueDoctorCommand(command);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return command;
}

function validateEmergencyAttendanceDraft(input: EmergencyAttendanceInput): void {
  if (!input.stageId || !input.lectureTitle.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(input.lectureDate)
    || !/^\d{2}:\d{2}$/.test(input.startTime) || (!input.studentIdentifier?.trim() && input.physicalHeadcount == null)
    || (input.studentIdentifier?.trim() && !input.reason?.trim())
    || (input.physicalHeadcount != null && (!Number.isInteger(input.physicalHeadcount) || input.physicalHeadcount < 0 || input.physicalHeadcount > 10000))) {
    throw new Error('invalid_emergency_draft');
  }
}

export async function saveEmergencyAttendanceDraft(ownerUid: string, input: EmergencyAttendanceInput): Promise<DoctorAttendanceCommand> {
  await ensureAttendanceInitialized();
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  validateEmergencyAttendanceDraft(input);
  const command: DoctorAttendanceCommand = {
    kind: 'emergency_draft', requestId: attendanceRequestId(), ownerUid, sessionId: `draft:${attendanceRequestId()}`,
    input: { ...input, lectureTitle: input.lectureTitle.trim(), studentIdentifier: input.studentIdentifier?.trim(), reason: input.reason?.trim(),
      sessionCreateRequestId: attendanceRequestId(), headcountRequestId: attendanceRequestId() }, status: 'pending',
  };
  await getAttendanceRepository().enqueueDoctorCommand(command);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return command;
}

export async function reviseEmergencyAttendanceDraft(ownerUid: string, requestId: string, input: EmergencyAttendanceInput): Promise<void> {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  const command = (await repo.listDoctorCommands(ownerUid)).find(item => item.requestId === requestId);
  if (!command || command.kind !== 'emergency_draft' || command.status !== 'needs_help'
    || !['emergency_occurrence_ambiguous', 'emergency_student_ambiguous'].includes(String(command.reason))) throw new Error('draft_not_editable');
  validateEmergencyAttendanceDraft(input);
  await repo.updateDoctorCommand({ ...command, status: 'pending', reason: undefined,
    input: { ...command.input, ...input, sessionCreateRequestId: attendanceRequestId(), headcountRequestId: attendanceRequestId() },
  });
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
}

export interface DoctorAttendanceCommand {
  kind?: 'manual' | 'import' | 'session_update' | 'emergency_draft';
  localOrder?: number;
  requestId: string;
  ownerUid: string;
  sessionId: string;
  input: Record<string, unknown>;
  status: 'pending' | 'synced' | 'needs_help';
  reason?: string;
  [key: string]: unknown;
}

export const listDoctorAttendanceCommands = async (ownerUid: string): Promise<DoctorAttendanceCommand[]> => {
  await ensureAttendanceInitialized();
  const repo = getAttendanceRepository();
  return (await repo.listDoctorCommands(ownerUid)) as unknown as DoctorAttendanceCommand[];
};

export async function syncDoctorAttendanceCommands(ownerUid: string): Promise<void> {
  await ensureAttendanceInitialized();
  if (auth.currentUser?.uid !== ownerUid || navigator.onLine === false) return;
  const repo = getAttendanceRepository();
  const commands = await listDoctorAttendanceCommands(ownerUid);
  const pending = commands.filter(item => item.status === 'pending').sort((first, second) => Number(second.kind === 'import') - Number(first.kind === 'import') || (first.localOrder || 0) - (second.localOrder || 0));
  const blockedSessions = new Set<string>();
  for (const command of commands) if (command.kind === 'import' && command.status === 'needs_help') blockedSessions.add(command.sessionId);
  for (const command of pending) {
    if (auth.currentUser?.uid !== ownerUid) return;
    if (blockedSessions.has(command.sessionId)) continue;
    try {
      if (command.kind === 'emergency_draft') {
        const draft = command.input as unknown as EmergencyAttendanceInput & { sessionCreateRequestId: string; headcountRequestId: string };
        const workspace = await getDoctorAttendanceWorkspace(ownerUid, draft.stageId);
        if (workspace.offline) throw new Error('attendance_offline');
        const occurrence = matchEmergencyOccurrence(draft, workspace.bootstrap.occurrences);
        if (!occurrence) throw Object.assign(new Error('emergency_occurrence_ambiguous'), { status: 409 });
        const student = draft.studentIdentifier ? matchEmergencyStudent(draft.studentIdentifier, workspace.roster) : null;
        if (draft.studentIdentifier && !student) throw Object.assign(new Error('emergency_student_ambiguous'), { status: 409 });
        const created = await createAttendanceSession({ stageId: draft.stageId, occurrenceId: occurrence.id, physicalHeadcount: null,
          notes: '', requestId: draft.sessionCreateRequestId });
        const current = await getAttendanceSessionSnapshot(created.sessionId, ownerUid);
        if (student) await apiRequest(`/api/attendance/sessions/${encodeURIComponent(created.sessionId)}/manual`, {
          method: 'POST', body: JSON.stringify({ requestId: command.requestId, studentId: student.studentId,
            reason: draft.reason, expectedRevision: current.session.revision }),
        }, false, ownerUid);
        if (draft.physicalHeadcount != null) await updateAttendanceSession(created.sessionId, {
          requestId: draft.headcountRequestId, physicalHeadcount: draft.physicalHeadcount, reason: '',
        }, ownerUid);
        await repo.updateDoctorCommand({ ...command, status: 'synced', sessionId: created.sessionId });
        emitAttendanceChange();
        continue;
      }
      const path = command.kind === 'import' ? '/api/attendance/offline/import' : `/api/attendance/sessions/${encodeURIComponent(command.sessionId)}${command.kind === 'session_update' ? '' : '/manual'}`;
      const input: Record<string, unknown> = { ...command.input, requestId: command.requestId };
      if (command.kind === 'session_update') {
        const current = await apiRequest<AttendanceSessionSnapshot>(`/api/attendance/sessions/${encodeURIComponent(command.sessionId)}`, {}, false, ownerUid);
        const basis = command.input.basis as { notes: string; physicalHeadcount: number | null };
        for (const field of ['notes', 'physicalHeadcount'] as const) {
          if (input[field] !== undefined && current.session[field] !== basis[field] && current.session[field] !== input[field]) throw Object.assign(new Error('revision_conflict'), { status: 409 });
        }
        input.expectedRevision = current.session.revision;
        delete input.basis;
      }
      const result: any = await apiRequest(path, { method: command.kind === 'session_update' ? 'PATCH' : 'POST', body: JSON.stringify(input) }, false, ownerUid);
      const key = `attendance-doctor:${ownerUid}:${command.sessionId}`;
      const cached = await repo.getMetadata<AttendanceSessionSnapshot>(key, ownerUid);
      if (cached && result.session) {
        const data = { ...cached, session: { ...cached.session, notes: result.session.notes, physicalHeadcount: result.session.physical_headcount ?? null, status: result.session.status, revision: Number(result.session.revision), endedAt: result.session.ended_at } };
        await repo.commitDoctorSession({ meta: { key, data }, command: { ...command, status: 'synced' } });
        await repo.setMetadata(key, data, ownerUid);
      } else if (cached && result.record) {
        const row = result.record;
        const record = { id: row.id, sessionId: row.session_id, rosterStudentId: row.roster_student_id, officialName: row.official_name_snapshot,
          entryMethod: row.entry_method, status: row.status, receivedAt: row.received_at, decidedAt: row.decided_at, reviewFlags: row.review_flags || [], revision: Number(row.revision) };
        const records = cached.records.filter(item => item.id !== record.id).concat(record);
        const counts = { ...cached.counts, confirmed: records.filter(item => item.status === 'confirmed').length };
        counts.discrepancy = cached.session.physicalHeadcount == null ? 0 : Math.max(0, counts.confirmed - cached.session.physicalHeadcount);
        const data = { ...cached, records, counts };
        await repo.commitDoctorSession({ meta: { key, data }, command: { ...command, status: 'synced' } });
        await repo.setMetadata(key, data, ownerUid);
      } else {
        await repo.updateDoctorCommand({ ...command, status: 'synced' });
      }
      emitAttendanceChange();
    } catch (error: any) {
      blockedSessions.add(command.sessionId);
      if ([400, 403, 409].includes(error.status)) {
        await repo.updateDoctorCommand({ ...command, status: 'needs_help', reason: error.message });
        emitAttendanceChange();
      }
    }
  }
}

export async function setAttendanceRecordStatus(
  recordId: string,
  status: 'void' | 'restore',
  input: Record<string, unknown>,
): Promise<any> {
  return apiRequest(`/api/attendance/records/${encodeURIComponent(recordId)}/${status}`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export async function resolveAttendanceReview(receiptId: string, input: Record<string, unknown>): Promise<any> {
  return apiRequest(`/api/attendance/reviews/${encodeURIComponent(receiptId)}/resolve`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export async function requestAttendanceKeyRotationChallenge(nonce?: string): Promise<{ challengeId: string; nonce: string }> {
  return apiRequest('/api/attendance/key-rotation/challenge', {
    method: 'POST',
    body: JSON.stringify(nonce ? { nonce } : {}),
  });
}

export async function commitAttendanceKeyRotation(payload: {
  challengeId: string;
  nonce: string;
  oldKey: any;
  newKey: any;
  oldSignature: string;
  newSignature: string;
}): Promise<any> {
  return apiRequest('/api/attendance/key-rotation/commit', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getAttendanceStorageHealth(ownerUid: string): Promise<StorageHealth> {
  const repo = getAttendanceRepository();
  return repo.getHealth(ownerUid);
}

export { canonicalAttendanceState };

