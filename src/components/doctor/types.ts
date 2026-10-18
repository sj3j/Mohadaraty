export type LectureMode = 'theoretical' | 'practical' | 'both';

export type AttendanceCellStatus = 'present' | 'absent' | 'excused' | 'unrecorded' | 'pending' | 'voided' | 'not_applicable';

export interface DoctorSubject {
  id: string;
  nameAr: string;
  nameEn: string;
  stageId: string;
  stageNameAr: string;
  type: LectureMode;
  code?: string;
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
}

export interface StudentAttendanceRow {
  studentId: string;
  name: string;
  group: string; // e.g. "A", "B", "C"
  examCode: string;
  attendance: Record<string, AttendanceCellStatus>; // lectureId -> status
  notes?: string;
}

export type DoctorPortalTab = 'live' | 'excel' | 'analytics';
