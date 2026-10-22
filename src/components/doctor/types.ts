export type LectureMode = 'theoretical' | 'practical';

export type AttendanceCellStatus = 'present' | 'absent' | 'excused' | 'unrecorded' | 'pending' | 'voided' | 'not_applicable';

export interface DoctorSubject {
  id: string;
  nameAr: string;
  nameEn: string;
  stageId: string;
  stageNameAr: string;
  type: 'theoretical' | 'practical' | 'both';
  code?: string;
  timetableSessionIds?: string[];
}

export interface LectureColumn {
  id: string;
  number: number;
  date: string;
  title: string;
  mode: 'theoretical' | 'practical';
  time?: string;
  endTime?: string;
  day?: number;
  audienceGroups?: string[];
  location?: string;
  stageId?: string;
  stageName?: string;
  teacher?: string;
  subjectId?: string;
}

export interface WeeklyLectureColumn {
  id: string;
  weekNumber: number;
  sessionIndex: number;
  titleAr: string;
  titleEn: string;
  startDate: string;
  endDate: string;
  mode: 'theoretical' | 'practical';
  occurrences: LectureColumn[];
}

import type { AttendanceRecordView } from '../../../shared/attendance';

export interface StudentWeeklyCellInfo {
  status: AttendanceCellStatus;
  isCompensation: boolean;
  scheduledOccurrence?: LectureColumn;
  actualOccurrence?: LectureColumn;
  attendedGroup?: string;
  scheduledGroup?: string;
  attendedDate?: string;
  attendedTime?: string;
  notes?: string;
  scanTime?: string;
  locationBadge?: string;
}

export interface StudentAttendanceRow {
  studentId: string;
  name: string;
  group: string; // e.g. "A", "B", "C"
  examCode: string;
  attendance: Record<string, AttendanceCellStatus>; // lectureId -> status
  records?: Record<string, AttendanceRecordView>;
  notes?: string;
}

export type DoctorPortalTab = 'timetable' | 'live' | 'excel' | 'analytics';
