import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  ATTENDANCE_QR_VERSION,
  ATTENDANCE_RECONCILIATION_HOURS,
  ATTENDANCE_TIMEZONE,
  attendanceTermId,
  buildAttendanceOccurrences,
  findAttendanceTerm,
  type AttendanceOccurrenceCandidate,
  type AttendanceQrClaims,
  type AttendanceRecordView,
  type AttendanceSessionView,
  type AttendanceOfflinePermitClaims,
} from './attendance.js';
import { baghdadToday } from './academicCalendar.js';
import { isMasterAdminEmail } from './masterAdmins.js';
import { loadCalendar } from './seasonRollover.js';
import { hasStageCapability, type StaffProjection } from './staffCapabilities.js';
import { studentForToken } from './studentLookup.js';
import { getSupabaseAdmin } from './supabaseClient.js';
import type { StageTimetableDoc } from './timetable.js';
import { verifyAttendanceDevice, verifyAttendanceKeyRotation } from './attendanceDevice.js';
import { summarizeAttendanceTelemetry } from './attendanceSecurity.js';
import { attendanceSessionId, validateAttendancePublicKey, verifyOfflineAttendanceToken } from './attendanceOffline.js';
import { validateQrKeyConfig, mapConfigErrorToResponse, type QrKeyConfig } from './attendanceConfig.js';

export interface AttendanceDeps {
  admin: any;
}

type Actor = {
  uid: string;
  staff: StaffProjection;
  student: { id: string; data: any } | null;
  doctor?: { stageId: string; timetableSessionIds: string[]; subjects?: import('./attendance.js').AttendanceDoctorSubject[] };
};

const MAX_SYNC_RECEIPTS = 25;
const MAX_REASON_LENGTH = 1000;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const requestId = () => crypto.randomUUID();

function qrKeyConfig(): QrKeyConfig {
  return validateQrKeyConfig();
}

export function signAttendanceQr(claims: AttendanceQrClaims): string {
  return signServerCredential(claims);
}

function signServerCredential(claims: AttendanceQrClaims | AttendanceOfflinePermitClaims): string {
  const { privateKey, keyId } = qrKeyConfig();
  if (!privateKey) throw new Error('attendance_qr_not_configured');
  return jwt.sign(claims, privateKey, {
    algorithm: 'ES256',
    keyid: keyId,
    noTimestamp: true,
  });
}

function verifyOfflinePermit(token: string): AttendanceOfflinePermitClaims {
  const header = jwt.decode(token, { complete: true })?.header;
  const key = header?.kid ? qrKeyConfig().publicKeys[header.kid] : undefined;
  if (!key) throw new Error('unknown_qr_key');
  try { return jwt.verify(token, key, { algorithms: ['ES256'] }) as AttendanceOfflinePermitClaims; }
  catch { throw new Error('invalid_offline_permit'); }
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

export function attendanceErrorResponse(error: any): { status: number; error: string } {
  // Check typed configuration errors first
  const configResponse = mapConfigErrorToResponse(error);
  if (configResponse) return configResponse;

  const message = String(error?.message || error || 'unknown_error');
  const code = String(error?.code || 'attendance_error');
  if (message.includes('revision_conflict') || message.includes('concurrency_conflict') || message.includes('challenge_already_consumed') || message.includes('alias_conflict')) {
    return { status: 409, error: message.split('\n')[0] };
  }
  if (code === 'PGRST205' || code === '42P01' || /attendance_.+schema cache|public\.attendance_.+does not exist/i.test(message)) {
    return { status: 503, error: 'attendance_schema_missing' };
  }
  if (message.includes('not_configured') || message.includes('Supabase')) {
    return { status: 503, error: 'attendance_not_configured' };
  }
  if (/unknown_|invalid_|not_in_|not_editable|not_ready|finalized|cancelled|too_long|idempotency/.test(message)) {
    return { status: 400, error: message.split('\n')[0] };
  }
  return { status: 500, error: 'attendance_request_failed' };
}

function safeErrorCode(error: any): string {
  if (error?.configCode) return error.configCode;
  const code = String(error?.code || '');
  if (code && code !== 'attendance_error') return code;
  const msg = String(error?.message || '');
  // Return the message if it looks like a known safe code, otherwise generic
  if (/^[a-z_]+$/.test(msg) && msg.length < 80) return msg;
  return 'attendance_error';
}

function attendanceError(res: any, error: any, label: string) {
  const response = attendanceErrorResponse(error);
  const code = safeErrorCode(error);
  console.error(`[attendance] ${label} failed`, {
    code,
    category: response.error,
    status: response.status,
  });
  return res.status(response.status).json({ error: response.error });
}

function supabaseOrThrow() {
  const client = getSupabaseAdmin();
  if (!client) throw new Error('Supabase attendance backend not configured');
  return client;
}

async function boundedAttendanceRows(query: () => any, maximum = 2000): Promise<{ rows: any[]; complete: boolean }> {
  const rows: any[] = [];
  for (let offset = 0; offset < maximum; offset += 500) {
    const { data, error } = await query().range(offset, Math.min(offset + 499, maximum - 1));
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 500) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function attendanceRowsByIds(supabase: ReturnType<typeof supabaseOrThrow>, table: string, column: string, ids: string[]): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < ids.length; offset += 20) {
    const { data, error } = await supabase.from(table).select('*').in(column, ids.slice(offset, offset + 20));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
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
  const doctorDoc = await db.collection('attendanceDoctors').doc(token.uid).get();
  const doctorData = doctorDoc.exists ? doctorDoc.data() : null;
  const doctor = doctorData?.enabled === true && !staff.staffDisabled && typeof doctorData.stageId === 'string' && Array.isArray(doctorData.timetableSessionIds)
    ? { stageId: doctorData.stageId, timetableSessionIds: doctorData.timetableSessionIds.filter((id: unknown) => typeof id === 'string'), subjects: doctorData.subjects || [] } : undefined;
  return { uid: token.uid, staff, student, doctor };
}

export function canManageOccurrence(actor: Actor, occurrence: AttendanceOccurrenceCandidate): boolean {
  if (actor.staff.staffDisabled) return false;
  return hasStageCapability(actor.staff, 'manageAttendance', occurrence.stageId)
    || (actor.doctor?.stageId === occurrence.stageId && actor.doctor.timetableSessionIds.includes(occurrence.timetableSessionId));
}

function requestedStage(req: any): string {
  const raw = req.query?.stageId ?? req.body?.stageId;
  return typeof raw === 'string' ? raw.trim() : '';
}

function actorStage(actor: Actor, req: any, managing = false): string {
  if (!managing && actor.student?.data?.stageId) return String(actor.student.data.stageId);
  const stageId = requestedStage(req) || actor.doctor?.stageId || String(actor.staff.managedStageId || '');
  if (!hasStageCapability(actor.staff, 'manageAttendance', stageId) && actor.doctor?.stageId !== stageId) {
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
  const activeDocs = snap.docs
    .map((doc: any) => ({ id: doc.id, data: doc.data() || {} }))
    .filter(({ data }: any) => data.isActive !== false);

  const hasMissingSubgroup = activeDocs.some(({ data }: any) => !(data.subgroup || data.group));
  const userGroupByEmail = new Map<string, string>();

  if (hasMissingSubgroup) {
    try {
      const usersSnap = await admin.firestore().collection('users').where('stageId', '==', stageId).get();
      usersSnap.docs.forEach((uDoc: any) => {
        const uData = uDoc.data() || {};
        const grp = String(uData.group || uData.subgroup || '').trim();
        if (grp) {
          if (uData.email) userGroupByEmail.set(String(uData.email).trim().toLowerCase(), grp);
          userGroupByEmail.set(uDoc.id, grp);
        }
      });
    } catch (lookupErr) {
      console.warn('[attendanceApi] Optional users group fallback failed:', lookupErr);
    }
  }

  return activeDocs
    .map(({ id, data }: any) => {
      const email = String(data.email || id || '').trim().toLowerCase();
      const resolvedSubgroup = String(data.subgroup || data.group || userGroupByEmail.get(email) || userGroupByEmail.get(id) || '').trim();
      return {
        studentId: id,
        officialName: String(data.name || '').trim(),
        rosterIdentifier: String(data.loginCode || data.examCode || ''),
        subgroup: resolvedSubgroup,
      };
    })
    .filter((student: any) => student.officialName)
    .sort((a: any, b: any) => a.officialName.localeCompare(b.officialName, 'ar'));
}

const attendanceSubjectCache = new Map<string, { expiresAt: number; value: Promise<import('./attendance.js').AttendanceDoctorSubject[]> }>();

async function loadStageAttendanceSubjects(admin: any, stageId: string) {
  const snapshot = await admin.firestore().collection('attendanceSubjectSlots').where('stageId', '==', stageId).get();
  const subjects = new Map<string, import('./attendance.js').AttendanceDoctorSubject>();
  for (const document of snapshot.docs) {
    const data = document.data() || {};
    if (typeof data.subjectId !== 'string' || typeof data.timetableSessionId !== 'string') continue;
    const existing = subjects.get(data.subjectId);
    if (existing) {
      if (!existing.timetableSessionIds.includes(data.timetableSessionId)) {
        existing.timetableSessionIds.push(data.timetableSessionId);
      }
      if (existing.type !== data.type && data.type) {
        existing.type = 'both';
      }
      if (!existing.nameAr && data.nameAr) existing.nameAr = data.nameAr;
      if (!existing.nameEn && data.nameEn) existing.nameEn = data.nameEn;
    } else {
      subjects.set(data.subjectId, {
        id: data.subjectId,
        nameAr: data.nameAr || '',
        nameEn: data.nameEn || '',
        type: data.type || 'both',
        timetableSessionIds: [data.timetableSessionId],
      });
    }
  }
  return [...subjects.values()];
}

function stageAttendanceSubjects(admin: any, stageId: string) {
  const cached = attendanceSubjectCache.get(stageId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = loadStageAttendanceSubjects(admin, stageId).catch(error => {
    attendanceSubjectCache.delete(stageId);
    throw error;
  });
  attendanceSubjectCache.set(stageId, { expiresAt: Date.now() + 300000, value });
  return value;
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
    mode: row.mode || 'other',
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
  if (!canManageOccurrence(actor, occurrenceFromRow(occurrence))) {
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
  async function doctorWorkspace(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      if (actor.staff.staffDisabled) return res.status(403).json({ error: 'manage_attendance_forbidden' });
      const stageId = actor.doctor?.stageId || actorStage(actor, req, true);
      if (!hasStageCapability(actor.staff, 'manageAttendance', stageId) && actor.doctor?.stageId !== stageId) return res.status(403).json({ error: 'manage_attendance_forbidden' });
      const ctx = await attendanceContext(admin, stageId);
      const timetable = await timetableFor(admin.firestore(), stageId);
      const occurrences = buildAttendanceOccurrences(ctx.calendar, timetable, stageId, ctx.today, 52, 52).filter(item => canManageOccurrence(actor, item));
      const subjects = actor.doctor?.subjects?.length ? actor.doctor.subjects : (timetable?.sessions || []).map(item => ({
        id: item.id, nameAr: item.title, nameEn: item.title,
        type: item.kind === 'theory' ? 'theoretical' : 'practical', timetableSessionIds: [item.id],
      }));
      const supabase = supabaseOrThrow();
      const history = await boundedAttendanceRows(() => supabase.from('attendance_occurrences').select('*').eq('stage_id', stageId).order('id'), 10000);
      if (!history.complete) throw new Error('attendance_history_too_long');
      const authorized = history.rows.map(occurrenceFromRow).filter(item => canManageOccurrence(actor, item));
      const sessionRows = await attendanceRowsByIds(supabase, 'attendance_sessions', 'occurrence_id', authorized.map(item => item.id));
      const byId = new Map(history.rows.map(item => [item.id, item]));
      const records: any[] = [];
      for (let offset = 0; offset < sessionRows.length; offset += 20) {
        const ids = sessionRows.slice(offset, offset + 20).map(row => row.id);
        const page = await boundedAttendanceRows(() => supabase.from('attendance_records').select('*').in('session_id', ids).order('id'), 20000);
        if (!page.complete) throw new Error('attendance_history_too_long');
        records.push(...page.rows);
      }
      res.json({ stageId, subjects,
        roster: await officialRoster(admin, stageId, occurrences[0]),
        bootstrap: { serverNow: new Date().toISOString(), timezone: ATTENDANCE_TIMEZONE, stageId, term: termPayload(ctx.calendar, ctx.term), occurrences, canManage: true },
        sessions: sessionRows.map(row => sessionFromRows(row, byId.get(row.occurrence_id)!)),
        records: records.map(recordFromRow),
      });
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'doctor workspace');
    }
  }
  async function prepareOffline(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      const stageId = actorStage(actor, req, true);
      const ctx = await attendanceContext(admin, stageId);
      if (!ctx.term) return res.status(400).json({ error: 'no_active_academic_term' });
      const publicKey = validateAttendancePublicKey(req.body?.publicKey);
      const timetable = await timetableFor(admin.firestore(), stageId);
      const occurrences = buildAttendanceOccurrences(ctx.calendar, timetable, stageId, ctx.today, 1, 52).filter(item => canManageOccurrence(actor, item));
      if (!occurrences.length || occurrences.length > 5000) throw new Error('invalid_offline_schedule');
      const id = requestId();
      const permit = signServerCredential({ typ: 'simosan-offline-permit', id, professorUid: actor.uid, stageId, publicKey });
      const roster = await officialRoster(admin, stageId, occurrences[0]);
      const term = termPayload(ctx.calendar, ctx.term)!;
      const { error } = await supabaseOrThrow().from('attendance_offline_grants').insert({
        id, professor_uid: actor.uid, stage_id: stageId, token_hash: sha256(permit), term,
        occurrences: Object.fromEntries(occurrences.map(item => [item.id, item])), roster,
        session_ids: Object.fromEntries(occurrences.map(item => [item.id, attendanceSessionId(item.id)])),
      });
      if (error) throw error;
      res.json({ ownerUid: actor.uid, permit, roster, sessions: Object.fromEntries(occurrences.map(item => [item.id, attendanceSessionId(item.id)])), bootstrap: {
        serverNow: new Date().toISOString(), timezone: ATTENDANCE_TIMEZONE, stageId, term, occurrences, canManage: true,
      } });
    } catch (error: any) {
      if (error.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'offline setup');
    }
  }

  async function importOfflineToken(qrToken: string, requiredOwner?: string) {
    const verified = verifyOfflineAttendanceToken(qrToken, verifyOfflinePermit);
    if (!verified) return null;
    const { claims, permit, credential } = verified;
    if (requiredOwner && requiredOwner !== permit.professorUid) throw new Error('invalid_permit_owner');
    const supabase = supabaseOrThrow();
    const { data: pack, error } = await supabase.from('attendance_offline_grants').select('*').eq('id', permit.id).single();
    if (error) throw error;
    if (!pack || pack.revoked_at || pack.token_hash !== sha256(credential) || pack.professor_uid !== permit.professorUid) throw new Error('invalid_offline_permit');
    const occurrence = pack.occurrences[claims.occurrenceId] as AttendanceOccurrenceCandidate | undefined;
    if (!occurrence || ['stageId', 'lectureDate', 'title', 'startTime', 'endTime'].some(field => (occurrence as any)[field] !== (claims as any)[field])) throw new Error('invalid_offline_occurrence');
    const lecturer = await actorFor(admin, { user: { uid: permit.professorUid } });
    if (!canManageOccurrence(lecturer, occurrence)) throw new Error('offline_authority_unavailable');
    const result = await supabase.rpc('attendance_import_offline_session', {
      p_grant_id: permit.id, p_grant_hash: sha256(credential), p_occurrence_id: occurrence.id,
      p_session_id: claims.sessionId, p_challenge_id: claims.challengeId, p_qr_token: qrToken, p_token_hash: sha256(qrToken), p_headcount: claims.expectedHeadcount,
    });
    if (result.error) throw result.error;
    return { claims, result: result.data };
  }

  async function importOfflineSession(req: any, res: any) {
    try {
      const imported = await importOfflineToken(req.body?.qrToken, req.user.uid);
      if (!imported) throw new Error('invalid_offline_qr');
      return res.json(imported.result);
    } catch (error) { return attendanceError(res, error, 'offline session import'); }
  }

  async function bootstrap(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      const wantsManage = !!actor.doctor || requestedStage(req) !== '' || hasStageCapability(
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
        occurrences: wantsManage ? ctx.occurrences.filter(item => canManageOccurrence(actor, item)) : ctx.occurrences,
        canManage: hasStageCapability(actor.staff, 'manageAttendance', stageId) || actor.doctor?.stageId === stageId,
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
      const timetable = await timetableFor(admin.firestore(), stageId);
      const occurrence = buildAttendanceOccurrences(ctx.calendar, timetable, stageId, ctx.today, 52, 52)
        .find(item => item.id === req.body?.occurrenceId);
      if (!occurrence) return res.status(400).json({ error: 'invalid_occurrence' });
      if (!canManageOccurrence(actor, occurrence)) return res.status(403).json({ error: 'manage_attendance_forbidden' });
      const expectedHeadcount = Number(req.body?.expectedHeadcount);
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
      if (!Number.isInteger(expectedHeadcount) || expectedHeadcount < 1 || expectedHeadcount > 10000) {
        return res.status(400).json({ error: 'invalid_headcount' });
      }
      if (notes.length > 2000) return res.status(400).json({ error: 'notes_too_long' });

      const sessionId = attendanceSessionId(occurrence.id);
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
      scheduledEnd.setUTCHours(scheduledEnd.getUTCHours() + ATTENDANCE_RECONCILIATION_HOURS);
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
      if (actor.student.data.isActive === false) return res.status(403).json({ error: 'student_identity_disabled' });
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
          const offline = await importOfflineToken(receipt.qrToken);
          const claims = offline?.claims || verifyAttendanceQr(receipt.qrToken);
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
            p_advisory: summarizeAttendanceTelemetry(receipt.telemetry),
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
      const [recordResult, receiptResult, expectedResult] = await Promise.all([
        boundedAttendanceRows(() => supabase.from('attendance_records').select('*').eq('roster_student_id', actor.student!.id).order('received_at', { ascending: false }).order('id')),
        boundedAttendanceRows(() => supabase.from('attendance_receipts').select('*').eq('actor_uid', actor.uid).order('received_at', { ascending: false }).order('request_id')),
        boundedAttendanceRows(() => supabase.from('attendance_session_roster').select('session_id').eq('roster_student_id', actor.student!.id).eq('expected_attendee', true).order('session_id')),
      ]);
      const recordRows = recordResult.rows;
      const receiptRows = receiptResult.rows;
      const sessionIds = [...new Set([...recordRows.map(row => row.session_id), ...receiptRows.map(row => row.session_id), ...expectedResult.rows.map(row => row.session_id)])];
      let sessionRows: any[] = [];
      let occurrenceRows: any[] = [];
      if (sessionIds.length) {
        sessionRows = await attendanceRowsByIds(supabase, 'attendance_sessions', 'id', sessionIds);
        const occurrenceIds = [...new Set(sessionRows.map(row => row.occurrence_id))];
        if (occurrenceIds.length) {
          occurrenceRows = await attendanceRowsByIds(supabase, 'attendance_occurrences', 'id', occurrenceIds);
        }
      }
      const occurrenceMap = new Map(occurrenceRows.map(row => [row.id, row]));
      const sessions = sessionRows
        .filter(row => occurrenceMap.has(row.occurrence_id))
        .map(row => ({ ...sessionFromRows(row, occurrenceMap.get(row.occurrence_id)), notes: '' }));
      const recordsBySession = new Map((recordRows || []).map(row => [row.session_id, row]));
      res.json({
        serverNow: new Date().toISOString(),
        timezone: ATTENDANCE_TIMEZONE,
        stageId,
        term: termPayload(ctx.calendar, ctx.term),
        occurrences: ctx.occurrences,
        subjects: await stageAttendanceSubjects(admin, stageId),
        sessions,
        records: (recordRows || []).map(recordFromRow),
        historyComplete: recordResult.complete && receiptResult.complete && expectedResult.complete,
        receipts: (receiptRows || []).map(row => ({
          requestId: row.request_id,
          sessionId: row.session_id,
          resolution: recordsBySession.get(row.session_id)?.status === 'confirmed' ? 'confirmed' : recordsBySession.get(row.session_id)?.status === 'voided' ? 'needs_review' : row.resolution,
          reason: recordsBySession.get(row.session_id)?.status === 'voided' ? 'record_voided' : row.reason,
          receivedAt: row.received_at,
          recordId: recordsBySession.get(row.session_id)?.id || null,
          recordStatus: recordsBySession.get(row.session_id)?.status || null,
          revision: recordsBySession.get(row.session_id)?.revision || undefined,
        })),
      });
    } catch (error) {
      return attendanceError(res, error, 'mine');
    }
  }

  async function sessionSnapshot(req: any, res: any) {
    try {
      const loaded = await loadSessionAuthorized(admin, req, req.params.sessionId);
      const pages = await Promise.all([
        boundedAttendanceRows(() => loaded.supabase.from('attendance_session_roster').select('*').eq('session_id', loaded.session.id).order('roster_student_id'), 10000),
        boundedAttendanceRows(() => loaded.supabase.from('attendance_records').select('*').eq('session_id', loaded.session.id).order('id'), 10000),
        boundedAttendanceRows(() => loaded.supabase.from('attendance_receipts').select('*').eq('session_id', loaded.session.id).eq('resolution', 'needs_review').order('request_id'), 10000),
      ]);
      if (pages.some(page => !page.complete)) throw new Error('attendance_roster_too_long');
      const [roster, records, review] = pages.map(page => page.rows);
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
          reviewRevision: Number(row.review_revision) || 1,
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
        p_allow_late_confirmation: req.body?.allowLateConfirmation === true,
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'resolve review');
    }
  }

  async function createKeyRotationChallenge(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      if (!actor.student) return res.status(403).json({ error: 'student_identity_required' });
      if (actor.student.data.isActive === false) return res.status(403).json({ error: 'student_identity_disabled' });
      const nonce = crypto.randomBytes(32).toString('hex');
      const { data, error } = await supabaseOrThrow().rpc('attendance_create_key_rotation_challenge', {
        p_actor_uid: actor.uid,
        p_nonce: nonce,
      });
      if (error) throw error;
      res.json({ challengeId: data, nonce });
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'create key rotation challenge');
    }
  }

  async function commitKeyRotation(req: any, res: any) {
    try {
      const actor = await actorFor(admin, req);
      if (!actor.student) return res.status(403).json({ error: 'student_identity_required' });
      if (actor.student.data.isActive === false) return res.status(403).json({ error: 'student_identity_disabled' });
      const { challengeId, nonce, oldKey, newKey, oldSignature, newSignature } = req.body || {};
      if (!challengeId || !nonce || !oldKey || !newKey || !oldSignature || !newSignature) {
        return res.status(400).json({ error: 'invalid_rotation_payload' });
      }
      const { oldDeviceDigest, newDeviceDigest } = verifyAttendanceKeyRotation({
        actorUid: actor.uid,
        challengeId,
        nonce,
        oldKey,
        newKey,
        oldSignature,
        newSignature,
      });
      const { data, error } = await supabaseOrThrow().rpc('attendance_commit_key_rotation', {
        p_challenge_id: challengeId,
        p_actor_uid: actor.uid,
        p_roster_student_id: actor.student.id,
        p_old_device_digest: oldDeviceDigest,
        p_new_device_digest: newDeviceDigest,
        p_rotation_proof: {
          oldKey,
          newKey,
          oldSignature,
          newSignature,
          nonce,
        },
      });
      if (error) throw error;
      res.json(data);
    } catch (error: any) {
      if (error?.status === 403) return res.status(403).json({ error: error.message });
      return attendanceError(res, error, 'commit key rotation');
    }
  }

  return {
    doctorWorkspace,
    prepareOffline,
    importOfflineSession,
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
    createKeyRotationChallenge,
    commitKeyRotation,
  };
}
