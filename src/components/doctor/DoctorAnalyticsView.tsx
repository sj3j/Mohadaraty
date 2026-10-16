import React, { useMemo } from 'react';
import { 
  BarChart3, Users, AlertTriangle, ShieldAlert, Award, 
  ArrowUpRight, ArrowDownRight, Printer, FileText, CheckCircle2 
} from 'lucide-react';
import { DoctorSubject, LectureColumn, StudentAttendanceRow } from './types';
import { calculateStudentStats } from './mockData';

interface DoctorAnalyticsViewProps {
  subject: DoctorSubject;
  lectures: LectureColumn[];
  students: StudentAttendanceRow[];
  isRtl: boolean;
}

export default function DoctorAnalyticsView({
  subject,
  lectures,
  students,
  isRtl,
}: DoctorAnalyticsViewProps) {
  // Aggregate calculations
  const analytics = useMemo(() => {
    let totalPossibleAttendances = 0;
    let totalActualPresent = 0;
    let totalAbsences = 0;
    const deprivedList: { student: StudentAttendanceRow; stats: ReturnType<typeof calculateStudentStats> }[] = [];
    const warningList: { student: StudentAttendanceRow; stats: ReturnType<typeof calculateStudentStats> }[] = [];

    students.forEach((std) => {
      const stats = calculateStudentStats(std, lectures);
      totalPossibleAttendances += stats.totalHeld;
      totalActualPresent += stats.present;
      totalAbsences += stats.absent;

      if (stats.status === 'deprived') {
        deprivedList.push({ student: std, stats });
      } else if (stats.status === 'warning') {
        warningList.push({ student: std, stats });
      }
    });

    const averageAttendanceRate = totalPossibleAttendances > 0 
      ? Math.round((totalActualPresent / totalPossibleAttendances) * 100) 
      : 100;

    // Per-lecture attendance rates for trend chart
    const lectureTrends = lectures.map((lec) => {
      let presentForLec = 0;
      let recordedCount = 0;
      students.forEach((s) => {
        const status = s.attendance[lec.id];
        if (status && status !== 'unrecorded') {
          recordedCount++;
          if (status === 'present') presentForLec++;
        }
      });
      const rate = recordedCount > 0 ? Math.round((presentForLec / recordedCount) * 100) : 0;
      return {
        id: lec.id,
        number: lec.number,
        title: lec.title,
        date: lec.date,
        rate,
        present: presentForLec,
        total: recordedCount,
      };
    });

    // Per-group rates
    const groupStats: Record<string, { present: number; total: number }> = {};
    students.forEach((std) => {
      if (!groupStats[std.group]) groupStats[std.group] = { present: 0, total: 0 };
      const stats = calculateStudentStats(std, lectures);
      groupStats[std.group].present += stats.present;
      groupStats[std.group].total += stats.totalHeld;
    });

    return {
      averageAttendanceRate,
      deprivedList,
      warningList,
      lectureTrends,
      groupStats,
      totalStudents: students.length,
      totalAbsences,
    };
  }, [students, lectures]);

  return (
    <div className="space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Overall Attendance Rate */}
        <div className="p-5 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">
              {isRtl ? 'متوسط نسبة الحضور' : 'Avg Attendance Rate'}
            </span>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400">
              <Award className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-slate-900 dark:text-zinc-100">
              {analytics.averageAttendanceRate}%
            </span>
            <span className="text-xs font-bold text-emerald-600 flex items-center">
              <ArrowUpRight className="h-3.5 w-3.5" />
              +4.2%
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 font-bold">
            {isRtl ? 'نسبة ممتازة لكافة المحاضرات' : 'Across all registered lectures'}
          </p>
        </div>

        {/* Card 2: Deprived / High-risk Students */}
        <div className="p-5 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">
              {isRtl ? 'المحرومين بالغياب' : 'Deprived Students'}
            </span>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-rose-600 dark:text-rose-400">
              {analytics.deprivedList.length}
            </span>
            <span className="text-xs text-slate-400 font-bold">
              {isRtl ? 'طالب تجاوز 15%' : 'students > 15%'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 font-bold">
            {isRtl ? 'يستوجب إصدار أمر حرمان رسمي' : 'Requires academic sanction letter'}
          </p>
        </div>

        {/* Card 3: Warning Students */}
        <div className="p-5 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">
              {isRtl ? 'إنذار أول (مهددين)' : 'First Warnings'}
            </span>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-amber-600 dark:text-amber-400">
              {analytics.warningList.length}
            </span>
            <span className="text-xs text-slate-400 font-bold">
              {isRtl ? 'طالب بين 10% - 14%' : 'students 10% - 14%'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 font-bold">
            {isRtl ? 'تحت المتابعة الدقيقة' : 'Under active watch'}
          </p>
        </div>

        {/* Card 4: Enrolled Headcount */}
        <div className="p-5 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">
              {isRtl ? 'إجمالي الطلبة' : 'Enrolled Students'}
            </span>
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400">
              <Users className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-black text-slate-900 dark:text-zinc-100">
              {analytics.totalStudents}
            </span>
            <span className="text-xs text-slate-400 font-bold">
              {isRtl ? 'في 3 شعب' : 'in 3 groups'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-slate-400 font-bold">
            {lectures.length} {isRtl ? 'محاضرة مبرمجة للفصل' : 'scheduled lectures'}
          </p>
        </div>
      </div>

      {/* Lecture-by-Lecture Attendance Chart */}
      <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black text-slate-900 dark:text-zinc-100">
              {isRtl ? 'مخطط الحضور عبر المحاضرات' : 'Lecture Attendance Trend'}
            </h3>
            <p className="text-xs text-slate-400">
              {isRtl ? 'نسبة حضور الطلاب لكل محاضرة خلال الفصل الدراسي' : 'Attendance percentage recorded per lecture'}
            </p>
          </div>
          <span className="text-xs font-bold text-teal-600 dark:text-teal-400 flex items-center gap-1">
            <BarChart3 className="h-4 w-4" />
            {isRtl ? 'مخطط تحليلي' : 'Analytical Chart'}
          </span>
        </div>

        {/* CSS Bar Chart */}
        <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 pt-6 items-end h-48 border-b border-slate-100 dark:border-zinc-800">
          {analytics.lectureTrends.map((trend) => (
            <div key={trend.id} className="flex flex-col items-center gap-2 h-full justify-end group">
              <span className="text-[10px] font-mono font-bold text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity">
                {trend.rate}%
              </span>
              <div className="w-full max-w-[28px] bg-slate-100 dark:bg-zinc-800 rounded-t-xl overflow-hidden h-36 flex items-end">
                <div 
                  className={`w-full rounded-t-xl transition-all duration-500 ${
                    trend.rate >= 80 
                      ? 'bg-teal-500 group-hover:bg-teal-600' 
                      : trend.rate >= 60 
                      ? 'bg-amber-500 group-hover:bg-amber-600' 
                      : 'bg-rose-500 group-hover:bg-rose-600'
                  }`}
                  style={{ height: `${trend.rate}%` }}
                />
              </div>
              <span className="text-[10px] font-black text-slate-600 dark:text-zinc-400">
                م {trend.number}
              </span>
            </div>
          ))}
        </div>

        {/* Group Comparison breakdown */}
        <div className="pt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {Object.entries(analytics.groupStats).map(([grp, data]) => {
            const grpRate = data.total > 0 ? Math.round((data.present / data.total) * 100) : 0;
            return (
              <div key={grp} className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-700/60 flex items-center justify-between">
                <div>
                  <span className="text-xs font-black text-slate-800 dark:text-zinc-200">
                    {isRtl ? `شعبة ${grp}` : `Group ${grp}`}
                  </span>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {data.present} / {data.total} {isRtl ? 'حضور' : 'attendances'}
                  </div>
                </div>
                <span className="text-sm font-black font-mono text-teal-600 dark:text-teal-400">
                  {grpRate}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Deprivation & Sanctions Management Table */}
      <div className="p-6 rounded-3xl bg-white border border-slate-200/80 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'قائمة الطلبة المستحقين للإنذارات والحرمان بالغياب' : 'Deprivation & Academic Warnings List'}
              </h3>
              <p className="text-xs text-slate-400">
                {isRtl ? 'حسب ضوابط وزارة التعليم العالي والبحث العلمي' : 'Per Ministry of Higher Education absence policies'}
              </p>
            </div>
          </div>

          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 font-bold text-xs transition-colors"
          >
            <Printer className="h-4 w-4" />
            <span>{isRtl ? 'طباعة القائمة الرسمية' : 'Print Official Sanction'}</span>
          </button>
        </div>

        {/* Warning & Deprived Table */}
        <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-zinc-700">
          <table className="w-full text-xs text-start">
            <thead className="bg-slate-50 dark:bg-zinc-800 text-slate-500 font-bold border-b border-slate-200 dark:border-zinc-700">
              <tr>
                <th className="py-2.5 px-3 text-start">{isRtl ? 'اسم الطالب' : 'Student'}</th>
                <th className="py-2.5 px-3 text-center">{isRtl ? 'الرقم الامتحاني' : 'Exam Code'}</th>
                <th className="py-2.5 px-3 text-center">{isRtl ? 'الشعبة' : 'Group'}</th>
                <th className="py-2.5 px-3 text-center">{isRtl ? 'مرات الغياب' : 'Absences'}</th>
                <th className="py-2.5 px-3 text-center">{isRtl ? 'نسبة الغياب' : 'Absence %'}</th>
                <th className="py-2.5 px-3 text-center">{isRtl ? 'الإجراء القانوني' : 'Legal Action'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
              {[...analytics.deprivedList, ...analytics.warningList].length > 0 ? (
                [...analytics.deprivedList, ...analytics.warningList].map(({ student, stats }) => {
                  const isDeprived = stats.status === 'deprived';
                  return (
                    <tr key={student.studentId} className="hover:bg-slate-50 dark:hover:bg-zinc-800/50">
                      <td className="py-3 px-3 font-black text-slate-800 dark:text-zinc-100">
                        {student.name}
                      </td>
                      <td className="py-3 px-3 text-center font-mono text-slate-400">
                        {student.examCode}
                      </td>
                      <td className="py-3 px-3 text-center font-bold">
                        {student.group}
                      </td>
                      <td className="py-3 px-3 text-center font-black text-rose-600 dark:text-rose-400">
                        {stats.absent} {isRtl ? 'محاضرة' : 'lecs'}
                      </td>
                      <td className="py-3 px-3 text-center font-mono font-black text-rose-600 dark:text-rose-400">
                        {stats.absenceRate}%
                      </td>
                      <td className="py-3 px-3 text-center">
                        {isDeprived ? (
                          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 font-black text-[11px]">
                            {isRtl ? 'حرمان نهائي من الامتحان' : 'Deprived from Exam'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 font-black text-[11px]">
                            {isRtl ? 'إنذار أولي بالغياب' : 'First Formal Warning'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400 font-bold">
                    {isRtl ? 'ممتاز! لا يوجد أي طالب متجاوز لنسب الغياب المقررة' : 'Great! No students are at risk of deprivation'}
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
