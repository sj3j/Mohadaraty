import React, { useState, useMemo } from 'react';
import { 
  Search, Download, Printer, Filter, Check, X, Clock, Minus, 
  HelpCircle, ChevronDown, Sparkles, FileSpreadsheet, ShieldAlert
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow, AttendanceCellStatus } from './types';
const calculateStudentStats = (student: StudentAttendanceRow, lectures: LectureColumn[]) => {
  const present = lectures.filter(lecture => student.attendance[lecture.id] === 'present').length;
  const absent = lectures.filter(lecture => student.attendance[lecture.id] === 'absent').length;
  const excused = lectures.filter(lecture => student.attendance[lecture.id] === 'excused').length;
  const counted = present + absent;
  return { present, absent, excused, totalHeld: counted,
    attendanceRate: counted ? Math.round(100 * present / counted) : 0,
    absenceRate: counted ? Math.round(100 * absent / counted) : 0, status: 'safe' as const };
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
  const [hoveredCell, setHoveredCell] = useState<{ studentId: string; lectureId: string } | null>(null);

  // Filter students based on search query, group, and risk status
  const filteredStudents = useMemo(() => {
    return students.filter((student) => {
      const matchesSearch = student.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            student.examCode.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesGroup = selectedGroup === 'all' || student.group === selectedGroup;
      return matchesSearch && matchesGroup;
    });
  }, [students, lectures, searchQuery, selectedGroup]);

  const handleCellClick = (studentId: string, lectureId: string, currentStatus: AttendanceCellStatus = 'unrecorded') => {
    if (currentStatus !== 'pending') onUpdateAttendance(studentId, lectureId, currentStatus === 'present' ? 'voided' : 'present');
  };

  // Export to Excel-compatible CSV file with UTF-8 BOM
  const handleExportCsv = () => {
    const headers = [
      isRtl ? 'الرقم' : 'No',
      isRtl ? 'اسم الطالب الرباعي' : 'Student Name',
      isRtl ? 'الرقم الامتحاني' : 'Exam Code',
      isRtl ? 'الشعبة' : 'Group',
      ...lectures.map((l) => `${isRtl ? 'محاضرة' : 'Lec'} ${l.number} (${l.date})`),
      isRtl ? 'مجموع الحضور' : 'Total Attended',
      isRtl ? 'مجموع الغياب' : 'Total Absent',
      isRtl ? 'نسبة الحضور %' : 'Attendance %',
      isRtl ? 'الموقف الأكاديمي' : 'Status',
    ];

    const rows = filteredStudents.map((std, idx) => {
      const stats = calculateStudentStats(std, lectures);
      const lectureCells = lectures.map((lec) => {
        const val = std.attendance[lec.id] || 'unrecorded';
        if (val === 'present') return isRtl ? 'حاضر' : 'Present';
        if (val === 'absent') return isRtl ? 'غائب' : 'Absent';
        if (val === 'excused') return isRtl ? 'مجاز' : 'Excused';
        if (val === 'pending') return isRtl ? 'معلق' : 'Pending';
        if (val === 'voided') return isRtl ? 'ملغى' : 'Voided';
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
      {/* Top Toolbar: Filters & Actions */}
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 p-4 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
        {/* Search & Group filters */}
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

          {/* Group Filter */}
          <div className="flex items-center gap-1 p-1 rounded-2xl bg-slate-100 dark:bg-zinc-800 border border-slate-200/60 dark:border-zinc-700/60">
            {['all', 'A', 'B', 'C'].map((grp) => (
              <button
                key={grp}
                onClick={() => setSelectedGroup(grp)}
                className={`px-3 py-1 rounded-xl text-xs font-black transition-all ${
                  selectedGroup === grp
                    ? 'bg-white text-teal-700 shadow-sm dark:bg-zinc-700 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {grp === 'all' ? (isRtl ? 'كل الشُعب' : 'All') : `${isRtl ? 'شعبة' : 'Group'} ${grp}`}
              </button>
            ))}
          </div>

        </div>

        {/* Export & Print Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportCsv}
            className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-black text-xs shadow-md shadow-teal-600/20 transition-all"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>{isRtl ? 'تصدير Excel' : 'Export Excel'}</span>
          </button>

          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-2xl border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 transition-colors text-xs font-bold"
          >
            <Printer className="h-4 w-4" />
            <span>{isRtl ? 'طباعة' : 'Print'}</span>
          </button>
        </div>
      </div>

      {/* Legend & Instructions */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-[11px] font-bold text-slate-500 dark:text-zinc-400">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 font-black">
              ✓
            </span>
            {isRtl ? 'حاضر (اضغط للتغيير)' : 'Present'}
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

                {/* Lecture Columns */}
                {lectures.map((lec) => (
                  <th 
                    key={lec.id} 
                    className="py-2.5 px-3 text-center min-w-[90px] border-e border-slate-200 dark:border-zinc-700 transition-colors hover:bg-slate-200/60 dark:hover:bg-zinc-700/60"
                  >
                    <div className="font-black text-slate-800 dark:text-zinc-100">
                      {isRtl ? `م ${lec.number}` : `Lec ${lec.number}`}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                      {lec.date.slice(5)}
                    </div>
                    <div className="text-[9px] font-bold text-teal-600 dark:text-teal-400">
                      {lec.mode === 'practical' ? (isRtl ? 'عملي' : 'Prac') : (isRtl ? 'نظري' : 'Theo')}
                    </div>
                  </th>
                ))}

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

                      {/* Group */}
                      <td className="py-2.5 px-3 text-center border-e border-slate-100 dark:border-zinc-800 font-bold">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300 text-[11px]">
                          {student.group}
                        </span>
                      </td>

                      {/* Lecture Attendance Checkmarks & Crosses */}
                      {lectures.map((lec) => {
                        const status = student.attendance[lec.id] || 'unrecorded';
                        return (
                          <td
                            key={lec.id}
                            onClick={() => handleCellClick(student.studentId, lec.id, status)}
                            className="py-2 px-2 text-center border-e border-slate-100 dark:border-zinc-800 cursor-pointer transition-all hover:bg-slate-200/50 dark:hover:bg-zinc-700/50"
                            title={`${student.name} - م ${lec.number}: اضغط لتغيير الحالة`}
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
