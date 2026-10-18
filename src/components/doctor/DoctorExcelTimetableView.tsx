import React, { useState, useMemo } from 'react';
import { 
  Search, Download, Printer, Filter, Check, X, Clock, Minus, 
  HelpCircle, ChevronDown, Sparkles, FileSpreadsheet, ShieldAlert,
  Users
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow, AttendanceCellStatus } from './types';

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
  return audienceGroups.includes(studentGroup);
};

const calculateStudentStats = (student: StudentAttendanceRow, lectures: LectureColumn[]) => {
  let present = 0;
  let absent = 0;
  let excused = 0;
  let notApplicable = 0;

  for (const lecture of lectures) {
    const isAudience = isStudentInLectureAudience(student.group, lecture.audienceGroups);
    const recordedStatus = student.attendance[lecture.id];

    if (!isAudience && recordedStatus !== 'present' && recordedStatus !== 'excused') {
      notApplicable++;
      continue;
    }

    if (recordedStatus === 'present') present++;
    else if (recordedStatus === 'absent') absent++;
    else if (recordedStatus === 'excused') excused++;
  }

  const counted = present + absent;
  return {
    present,
    absent,
    excused,
    notApplicable,
    totalHeld: counted,
    attendanceRate: counted ? Math.round(100 * present / counted) : 0,
    absenceRate: counted ? Math.round(100 * absent / counted) : 0,
    status: 'safe' as const,
  };
};

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

  // Derive dynamic groups and subgroups from the student roster + standard stage groups (A, B, C, D)
  const { availableGroups, subgroupsByGroup, hasUnassigned } = useMemo(() => {
    const STANDARD_GROUPS = ['A', 'B', 'C', 'D'];
    const groupsSet = new Set<string>(STANDARD_GROUPS);
    const subgroupsMap = new Map<string, Set<string>>();
    let unassigned = false;

    // Seed standard subgroups A1..A4, B1..B4, C1..C4, D1..D4
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

  const handleCellClick = (studentId: string, lectureId: string, currentStatus: AttendanceCellStatus = 'unrecorded') => {
    if (currentStatus !== 'pending' && currentStatus !== 'not_applicable') {
      onUpdateAttendance(studentId, lectureId, currentStatus === 'present' ? 'voided' : 'present');
    }
  };

  // Export to Excel-compatible CSV file with UTF-8 BOM
  const handleExportCsv = () => {
    const headers = [
      isRtl ? 'الرقم' : 'No',
      isRtl ? 'اسم الطالب الرباعي' : 'Student Name',
      isRtl ? 'الرقم الامتحاني' : 'Exam Code',
      isRtl ? 'الشعبة' : 'Group',
      ...lectures.map((l) => {
        const day = getLectureDayName(l, isRtl);
        const time = formatLectureTime(l.time, l.endTime);
        const audience = (l.audienceGroups && l.audienceGroups.length > 0)
          ? l.audienceGroups.join('/')
          : (isRtl ? 'عامة' : 'All');
        const modeStr = l.mode === 'practical' ? (isRtl ? 'عملي' : 'Prac') : (isRtl ? 'نظري' : 'Theo');
        const timeInfo = time ? ` ${time}` : '';
        const dayInfo = day ? `${day} ` : '';
        return `${isRtl ? 'محاضرة' : 'Lec'} ${l.number} [${modeStr}] (${dayInfo}${l.date}${timeInfo} | ${audience})`;
      }),
      isRtl ? 'مجموع الحضور' : 'Total Attended',
      isRtl ? 'مجموع الغياب' : 'Total Absent',
      isRtl ? 'نسبة الحضور %' : 'Attendance %',
      isRtl ? 'الموقف الأكاديمي' : 'Status',
    ];

    const rows = filteredStudents.map((std, idx) => {
      const stats = calculateStudentStats(std, lectures);
      const lectureCells = lectures.map((lec) => {
        const isAudience = isStudentInLectureAudience(std.group, lec.audienceGroups);
        const val = std.attendance[lec.id] || 'unrecorded';
        if (val === 'present') return isRtl ? 'حاضر' : 'Present';
        if (val === 'absent') return isRtl ? 'غائب' : 'Absent';
        if (val === 'excused') return isRtl ? 'مجاز' : 'Excused';
        if (val === 'pending') return isRtl ? 'معلق' : 'Pending';
        if (val === 'voided') return isRtl ? 'ملغى' : 'Voided';
        if (!isAudience) return isRtl ? 'غير مشمول' : 'N/A';
        return '-';
      });

      const statusLabel = isRtl ? 'سياسة العقوبات غير معتمدة' : 'Sanctions policy not configured';

      return [
        idx + 1,
        std.name,
        std.examCode,
        std.group,
        ...lectureCells,
        stats.present,
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
    link.setAttribute('download', `Attendance_${subject.nameEn.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4" dir={isRtl ? 'rtl' : 'ltr'}>
      {isOffline && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{isRtl ? 'هذه نسخة محفوظة؛ التصحيحات اليدوية تظهر فوراً وتنتظر المزامنة.' : 'Cached ledger; manual corrections save locally and await sync.'}</p>}
      
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
                className={`px-3 py-1 rounded-xl text-xs font-black transition-all ${
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
                  className={`px-3 py-1 rounded-xl text-xs font-black transition-all ${
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
                  className={`px-3 py-1 rounded-xl text-xs font-black transition-all ${
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
              <span>{isRtl ? 'تصدير Excel' : 'Export Excel'}</span>
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

        {/* Second-Tier Subgroup Chips (visible when a specific group is selected) */}
        {selectedGroup !== 'all' && selectedGroup !== 'unassigned' && subgroupsByGroup[selectedGroup]?.length > 0 && (
          <div className="flex items-center gap-2 pt-1 border-t border-slate-100 dark:border-zinc-800/80">
            <span className="text-[11px] font-bold text-slate-400 dark:text-zinc-500 flex items-center gap-1">
              <Users className="h-3 w-3" />
              {isRtl ? 'المجموعات الفرعية:' : 'Subgroups:'}
            </span>
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setSelectedSubgroup('all')}
                className={`px-2.5 py-0.5 rounded-lg text-xs font-bold transition-all ${
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
                  className={`px-2.5 py-0.5 rounded-lg text-xs font-bold transition-all ${
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
            {isRtl ? 'حاضر' : 'Present'}
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
            {isRtl ? 'لم تُسجل' : 'Unrecorded'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300 font-black text-[10px]">
              ⏳
            </span>
            {isRtl ? 'معلق' : 'Pending'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex px-1.5 py-0.5 items-center justify-center rounded-lg bg-slate-100 text-slate-400 dark:bg-zinc-800 font-bold text-[9px]">
              {isRtl ? 'غير مشمول' : 'N/A'}
            </span>
            {isRtl ? 'غير مشمول (شعبة أخرى)' : 'Not in Audience'}
          </span>
        </div>

        <div>
          {isRtl
            ? `عرض ${filteredStudents.length} من أصل ${students.length} طالب`
            : `Showing ${filteredStudents.length} of ${students.length} students`}
        </div>
      </div>

      {/* Master Excel Spreadsheet Table */}
      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="overflow-x-auto max-h-[70vh]">
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

                {/* Lecture Columns with Rich Timetable Info */}
                {lectures.map((lec) => {
                  const dayName = getLectureDayName(lec, isRtl);
                  const timeFormatted = formatLectureTime(lec.time, lec.endTime);
                  const audience = (lec.audienceGroups && lec.audienceGroups.length > 0)
                    ? lec.audienceGroups.join(', ')
                    : (isRtl ? 'الكل' : 'All');

                  return (
                    <th 
                      key={lec.id} 
                      className="py-2.5 px-3 text-center min-w-[110px] border-e border-slate-200 dark:border-zinc-700 transition-colors hover:bg-slate-200/60 dark:hover:bg-zinc-700/60"
                      title={`${lec.title}${lec.location ? ` • ${lec.location}` : ''}`}
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span className="font-black text-slate-800 dark:text-zinc-100">
                          {isRtl ? `م ${lec.number}` : `Lec ${lec.number}`}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-bold bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
                          {lec.mode === 'practical' ? (isRtl ? 'عملي' : 'Prac') : (isRtl ? 'نظري' : 'Theo')}
                        </span>
                      </div>

                      {dayName && (
                        <div className="text-[10px] font-bold text-slate-600 dark:text-zinc-300 mt-0.5">
                          {dayName} ({lec.date.slice(5)})
                        </div>
                      )}

                      {timeFormatted && (
                        <div className="text-[9px] font-mono text-slate-500 dark:text-zinc-400 flex items-center justify-center gap-0.5 mt-0.5">
                          <Clock className="h-2.5 w-2.5 text-slate-400" />
                          <span>{timeFormatted}</span>
                        </div>
                      )}

                      <div className="mt-1">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-black ${
                          lec.audienceGroups?.length 
                            ? 'bg-amber-100/80 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200/50 dark:border-amber-900/50' 
                            : 'bg-slate-200/60 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
                        }`}>
                          {audience}
                        </span>
                      </div>
                    </th>
                  );
                })}

                {/* Summary Metrics Columns */}
                <th className="py-3 px-3 text-center min-w-[80px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'حضور' : 'Attended'}
                </th>
                <th className="py-3 px-3 text-center min-w-[80px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
                  {isRtl ? 'غياب' : 'Absent'}
                </th>
                <th className="py-3 px-3 text-center min-w-[80px] font-black bg-slate-50 dark:bg-zinc-850 border-e border-slate-200 dark:border-zinc-700">
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
                  const stats = calculateStudentStats(student, lectures);
                  const isDeprived = false;

                  return (
                    <tr 
                      key={student.studentId}
                      className={`hover:bg-teal-50/40 dark:hover:bg-zinc-800/50 transition-colors ${
                        idx % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-slate-50/40 dark:bg-zinc-900/60'
                      } ${isDeprived ? 'bg-red-50/30 dark:bg-red-950/20' : ''}`}
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
                          {isDeprived && (
                            <span className="flex h-2 w-2 rounded-full bg-rose-500 animate-pulse" title="محروم بالغياب" />
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono font-normal">
                          {student.examCode}
                        </div>
                      </td>

                      {/* Subgroup */}
                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-bold">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300 text-[11px]">
                          {student.group || (isRtl ? 'غير محدد' : '-')}
                        </span>
                      </td>

                      {/* Lecture Attendance Checkmarks & Crosses */}
                      {lectures.map((lec) => {
                        const isAudience = isStudentInLectureAudience(student.group, lec.audienceGroups);
                        const rawStatus = student.attendance[lec.id];
                        const isNotApplicable = !isAudience && rawStatus !== 'present' && rawStatus !== 'excused';
                        const status = isNotApplicable ? 'not_applicable' : (rawStatus || 'unrecorded');

                        return (
                          <td
                            key={lec.id}
                            onClick={() => {
                              if (!isNotApplicable) {
                                handleCellClick(student.studentId, lec.id, status);
                              }
                            }}
                            className={`py-2 px-2 text-center border-e border-slate-100 dark:border-zinc-800 transition-all ${
                              isNotApplicable 
                                ? 'bg-slate-50/70 dark:bg-zinc-950/40 cursor-not-allowed opacity-50' 
                                : 'cursor-pointer hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                            }`}
                            title={
                              isNotApplicable
                                ? (isRtl ? `${student.name} غير مشمول بهذه المحاضرة (مخصصة لشعبة: ${(lec.audienceGroups || []).join(', ')})` : `${student.name} is not in this lecture's audience`)
                                : `${student.name} - م ${lec.number}: اضغط لتغيير الحالة`
                            }
                          >
                            <div className="flex items-center justify-center">
                              {status === 'present' ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 font-black shadow-xs hover:scale-110 transition-transform">
                                  ✓
                                </span>
                              ) : status === 'absent' ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 font-black shadow-xs hover:scale-110 transition-transform">
                                  ✗
                                </span>
                              ) : status === 'excused' ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400 font-black shadow-xs hover:scale-110 transition-transform">
                                  ⏱
                                </span>
                              ) : status === 'pending' ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300 font-black shadow-xs hover:scale-110 transition-transform text-[11px]" title={isRtl ? 'بانتظار المزامنة' : 'Pending sync'}>
                                  ⏳
                                </span>
                              ) : status === 'voided' ? (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400 font-black shadow-xs hover:scale-110 transition-transform text-[11px]" title={isRtl ? 'ملغى' : 'Voided'}>
                                  ⊘
                                </span>
                              ) : status === 'not_applicable' ? (
                                <span className="text-[10px] font-bold text-slate-400 dark:text-zinc-600 px-1.5 py-0.5 rounded bg-slate-100/70 dark:bg-zinc-800/40 select-none">
                                  {isRtl ? 'غير مشمول' : 'N/A'}
                                </span>
                              ) : (
                                <span className="flex h-7 w-7 items-center justify-center rounded-xl text-slate-300 dark:text-zinc-600 font-bold">
                                  -
                                </span>
                              )}
                            </div>
                          </td>
                        );
                      })}

                      {/* Summary Metrics */}
                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-black text-emerald-600 dark:text-emerald-400">
                        {stats.present}
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
                        <span className="inline-block px-2 py-0.5 rounded-lg bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300 font-bold text-[10px]">{isRtl ? 'السياسة غير معتمدة' : 'Policy unconfigured'}</span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={lectures.length + 7} className="py-12 text-center text-slate-400 dark:text-zinc-500 font-bold">
                    {isRtl ? 'لا توجد نتائج مطابقة لبحثك' : 'No matching student records found'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
