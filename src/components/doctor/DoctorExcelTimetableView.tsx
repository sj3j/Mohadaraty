import React, { useState, useMemo } from 'react';
import { 
  Search, FileSpreadsheet, Printer, Users, Check, X, Clock,
  Info, Sparkles, ChevronDown, RotateCcw, ShieldAlert
} from 'lucide-react';
import { 
  DoctorSubject, LectureColumn, StudentAttendanceRow, AttendanceCellStatus,
  WeeklyLectureColumn, StudentWeeklyCellInfo
} from './types';
import { attendanceWeekStart } from '../../../shared/attendance';
import { attendanceLocationBadge, attendanceScanTimeBadge } from '../../../shared/attendanceSecurity';

const DAY_NAMES_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DAY_NAMES_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const getLectureDayName = (lec: LectureColumn, isRtl: boolean): string => {
  const dayIndex = typeof lec.day === 'number' && lec.day >= 0 && lec.day <= 6
    ? lec.day
    : (lec.date ? new Date(`${lec.date}T00:00:00`).getDay() : undefined);
  if (dayIndex === undefined || isNaN(dayIndex)) return '';
  return isRtl ? DAY_NAMES_AR[dayIndex] : DAY_NAMES_EN[dayIndex];
};

export const formatLectureTime = (time?: string, endTime?: string): string => {
  if (!time) return '';
  if (!endTime) return time;
  return `${time} - ${endTime}`;
};

export const isStudentInLectureAudience = (studentGroup: string, audienceGroups?: string[]): boolean => {
  if (!audienceGroups || audienceGroups.length === 0) return true;
  if (!studentGroup) return false;
  const trimmed = studentGroup.trim().toUpperCase();
  if (audienceGroups.some(g => g.trim().toUpperCase() === trimmed)) return true;
  const groupLetter = trimmed.charAt(0);
  return audienceGroups.some(g => {
    const ug = g.trim().toUpperCase();
    return ug === groupLetter || ug.startsWith(trimmed) || trimmed.startsWith(ug);
  });
};

/**
 * Builds chronological weekly columns from all subject occurrences.
 * Handles partitioning if a subject meets multiple times a week for the same group.
 */
export function buildWeeklyColumns(lectures: LectureColumn[], isRtl: boolean): WeeklyLectureColumn[] {
  if (!lectures || lectures.length === 0) return [];

  // Group lectures by attendance week start (Saturday-anchored week)
  const weekMap = new Map<string, LectureColumn[]>();
  for (const lec of lectures) {
    const weekStart = attendanceWeekStart(lec.date);
    if (!weekMap.has(weekStart)) {
      weekMap.set(weekStart, []);
    }
    weekMap.get(weekStart)!.push(lec);
  }

  // Sort weeks chronologically
  const sortedWeekStarts = Array.from(weekMap.keys()).sort();
  const weeklyColumns: WeeklyLectureColumn[] = [];

  sortedWeekStarts.forEach((weekStart, weekIndex) => {
    const weekLectures = weekMap.get(weekStart) || [];
    // Sort lectures in week by date and time
    weekLectures.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

    // Check if any audience group appears more than once in this week
    // to partition into multiple sessions if a subject meets twice in one week
    const sessionBuckets: LectureColumn[][] = [];
    for (const lec of weekLectures) {
      let placed = false;
      for (const bucket of sessionBuckets) {
        const hasOverlap = (lec.audienceGroups || []).some(g =>
          bucket.some(bLec => (bLec.audienceGroups || []).includes(g))
        );
        if (!hasOverlap) {
          bucket.push(lec);
          placed = true;
          break;
        }
      }
      if (!placed) {
        sessionBuckets.push([lec]);
      }
    }

    const weekNumber = weekIndex + 1;
    const isMultiSession = sessionBuckets.length > 1;

    sessionBuckets.forEach((bucket, sessionIdx) => {
      const sessionIndex = sessionIdx + 1;
      const titleAr = isMultiSession
        ? `الأسبوع ${weekNumber} (م${sessionIndex})`
        : `الأسبوع ${weekNumber}`;
      const titleEn = isMultiSession
        ? `Week ${weekNumber} (Lec ${sessionIndex})`
        : `Week ${weekNumber}`;

      const dates = bucket.map(l => l.date).filter(Boolean).sort();
      const startDate = dates[0] || weekStart;
      const endDate = dates[dates.length - 1] || weekStart;

      weeklyColumns.push({
        id: `week_${weekNumber}_s${sessionIndex}`,
        weekNumber,
        sessionIndex,
        titleAr,
        titleEn,
        startDate,
        endDate,
        mode: bucket[0]?.mode || 'theoretical',
        occurrences: bucket,
      });
    });
  });

  return weeklyColumns;
}

/**
 * Calculates a student's attendance details for a specific weekly column,
 * automatically detecting whether attendance was with their native group or compensation (تعويض).
 */
export function calculateStudentWeeklyCellInfo(
  student: StudentAttendanceRow,
  weeklyCol: WeeklyLectureColumn,
  isRtl: boolean
): StudentWeeklyCellInfo {
  const stdGroup = (student.group || '').trim();

  // 1. Find the scheduled occurrence for the student's group in this week
  let scheduledOccurrence = weeklyCol.occurrences.find(occ =>
    isStudentInLectureAudience(stdGroup, occ.audienceGroups)
  );

  if (!scheduledOccurrence && weeklyCol.occurrences.length > 0) {
    const groupLetter = stdGroup.charAt(0).toUpperCase();
    scheduledOccurrence = weeklyCol.occurrences.find(occ =>
      (occ.audienceGroups || []).some(g => g.toUpperCase().startsWith(groupLetter))
    ) || weeklyCol.occurrences[0];
  }

  // 2. Check if the student attended ANY occurrence in this weekly column
  let actualOccurrence: LectureColumn | undefined;
  let isCompensation = false;
  let status: AttendanceCellStatus = 'unrecorded';

  for (const occ of weeklyCol.occurrences) {
    const raw = student.attendance[occ.id];
    if (raw === 'present') {
      actualOccurrence = occ;
      const isNative = isStudentInLectureAudience(stdGroup, occ.audienceGroups);
      isCompensation = !isNative;
      status = 'present';
      break;
    }
  }

  // If not present, check for excused / pending / voided / absent
  if (status !== 'present') {
    for (const occ of weeklyCol.occurrences) {
      const raw = student.attendance[occ.id];
      if (raw === 'excused') {
        status = 'excused';
        actualOccurrence = occ;
        break;
      }
      if (raw === 'pending') {
        status = 'pending';
        actualOccurrence = occ;
        break;
      }
      if (raw === 'voided') {
        status = 'voided';
        actualOccurrence = occ;
        break;
      }
      if (raw === 'absent') {
        status = 'absent';
        actualOccurrence = occ;
        break;
      }
    }
  }

  const scheduledAudienceStr = (scheduledOccurrence?.audienceGroups && scheduledOccurrence.audienceGroups.length > 0)
    ? scheduledOccurrence.audienceGroups.join(', ')
    : (isRtl ? 'عامة' : 'All');

  const actualAudienceStr = (actualOccurrence?.audienceGroups && actualOccurrence.audienceGroups.length > 0)
    ? actualOccurrence.audienceGroups.join(', ')
    : scheduledAudienceStr;

  const attendedOcc = actualOccurrence || scheduledOccurrence;
  const record = attendedOcc ? student.records?.[attendedOcc.id] : undefined;
  const scanTimeBadge = attendanceScanTimeBadge(record?.advisory, isRtl);
  const locationBadge = attendanceLocationBadge(record?.advisory, isRtl);

  return {
    status,
    isCompensation,
    scheduledOccurrence,
    actualOccurrence,
    attendedGroup: actualAudienceStr,
    scheduledGroup: scheduledAudienceStr,
    attendedDate: actualOccurrence?.date || scheduledOccurrence?.date,
    attendedTime: actualOccurrence?.time || scheduledOccurrence?.time,
    scanTime: scanTimeBadge || undefined,
    locationBadge: locationBadge || undefined,
  };
}

export const calculateStudentWeeklyStats = (
  student: StudentAttendanceRow,
  weeklyColumns: WeeklyLectureColumn[],
  isRtl: boolean
) => {
  let present = 0;
  let compensation = 0;
  let absent = 0;
  let excused = 0;
  let unrecorded = 0;

  for (const wCol of weeklyColumns) {
    const info = calculateStudentWeeklyCellInfo(student, wCol, isRtl);
    if (info.status === 'present') {
      present++;
      if (info.isCompensation) compensation++;
    } else if (info.status === 'absent') {
      absent++;
    } else if (info.status === 'excused') {
      excused++;
    } else {
      unrecorded++;
    }
  }

  const counted = present + absent;
  return {
    present,
    compensation,
    absent,
    excused,
    unrecorded,
    totalHeld: counted,
    attendanceRate: counted ? Math.round((100 * present) / counted) : 0,
    absenceRate: counted ? Math.round((100 * absent) / counted) : 0,
  };
};

interface ActivePopoverData {
  student: StudentAttendanceRow;
  weeklyCol: WeeklyLectureColumn;
  cellInfo: StudentWeeklyCellInfo;
}

interface DoctorExcelTimetableViewProps {
  subject: DoctorSubject;
  lectures: LectureColumn[];
  students: StudentAttendanceRow[];
  isRtl: boolean;
  onUpdateAttendance: (studentId: string, lectureId: string, newStatus: AttendanceCellStatus) => void;
  isOffline?: boolean;
}

export default function DoctorExcelTimetableView({
  subject,
  lectures,
  students,
  isRtl,
  onUpdateAttendance,
  isOffline,
}: DoctorExcelTimetableViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [selectedSubgroup, setSelectedSubgroup] = useState<string>('all');
  const [activeInfoPopover, setActiveInfoPopover] = useState<ActivePopoverData | null>(null);

  // Build weekly aggregated columns
  const weeklyColumns = useMemo(() => {
    return buildWeeklyColumns(lectures, isRtl);
  }, [lectures, isRtl]);

  // Derive dynamic groups and subgroups from the student roster + standard stage groups (A, B, C, D)
  const { availableGroups, subgroupsByGroup, hasUnassigned } = useMemo(() => {
    const STANDARD_GROUPS = ['A', 'B', 'C', 'D'];
    const groupsSet = new Set<string>(STANDARD_GROUPS);
    const subgroupsMap = new Map<string, Set<string>>();
    let unassigned = false;

    for (const g of STANDARD_GROUPS) {
      subgroupsMap.set(g, new Set([`${g}1`, `${g}2`, `${g}3`, `${g}4`]));
    }

    for (const s of students) {
      const sub = (s.group || '').trim();
      if (!sub) {
        unassigned = true;
        continue;
      }
      const match = sub.match(/^([A-Za-z]+)/);
      const mainGroup = match ? match[1].toUpperCase() : sub.charAt(0).toUpperCase();
      groupsSet.add(mainGroup);

      if (!subgroupsMap.has(mainGroup)) {
        subgroupsMap.set(mainGroup, new Set());
      }
      subgroupsMap.get(mainGroup)!.add(sub);
    }

    const sortedGroups = Array.from(groupsSet).sort();
    const sortedSubgroupsMap: Record<string, string[]> = {};
    for (const g of sortedGroups) {
      sortedSubgroupsMap[g] = Array.from(subgroupsMap.get(g) || []).sort();
    }

    return {
      availableGroups: sortedGroups,
      subgroupsByGroup: sortedSubgroupsMap,
      hasUnassigned: unassigned,
    };
  }, [students]);

  // Filter students based on search query, group, and subgroup
  const filteredStudents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return students.filter((student) => {
      const matchesSearch = !query ||
        student.name.toLowerCase().includes(query) ||
        student.examCode.toLowerCase().includes(query);

      let matchesGroup = true;
      const stdGroup = (student.group || '').trim();

      if (selectedGroup === 'unassigned') {
        matchesGroup = !stdGroup;
      } else if (selectedGroup !== 'all') {
        if (selectedSubgroup !== 'all') {
          matchesGroup = stdGroup === selectedSubgroup;
        } else {
          matchesGroup = stdGroup.toUpperCase().startsWith(selectedGroup.toUpperCase()) || stdGroup === selectedGroup;
        }
      }

      return matchesSearch && matchesGroup;
    });
  }, [students, searchQuery, selectedGroup, selectedSubgroup]);

  const handleSelectGroup = (grp: string) => {
    setSelectedGroup(grp);
    setSelectedSubgroup('all');
  };

  const handleCellClick = (student: StudentAttendanceRow, weeklyCol: WeeklyLectureColumn) => {
    const cellInfo = calculateStudentWeeklyCellInfo(student, weeklyCol, isRtl);
    const targetLectureId = cellInfo.actualOccurrence?.id || cellInfo.scheduledOccurrence?.id || weeklyCol.occurrences[0]?.id;
    if (!targetLectureId) return;

    if (cellInfo.status === 'present') {
      onUpdateAttendance(student.studentId, targetLectureId, 'voided');
    } else {
      onUpdateAttendance(student.studentId, targetLectureId, 'present');
    }
  };

  // Export to Excel-compatible CSV file with UTF-8 BOM
  const handleExportCsv = () => {
    const headers = [
      isRtl ? 'الرقم' : 'No',
      isRtl ? 'اسم الطالب الرباعي' : 'Student Name',
      isRtl ? 'الرقم الامتحاني' : 'Exam Code',
      isRtl ? 'الشعبة' : 'Group',
      ...weeklyColumns.map((w) => {
        const title = isRtl ? w.titleAr : w.titleEn;
        const modeStr = w.mode === 'practical' ? (isRtl ? 'عملي' : 'Lab') : (isRtl ? 'نظري' : 'Theory');
        return `${title} [${modeStr}] (${w.startDate})`;
      }),
      isRtl ? 'مجموع الحضور' : 'Total Attended',
      isRtl ? 'حضور التعويض ⚡' : 'Substituted ⚡',
      isRtl ? 'مجموع الغياب' : 'Total Absent',
      isRtl ? 'نسبة الحضور %' : 'Attendance %',
      isRtl ? 'الموقف الأكاديمي' : 'Status',
    ];

    const rows = filteredStudents.map((std, idx) => {
      const stats = calculateStudentWeeklyStats(std, weeklyColumns, isRtl);
      const weekCells = weeklyColumns.map((wCol) => {
        const info = calculateStudentWeeklyCellInfo(std, wCol, isRtl);
        if (info.status === 'present') {
          return info.isCompensation
            ? (isRtl ? `حاضر (تعويض - ${info.attendedGroup})` : `Present (Substituted - ${info.attendedGroup})`)
            : (isRtl ? 'حاضر' : 'Present');
        }
        if (info.status === 'absent') return isRtl ? 'غائب' : 'Absent';
        if (info.status === 'excused') return isRtl ? 'مجاز' : 'Excused';
        if (info.status === 'pending') return isRtl ? 'معلق' : 'Pending';
        if (info.status === 'voided') return isRtl ? 'ملغى' : 'Voided';
        return '-';
      });

      const statusLabel = isRtl ? 'السياسة غير معتمدة' : 'Policy unconfigured';

      return [
        idx + 1,
        std.name,
        std.examCode,
        std.group,
        ...weekCells,
        stats.present,
        stats.compensation,
        stats.absent,
        `${stats.attendanceRate}%`,
        statusLabel,
      ];
    });

    const csvCell = (value: string | number) => {
      const raw = String(value);
      const safe = /^[=+@\-\t\r]/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replace(/"/g, '""') + '"';
    };
    const csvContent = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Attendance_Weekly_${subject.nameEn.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {isOffline && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 border border-amber-200">
          {isRtl ? 'هذه نسخة محفوظة؛ التصحيحات اليدوية تظهر فوراً وتنتظر المزامنة.' : 'Cached ledger; manual corrections save locally and await sync.'}
        </p>
      )}

      {/* Top Toolbar: Search, Dynamic Group/Subgroup Filters & Actions */}
      <div className="flex flex-col gap-3 p-4 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* Search & Main Group filters */}
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <div className="relative min-w-[220px] flex-1 sm:flex-initial">
              <Search className="absolute start-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={isRtl ? 'بحث باسم الطالب أو الرمز...' : 'Search student or code...'}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-2 pe-3 ps-9 text-xs font-bold text-slate-800 placeholder-slate-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            {/* Dynamic Group Filter */}
            <div className="flex flex-wrap items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-zinc-800 border border-slate-200/60 dark:border-zinc-700/60">
              <button
                onClick={() => handleSelectGroup('all')}
                className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                  selectedGroup === 'all'
                    ? 'bg-white text-teal-700 shadow-sm dark:bg-zinc-700 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {isRtl ? 'كل الشُعب' : 'All Groups'}
              </button>

              {availableGroups.map((grp) => (
                <button
                  key={grp}
                  onClick={() => handleSelectGroup(grp)}
                  className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                    selectedGroup === grp
                      ? 'bg-white text-teal-700 shadow-sm dark:bg-zinc-700 dark:text-teal-300'
                      : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  {isRtl ? `شعبة ${grp}` : `Group ${grp}`}
                </button>
              ))}

              {hasUnassigned && (
                <button
                  onClick={() => handleSelectGroup('unassigned')}
                  className={`px-3 py-1 rounded-xl text-xs font-black transition-all cursor-pointer ${
                    selectedGroup === 'unassigned'
                      ? 'bg-white text-amber-700 shadow-sm dark:bg-zinc-700 dark:text-amber-300'
                      : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  {isRtl ? 'غير محدد' : 'Unassigned'}
                </button>
              )}
            </div>
          </div>

          {/* Export & Print Actions */}
          <div className="flex items-center gap-2 ms-auto lg:ms-0">
            <button
              onClick={handleExportCsv}
              className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-black text-xs shadow-md shadow-teal-600/20 transition-all cursor-pointer"
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>{isRtl ? 'تصدير Excel أسبوعي' : 'Export Weekly Excel'}</span>
            </button>

            <button
              onClick={() => window.print()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-2xl border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 transition-colors text-xs font-bold cursor-pointer"
            >
              <Printer className="h-4 w-4" />
              <span>{isRtl ? 'طباعة' : 'Print'}</span>
            </button>
          </div>
        </div>

        {/* Second-Tier Subgroup Chips */}
        {selectedGroup !== 'all' && selectedGroup !== 'unassigned' && subgroupsByGroup[selectedGroup]?.length > 0 && (
          <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-zinc-800/80">
            <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 flex items-center gap-1">
              <Users className="h-3 w-3" />
              {isRtl ? 'المجموعات الفرعية:' : 'Subgroups:'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setSelectedSubgroup('all')}
                className={`px-2.5 py-0.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  selectedSubgroup === 'all'
                    ? 'bg-teal-600 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300'
                }`}
              >
                {isRtl ? `كل ${selectedGroup}` : `All ${selectedGroup}`}
              </button>
              {subgroupsByGroup[selectedGroup].map((sub) => (
                <button
                  key={sub}
                  onClick={() => setSelectedSubgroup(sub)}
                  className={`px-2.5 py-0.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    selectedSubgroup === sub
                      ? 'bg-teal-600 text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-800 dark:text-zinc-300'
                  }`}
                >
                  {sub}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Legend & Instructions */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-[11px] font-bold text-slate-500 dark:text-zinc-400">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 font-black">
              ✓
            </span>
            {isRtl ? 'حاضر (نظامي)' : 'Present'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400 font-black text-xs shadow-xs">
              ⚡
            </span>
            {isRtl ? 'حاضر تعويض (شعبة أخرى)' : 'Substituted ⚡'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 font-black">
              ✗
            </span>
            {isRtl ? 'غائب' : 'Absent'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 font-black">
              ⏱
            </span>
            {isRtl ? 'إجازة / عذر' : 'Excused'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-slate-100 text-slate-400 dark:bg-zinc-800 font-black">
              -
            </span>
            {isRtl ? 'لم تُسجل / قادمة' : 'Unrecorded'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-slate-100 text-teal-600 dark:bg-zinc-800 dark:text-teal-400 font-black">
              <Info className="h-3 w-3" />
            </span>
            {isRtl ? 'تفاصيل الحضور والتعويض (i)' : 'Info Details (i)'}
          </span>
        </div>

        <div>
          {isRtl
            ? `عرض ${filteredStudents.length} من أصل ${students.length} طالب • ${weeklyColumns.length} أسابيع`
            : `Showing ${filteredStudents.length} of ${students.length} students • ${weeklyColumns.length} weeks`}
        </div>
      </div>

      {/* Master Excel Spreadsheet Table */}
      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto max-h-[72vh]">
          <table className="w-full text-xs text-start border-collapse select-none">
            {/* Table Header */}
            <thead>
              <tr className="sticky top-0 z-30 bg-slate-100/95 dark:bg-zinc-800/95 backdrop-blur border-b border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300">
                <th className="py-3 px-2 text-center w-12 font-black border-e border-slate-200 dark:border-zinc-700">
                  #
                </th>
                
                {/* Sticky Student Name Column */}
                <th className={`sticky ${isRtl ? 'right-0' : 'left-0'} z-40 bg-slate-100 dark:bg-zinc-800 py-3 px-4 min-w-[200px] text-start font-black border-e-2 border-slate-300 dark:border-zinc-600 shadow-sm`}>
                  {isRtl ? 'اسم الطالب الرباعي' : 'Student Name'}
                </th>

                <th className="py-3 px-3 text-center min-w-[70px] font-black border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'الشعبة' : 'Group'}
                </th>

                {/* Weekly Columns */}
                {weeklyColumns.map((wCol) => {
                  const modeStr = wCol.mode === 'practical' ? (isRtl ? 'عملي' : 'Lab') : (isRtl ? 'نظري' : 'Theory');
                  return (
                    <th 
                      key={wCol.id} 
                      className="py-2.5 px-3 text-center min-w-[105px] border-e border-slate-200 dark:border-zinc-700 transition-colors hover:bg-slate-200/60 dark:hover:bg-zinc-700/60"
                      title={`${isRtl ? wCol.titleAr : wCol.titleEn} (${wCol.startDate})`}
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span className="font-black text-slate-900 dark:text-zinc-100">
                          {isRtl ? wCol.titleAr : wCol.titleEn}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-bold bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                          {modeStr}
                        </span>
                      </div>

                      <div className="text-[10px] font-mono text-slate-500 dark:text-zinc-400 mt-0.5">
                        {wCol.startDate.slice(5)}
                      </div>
                    </th>
                  );
                })}

                {/* Summary Metrics Columns */}
                <th className="py-3 px-3 text-center min-w-[75px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'حضور' : 'Attended'}
                </th>
                <th className="py-3 px-3 text-center min-w-[75px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700 text-indigo-600 dark:text-indigo-400">
                  {isRtl ? 'تعويض ⚡' : 'Sub ⚡'}
                </th>
                <th className="py-3 px-3 text-center min-w-[75px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'غياب' : 'Absent'}
                </th>
                <th className="py-3 px-3 text-center min-w-[75px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'النسبة' : 'Rate'}
                </th>
                <th className="py-3 px-3 text-center min-w-[95px] font-black bg-slate-50 dark:bg-zinc-850">
                  {isRtl ? 'الحالة' : 'Status'}
                </th>
              </tr>
            </thead>

            {/* Table Body */}
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
              {filteredStudents.length > 0 ? (
                filteredStudents.map((student, idx) => {
                  const stats = calculateStudentWeeklyStats(student, weeklyColumns, isRtl);

                  return (
                    <tr 
                      key={student.studentId}
                      className={`hover:bg-teal-50/40 dark:hover:bg-zinc-800/50 transition-colors ${
                        idx % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-slate-50/40 dark:bg-zinc-900/60'
                      }`}
                    >
                      {/* Row Index */}
                      <td className="py-2.5 px-2 text-center text-slate-400 font-mono text-[11px] border-e border-slate-100 dark:border-zinc-800">
                        {idx + 1}
                      </td>

                      {/* Sticky Student Name & Info */}
                      <td className={`sticky ${isRtl ? 'right-0' : 'left-0'} z-20 ${
                        idx % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-slate-50 dark:bg-zinc-900'
                      } py-2.5 px-4 font-black text-slate-900 dark:text-zinc-100 border-e-2 border-slate-300 dark:border-zinc-700 shadow-sm`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{student.name}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono font-normal">
                          {student.examCode}
                        </div>
                      </td>

                      {/* Student Subgroup */}
                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-bold">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300 text-[11px]">
                          {student.group || (isRtl ? 'غير محدد' : '-')}
                        </span>
                      </td>

                      {/* Weekly Attendance Squares */}
                      {weeklyColumns.map((wCol) => {
                        const cellInfo = calculateStudentWeeklyCellInfo(student, wCol, isRtl);
                        const status = cellInfo.status;
                        const isComp = cellInfo.isCompensation;

                        return (
                          <td
                            key={wCol.id}
                            className="py-2 px-1.5 text-center border-e border-slate-100 dark:border-zinc-800 relative group"
                          >
                            <div className="flex items-center justify-center gap-1">
                              {/* Square Button with Attendance Mark */}
                              <button
                                type="button"
                                onClick={() => handleCellClick(student, wCol)}
                                className="cursor-pointer hover:scale-105 active:scale-95 transition-transform"
                                title={
                                  status === 'present'
                                    ? (isComp
                                      ? (isRtl ? `حاضر (تعويض مع شعبة ${cellInfo.attendedGroup}) - اضغط للتعديل` : `Present (Substituted in ${cellInfo.attendedGroup}) - Click to toggle`)
                                      : (isRtl ? 'حاضر (حضور نظامي) - اضغط للتعديل' : 'Present - Click to toggle'))
                                    : status === 'absent'
                                    ? (isRtl ? 'غائب - اضغط لتسجيل الحضور' : 'Absent - Click to mark present')
                                    : (isRtl ? 'اضغط لتسجيل الحضور' : 'Click to mark attendance')
                                }
                              >
                                {status === 'present' ? (
                                  isComp ? (
                                    /* Compensation Attendance: Distinct Indigo/Purple Badge with Lightning ⚡ */
                                    <div className="relative flex h-7 items-center gap-0.5 px-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-indigo-600 text-white font-black shadow-xs border border-indigo-400/50">
                                      <Check className="h-3 w-3 stroke-[3]" />
                                      <span className="text-[10px]">⚡</span>
                                    </div>
                                  ) : (
                                    /* Native Regular Attendance: Emerald Checkmark ✓ */
                                    <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 font-black shadow-xs">
                                      ✓
                                    </span>
                                  )
                                ) : status === 'absent' ? (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 font-black shadow-xs">
                                    ✗
                                  </span>
                                ) : status === 'excused' ? (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 font-black shadow-xs">
                                    ⏱
                                  </span>
                                ) : status === 'pending' ? (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300 font-black shadow-xs text-[11px]" title={isRtl ? 'بانتظار المزامنة' : 'Pending sync'}>
                                    ⏳
                                  </span>
                                ) : status === 'voided' ? (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400 font-black shadow-xs text-[11px]" title={isRtl ? 'ملغى' : 'Voided'}>
                                    ⊘
                                  </span>
                                ) : (
                                  <span className="flex h-7 w-7 items-center justify-center rounded-xl text-slate-300 dark:text-zinc-600 font-bold hover:bg-slate-200/50 dark:hover:bg-zinc-700/50">
                                    -
                                  </span>
                                )}
                              </button>

                              {/* Small Info Icon (i) - Opens Floating Details Popover Card */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveInfoPopover({ student, weeklyCol: wCol, cellInfo });
                                }}
                                className={`p-1 rounded-md text-slate-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-zinc-800 dark:hover:text-teal-400 transition-colors cursor-pointer ${
                                  isComp ? 'text-indigo-500 font-bold' : ''
                                }`}
                                title={isRtl ? 'عرض تفاصيل الحضور وتاريخ الشعبة والتعويض' : 'View attendance & compensation details'}
                              >
                                <Info className="h-3 w-3" />
                              </button>
                            </div>
                          </td>
                        );
                      })}

                      {/* Summary Metrics */}
                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-black text-emerald-600 dark:text-emerald-400">
                        {stats.present}
                      </td>

                      <td className={`py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-black ${
                        stats.compensation > 0 ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-300 dark:text-zinc-600'
                      }`}>
                        {stats.compensation > 0 ? `${stats.compensation} ⚡` : '0'}
                      </td>

                      <td className={`py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-black ${
                        stats.absent > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400'
                      }`}>
                        {stats.absent}
                      </td>

                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-mono font-black text-slate-700 dark:text-zinc-200">
                        {stats.attendanceRate}%
                      </td>

                      {/* Academic Status Badge */}
                      <td className="py-2.5 px-3 text-center">
                        <span className="inline-block px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300 font-bold text-[10px]">
                          {isRtl ? 'السياسة غير معتمدة' : 'Policy unconfigured'}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={weeklyColumns.length + 8} className="py-12 text-center text-slate-400 dark:text-zinc-500 font-bold">
                    {isRtl ? 'لا توجد نتائج مطابقة لبحثك' : 'No matching student records found'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Interactive Info Popover Modal */}
      {activeInfoPopover && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div 
            className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl border border-slate-200 dark:bg-zinc-900 dark:border-zinc-800 animate-in zoom-in-95 duration-150"
            dir={isRtl ? 'rtl' : 'ltr'}
          >
            {/* Popover Header */}
            <div className="p-5 border-b border-slate-100 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-800/40 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-2xl shadow-xs ${
                  activeInfoPopover.cellInfo.isCompensation
                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                    : activeInfoPopover.cellInfo.status === 'present'
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-slate-200 text-slate-600 dark:bg-zinc-700 dark:text-zinc-300'
                }`}>
                  {activeInfoPopover.cellInfo.isCompensation ? <Sparkles className="h-5 w-5" /> : <Info className="h-5 w-5" />}
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-zinc-100">
                    {activeInfoPopover.student.name}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-zinc-400 mt-0.5">
                    <span className="font-mono">{activeInfoPopover.student.examCode}</span>
                    <span>•</span>
                    <span>{isRtl ? `شعبة ${activeInfoPopover.student.group || 'غير محدد'}` : `Group ${activeInfoPopover.student.group || '-'}`}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setActiveInfoPopover(null)}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-200/60 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Popover Content */}
            <div className="p-5 space-y-4 text-xs">
              <div className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200/60 dark:border-zinc-700/60">
                <span className="font-bold text-slate-500 dark:text-zinc-400">
                  {isRtl ? 'المحاضرة والأسبوع:' : 'Week & Session:'}
                </span>
                <span className="font-black text-slate-800 dark:text-zinc-200">
                  {isRtl ? activeInfoPopover.weeklyCol.titleAr : activeInfoPopover.weeklyCol.titleEn} ({subject.nameAr})
                </span>
              </div>

              {/* Status Badge */}
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500 dark:text-zinc-400">
                  {isRtl ? 'حالة الحضور:' : 'Attendance Status:'}
                </span>
                <div>
                  {activeInfoPopover.cellInfo.status === 'present' ? (
                    activeInfoPopover.cellInfo.isCompensation ? (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-black bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800">
                        <span>⚡</span>
                        <span>{isRtl ? 'حاضر تعويض (في شعبة أخرى)' : 'Substituted in another group'}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-black bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800">
                        <Check className="h-3 w-3 stroke-[3]" />
                        <span>{isRtl ? 'حاضر (حضور نظامي)' : 'Present (Regular)'}</span>
                      </span>
                    )
                  ) : activeInfoPopover.cellInfo.status === 'absent' ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-black bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800">
                      <span>✗</span>
                      <span>{isRtl ? 'غائب عن المحاضرة' : 'Absent'}</span>
                    </span>
                  ) : activeInfoPopover.cellInfo.status === 'excused' ? (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-black bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800">
                      <span>⏱</span>
                      <span>{isRtl ? 'مجاز بعذر رسمي' : 'Excused'}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-black bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
                      <span>-</span>
                      <span>{isRtl ? 'لم تُسجل بعد' : 'Unrecorded'}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Grid of Key Details */}
              <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <div className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/50 dark:border-zinc-700/50 space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 block">
                    {isRtl ? 'تاريخ الحضور / المحاضرة' : 'Date'}
                  </span>
                  <span className="font-mono font-black text-slate-800 dark:text-zinc-200">
                    {activeInfoPopover.cellInfo.attendedDate || activeInfoPopover.weeklyCol.startDate}
                  </span>
                </div>

                <div className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/50 dark:border-zinc-700/50 space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 block">
                    {isRtl ? 'توقيت المحاضرة' : 'Time'}
                  </span>
                  <span className="font-mono font-black text-slate-800 dark:text-zinc-200">
                    {activeInfoPopover.cellInfo.attendedTime || activeInfoPopover.cellInfo.scheduledOccurrence?.time || (isRtl ? 'غير محدد' : '-')}
                  </span>
                </div>

                <div className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200/50 dark:border-zinc-700/50 space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 block">
                    {isRtl ? 'شعبة الطالب الأساسية' : 'Native Group'}
                  </span>
                  <span className="font-black text-slate-800 dark:text-zinc-200">
                    {activeInfoPopover.student.group || (isRtl ? 'غير محدد' : '-')}
                  </span>
                </div>

                <div className={`p-3 rounded-2xl border space-y-1 ${
                  activeInfoPopover.cellInfo.isCompensation
                    ? 'bg-indigo-50/70 border-indigo-200 dark:bg-indigo-950/30 dark:border-indigo-800/60'
                    : 'bg-slate-50 dark:bg-zinc-800/40 border-slate-200/50 dark:border-zinc-700/50'
                }`}>
                  <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-500 block">
                    {isRtl ? 'الشعبة التي حضر معها' : 'Attended Group'}
                  </span>
                  <span className={`font-black ${
                    activeInfoPopover.cellInfo.isCompensation ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-800 dark:text-zinc-200'
                  }`}>
                    {activeInfoPopover.cellInfo.attendedGroup || (isRtl ? 'لم يحضر' : '-')}
                  </span>
                </div>
              </div>

              {/* Student Scan Telemetry (Phone Timestamp, Timezone & Location) */}
              {(activeInfoPopover.cellInfo.scanTime || activeInfoPopover.cellInfo.locationBadge) && (
                <div className="p-3 rounded-2xl bg-teal-50/80 dark:bg-teal-950/40 border border-teal-200/60 dark:border-teal-900/60 space-y-1.5">
                  <span className="text-[10px] font-bold text-teal-800 dark:text-teal-300 block">
                    {isRtl ? 'بيانات مسح الطالب (توقيت الهاتف والموقع)' : 'Student Scan Telemetry (Time & Location)'}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {activeInfoPopover.cellInfo.locationBadge && (
                      <span className="text-xs font-bold text-slate-700 dark:text-zinc-200">
                        {activeInfoPopover.cellInfo.locationBadge}
                      </span>
                    )}
                    {activeInfoPopover.cellInfo.scanTime && (
                      <span className="text-xs font-bold text-teal-900 dark:text-teal-200 font-mono">
                        {activeInfoPopover.cellInfo.scanTime}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Compensation Verdict Box */}
              <div className={`p-3 rounded-2xl border text-xs font-bold flex items-center gap-2.5 ${
                activeInfoPopover.cellInfo.isCompensation
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-900 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-200'
                  : 'bg-slate-50 border-slate-200 text-slate-600 dark:bg-zinc-800/50 dark:border-zinc-700 dark:text-zinc-300'
              }`}>
                {activeInfoPopover.cellInfo.isCompensation ? (
                  <>
                    <Sparkles className="h-4 w-4 text-indigo-600 shrink-0" />
                    <span>{isRtl ? 'حضور تعويضي: احتُسب حضور الطالب بنجاح بالتعويض عن شعبته الأصلية.' : 'Substituted: Attendance credited as compensation for native group.'}</span>
                  </>
                ) : activeInfoPopover.cellInfo.status === 'present' ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>{isRtl ? 'حضور نظامي: الطالب حضر مع مجموعته الدراسية المقررة.' : 'Regular attendance: Student attended with scheduled cohort.'}</span>
                  </>
                ) : (
                  <>
                    <Clock className="h-4 w-4 text-slate-400 shrink-0" />
                    <span>{isRtl ? 'لم يُسجل حضور تعويضي لهذا الطالب في هذا الأسبوع.' : 'No substitution record registered for this week.'}</span>
                  </>
                )}
              </div>
            </div>

            {/* Popover Footer with Quick Audited Override Actions */}
            <div className="p-4 bg-slate-50 border-t border-slate-100 dark:bg-zinc-800/60 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {activeInfoPopover.cellInfo.status === 'present' ? (
                  <button
                    onClick={() => {
                      const targetId = activeInfoPopover.cellInfo.actualOccurrence?.id || activeInfoPopover.cellInfo.scheduledOccurrence?.id;
                      if (targetId) onUpdateAttendance(activeInfoPopover.student.studentId, targetId, 'voided');
                      setActiveInfoPopover(null);
                    }}
                    className="px-3.5 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 font-bold text-xs transition-colors cursor-pointer"
                  >
                    {isRtl ? 'إلغاء الحضور (تسجيل غياب)' : 'Void (Mark Absent)'}
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const targetId = activeInfoPopover.cellInfo.scheduledOccurrence?.id || activeInfoPopover.weeklyCol.occurrences[0]?.id;
                      if (targetId) onUpdateAttendance(activeInfoPopover.student.studentId, targetId, 'present');
                      setActiveInfoPopover(null);
                    }}
                    className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-sm transition-colors cursor-pointer"
                  >
                    {isRtl ? 'تسجيل حضور مؤكد ✓' : 'Mark as Present ✓'}
                  </button>
                )}
              </div>

              <button
                onClick={() => setActiveInfoPopover(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-700 font-bold text-xs transition-colors cursor-pointer"
              >
                {isRtl ? 'إغلاق' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
