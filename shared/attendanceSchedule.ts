import { attendanceWeekStart, canonicalAttendanceState, type AttendanceMine, type AttendanceOccurrenceCandidate, type LocalAttendanceReceipt } from './attendance.js';

export interface StudentAttendanceRow {
  occurrence: Pick<AttendanceOccurrenceCandidate, 'id' | 'stageId' | 'lectureDate' | 'title' | 'startTime' | 'endTime'> & Partial<AttendanceOccurrenceCandidate>;
  weekStart: string;
  state: ReturnType<typeof canonicalAttendanceState> | 'absent';
  receipt?: LocalAttendanceReceipt;
}

export type LectureTimingStatus = 'past' | 'today' | 'upcoming';

/** Date-only schedule state; attendance results are resolved independently. */
export function lectureTimingStatus(lectureDate: string, today: string): LectureTimingStatus {
  if (lectureDate < today) return 'past';
  if (lectureDate > today) return 'upcoming';
  return 'today';
}

export function studentAttendanceRows(mine: AttendanceMine | null, receipts: LocalAttendanceReceipt[], subgroup?: string): StudentAttendanceRow[] {
  const cancelledSessionIds = new Set((mine?.cancelledSessions || []).map(session => session.id));
  const visibleReceipts = receipts.filter(receipt => !cancelledSessionIds.has(receipt.sessionId));
  const occurrences = new Map<string, StudentAttendanceRow['occurrence']>();
  for (const occurrence of mine?.occurrences || []) {
    if (!occurrence.audienceGroups.length || occurrence.audienceGroups.includes(subgroup || '')) occurrences.set(occurrence.id, occurrence);
  }
  for (const session of mine?.sessions || []) occurrences.set(session.occurrenceId, session.occurrence);
  for (const receipt of visibleReceipts) if (!occurrences.has(receipt.occurrenceId)) occurrences.set(receipt.occurrenceId, receipt.occurrence);
  return [...occurrences.values()].map(occurrence => {
    const session = mine?.sessions.find(item => item.occurrenceId === occurrence.id);
    const record = session && mine?.records.find(item => item.sessionId === session.id);
    const matching = visibleReceipts.filter(item => item.occurrenceId === occurrence.id);
    const receipt = matching.find(item => item.status !== 'invalid') || matching[0];
    let state: StudentAttendanceRow['state'] = canonicalAttendanceState(record || undefined, receipt);
    if (state === 'none' && session?.status === 'finalized' && !mine?.offline && mine?.historyComplete !== false) state = 'absent';
    return { occurrence, receipt, state, weekStart: attendanceWeekStart(occurrence.lectureDate) };
  }).sort((first, second) => first.occurrence.lectureDate.localeCompare(second.occurrence.lectureDate) || first.occurrence.startTime.localeCompare(second.occurrence.startTime) || first.occurrence.id.localeCompare(second.occurrence.id));
}
