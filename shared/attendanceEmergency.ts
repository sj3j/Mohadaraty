import type { AttendanceOccurrenceCandidate, AttendanceRosterEntry } from './attendance.js';

export interface EmergencyAttendanceInput {
  stageId: string;
  lectureTitle: string;
  lectureDate: string;
  startTime: string;
  studentIdentifier?: string;
  reason?: string;
  physicalHeadcount?: number | null;
}

export function normalizeAttendanceIdentity(value: string): string {
  return value.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function matchEmergencyOccurrence(input: EmergencyAttendanceInput, occurrences: AttendanceOccurrenceCandidate[]): AttendanceOccurrenceCandidate | null {
  const matches = occurrences.filter(item => item.stageId === input.stageId && item.lectureDate === input.lectureDate
    && item.startTime === input.startTime && normalizeAttendanceIdentity(item.title) === normalizeAttendanceIdentity(input.lectureTitle));
  return matches.length === 1 ? matches[0] : null;
}

export function matchEmergencyStudent(identifier: string, roster: AttendanceRosterEntry[]): AttendanceRosterEntry | null {
  const wanted = normalizeAttendanceIdentity(identifier);
  if (!wanted) return null;
  const byNumber = roster.filter(item => item.rosterIdentifier && normalizeAttendanceIdentity(item.rosterIdentifier) === wanted);
  if (byNumber.length) return byNumber.length === 1 ? byNumber[0] : null;
  const byName = roster.filter(item => normalizeAttendanceIdentity(item.officialName) === wanted);
  return byName.length === 1 ? byName[0] : null;
}
