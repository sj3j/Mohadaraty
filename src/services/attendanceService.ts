import {
  canonicalAttendanceState,
  parseUnverifiedAttendanceQr,
  type AttendanceBootstrap,
  type AttendanceMine,
  type AttendanceSessionSnapshot,
  type LocalAttendanceReceipt,
} from '../../shared/attendance';
import { apiUrl } from '../lib/apiBase';
import { auth } from '../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import {
  STORE_META,
  attendanceDurablePut,
  dbGet,
  getAttendanceReceipt,
  getAttendanceState,
  listAttendanceReceipts,
  saveAttendanceReceipt,
  saveAttendanceState,
} from '../lib/localDb';

const INSTALLATION_KEY = 'attendance_installation_id';
const ATTENDANCE_EVENT = 'simosan-attendance-changed';
let activeSync: Promise<void> | null = null;

type AttendanceMeta = { key: string; value: string };
type CachedAttendanceState = { ownerUid: string; data: AttendanceMine; updatedAt: number };

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emitAttendanceChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ATTENDANCE_EVENT));
}

export function subscribeAttendanceChanges(listener: () => void): () => void {
  window.addEventListener(ATTENDANCE_EVENT, listener);
  return () => window.removeEventListener(ATTENDANCE_EVENT, listener);
}

async function installationId(): Promise<string> {
  const stored = await dbGet<AttendanceMeta>(STORE_META, INSTALLATION_KEY).catch(() => undefined);
  if (stored?.value) return stored.value;
  const value = newId();
  await attendanceDurablePut(STORE_META, { key: INSTALLATION_KEY, value });
  return value;
}

async function token(forceRefresh = false): Promise<string> {
  const current = auth.currentUser;
  if (!current) throw new Error('login_required');
  return current.getIdToken(forceRefresh);
}

async function apiRequest<T>(path: string, init: RequestInit = {}, forceRefresh = false): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await token(forceRefresh)}`,
      ...(init.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(data?.error || `attendance_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export async function captureAttendanceQr(rawQrToken: string): Promise<{
  receipt: LocalAttendanceReceipt;
  alreadySaved: boolean;
}> {
  const current = auth.currentUser;
  if (!current) throw new Error('login_required');
  const qrToken = rawQrToken.trim();
  const claims = parseUnverifiedAttendanceQr(qrToken);
  if (!claims) throw new Error('invalid_attendance_qr');

  const receipts = await listAttendanceReceipts<LocalAttendanceReceipt>(current.uid);
  const existing = receipts.find(receipt => receipt.sessionId === claims.sessionId);
  if (existing) return { receipt: existing, alreadySaved: true };

  const now = Date.now();
  let receipt: LocalAttendanceReceipt;
  try {
    receipt = {
      requestId: newId(),
      ownerUid: current.uid,
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
      installationId: await installationId(),
      capturedAtClient: new Date(now).toISOString(),
      savedAt: now,
      updatedAt: now,
      status: 'pending',
      attemptCount: 0,
    };
    await saveAttendanceReceipt(receipt);
  } catch {
    throw new Error('attendance_not_saved');
  }
  emitAttendanceChange();
  return { receipt, alreadySaved: false };
}

export async function listLocalAttendanceReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]> {
  const receipts = await listAttendanceReceipts<LocalAttendanceReceipt>(ownerUid);
  return receipts.sort((a, b) => b.savedAt - a.savedAt);
}

async function updateReceipt(requestId: string, patch: Partial<LocalAttendanceReceipt>) {
  const current = await getAttendanceReceipt<LocalAttendanceReceipt>(requestId);
  if (!current) return;
  await saveAttendanceReceipt({ ...current, ...patch, requestId, updatedAt: Date.now() });
  emitAttendanceChange();
}

async function markBatch(receipts: LocalAttendanceReceipt[], patch: Partial<LocalAttendanceReceipt>) {
  for (const receipt of receipts) await updateReceipt(receipt.requestId, patch);
}

async function runSync(ownerUid?: string): Promise<void> {
  const current = auth.currentUser;
  const uid = ownerUid || current?.uid;
  if (!uid) return;
  const receipts = (await listLocalAttendanceReceipts(uid)).filter(receipt =>
    receipt.status === 'pending' || receipt.status === 'syncing' || receipt.status === 'waiting_for_login');
  if (!receipts.length) return;
  if (!current || current.uid !== uid) {
    await markBatch(receipts, { status: 'waiting_for_login', reason: 'login_required' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  for (let offset = 0; offset < receipts.length; offset += 25) {
    const batch = receipts.slice(offset, offset + 25);
    await markBatch(batch, { status: 'syncing', reason: undefined });
    const payload = batch.map(receipt => ({
      requestId: receipt.requestId,
      ownerUid: receipt.ownerUid,
      qrToken: receipt.qrToken,
      sessionId: receipt.sessionId,
      occurrenceId: receipt.occurrenceId,
      installationId: receipt.installationId,
      capturedAtClient: receipt.capturedAtClient,
    }));

    let response: { results: any[] };
    try {
      response = await apiRequest('/api/attendance/receipts/sync', {
        method: 'POST',
        body: JSON.stringify({ receipts: payload }),
      });
    } catch (error: any) {
      if (error?.status === 401) {
        try {
          response = await apiRequest('/api/attendance/receipts/sync', {
            method: 'POST',
            body: JSON.stringify({ receipts: payload }),
          }, true);
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
        attemptCount: receipt.attemptCount + 1,
      });
    }
  }
}

export function syncAttendanceReceipts(ownerUid?: string): Promise<void> {
  if (!activeSync) {
    activeSync = runSync(ownerUid).finally(() => { activeSync = null; });
  }
  return activeSync;
}

export function startAttendanceSync(ownerUid: string): () => void {
  const sync = () => { void syncAttendanceReceipts(ownerUid); };
  const visible = () => { if (document.visibilityState === 'visible') sync(); };
  window.addEventListener('online', sync);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', visible);
  const stopAuth = onAuthStateChanged(auth, current => {
    if (current?.uid === ownerUid) sync();
  });
  sync();
  return () => {
    window.removeEventListener('online', sync);
    window.removeEventListener('focus', sync);
    document.removeEventListener('visibilitychange', visible);
    stopAuth();
  };
}

export async function getAttendanceBootstrap(stageId?: string): Promise<AttendanceBootstrap> {
  const query = stageId ? `?stageId=${encodeURIComponent(stageId)}` : '';
  return apiRequest(`/api/attendance/bootstrap${query}`);
}

export async function getMyAttendance(ownerUid: string): Promise<AttendanceMine> {
  try {
    const data = await apiRequest<AttendanceMine>('/api/attendance/mine');
    await saveAttendanceState<CachedAttendanceState>({ ownerUid, data, updatedAt: Date.now() });
    return data;
  } catch (error) {
    const cached = await getAttendanceState<CachedAttendanceState>(ownerUid);
    if (cached?.data) return cached.data;
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

export async function getAttendanceSessionSnapshot(sessionId: string): Promise<AttendanceSessionSnapshot> {
  return apiRequest(`/api/attendance/sessions/${encodeURIComponent(sessionId)}`);
}

export async function updateAttendanceSession(sessionId: string, input: Record<string, unknown>): Promise<any> {
  return apiRequest(`/api/attendance/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
}

export async function markAttendanceManually(sessionId: string, input: Record<string, unknown>): Promise<any> {
  return apiRequest(`/api/attendance/sessions/${encodeURIComponent(sessionId)}/manual`, {
    method: 'POST', body: JSON.stringify(input),
  });
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
