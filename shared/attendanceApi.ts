import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  ATTENDANCE_QR_VERSION,
  ATTENDANCE_RECONCILIATION_DAYS,
  ATTENDANCE_TIMEZONE,
  attendanceTermId,
  buildAttendanceOccurrences,
  findAttendanceTerm,
  type AttendanceOccurrenceCandidate,
  type AttendanceQrClaims,
  type AttendanceRecordView,
  type AttendanceSessionView,
} from './attendance.js';
import { baghdadToday } from './academicCalendar.js';
import { isMasterAdminEmail } from './masterAdmins.js';
import { loadCalendar } from './seasonRollover.js';
import { hasStageCapability, type StaffProjection } from './staffCapabilities.js';
import { studentForToken } from './studentLookup.js';
import { getSupabaseAdmin } from './supabaseClient.js';
import type { StageTimetableDoc } from './timetable.js';
import { verifyAttendanceDevice } from './attendanceDevice.js';
import { summarizeAttendanceTelemetry, type CampusBoundary } from './attendanceSecurity.js';

export interface AttendanceDeps {
  admin: any;
}

type Actor = {
  uid: string;
  staff: StaffProjection;
  student: { id: string; data: any } | null;
};

const MAX_SYNC_RECEIPTS = 25;
const MAX_REASON_LENGTH = 1000;

const normalizePem = (value: string | undefined) => (value || '').replace(/\\n/g, '\n').trim();
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const requestId = () => crypto.randomUUID();

function qrKeyConfig() {
  const privateKey = normalizePem(process.env.ATTENDANCE_QR_PRIVATE_KEY);
  const keyId = (process.env.ATTENDANCE_QR_KEY_ID || 'attendance-v1').trim();
  const publicKeys: Record<string, string> = {};
  if (privateKey) {
    publicKeys[keyId] = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }
  try {
    const configured = JSON.parse(process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON || '{}');
    if (configured && typeof configured === 'object') {
      for (const [kid, value] of Object.entries(configured)) {
        if (typeof value === 'string' && kid) publicKeys[kid] = normalizePem(value);
      }
    }
  } catch {
    throw new Error('ATTENDANCE_QR_PUBLIC_KEYS_JSON is not valid JSON');
  }
  return { privateKey, keyId, publicKeys };
}

export function signAttendanceQr(claims: AttendanceQrClaims): string {
  const { privateKey, keyId } = qrKeyConfig();
  if (!privateKey) throw new Error('attendance_qr_not_configured');
  return jwt.sign(claims, privateKey, {
    algorithm: 'ES256',
    keyid: keyId,
    noTimestamp: true,
  });
}

export function verifyAttendanceQr(token: string): AttendanceQrClaims {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096) {
    throw new Error('invalid_qr');
  }
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && typeof decoded === 'object' && typeof decoded.header?.kid === 'string'
    ? decoded.header.kid
    : '';
  const publicKey = qrKeyConfig().publicKeys[kid];
  if (!publicKey) throw new Error('unknown_qr_key');
  let claims: AttendanceQrClaims;
  try {
    claims = jwt.verify(token, publicKey, { algorithms: ['ES256'] }) as AttendanceQrClaims;
  } catch {
    throw new Error('invalid_qr');
  }
  if (claims.v !== ATTENDANCE_QR_VERSION || claims.typ !== 'simosan-attendance') throw new Error('invalid_qr');
  if (![claims.sessionId, claims.challengeId, claims.occurrenceId, claims.stageId, claims.lectureDate, claims.title, claims.startTime, claims.endTime]
    .every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) {
    throw new Error('invalid_qr');
  }
  return claims;
}

function campusBoundary(): CampusBoundary | undefined {
  const values = [process.env.ATTENDANCE_CAMPUS_LATITUDE, process.env.ATTENDANCE_CAMPUS_LONGITUDE, process.env.ATTENDANCE_CAMPUS_RADIUS_METERS];
  if (values.some(value => !value?.trim())) return undefined;
  const [latitude, longitude, radiusMeters] = values.map(Number);
  if (![latitude, longitude, radiusMeters].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || radiusMeters <= 0) return undefined;
  return { latitude, longitude, radiusMeters };
}

function attendanceError(res: any, error: any, label: string) {
  const message = String(error?.message || error || 'unknown_error');
  console.error(`[attendance] ${label} failed`, error);
  if (message.includes('revision_conflict')) return res.status(409).json({ error: 'revision_conflict' });
  if (message.includes('not_configured') || message.includes('Supabase')) {
    return res.status(503).json({ error: 'attendance_not_configured' });
  }
  if (/unknown_|invalid_|not_in_|not_editable|not_ready|finalized|cancelled|too_long|idempotency/.test(message)) {
    return res.status(400).json({ error: message.split('\n')[0] });
  }
  return res.status(500).json({ error: 'attendance_request_failed' });
}

function supabaseOrThrow() {
  const client = getSupabaseAdmin();
  if (!client) throw new Error('Supabase attendance backend not configured');
  return client;
}

async function actorFor(admin: any, req: any): Promise<Actor> {
  const db = admin.firestore();
  const token = req.user || {};
  const userDoc = await db.collection('users').doc(token.uid).get();
  const data = userDoc.exists ? userDoc.data() || {} : {};
  const master = token.email_verified === true && isMasterAdminEmail(token.email);
  const staff: StaffProjection = {
    role: master ? 'master_admin' : data.role,
    isMasterAdmin: master || data.isMasterAdmin === true,
    managedStageId: data.managedStageId || null,
    permissions: data.permissions || {},
    staffDisabled: data.staffDisabled === true,
  };
  let student: Actor['student'] = null;
  try {
    student = await studentForToken(db, token);
  } catch (error: any) {
    if (error?.code !== 'NO_STUDENT') throw error;
  }
  return { uid: token.uid, staff, student };
}

function requestedStage(req: any): string {
  const raw = req.query?.stageId ?? req.body?.stageId;
  return typeof raw === 'string' ? raw.trim() : '';
}

function actorStage(actor: Actor, req: any, managing = false): string {
  if (!managing && actor.student?.data?.stageId) return String(actor.student.data.stageId);
  const stageId = requestedStage(req) || String(actor.staff.managedStageId || '');
  if (!hasStageCapability(actor.staff, 'manageAttendance', stageId)) {
    const error: any = new Error('manage_attendance_forbidden');
    error.status = 403;
    throw error;
  }
  return stageId;
}

async function timetableFor(db: any, stageId: string): Promise<StageTimetableDoc | null> {
  const snap = await db.collection('timetables').doc(stageId).get();
  return snap.exists ? snap.data() as StageTimetableDoc : null;
}

async function attendanceContext(admin: any, stageId: string, now = new Date()) {
  const db = admin.firestore();
  const calendar = await loadCalendar(db);
  const today = baghdadToday(calendar.timezone || ATTENDANCE_TIMEZONE, now);
  const term = findAttendanceTerm(calendar, today);
  const timetable = await timetableFor(db, stageId);
  const occurrences = buildAttendanceOccurrences(calendar, timetable, stageId, today);
  return { calendar, today, term, occurrences };
}

function termPayload(calendar: any, term: any) {
  return term ? {
    id: attendanceTermId(calendar, term),
    calendarTermId: term.id,
    yearLabel: calendar.yearLabel,
    nameAr: term.nameAr,
    nameEn: term.nameEn,
    startDate: term.startDate,
    endDate: term.endDate,
    timezone: ATTENDANCE_TIMEZONE,
  } : null;
}

async function officialRoster(admin: any, stageId: string, occurrence: AttendanceOccurrenceCandidate) {
  const snap = await admin.firestore().collection('students').where('stageId', '==', stageId).get();
  return snap.docs
    .map((doc: any) => ({ id: doc.id, data: doc.data() || {} }))
    .filter(({ data }: any) => data.isActive !== false)
    .map(({ id, data }: any) => ({
      studentId: id,
      officialName: String(data.name || '').trim(),
      rosterIdentifier: String(data.loginCode || data.examCode || ''),
      subgroup: String(data.subgroup || data.group || ''),
    }))
    .filter((student: any) => student.officialName)
    .sort((a: any, b: any) => a.officialName.localeCompare(b.officialName, 'ar'));
}

function occurrenceFromRow(row: any): AttendanceOccurrenceCandidate {
  const lectureDate = String(row.lecture_date);
  const start = new Date(row.start_at);
  const end = new Date(row.end_at);
  const time = (date: Date) => date.toLocaleTimeString('en-GB', {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return {
    id: row.id,
    termId: row.term_id,
    stageId: row.stage_id,
    timetableSessionId: row.timetable_session_id,
    lectureDate,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    startTime: time(start),
    endTime: time(end),
    day: new Date(`${lectureDate}T12:00:00Z`).getUTCDay() as any,
    audienceGroups: row.audience_groups || [],
    ...(row.location ? { location: row.location } : {}),
    ...(row.teacher ? { teacher: row.teacher } : {}),
  };
}

function recordFromRow(row: any): AttendanceRecordView {
  return {
    id: row.id,
    sessionId: row.session_id,
    rosterStudentId: row.roster_student_id,
    officialName: row.official_name_snapshot,
    entryMethod: row.entry_method,
    status: row.status,
    receivedAt: row.received_at,
    decidedAt: row.decided_at,
    reviewFlags: row.review_flags || [],
    advisory: row.advisory || undefined,
    revision: Number(row.revision),
  };
}

function sessionFromRows(row: any, occurrence: any): AttendanceSessionView {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    expectedHeadcount: row.expected_headcount,
    notes: row.notes || '',
    status: row.status,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    reconciliationDeadline: row.reconciliation_deadline,
    revision: Number(row.revision),
    occurrence: occurrenceFromRow(occurrence),
  };
}

async function loadSessionAuthorized(admin: any, req: any, sessionId: string) {
  const actor = await actorFor(admin, req);
  const supabase = supabaseOrThrow();
  const { data: session, error: sessionError } = await supabase
    .from('attendance_sessions').select('*').eq('id', sessionId).single();
  if (sessionError || !session) throw sessionError || new Error('unknown_session');
  const { data: occurrence, error: occurrenceError } = await supabase
    .from('attendance_occurrences').select('*').eq('id', session.occurrence_id).single();
  if (occurrenceError || !occurrence) throw occurrenceError || new Error('unknown_occurrence');
  if (!hasStageCapability(actor.staff, 'manageAttendance', occurrence.stage_id)) {
    const error: any = new Error('manage_attendance_forbidden');
    error.status = 403;
    throw error;
  }
  return { actor, supabase, session, occurrence };
}

function assertReason(raw: unknown, required = true): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if ((required && !value) || value.length > MAX_REASON_LENGTH) throw new Error('invalid_reason');
  return value;
}

export function createAttendanceHandlers({ admin }: AttendanceDeps) {
  async function bootstrap(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      const wantsManage = requestedStage(req) !== '' || hasStageCapability(
        actor.staff,
        'manageAttendance',
        actor.staff.managedStageId,
      );
      const stageId = actorStage(actor, req, wantsManage);
      const ctx = await attendanceContext(admin, stageId);
      res.json({
        serverNow: new Date().toISOString(),
        timezone: ATTENDANCE_TIMEZONE,
        stageId,
        term: termPayload(ctx.calendar, ctx.term),
        occurrences: ctx.occurrences,
        canManage: hasStageCapability(actor.staff, 'manageAttendance', stageId),
      });
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'bootstrap');
    }
  }

  async function createSession(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      const stageId = actorStage(actor, req, true);
      const ctx = await attendanceContext(admin, stageId);
      if (!ctx.term) return res.status(400).json({ error: 'no_active_academic_term' });
      const occurrence = ctx.occurrences.find(item => item.id === req.body?.occurrenceId);
      if (!occurrence) return res.status(400).json({ error: 'invalid_occurrence' });
      const expectedHeadcount = Number(req.body?.expectedHeadcount);
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
      if (!Number.isInteger(expectedHeadcount) || expectedHeadcount < 1 || expectedHeadcount > 10000) {
        return res.status(400).json({ error: 'invalid_headcount' });
      }
      if (notes.length > 2000) return res.status(400).json({ error: 'notes_too_long' });

      const sessionId = requestId();
      const challengeId = requestId();
      const creationRequestId = typeof req.body?.requestId === 'string' ? req.body.requestId : requestId();
      const claims: AttendanceQrClaims = {
        v: ATTENDANCE_QR_VERSION,
        typ: 'simosan-attendance',
        sessionId,
        challengeId,
        occurrenceId: occurrence.id,
        stageId,
        lectureDate: occurrence.lectureDate,
        title: occurrence.title,
        startTime: occurrence.startTime,
        endTime: occurrence.endTime,
      };
      const qrToken = signAttendanceQr(claims);
      const roster = await officialRoster(admin, stageId, occurrence);
      const scheduledEnd = new Date(occurrence.endAt);
      scheduledEnd.setUTCDate(scheduledEnd.getUTCDate() + ATTENDANCE_RECONCILIATION_DAYS);
      const term = termPayload(ctx.calendar, ctx.term)!;
      const { keyId } = qrKeyConfig();
      const { data, error } = await supabaseOrThrow().rpc('attendance_create_session', {
        p_term: term,
        p_occurrence: occurrence,
        p_session: {
          id: sessionId,
          requestId: creationRequestId,
          professorUid: actor.uid,
          expectedHeadcount,
          notes,
          reconciliationDeadline: scheduledEnd.toISOString(),
        },
        p_roster: roster,
        p_challenge: { id: challengeId, tokenHash: sha256(qrToken), qrToken, keyId },
      });
      if (error) throw error;
      res.status(data?.existing ? 200 : 201).json({ ...data, rosterCount: roster.length });
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'create session');
    }
  }

  async function syncReceipts(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      if (!actor.student) return res.status(403).json({ error: 'student_identity_required' });
      const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
      if (receipts.length < 1 || receipts.length > MAX_SYNC_RECEIPTS) {
        return res.status(400).json({ error: 'invalid_receipt_batch' });
      }
      const supabase = supabaseOrThrow();
      const results: any[] = [];
      for (const receipt of receipts) {
        const receiptRequestId = typeof receipt?.requestId === 'string' ? receipt.requestId : '';
        try {
          if (!/^[0-9a-f-]{36}$/i.test(receiptRequestId)) throw new Error('invalid_request_id');
          if (receipt.ownerUid !== actor.uid) throw new Error('receipt_owner_mismatch');
          const claims = verifyAttendanceQr(receipt.qrToken);
          if (receipt.sessionId !== claims.sessionId || receipt.occurrenceId !== claims.occurrenceId) {
            throw new Error('receipt_claim_mismatch');
          }
          const device = verifyAttendanceDevice(receipt);
          const clientReportedAt = typeof receipt.capturedAtClient === 'string'
            && Number.isFinite(new Date(receipt.capturedAtClient).getTime())
            ? receipt.capturedAtClient
            : null;
          const { data, error } = await supabase.rpc('attendance_submit_receipt', {
            p_request_id: receiptRequestId,
            p_actor_uid: actor.uid,
            p_roster_student_id: actor.student.id,
            p_payload_hash: sha256(JSON.stringify({
              ownerUid: receipt.ownerUid,
              qrToken: receipt.qrToken,
              sessionId: receipt.sessionId,
              occurrenceId: receipt.occurrenceId,
              installationId: receipt.installationId,
              deviceDigest: device.deviceDigest,
              localDeviceConflict: receipt.localDeviceConflict === true,
            })),
            p_session_id: claims.sessionId,
            p_challenge_id: claims.challengeId,
            p_token_hash: sha256(receipt.qrToken),
            p_installation_digest: device.installationDigest,
            p_device_digest: device.deviceDigest,
            p_local_device_conflict: receipt.localDeviceConflict === true,
            p_advisory: summarizeAttendanceTelemetry(receipt.telemetry, campusBoundary()),
            p_client_reported_at: clientReportedAt,
          });
          if (error) throw error;
          results.push(data);
        } catch (error: any) {
          const reason = String(error?.message || 'invalid_evidence').split('\n')[0].slice(0, 100);
          const evidenceFailure = /invalid_request_id|invalid_qr|invalid_device_proof|receipt_claim_mismatch|idempotency_conflict/.test(reason);
          results.push({ requestId: receiptRequestId, resolution: evidenceFailure ? 'invalid_evidence' : 'retry_later', reason: evidenceFailure ? reason : 'verification_temporarily_unavailable' });
        }
      }
      res.json({ results });
    } catch (error) {
      return attendanceError(res, error, 'sync receipts');
    }
  }

  async function mine(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      if (!actor.student) return res.status(403).json({ error: 'student_identity_required' });
      const stageId = String(actor.student.data.stageId || '');
      const ctx = await attendanceContext(admin, stageId);
      const supabase = supabaseOrThrow();
      const [{ data: recordRows, error: recordError }, { data: receiptRows, error: receiptError }] = await Promise.all([
        supabase.from('attendance_records').select('*').eq('roster_student_id', actor.student.id).order('received_at', { ascending: false }).limit(500),
        supabase.from('attendance_receipts').select('*').eq('actor_uid', actor.uid).order('received_at', { ascending: false }).limit(500),
      ]);
      if (recordError) throw recordError;
      if (receiptError) throw receiptError;
      const sessionIds = [...new Set([...(recordRows || []).map(row => row.session_id), ...(receiptRows || []).map(row => row.session_id)])];
      let sessionRows: any[] = [];
      let occurrenceRows: any[] = [];
      if (sessionIds.length) {
        const sessionResult = await supabase.from('attendance_sessions').select('*').in('id', sessionIds);
        if (sessionResult.error) throw sessionResult.error;
        sessionRows = sessionResult.data || [];
        const occurrenceIds = [...new Set(sessionRows.map(row => row.occurrence_id))];
        if (occurrenceIds.length) {
          const occurrenceResult = await supabase.from('attendance_occurrences').select('*').in('id', occurrenceIds).eq('stage_id', stageId);
          if (occurrenceResult.error) throw occurrenceResult.error;
          occurrenceRows = occurrenceResult.data || [];
        }
      }
      const occurrenceMap = new Map(occurrenceRows.map(row => [row.id, row]));
      const sessions = sessionRows
        .filter(row => occurrenceMap.has(row.occurrence_id))
        .map(row => sessionFromRows(row, occurrenceMap.get(row.occurrence_id)));
      res.json({
        serverNow: new Date().toISOString(),
        timezone: ATTENDANCE_TIMEZONE,
        stageId,
        term: termPayload(ctx.calendar, ctx.term),
        occurrences: ctx.occurrences,
        sessions,
        records: (recordRows || []).map(recordFromRow),
        receipts: (receiptRows || []).map(row => ({
          requestId: row.request_id,
          sessionId: row.session_id,
          resolution: row.resolution,
          reason: row.reason,
          receivedAt: row.received_at,
          recordId: row.record_id,
        })),
      });
    } catch (error) {
      return attendanceError(res, error, 'mine');
    }
  }

  async function sessionSnapshot(req: any, res: any) {
    try {
      const loaded = await loadSessionAuthorized(admin, req, req.params.sessionId);
      const [{ data: roster, error: rosterError }, { data: records, error: recordsError }, { data: review, error: reviewError }] = await Promise.all([
        loaded.supabase.from('attendance_session_roster').select('*').eq('session_id', loaded.session.id).order('official_name'),
        loaded.supabase.from('attendance_records').select('*').eq('session_id', loaded.session.id).order('received_at'),
        loaded.supabase.from('attendance_receipts').select('*').eq('session_id', loaded.session.id).eq('resolution', 'needs_review').order('received_at'),
      ]);
      if (rosterError) throw rosterError;
      if (recordsError) throw recordsError;
      if (reviewError) throw reviewError;
      const mappedRecords = (records || []).map(recordFromRow);
      const confirmed = mappedRecords.filter(record => record.status === 'confirmed').length;
      res.json({
        serverNow: new Date().toISOString(),
        session: sessionFromRows(loaded.session, loaded.occurrence),
        roster: (roster || []).map(row => ({
          studentId: row.roster_student_id,
          officialName: row.official_name,
          rosterIdentifier: row.roster_identifier,
          subgroup: row.subgroup,
          expectedAttendee: row.expected_attendee !== false,
        })),
        records: mappedRecords,
        reviewReceipts: (review || []).map(row => ({
          requestId: row.request_id,
          sessionId: row.session_id,
          rosterStudentId: row.roster_student_id,
          resolution: row.resolution,
          reason: row.reason,
          receivedAt: row.received_at,
          reviewFlags: row.review_flags || [],
          advisory: row.advisory || undefined,
        })),
        counts: {
          confirmed,
          voided: mappedRecords.filter(record => record.status === 'voided').length,
          review: (review || []).length,
          discrepancy: Math.max(0, confirmed - loaded.session.expected_headcount),
        },
      });
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'session snapshot');
    }
  }

  async function updateSession(req: any, res: any) {
    try {
      const loaded = await loadSessionAuthorized(admin, req, req.params.sessionId);
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isInteger(expectedRevision)) return res.status(400).json({ error: 'invalid_revision' });
      const expectedHeadcount = req.body?.expectedHeadcount == null ? null : Number(req.body.expectedHeadcount);
      const notes = req.body?.notes == null ? null : String(req.body.notes);
      const nextStatus = req.body?.status == null ? null : String(req.body.status);
      const reason = assertReason(req.body?.reason, nextStatus != null);
      const { data, error } = await loaded.supabase.rpc('attendance_update_session', {
        p_request_id: typeof req.body?.requestId === 'string' ? req.body.requestId : requestId(),
        p_session_id: loaded.session.id,
        p_actor_uid: loaded.actor.uid,
        p_expected_revision: expectedRevision,
        p_expected_headcount: expectedHeadcount,
        p_notes: notes,
        p_next_status: nextStatus,
        p_reason: reason,
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'update session');
    }
  }

  async function manualRecord(req: any, res: any) {
    try {
      const loaded = await loadSessionAuthorized(admin, req, req.params.sessionId);
      const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId : '';
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!studentId || !Number.isInteger(expectedRevision)) return res.status(400).json({ error: 'invalid_manual_record' });
      const { data, error } = await loaded.supabase.rpc('attendance_manual_record', {
        p_request_id: typeof req.body?.requestId === 'string' ? req.body.requestId : requestId(),
        p_session_id: loaded.session.id,
        p_actor_uid: loaded.actor.uid,
        p_roster_student_id: studentId,
        p_reason: assertReason(req.body?.reason),
        p_expected_revision: expectedRevision,
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'manual record');
    }
  }

  async function setRecordStatus(req: any, res: any, status: 'confirmed' | 'voided') {
    try {
      const supabase = supabaseOrThrow();
      const recordResult = await supabase.from('attendance_records').select('id,session_id').eq('id', req.params.recordId).single();
      if (recordResult.error || !recordResult.data) throw recordResult.error || new Error('record_not_found');
      const loaded = await loadSessionAuthorized(admin, req, recordResult.data.session_id);
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isInteger(expectedRevision)) return res.status(400).json({ error: 'invalid_revision' });
      const { data, error } = await loaded.supabase.rpc('attendance_set_record_status', {
        p_request_id: typeof req.body?.requestId === 'string' ? req.body.requestId : requestId(),
        p_record_id: req.params.recordId,
        p_actor_uid: loaded.actor.uid,
        p_status: status,
        p_reason: assertReason(req.body?.reason),
        p_expected_revision: expectedRevision,
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, `${status} record`);
    }
  }

  async function resolveReview(req: any, res: any) {
    try {
      const supabase = supabaseOrThrow();
      const receiptResult = await supabase.from('attendance_receipts').select('request_id,session_id').eq('request_id', req.params.receiptId).single();
      if (receiptResult.error || !receiptResult.data) throw receiptResult.error || new Error('receipt_not_found');
      const loaded = await loadSessionAuthorized(admin, req, receiptResult.data.session_id);
      const decision = req.body?.decision === 'confirm' ? 'confirm' : req.body?.decision === 'reject' ? 'reject' : '';
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!decision || !Number.isInteger(expectedRevision)) return res.status(400).json({ error: 'invalid_review' });
      const { data, error } = await loaded.supabase.rpc('attendance_resolve_review', {
        p_request_id: typeof req.body?.requestId === 'string' ? req.body.requestId : requestId(),
        p_receipt_id: req.params.receiptId,
        p_actor_uid: loaded.actor.uid,
        p_decision: decision,
        p_reason: assertReason(req.body?.reason),
        p_expected_revision: expectedRevision,
        p_enroll_device: req.body?.enrollDevice === true,
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'resolve review');
    }
  }

  return {
    bootstrap,
    createSession,
    syncReceipts,
    mine,
    sessionSnapshot,
    updateSession,
    manualRecord,
    voidRecord: (req: any, res: any) => setRecordStatus(req, res, 'voided'),
    restoreRecord: (req: any, res: any) => setRecordStatus(req, res, 'confirmed'),
    resolveReview,
  };
}
