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
import { attendanceInstallation, attendanceRequestId, signDeviceReceipt, signOfflineAttendanceQr } from './attendanceCrypto';
import type { AttendanceTelemetry } from '../../shared/attendanceSecurity';
import {
  STORE_META,
  attendanceDurablePut,
  dbGet,
  getAttendanceReceipt,
  getAttendanceState,
  listAttendanceReceipts,
  saveAttendanceState,
  commitAttendanceCapture,
  changeAttendanceReceipt,
  STORE_ATTENDANCE_COMMANDS,
  dbGetAllByIndex,
  commitDoctorAttendanceSession,
} from '../lib/localDb';

const ATTENDANCE_EVENT = 'simosan-attendance-changed';
const activeSync = new Map<string, Promise<void>>();
const telemetryJobs = new Map<string, Promise<void>>();
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

export async function captureAttendanceQr(rawQrToken: string, cachedOwnerUid?: string): Promise<{
  receipt: LocalAttendanceReceipt;
  alreadySaved: boolean;
}> {
  const current = auth.currentUser;
  const ownerUid = current?.uid || cachedOwnerUid;
  if (!ownerUid || (current && cachedOwnerUid && current.uid !== cachedOwnerUid)) throw new Error('login_required');
  const qrToken = rawQrToken.trim();
  const claims = parseUnverifiedAttendanceQr(qrToken);
  if (!claims) throw new Error('invalid_attendance_qr');

  const now = Date.now();
  try {
    const installation = await attendanceInstallation();
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
      installationId: installation.value,
      devicePublicKey: installation.publicKey,
      capturedAtClient: new Date(now).toISOString(),
      savedAt: now,
      updatedAt: now,
      status: 'pending',
      attemptCount: 0,
      telemetry: { capturedOffline: navigator.onLine === false, location: { state: 'not_requested', phase: 'scan' } },
    };
    const [normalSignature, conflictSignature] = await Promise.all([
      signDeviceReceipt(installation, receipt), signDeviceReceipt(installation, { ...receipt, localDeviceConflict: true }),
    ]);
    receipt.deviceSignature = normalSignature;
    const result = await commitAttendanceCapture(receipt, conflictSignature);
    try {
      emitAttendanceChange();
      if (!result.alreadySaved) {
        capturedMonotonic.set(receipt.requestId, performance.now());
        const job = collectScanLocation(result.receipt).catch(() => undefined).finally(() => telemetryJobs.delete(receipt.requestId));
        telemetryJobs.set(receipt.requestId, job);
        void navigator.storage?.persist?.().catch(() => false);
      }
    } catch {}
    return result;
  } catch {
    throw new Error('attendance_not_saved');
  }
}

async function collectScanLocation(receipt: LocalAttendanceReceipt): Promise<void> {
  if (receipt.telemetry?.capturedOffline || receipt.localDeviceConflict || !navigator.geolocation) return;
  const location = await new Promise<AttendanceTelemetry['location']>(resolve => {
    let complete = false;
    const finish = (value: AttendanceTelemetry['location']) => { if (!complete) { complete = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ state: 'timeout', phase: 'scan' }), 3500);
    navigator.geolocation.getCurrentPosition(position => finish({ state: 'available', phase: 'scan', latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy }),
      error => finish({ state: error.code === 1 ? 'permission_unavailable' : error.code === 3 ? 'timeout' : 'unavailable', phase: 'scan' }),
      { enableHighAccuracy: false, maximumAge: 0, timeout: 3000 });
  });
  await changeAttendanceReceipt(receipt.requestId, current => ({ ...current, telemetry: { ...current.telemetry, location } }));
}

export async function listLocalAttendanceReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
  const receipts = await listAttendanceReceipts<LocalAttendanceReceipt>(ownerUid);
  return receipts.sort((a, b) => b.savedAt - a.savedAt);
}

async function updateReceipt(requestId: string, patch: Partial<LocalAttendanceReceipt>) {
  await changeAttendanceReceipt(requestId, current => {
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
  const current = auth.currentUser;
  const uid = ownerUid || current?.uid;
  if (!uid) return;
  await syncDoctorAttendanceCommands(uid);
  const receipts = (await listLocalAttendanceReceipts(uid)).filter(receipt =>
    receipt.status === 'pending' || receipt.status === 'syncing' || receipt.status === 'waiting_for_login');
  if (!receipts.length) return;
  if (!current || current.uid !== uid) {
    await markBatch(receipts, { status: 'waiting_for_login', reason: 'login_required' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  for (let offset = 0; offset < receipts.length; offset += 25) {
    if (auth.currentUser?.uid !== uid) return;
    const selected = receipts.slice(offset, offset + 25);
    await Promise.all(selected.map(receipt => telemetryJobs.get(receipt.requestId)));
    const batch = await Promise.all(selected.map(async receipt => await getAttendanceReceipt<LocalAttendanceReceipt>(receipt.requestId) || receipt));
    await markBatch(batch, { status: 'syncing', reason: undefined });
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
          continue;
        }
      } else {
        const authFailure = typeof error?.code === 'string' && error.code.startsWith('auth/')
          && error.code !== 'auth/network-request-failed';
        await markBatch(batch, {
          status: authFailure ? 'waiting_for_login' : 'pending',
          reason: authFailure ? 'login_required' : 'retry_later',
        });
        continue;
      }
    }

    const byRequest = new Map(response.results.map(result => [result.requestId, result]));
    for (const receipt of batch) {
      const result = byRequest.get(receipt.requestId);
      if (!result) {
        await updateReceipt(receipt.requestId, { status: 'pending', reason: 'missing_acknowledgement' });
        continue;
      }
      const resolution = result.resolution;
      const status: LocalAttendanceReceipt['status'] =
        resolution === 'confirmed' || resolution === 'already_recorded' ? 'confirmed'
          : resolution === 'needs_review' ? 'review'
            : resolution === 'invalid_evidence' ? 'invalid'
              : 'pending';
      await updateReceipt(receipt.requestId, {
        status,
        resolution,
        reason: result.reason,
        recordId: result.recordId || null,
        receivedAt: result.receivedAt || null,
        recordStatus: result.recordStatus || null,
        recordRevision: Number(result.revision) || undefined,
        telemetry: { capturedOffline: receipt.telemetry?.capturedOffline },
        attemptCount: receipt.attemptCount + 1,
      });
    }
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
  return (await dbGet<{ data: AttendanceOfflinePack }>(STORE_META, `attendance-pack:${ownerUid}:${stageId}`))?.data;
}

export async function getDoctorAttendanceWorkspace(ownerUid: string, stageId?: string): Promise<AttendanceDoctorWorkspace> {
  const key = `attendance-workspace:${ownerUid}:${stageId || ''}`;
  try {
    const data = await apiRequest<AttendanceDoctorWorkspace>(`/api/attendance/doctor/workspace${stageId ? `?stageId=${encodeURIComponent(stageId)}` : ''}`, {}, false, ownerUid);
    await attendanceDurablePut(STORE_META, { key, data });
    return data;
  } catch (error: any) {
    if (error.status === 403) throw error;
    const cached = await dbGet<{ data: AttendanceDoctorWorkspace }>(STORE_META, key);
    if (!cached) throw error;
    return { ...cached.data, offline: true };
  }
}

export async function prepareOfflineAttendance(stageId: string, ownerUid: string): Promise<AttendanceOfflinePack> {
  const installation = await attendanceInstallation();
  const pack = await apiRequest<AttendanceOfflinePack>('/api/attendance/offline/prepare', {
    method: 'POST', body: JSON.stringify({ stageId, publicKey: installation.publicKey }),
  }, false, ownerUid);
  if (pack.ownerUid !== ownerUid) throw new Error('invalid_permit_owner');
  await attendanceDurablePut(STORE_META, { key: `attendance-pack:${ownerUid}:${stageId}`, data: pack });
  return pack;
}

export async function createOfflineAttendanceSession(input: { stageId: string; occurrenceId: string; expectedHeadcount: number }, ownerUid: string) {
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const pack = await getOfflineAttendancePack(ownerUid, input.stageId);
  const occurrence = pack?.bootstrap.occurrences.find(item => item.id === input.occurrenceId);
  if (!pack || !occurrence) throw new Error('offline_setup_required');
  if (!Number.isInteger(input.expectedHeadcount) || input.expectedHeadcount < 1 || input.expectedHeadcount > 10000) throw new Error('invalid_headcount');
  const sessionId = pack.sessions[occurrence.id];
  const qrToken = await signOfflineAttendanceQr(pack.permit, {
    v: 1, typ: 'simosan-attendance', sessionId, challengeId: attendanceRequestId(), occurrenceId: occurrence.id,
    stageId: occurrence.stageId, lectureDate: occurrence.lectureDate, title: occurrence.title, startTime: occurrence.startTime,
    endTime: occurrence.endTime, expectedHeadcount: input.expectedHeadcount,
  });
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  const previous = await dbGet<{ data: AttendanceSessionSnapshot }>(STORE_META, key);
  const snapshot: AttendanceSessionSnapshot = previous?.data || {
    offline: true, serverNow: pack.bootstrap.serverNow,
    session: { id: sessionId, occurrenceId: occurrence.id, occurrence, expectedHeadcount: input.expectedHeadcount, notes: '', status: 'active',
      createdAt: '', reconciliationDeadline: new Date(Date.parse(occurrence.endAt) + 36 * 3600000).toISOString(), revision: 0 },
    roster: pack.roster.map(student => ({ ...student, expectedAttendee: !occurrence.audienceGroups.length || occurrence.audienceGroups.includes(student.subgroup) })),
    records: [], reviewReceipts: [], counts: { confirmed: 0, voided: 0, review: 0, discrepancy: 0 },
  };
  if (snapshot.session.status !== 'active') throw new Error('session_not_editable');
  const command: DoctorAttendanceCommand = { kind: 'import', requestId: attendanceRequestId(), ownerUid, sessionId, input: { qrToken }, status: 'pending' };
  await commitDoctorAttendanceSession({ key, data: snapshot }, command);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return { sessionId, qrToken, revision: snapshot.session.revision, status: 'active' };
}

export async function getMyAttendance(ownerUid: string): Promise<AttendanceMine> {
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
  expectedHeadcount: number;
  notes: string;
  requestId: string;
}): Promise<{ sessionId: string; qrToken: string; revision: number; status: string; existing: boolean; rosterCount: number }> {
  return apiRequest('/api/attendance/sessions', { method: 'POST', body: JSON.stringify(input) });
}

export async function getAttendanceSessionSnapshot(sessionId: string, ownerUid = auth.currentUser?.uid): Promise<AttendanceSessionSnapshot> {
  if (!ownerUid) throw new Error('login_required');
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  try {
    const data = await apiRequest<AttendanceSessionSnapshot>(`/api/attendance/sessions/${encodeURIComponent(sessionId)}`, {}, false, ownerUid);
    await attendanceDurablePut(STORE_META, { key, data }).catch(() => undefined);
    return overlayDoctorCommands(data, ownerUid);
  } catch (error: any) {
    if (error.status === 403) throw error;
    const cached = await dbGet<{ data: AttendanceSessionSnapshot }>(STORE_META, key);
    if (!cached) throw error;
    return overlayDoctorCommands({ ...cached.data, offline: true }, ownerUid);
  }
}

export async function updateAttendanceSession(sessionId: string, input: Record<string, unknown>, ownerUid = auth.currentUser?.uid): Promise<any> {
  if (!ownerUid || (auth.currentUser && auth.currentUser.uid !== ownerUid)) throw new Error('login_required');
  const key = `attendance-doctor:${ownerUid}:${sessionId}`;
  const cached = await dbGet<{ data: AttendanceSessionSnapshot }>(STORE_META, key);
  if (!cached) throw new Error('offline_session_not_cached');
  const snapshot = await overlayDoctorCommands(cached.data, ownerUid);
  const basis = { notes: snapshot.session.notes, expectedHeadcount: snapshot.session.expectedHeadcount };
  const command: DoctorAttendanceCommand = { kind: 'session_update', requestId: String(input.requestId || attendanceRequestId()), ownerUid, sessionId, input: { ...input, basis }, status: 'pending' };
  await commitDoctorAttendanceSession({ key, data: cached.data }, command);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return command;
}

async function overlayDoctorCommands(snapshot: AttendanceSessionSnapshot, ownerUid: string): Promise<AttendanceSessionSnapshot> {
  const commands = (await listDoctorAttendanceCommands(ownerUid)).filter(command => command.sessionId === snapshot.session.id && command.kind === 'session_update' && command.status === 'pending').sort((first, second) => (first.localOrder || 0) - (second.localOrder || 0));
  const session = { ...snapshot.session };
  for (const command of commands) {
    if (typeof command.input.notes === 'string') session.notes = command.input.notes;
    if (typeof command.input.expectedHeadcount === 'number') session.expectedHeadcount = command.input.expectedHeadcount;
    if (command.input.status === 'ended') session.status = 'ended';
  }
  return { ...snapshot, session };
}

export async function markAttendanceManually(sessionId: string, input: Record<string, unknown>, ownerUid = auth.currentUser?.uid): Promise<DoctorAttendanceCommand> {
  if (!ownerUid) throw new Error('login_required');
  if (auth.currentUser && auth.currentUser.uid !== ownerUid) throw new Error('login_required');
  const command: DoctorAttendanceCommand = { requestId: String(input.requestId || attendanceRequestId()), ownerUid, sessionId, input, status: 'pending' };
  await attendanceDurablePut(STORE_ATTENDANCE_COMMANDS, command);
  emitAttendanceChange();
  void syncAttendanceReceipts(ownerUid).catch(() => undefined);
  return command;
}

export interface DoctorAttendanceCommand {
  kind?: 'manual' | 'import' | 'session_update';
  localOrder?: number;
  requestId: string;
  ownerUid: string;
  sessionId: string;
  input: Record<string, unknown>;
  status: 'pending' | 'synced' | 'needs_help';
  reason?: string;
}

export const listDoctorAttendanceCommands = (ownerUid: string) => dbGetAllByIndex<DoctorAttendanceCommand>(STORE_ATTENDANCE_COMMANDS, 'by_owner', IDBKeyRange.only(ownerUid));

export async function syncDoctorAttendanceCommands(ownerUid: string): Promise<void> {
  if (auth.currentUser?.uid !== ownerUid || navigator.onLine === false) return;
  const commands = await listDoctorAttendanceCommands(ownerUid);
  const pending = commands.filter(item => item.status === 'pending').sort((first, second) => Number(second.kind === 'import') - Number(first.kind === 'import') || (first.localOrder || 0) - (second.localOrder || 0));
  const blockedSessions = new Set<string>();
  for (const command of pending) {
    if (auth.currentUser?.uid !== ownerUid) return;
    if (blockedSessions.has(command.sessionId)) continue;
    try {
      const path = command.kind === 'import' ? '/api/attendance/offline/import' : `/api/attendance/sessions/${encodeURIComponent(command.sessionId)}${command.kind === 'session_update' ? '' : '/manual'}`;
      const input: Record<string, unknown> = { ...command.input, requestId: command.requestId };
      if (command.kind === 'session_update') {
        const current = await apiRequest<AttendanceSessionSnapshot>(`/api/attendance/sessions/${encodeURIComponent(command.sessionId)}`, {}, false, ownerUid);
        const basis = command.input.basis as { notes: string; expectedHeadcount: number };
        for (const field of ['notes', 'expectedHeadcount'] as const) {
          if (input[field] !== undefined && current.session[field] !== basis[field] && current.session[field] !== input[field]) throw Object.assign(new Error('revision_conflict'), { status: 409 });
        }
        input.expectedRevision = current.session.revision;
        delete input.basis;
      }
      const result: any = await apiRequest(path, { method: command.kind === 'session_update' ? 'PATCH' : 'POST', body: JSON.stringify(input) }, false, ownerUid);
      const key = `attendance-doctor:${ownerUid}:${command.sessionId}`;
      const cached = await dbGet<{ data: AttendanceSessionSnapshot }>(STORE_META, key);
      if (cached && result.session) {
        const data = { ...cached.data, session: { ...cached.data.session, notes: result.session.notes, expectedHeadcount: result.session.expected_headcount, status: result.session.status, revision: Number(result.session.revision), endedAt: result.session.ended_at } };
        await commitDoctorAttendanceSession({ key, data }, { ...command, status: 'synced' });
      } else if (cached && result.record) {
        const row = result.record;
        const record = { id: row.id, sessionId: row.session_id, rosterStudentId: row.roster_student_id, officialName: row.official_name_snapshot,
          entryMethod: row.entry_method, status: row.status, receivedAt: row.received_at, decidedAt: row.decided_at, reviewFlags: row.review_flags || [], revision: Number(row.revision) };
        const records = cached.data.records.filter(item => item.id !== record.id).concat(record);
        const counts = { ...cached.data.counts, confirmed: records.filter(item => item.status === 'confirmed').length };
        counts.discrepancy = Math.max(0, counts.confirmed - cached.data.session.expectedHeadcount);
        await commitDoctorAttendanceSession({ key, data: { ...cached.data, records, counts } }, { ...command, status: 'synced' });
      } else await attendanceDurablePut(STORE_ATTENDANCE_COMMANDS, { ...command, status: 'synced' });
      emitAttendanceChange();
    } catch (error: any) {
      blockedSessions.add(command.sessionId);
      if ([400, 403, 409].includes(error.status)) {
        await attendanceDurablePut(STORE_ATTENDANCE_COMMANDS, { ...command, status: 'needs_help', reason: error.message });
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

export { canonicalAttendanceState };
