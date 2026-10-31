import { addDays, daysBetween, type AcademicCalendar, type AcademicTerm } from './academicCalendar.js';
import { TEACHING_DAYS, type DayIndex, type StageTimetableDoc, type TimetableSession } from './timetable.js';
import type { AttendanceAdvisory, AttendanceTelemetry } from './attendanceSecurity.js';

export const ATTENDANCE_TIMEZONE = 'Asia/Baghdad';
export const ATTENDANCE_RECONCILIATION_HOURS = 36;
/** V2 removes the hall count from the signed QR payload. */
export const ATTENDANCE_QR_VERSION = 2;

export type AttendanceSessionStatus = 'active' | 'ended' | 'finalized' | 'cancelled';
export type AttendanceRecordStatus = 'confirmed' | 'voided';
export type AttendanceReceiptResolution =
  | 'confirmed'
  | 'already_recorded'
  | 'needs_review'
  | 'invalid_evidence';

export interface AttendanceOccurrenceCandidate {
  id: string;
  termId: string;
  stageId: string;
  timetableSessionId: string;
  lectureDate: string;
  title: string;
  startAt: string;
  endAt: string;
  startTime: string;
  endTime: string;
  day: DayIndex;
  audienceGroups: string[];
  location?: string;
  teacher?: string;
  mode?: 'theory' | 'practical' | 'other';
}

export interface AttendanceQrClaims {
  v: 1 | 2;
  typ: 'simosan-attendance';
  sessionId: string;
  challengeId: string;
  occurrenceId: string;
  stageId: string;
  lectureDate: string;
  title: string;
  startTime: string;
  endTime: string;
  /** Server-assigned attempt number for repeat sessions of one occurrence. */
  attemptGeneration?: number;
  /** Present only on legacy V1 offline QR codes. */
  expectedHeadcount?: number;
}

export interface AttendanceOfflinePermitClaims {
  typ: 'simosan-offline-permit';
  id: string;
  professorUid: string;
  stageId: string;
  publicKey: JsonWebKey;
  exp?: number;
  iat?: number;
}

export interface AttendanceOfflinePack {
  ownerUid: string;
  permit: string;
  bootstrap: AttendanceBootstrap;
  roster: AttendanceRosterEntry[];
  sessions: Record<string, string>;
  /** Attempt number paired with each pre-authorized session ID. */
  attemptGenerations?: Record<string, number>;
  /** Server-issued expiry for the device-bound offline authority. */
  expiresAt: string;
}

export interface LocalAttendanceReceipt {
  requestId: string;
  ownerUid: string;
  qrToken: string;
  sessionId: string;
  occurrenceId: string;
  stageId: string;
  occurrence: Pick<AttendanceOccurrenceCandidate, 'id' | 'stageId' | 'lectureDate' | 'title' | 'startTime' | 'endTime'>;
  installationId: string;
  localDeviceConflict?: boolean;
  devicePublicKey?: JsonWebKey;
  deviceSignature?: string;
  /** V2 binds scan-time location evidence to the device signature. */
  deviceProofVersion?: 1 | 2;
  locationProof?: AttendanceTelemetry['location'];
  telemetry?: AttendanceTelemetry;
  capturedAtClient?: string;
  savedAt: number;
  updatedAt: number;
  status: 'pending' | 'syncing' | 'waiting_for_login' | 'confirmed' | 'review' | 'invalid';
  resolution?: AttendanceReceiptResolution;
  reason?: string;
  recordId?: string | null;
  receivedAt?: string | null;
  recordStatus?: AttendanceRecordStatus | null;
  recordRevision?: number;
  attemptCount: number;
  leaseId?: string;
  leaseExpiresAt?: number;
}

export interface AttendanceRecordView {
  id: string;
  sessionId: string;
  rosterStudentId: string;
  officialName: string;
  entryMethod: 'qr' | 'manual';
  status: AttendanceRecordStatus;
  receivedAt: string;
  decidedAt: string;
  reviewFlags: string[];
  advisory?: AttendanceAdvisory;
  revision: number;
}

export interface AttendanceSessionView {
  id: string;
  occurrenceId: string;
  /** Actual people observed in the hall; deliberately independent of QR scans. */
  physicalHeadcount: number | null;
  notes: string;
  status: AttendanceSessionStatus;
  createdAt: string;
  endedAt?: string | null;
  reconciliationDeadline: string;
  revision: number;
  attemptGeneration?: number;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  occurrence: AttendanceOccurrenceCandidate;
}

export interface AttendanceRosterEntry {
  studentId: string;
  officialName: string;
  rosterIdentifier: string;
  subgroup: string;
  expectedAttendee?: boolean;
}

export interface AttendanceBootstrap {
  serverNow: string;
  timezone: string;
  stageId: string;
  term: {
    id: string;
    calendarTermId: string;
    yearLabel: string;
    nameAr: string;
    nameEn: string;
    startDate: string;
    endDate: string;
    timezone: string;
  } | null;
  occurrences: AttendanceOccurrenceCandidate[];
  canManage: boolean;
}

export interface AttendanceDoctorSubject {
  id: string;
  nameAr: string;
  nameEn: string;
  type: 'theoretical' | 'practical' | 'both';
  timetableSessionIds: string[];
}

export interface AttendanceDoctorWorkspace {
  offline?: boolean;
  stageId: string;
  subjects: AttendanceDoctorSubject[];
  bootstrap: AttendanceBootstrap;
  roster: AttendanceRosterEntry[];
  sessions: AttendanceSessionView[];
  records: AttendanceRecordView[];
  reviewCounts?: Record<string, number>;
}

export interface AttendanceMine {
  offline?: boolean;
  unavailableReason?: string;
  historyComplete?: boolean;
  serverNow: string;
  timezone: string;
  stageId: string;
  subjects?: AttendanceDoctorSubject[];
  term: AttendanceBootstrap['term'];
  occurrences: AttendanceOccurrenceCandidate[];
  sessions: AttendanceSessionView[];
  /** Audited attempts excluded from attendance totals. */
  cancelledSessions?: AttendanceSessionView[];
  records: AttendanceRecordView[];
  receipts: Array<{
    requestId: string;
    sessionId: string;
    resolution: AttendanceReceiptResolution;
    reason: string;
    receivedAt: string;
    recordId?: string | null;
    recordStatus?: AttendanceRecordStatus | null;
    revision?: number;
  }>;
}

export interface AttendanceSessionSnapshot {
  offline?: boolean;
  serverNow: string;
  session: AttendanceSessionView;
  roster: AttendanceRosterEntry[];
  records: AttendanceRecordView[];
  reviewReceipts: Array<{
    requestId: string;
    sessionId: string;
    rosterStudentId?: string | null;
    resolution: AttendanceReceiptResolution;
    reason: string;
    receivedAt: string;
    reviewFlags?: string[];
    advisory?: AttendanceAdvisory;
    reviewRevision?: number;
  }>;
  counts: { confirmed: number; voided: number; review: number; discrepancy: number };
}

export function attendanceTermId(calendar: AcademicCalendar, term: AcademicTerm): string {
  return `${calendar.yearLabel}:${term.id}`;
}

export function findAttendanceTerm(calendar: AcademicCalendar, date: string): AcademicTerm | null {
  return (calendar.terms || []).find(term => date >= term.startDate && date <= term.endDate) || null;
}

/**
 * The teaching term whose schedule students should see. During exams and the
 * break between terms, keep the most recently completed teaching term visible.
 * Before the academic year starts there is no prior schedule to display.
 */
export function findAttendanceDisplayTerm(calendar: AcademicCalendar, date: string): AcademicTerm | null {
  const terms = (calendar.terms || [])
    .slice()
    .sort((first, second) => first.startDate.localeCompare(second.startDate));
  return terms.find(term => date >= term.startDate && date <= term.endDate)
    || terms.filter(term => term.endDate < date).pop()
    || null;
}

function dayIndex(isoDate: string): DayIndex {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay() as DayIndex;
}

/** Saturday is the first displayed teaching day in this repository. */
export function attendanceWeekStart(date: string): string {
  const daysSinceSaturday = (dayIndex(date) + 1) % 7;
  return addDays(date, -daysSinceSaturday);
}

export function attendanceWeekNumber(term: AcademicTerm, date: string): number {
  return Math.floor(daysBetween(attendanceWeekStart(term.startDate), attendanceWeekStart(date)) / 7) + 1;
}

export function occurrenceIdFor(
  calendar: AcademicCalendar,
  term: AcademicTerm,
  stageId: string,
  lectureDate: string,
  timetableSessionId: string,
): string {
  return `${attendanceTermId(calendar, term)}:${stageId}:${lectureDate}:${timetableSessionId}`;
}

function isoAtBaghdad(date: string, time: string): string {
  return new Date(`${date}T${time}:00+03:00`).toISOString();
}

export function buildAttendanceOccurrences(
  calendar: AcademicCalendar,
  timetable: StageTimetableDoc | null | undefined,
  stageId: string,
  referenceDate: string,
  weeksBefore = 8,
  weeksAfter = 1,
): AttendanceOccurrenceCandidate[] {
  const term = findAttendanceTerm(calendar, referenceDate);
  if (!term || !timetable?.sessions?.length || !stageId) return [];

  const firstWeek = addDays(attendanceWeekStart(referenceDate), -7 * Math.max(0, weeksBefore));
  const lastWeek = addDays(attendanceWeekStart(referenceDate), 7 * Math.max(0, weeksAfter));
  const occurrences: AttendanceOccurrenceCandidate[] = [];

  for (let weekStart = firstWeek; weekStart <= lastWeek; weekStart = addDays(weekStart, 7)) {
    for (const session of timetable.sessions) {
      const offset = TEACHING_DAYS.indexOf(session.day);
      const lectureDate = addDays(weekStart, offset >= 0 ? offset : ((session.day + 1) % 7));
      if (lectureDate < term.startDate || lectureDate > term.endDate) continue;
      occurrences.push(toOccurrence(calendar, term, stageId, lectureDate, session));
    }
  }

  return occurrences.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
}

/** Build every scheduled occurrence in the term students should currently see. */
export function buildAttendanceTermOccurrences(
  calendar: AcademicCalendar,
  timetable: StageTimetableDoc | null | undefined,
  stageId: string,
  referenceDate: string,
): AttendanceOccurrenceCandidate[] {
  const term = findAttendanceDisplayTerm(calendar, referenceDate);
  if (!term || !timetable?.sessions?.length || !stageId) return [];

  const firstWeek = attendanceWeekStart(term.startDate);
  const lastWeek = attendanceWeekStart(term.endDate);
  const occurrences: AttendanceOccurrenceCandidate[] = [];

  for (let weekStart = firstWeek; weekStart <= lastWeek; weekStart = addDays(weekStart, 7)) {
    for (const session of timetable.sessions) {
      const offset = TEACHING_DAYS.indexOf(session.day);
      const lectureDate = addDays(weekStart, offset >= 0 ? offset : ((session.day + 1) % 7));
      if (lectureDate < term.startDate || lectureDate > term.endDate) continue;
      occurrences.push(toOccurrence(calendar, term, stageId, lectureDate, session));
    }
  }

  return occurrences.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
}

function toOccurrence(
  calendar: AcademicCalendar,
  term: AcademicTerm,
  stageId: string,
  lectureDate: string,
  session: TimetableSession,
): AttendanceOccurrenceCandidate {
  return {
    id: occurrenceIdFor(calendar, term, stageId, lectureDate, session.id),
    termId: attendanceTermId(calendar, term),
    stageId,
    timetableSessionId: session.id,
    mode: session.kind,
    lectureDate,
    title: session.title,
    startAt: isoAtBaghdad(lectureDate, session.start),
    endAt: isoAtBaghdad(lectureDate, session.end),
    startTime: session.start,
    endTime: session.end,
    day: session.day,
    audienceGroups: session.groups || [],
    ...(session.location ? { location: session.location } : {}),
    ...(session.teacher ? { teacher: session.teacher } : {}),
  };
}

export function parseUnverifiedAttendanceQr(raw: string): AttendanceQrClaims | null {
  const token = raw.trim();
  if (token.length < 32 || token.length > 4096) return null;
  const pieces = token.split('.');
  if (pieces.length !== 3) return null;
  try {
    const encoded = pieces[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const json = typeof atob === 'function'
      ? decodeURIComponent(Array.from(atob(padded), char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''))
      : Buffer.from(padded, 'base64').toString('utf8');
    const claims = JSON.parse(json) as Partial<AttendanceQrClaims>;
    if ((claims.v !== 1 && claims.v !== ATTENDANCE_QR_VERSION) || claims.typ !== 'simosan-attendance') return null;
    if (![claims.sessionId, claims.challengeId, claims.occurrenceId, claims.stageId, claims.lectureDate, claims.title, claims.startTime, claims.endTime]
      .every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claims.lectureDate!) || !/^\d{2}:\d{2}$/.test(claims.startTime!) || !/^\d{2}:\d{2}$/.test(claims.endTime!)) return null;
    return claims as AttendanceQrClaims;
  } catch {
    return null;
  }
}

export function canonicalAttendanceState(
  record: AttendanceRecordView | undefined,
  local: LocalAttendanceReceipt | undefined,
): 'confirmed' | 'voided' | 'pending' | 'syncing' | 'login_required' | 'review' | 'invalid' | 'manual_required' | 'none' {
  if (local?.recordStatus && (!record || (local.recordRevision || 0) > record.revision)) return local.recordStatus;
  if (record?.status === 'confirmed') return 'confirmed';
  if (record?.status === 'voided') return 'voided';
  if (!local) return 'none';
  if (local.status === 'confirmed' && local.recordId) return 'confirmed';
  if (local.localDeviceConflict || local.reason === 'device_session_conflict' || local.reason === 'device_unverified') return 'manual_required';
  if (local.status === 'syncing') return 'syncing';
  if (local.status === 'waiting_for_login') return 'login_required';
  if (local.status === 'review') return 'review';
  if (local.status === 'invalid') return 'invalid';
  return 'pending';
}
