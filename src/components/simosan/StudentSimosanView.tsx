/**
 * Student attendance view. Signed QR captures are saved to IndexedDB before any
 * upload; pending evidence stays separate from server-confirmed attendance.
 * Exact dated occurrences and explicitly assigned subject slots drive this view.
 * Group substitution requires a separate authorized equivalence link.
 */

import React, { useState } from 'react';
import { 
  Camera, CheckCircle2, BookOpen, FlaskConical, ChevronLeft, 
  ChevronRight, Calendar, Clock, AlertCircle, ArrowRight,
  ShieldCheck, Check, Sparkles, RefreshCw
} from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import { captureAttendanceQr } from '../../services/attendanceService';
import QrScannerModal from './QrScannerModal';
import { useStudentAttendance } from './useStudentAttendance';
import type { StudentAttendanceRow } from '../../../shared/attendanceSchedule';
import { attendanceWeekStart } from '../../../shared/attendance';

interface StudentSimosanViewProps {
  user: UserProfile;
  lang: Language;
}

export interface WeekAttendanceItem {
  occurrenceId: string;
  receiptId?: string;
  state?: StudentAttendanceRow['state'];
  weekNumber: number;
  title: string;
  topic: string;
  date?: string;
  time?: string;
  attendedGroup?: string; // e.g. "D3" (native) or "B2" (substituted)
  teacher?: string;
  location?: string;
  status: 'attended' | 'substituted' | 'absent' | 'upcoming' | 'pending';
}

export interface SubjectItem {
  id: string;
  nameAr: string;
  nameEn: string;
  code: string;
  doctorName: string;
  theoryDoctor?: string;
  practicalDoctor?: string;
  hasTheory: boolean;
  hasPractical: boolean;
  iconBg: string;
  iconColor: string;
  theoryWeeks: WeekAttendanceItem[];
  practicalWeeks: WeekAttendanceItem[];
}

/**
 * Normalizes subject title for robust matching across theoretical and practical sessions.
 * Strips parentheses, brackets, mode descriptors ('نظري', 'عملي', 'مختبر', 'theory', 'practical', 'lab'),
 * punctuation, and unifies Arabic letters and Roman/Arabic numerals.
 */
export function normalizeCanonicalSubjectTitle(raw: string): string {
  if (!raw) return '';
  let text = String(raw).trim().toLowerCase();

  // 1. Remove text inside brackets/parentheses that mention mode
  text = text.replace(/[\(\[\{][^\)\]\}]*(?:نظري|عملي|مختبر|theory|practical|lab)[^\)\]\}]*[\)\]\}]/gi, ' ');

  // 2. Remove dash/slash prefixes with mode
  text = text.replace(/[-–—/]\s*(?:نظري|عملي|مختبر|theory|practical|lab)\b/gi, ' ');

  // 3. Remove standalone mode tokens
  text = text.replace(/\b(?:theory|theoretical|practical|lab|laboratory)\b/gi, ' ');
  text = text.replace(/(?:^|\s)(?:نظري|نظرية|عملي|عملية|مختبر|مختبرات)(?:\s|$)/g, ' ');

  // 4. Normalize Arabic characters
  text = text
    .replace(/[\u064B-\u065F\u0670]/g, '') // tashkeel
    .replace(/\u0640/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // Arabic numerals to standard digits
    .replace(/١/g, '1')
    .replace(/٢/g, '2')
    .replace(/٣/g, '3')
    .replace(/٤/g, '4')
    .replace(/٥/g, '5')
    .replace(/٦/g, '6')
    .replace(/٧/g, '7')
    .replace(/٨/g, '8')
    .replace(/٩/g, '9')
    .replace(/٠/g, '0');

  // 5. Roman numerals to digits
  text = text
    .replace(/\biv\b/gi, '4')
    .replace(/\biii\b/gi, '3')
    .replace(/\bii\b/gi, '2')
    .replace(/\bi\b/gi, '1');

  // 6. Clean punctuation & extra whitespace
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Strips mode suffixes from display names to get pure academic subject names.
 */
export function cleanDisplaySubjectName(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/[\(\[\{][^\)\]\}]*(?:نظري|عملي|مختبر|theory|practical|lab)[^\)\]\}]*[\)\]\}]/gi, '')
    .replace(/[-–—/]\s*(?:نظري|عملي|مختبر|theory|practical|lab)\s*$/gi, '')
    .replace(/\s+(?:نظري|عملي|مختبر|theory|practical|lab)\s*$/gi, '')
    .trim();
}

/**
 * Formats doctor names context-aware: shows both if different for theory and practical,
 * or single name if only one doctor teaches.
 */
export function formatSubjectDoctor(
  theoryDoctor?: string,
  practicalDoctor?: string,
  isRtl: boolean = true
): string {
  const tDoc = (theoryDoctor || '').trim();
  const pDoc = (practicalDoctor || '').trim();
  if (tDoc && pDoc && tDoc.toLowerCase() !== pDoc.toLowerCase()) {
    return isRtl
      ? `${tDoc} (نظري) • ${pDoc} (عملي)`
      : `${tDoc} (Theory) • ${pDoc} (Lab)`;
  }
  return tDoc || pDoc || '';
}

/**
 * Aggregates attendance rows and mine assignments into canonical SubjectItems.
 * Guarantees that theoretical lectures and practical labs for the same subject merge
 * into a single unified card, regardless of doctor or slot division.
 */
export function buildCanonicalSubjects(
  rows: StudentAttendanceRow[],
  mine: import('../../../shared/attendance').AttendanceMine | null,
  isRtl: boolean = true
): SubjectItem[] {
  const assignments = mine?.subjects || [];

  const isPractical = (
    occurrence: StudentAttendanceRow['occurrence'],
    assignment?: import('../../../shared/attendance').AttendanceDoctorSubject
  ) => {
    if (occurrence.mode === 'practical') return true;
    if (assignment?.type === 'practical') return true;
    const combined = `${occurrence.title || ''} ${occurrence.timetableSessionId || ''}`.toLowerCase();
    return /[\(\[\s_-](?:عملي|مختبر|practical|lab|laboratory)[\)\]\s_-]/i.test(` ${combined} `);
  };

  interface CanonicalSubjectAccumulator {
    id: string;
    nameAr: string;
    nameEn: string;
    code: string;
    theoryDoctors: Set<string>;
    practicalDoctors: Set<string>;
    theoryWeeks: WeekAttendanceItem[];
    practicalWeeks: WeekAttendanceItem[];
  }

  const canonicalMap = new Map<string, CanonicalSubjectAccumulator>();
  const keyAliases = new Map<string, string>();

  // Pass 1: Seed canonical map from known stage assignments
  for (const assignment of assignments) {
    const normAr = normalizeCanonicalSubjectTitle(assignment.nameAr || '');
    const normEn = normalizeCanonicalSubjectTitle(assignment.nameEn || '');
    const baseId = assignment.id.replace(/[-_](?:theory|practical|lab|theoritical|theori|pract)$/i, '');

    const canonicalKey = normAr ? `ar:${normAr}` : (normEn ? `en:${normEn}` : `id:${baseId}`);
    const targetKey =
      keyAliases.get(canonicalKey) ||
      (normAr && keyAliases.get(`ar:${normAr}`)) ||
      (normEn && keyAliases.get(`en:${normEn}`)) ||
      (baseId && keyAliases.get(`id:${baseId}`)) ||
      canonicalKey;

    if (!canonicalMap.has(targetKey)) {
      canonicalMap.set(targetKey, {
        id: baseId || assignment.id,
        nameAr: cleanDisplaySubjectName(assignment.nameAr) || assignment.nameAr || '',
        nameEn: cleanDisplaySubjectName(assignment.nameEn) || assignment.nameEn || '',
        code: baseId || assignment.id,
        theoryDoctors: new Set(),
        practicalDoctors: new Set(),
        theoryWeeks: [],
        practicalWeeks: [],
      });
    }

    const existing = canonicalMap.get(targetKey)!;
    if (!existing.nameAr && assignment.nameAr) existing.nameAr = cleanDisplaySubjectName(assignment.nameAr);
    if (!existing.nameEn && assignment.nameEn) existing.nameEn = cleanDisplaySubjectName(assignment.nameEn);

    if (normAr) keyAliases.set(`ar:${normAr}`, targetKey);
    if (normEn) keyAliases.set(`en:${normEn}`, targetKey);
    if (baseId) keyAliases.set(`id:${baseId}`, targetKey);
    keyAliases.set(`assign:${assignment.id}`, targetKey);
    for (const sid of assignment.timetableSessionIds) {
      if (sid) keyAliases.set(`session:${sid}`, targetKey);
    }
  }

  // Pass 2: Map each student attendance occurrence into its canonical subject
  for (const row of rows) {
    const occurrence = row.occurrence;
    const assignment = assignments.find(s => s.timetableSessionIds.includes(occurrence.timetableSessionId || ''));

    const normTitle = normalizeCanonicalSubjectTitle(occurrence.title || '');
    const sessionId = occurrence.timetableSessionId;

    let targetKey =
      (sessionId && keyAliases.get(`session:${sessionId}`)) ||
      (assignment && keyAliases.get(`assign:${assignment.id}`)) ||
      (normTitle && (keyAliases.get(`ar:${normTitle}`) || keyAliases.get(`en:${normTitle}`))) ||
      null;

    if (!targetKey) {
      for (const [cKey, cVal] of canonicalMap.entries()) {
        if (
          normTitle &&
          (normalizeCanonicalSubjectTitle(cVal.nameAr) === normTitle ||
            normalizeCanonicalSubjectTitle(cVal.nameEn) === normTitle)
        ) {
          targetKey = cKey;
          break;
        }
      }
    }

    if (!targetKey) {
      targetKey = normTitle ? `title:${normTitle}` : `id:${sessionId || occurrence.id}`;
      const cleanTitle = cleanDisplaySubjectName(occurrence.title) || occurrence.title;
      canonicalMap.set(targetKey, {
        id: sessionId || occurrence.id,
        nameAr: cleanTitle,
        nameEn: cleanTitle,
        code: occurrence.timetableSessionId || '',
        theoryDoctors: new Set(),
        practicalDoctors: new Set(),
        theoryWeeks: [],
        practicalWeeks: [],
      });
      if (normTitle) {
        keyAliases.set(`ar:${normTitle}`, targetKey);
        keyAliases.set(`en:${normTitle}`, targetKey);
      }
      if (sessionId) keyAliases.set(`session:${sessionId}`, targetKey);
    }

    const subjectAcc = canonicalMap.get(targetKey)!;

    const isLab = isPractical(occurrence, assignment);
    const doctor = (occurrence.teacher || '').trim();
    if (doctor) {
      if (isLab) {
        subjectAcc.practicalDoctors.add(doctor);
      } else {
        subjectAcc.theoryDoctors.add(doctor);
      }
    }

    const weekNumber = mine?.term
      ? Math.floor((Date.parse(row.weekStart) - Date.parse(attendanceWeekStart(mine.term.startDate))) / 604800000) + 1
      : 1;

    const item: WeekAttendanceItem = {
      occurrenceId: occurrence.id,
      receiptId: row.receipt?.requestId,
      state: row.state,
      weekNumber: Math.max(1, weekNumber),
      title: isRtl ? 'سجل المحاضرة' : 'Lecture record',
      topic: occurrence.title,
      date: occurrence.lectureDate,
      time: occurrence.startTime,
      teacher: doctor || undefined,
      location: occurrence.location || undefined,
      status: row.state === 'confirmed' ? 'attended' : row.state === 'absent' ? 'absent' : row.state === 'none' ? 'upcoming' : 'pending',
    };

    if (isLab) {
      subjectAcc.practicalWeeks.push(item);
    } else {
      subjectAcc.theoryWeeks.push(item);
    }
  }

  // Pass 3: Finalize SubjectItems with chronological ordering and week session labeling
  const result: SubjectItem[] = [];
  for (const acc of canonicalMap.values()) {
    if (acc.theoryWeeks.length === 0 && acc.practicalWeeks.length === 0) {
      continue;
    }

    const sortWeeks = (a: WeekAttendanceItem, b: WeekAttendanceItem) =>
      (a.date || '').localeCompare(b.date || '') ||
      (a.time || '').localeCompare(b.time || '') ||
      a.occurrenceId.localeCompare(b.occurrenceId);
    acc.theoryWeeks.sort(sortWeeks);
    acc.practicalWeeks.sort(sortWeeks);

    const annotateWeekTitles = (weeks: WeekAttendanceItem[]) => {
      const weekCounts = new Map<number, number>();
      for (const w of weeks) {
        weekCounts.set(w.weekNumber, (weekCounts.get(w.weekNumber) || 0) + 1);
      }
      const weekCurrentIndex = new Map<number, number>();
      for (const w of weeks) {
        const total = weekCounts.get(w.weekNumber) || 1;
        if (total > 1) {
          const current = (weekCurrentIndex.get(w.weekNumber) || 0) + 1;
          weekCurrentIndex.set(w.weekNumber, current);
          w.title = isRtl
            ? `الأسبوع ${w.weekNumber} (الجلسة ${current})`
            : `Week ${w.weekNumber} (Session ${current})`;
        } else {
          w.title = isRtl ? `الأسبوع ${w.weekNumber}` : `Week ${w.weekNumber}`;
        }
      }
    };
    annotateWeekTitles(acc.theoryWeeks);
    annotateWeekTitles(acc.practicalWeeks);

    const theoryDoctor = [...acc.theoryDoctors][0] || '';
    const practicalDoctor = [...acc.practicalDoctors][0] || '';
    const doctorName = formatSubjectDoctor(theoryDoctor, practicalDoctor, isRtl);

    result.push({
      id: acc.id,
      nameAr: acc.nameAr,
      nameEn: acc.nameEn,
      code: acc.code,
      doctorName,
      theoryDoctor: theoryDoctor || undefined,
      practicalDoctor: practicalDoctor || undefined,
      hasTheory: acc.theoryWeeks.length > 0,
      hasPractical: acc.practicalWeeks.length > 0,
      iconBg: 'bg-emerald-100 dark:bg-emerald-900/30',
      iconColor: 'text-emerald-600 dark:text-emerald-400',
      theoryWeeks: acc.theoryWeeks,
      practicalWeeks: acc.practicalWeeks,
    });
  }

  return result;
}

export default function StudentSimosanView({ user, lang }: StudentSimosanViewProps) {
  const isRtl = lang === 'ar';
  const userGroup = user.group || '—';
  const attendance = useStudentAttendance(user.uid, user.group);
  const [scanError, setScanError] = useState('');

  // Scanner state
  const [scannerOpen, setScannerOpen] = useState(false);

  // Selected subject & mode navigation state
  const [activeSubjectId, setActiveSubjectId] = useState<string | null>(null);
  const [showModeModal, setShowModeModal] = useState(false);
  const [selectedMode, setSelectedMode] = useState<'theory' | 'practical' | null>(null);

  // Success Scan Receipt Sheet
  const [scanSuccessSheet, setScanSuccessSheet] = useState<{
    open: boolean;
    lectureTitle: string;
    subjectName: string;
    receiptId: string;
    time: string;
    group: string;
  } | null>(null);

  const subjects = buildCanonicalSubjects(attendance.rows, attendance.mine, isRtl);
  const activeSubject = subjects.find(subject => subject.id === activeSubjectId) || null;
  const stateLabel = (state?: StudentAttendanceRow['state']) => {
    const labels: Record<string, [string, string]> = {
      pending: ['تم الحفظ على هذا الجهاز — بانتظار المزامنة', 'Saved on this device — pending sync'],
      syncing: ['جارٍ إرسال الإيصال', 'Uploading receipt'],
      login_required: ['تم الحفظ — سجل الدخول للمزامنة', 'Saved — sign in to sync'],
      review: ['تم الاستلام — بانتظار مراجعة الأستاذ', 'Received — lecturer review required'],
      manual_required: ['يحتاج تسجيلاً يدوياً من الأستاذ', 'Ask the lecturer for manual recording'],
      invalid: ['لم يعتمد الإيصال — راجع الأستاذ', 'Receipt not accepted — contact lecturer'],
      voided: ['تم إلغاء الحضور بواسطة الأستاذ', 'Attendance voided by lecturer'],
    };
    return (labels[state || 'pending'] || labels.pending)[isRtl ? 0 : 1];
  };

  // Handle open subject card
  const handleCardClick = (subject: SubjectItem) => {
    setActiveSubjectId(subject.id);
    setShowModeModal(true);
  };

  // Handle mode selection (نظري or عملي)
  const handleSelectMode = (mode: 'theory' | 'practical') => {
    setSelectedMode(mode);
    setShowModeModal(false);
  };

  // Back to subjects grid
  const handleBackToSubjects = () => {
    setSelectedMode(null);
    setActiveSubjectId(null);
  };

  const handleScanSuccess = async (scannedValue: string) => {
    setScannerOpen(false);
    setScanError('');
    try {
      const { receipt } = await captureAttendanceQr(scannedValue, user.uid);
      setScanSuccessSheet({
        open: true, lectureTitle: receipt.occurrence.title,
        subjectName: receipt.occurrence.lectureDate, receiptId: receipt.requestId,
        time: receipt.occurrence.startTime, group: userGroup,
      });
      void attendance.refresh();
    } catch {
      setScanError(isRtl
        ? 'لم يتم حفظ الإيصال. حاول مجدداً أو اطلب التسجيل اليدوي من الأستاذ.'
        : 'Receipt was NOT saved. Retry or ask the lecturer for manual attendance.');
    }
  };

  // Calculations for active subject
  const currentWeeksList = activeSubject && selectedMode
    ? (selectedMode === 'theory' ? activeSubject.theoryWeeks : activeSubject.practicalWeeks)
    : [];

  const completedWeeks = currentWeeksList.filter((w) => w.status === 'attended' || w.status === 'substituted').length;
  const missedWeeks = currentWeeksList.filter((w) => w.status === 'absent').length;
  const totalHeldWeeks = completedWeeks + missedWeeks;
  const attendancePercentage = totalHeldWeeks > 0 ? Math.round((completedWeeks / totalHeldWeeks) * 100) : 0;

  return (
    <div className="w-full space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
      {scanError && <p role="alert" className="rounded-2xl bg-rose-50 p-4 text-rose-800">{scanError}</p>}
      <div className="flex items-center justify-between rounded-2xl bg-slate-100 p-3 text-xs dark:bg-zinc-800" aria-live="polite">
        <span>{attendance.loading ? (isRtl ? 'تحميل السجل المحفوظ…' : 'Loading saved records…') : attendance.error || attendance.mine?.offline ? (isRtl ? 'عرض البيانات المحفوظة — الاتصال غير متاح' : 'Showing saved evidence — connection unavailable') : (isRtl ? 'سجل الحضور' : 'Attendance records')}</span>
        <button onClick={() => void attendance.retry().catch(() => setScanError(isRtl ? 'تعذرت المزامنة؛ الإيصالات محفوظة.' : 'Sync unavailable; saved receipts are retained.'))} className="flex items-center gap-1 font-bold"><RefreshCw className="h-4 w-4" />{isRtl ? 'مزامنة' : 'Sync'}</button>
      </div>
      {!attendance.loading && subjects.length === 0 && <p className="rounded-2xl bg-slate-50 p-4 text-sm dark:bg-zinc-800">{isRtl ? 'لا توجد محاضرات محملة بعد. يمكنك مسح رمز الأستاذ أو طلب المساعدة.' : 'No lectures are loaded yet. You can scan the lecturer’s QR or ask for help.'}</p>}
      {attendance.rows.filter(row => row.receipt && !['confirmed', 'none'].includes(row.state)).map(row => (
        <div key={row.occurrence.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" aria-live="polite">
          <strong>{row.occurrence.title} — {row.occurrence.lectureDate}</strong>
          <p>{stateLabel(row.state)}</p><p className="break-all font-mono">{row.receipt?.requestId}</p>
        </div>
      ))}
      {/* -------------------------------------------------------------
          1. TOP CENTERED ACTION BUTTON: تسجيل حضور بقارئ الباركود
          ------------------------------------------------------------- */}
      {!selectedMode && (
        <div className="flex justify-center pt-1 pb-2">
          <button
            onClick={() => setScannerOpen(true)}
            className="w-full sm:w-auto min-w-[280px] sm:min-w-[340px] px-8 py-4 rounded-2xl bg-gradient-to-r from-emerald-600 via-teal-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white font-black text-base sm:text-lg shadow-xl shadow-teal-700/20 flex items-center justify-center gap-3.5 active:scale-[0.98] transition-all border border-emerald-400/30 group cursor-pointer"
          >
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <Camera className="w-6 h-6 text-white" strokeWidth={2.5} />
            </div>
            <span className="tracking-tight">
              {isRtl ? 'تسجيل حضور بقارئ الباركود' : 'Record Attendance with QR Scanner'}
            </span>
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------
          2. SUBJECTS CARDS (StatCard Aesthetic)
          ------------------------------------------------------------- */}
      {!selectedMode && (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-black text-slate-800 dark:text-stone-200">
              {isRtl ? 'المواد الدراسية (اضغط لعرض السجل الأسبوعي)' : 'Academic Subjects'}
            </h2>
            <span className="text-xs font-bold text-slate-400 dark:text-zinc-500">
              {isRtl ? `كروبك الحالي: ${userGroup}` : `Your Group: ${userGroup}`}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {subjects.map((subj) => {
              const assessed = [...subj.theoryWeeks, ...subj.practicalWeeks].filter(week => week.status === 'attended' || week.status === 'absent');
              const attendanceRate = assessed.length ? Math.round(100 * assessed.filter(week => week.status === 'attended').length / assessed.length) : 0;

              return (
                <div
                  key={subj.id}
                  onClick={() => handleCardClick(subj)}
                  className="bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 rounded-2xl p-4.5 flex flex-col justify-between gap-3 shadow-sm transition-all hover:bg-slate-50 dark:hover:bg-zinc-700/50 hover:border-slate-200 dark:hover:border-zinc-600 cursor-pointer active:translate-y-px"
                >
                  <div className="flex items-start gap-3.5">
                    {/* StatCard colored icon container */}
                    <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${subj.iconBg}`}>
                      <BookOpen className={`w-5 h-5 ${subj.iconColor}`} strokeWidth={2.5} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {subj.code && (
                          <span className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300">
                            {subj.code}
                          </span>
                        )}
                        {subj.hasTheory && !subj.hasPractical && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">
                            {isRtl ? 'نظري فقط' : 'Theory only'}
                          </span>
                        )}
                        {!subj.hasTheory && subj.hasPractical && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400">
                            {isRtl ? 'عملي فقط' : 'Practical only'}
                          </span>
                        )}
                        {subj.hasTheory && subj.hasPractical && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400">
                            {isRtl ? `${subj.theoryWeeks.length} نظري • ${subj.practicalWeeks.length} عملي` : `${subj.theoryWeeks.length} Theory • ${subj.practicalWeeks.length} Lab`}
                          </span>
                        )}
                      </div>

                      <h3 className="font-black text-slate-900 dark:text-stone-100 text-base leading-snug mt-1 line-clamp-1">
                        {isRtl ? subj.nameAr : subj.nameEn}
                      </h3>

                      <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mt-0.5">
                        {subj.doctorName}
                      </p>
                    </div>
                  </div>

                  {/* StatCard Footer Info */}
                  <div className="pt-2 border-t border-slate-100 dark:border-zinc-700/80 flex items-center justify-between text-xs font-bold">
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-zinc-400">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                      <span>{isRtl ? `نسبة الحضور: ${attendanceRate}%` : `Rate: ${attendanceRate}%`}</span>
                    </div>

                    <span className="text-teal-600 dark:text-teal-400 font-black flex items-center gap-0.5 group-hover:translate-x-0.5 transition-transform">
                      {isRtl ? 'عرض الأسابيع' : 'View weeks'}
                      {isRtl ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------
          3. ACTION MODAL: Pops two buttons (نظري و عملي)
          ------------------------------------------------------------- */}
      {showModeModal && activeSubject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white p-6 shadow-2xl dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 space-y-5 animate-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="text-center space-y-1">
              <span className="text-[11px] font-mono font-bold text-slate-400 dark:text-zinc-500">
                {activeSubject.code}
              </span>
              <h3 className="text-lg font-black text-slate-900 dark:text-stone-100">
                {isRtl ? activeSubject.nameAr : activeSubject.nameEn}
              </h3>
              <p className="text-xs font-bold text-slate-500 dark:text-zinc-400">
                {isRtl ? 'اختر نوع المحاضرة لعرض سجل الحضور الأسبوعي' : 'Select lecture type to view weekly records'}
              </p>
            </div>

            {/* The Two Buttons: نظري و عملي */}
            <div className="grid grid-cols-1 gap-3">
              {/* Button 1: نظري */}
              <button
                onClick={() => activeSubject.hasTheory && handleSelectMode('theory')}
                disabled={!activeSubject.hasTheory}
                className={`w-full p-4 rounded-2xl border-2 text-start flex items-center justify-between gap-3 transition-all ${
                  activeSubject.hasTheory
                    ? 'border-emerald-100 dark:border-emerald-950/60 bg-emerald-50/50 hover:bg-emerald-50 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/40 active:scale-[0.98] cursor-pointer'
                    : 'border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/40 opacity-50 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                    activeSubject.hasTheory
                      ? 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                      : 'bg-slate-200 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500'
                  }`}>
                    <BookOpen className="w-5 h-5" strokeWidth={2.5} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-black text-sm text-slate-900 dark:text-stone-100">
                        {isRtl ? 'المحاضرات النظرية (نظري)' : 'Theoretical Lectures'}
                      </h4>
                      {!activeSubject.hasTheory && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400">
                          {isRtl ? 'غير متوفر' : 'N/A'}
                        </span>
                      )}
                    </div>
                    {activeSubject.theoryDoctor && (
                      <p className="text-xs font-bold text-emerald-700 dark:text-emerald-400 mt-0.5">
                        {activeSubject.theoryDoctor}
                      </p>
                    )}
                    <p className="text-xs font-bold text-slate-500 dark:text-zinc-400 mt-0.5">
                      {activeSubject.hasTheory
                        ? (isRtl ? `${activeSubject.theoryWeeks.length} أسابيع مسجلة` : `${activeSubject.theoryWeeks.length} weeks registered`)
                        : (isRtl ? 'لا توجد محاضرات نظرية لهذه المادة' : 'No theoretical lectures for this subject')}
                    </p>
                  </div>
                </div>
                {activeSubject.hasTheory && (
                  <div className="w-8 h-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center text-emerald-700 dark:text-emerald-300">
                    {isRtl ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>
                )}
              </button>

              {/* Button 2: عملي */}
              <button
                onClick={() => activeSubject.hasPractical && handleSelectMode('practical')}
                disabled={!activeSubject.hasPractical}
                className={`w-full p-4 rounded-2xl border-2 text-start flex items-center justify-between gap-3 transition-all ${
                  activeSubject.hasPractical
                    ? 'border-sky-100 dark:border-sky-950/60 bg-sky-50/50 hover:bg-sky-50 dark:bg-sky-950/20 dark:hover:bg-sky-950/40 active:scale-[0.98] cursor-pointer'
                    : 'border-slate-100 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/40 opacity-50 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                    activeSubject.hasPractical
                      ? 'bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300'
                      : 'bg-slate-200 dark:bg-zinc-700 text-slate-400 dark:text-zinc-500'
                  }`}>
                    <FlaskConical className="w-5 h-5" strokeWidth={2.5} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-black text-sm text-slate-900 dark:text-stone-100">
                        {isRtl ? 'المختبرات (عملي)' : 'Practical Labs'}
                      </h4>
                      {!activeSubject.hasPractical && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-zinc-400">
                          {isRtl ? 'غير متوفر' : 'N/A'}
                        </span>
                      )}
                    </div>
                    {activeSubject.practicalDoctor && (
                      <p className="text-xs font-bold text-sky-700 dark:text-sky-400 mt-0.5">
                        {activeSubject.practicalDoctor}
                      </p>
                    )}
                    <p className="text-xs font-bold text-slate-500 dark:text-zinc-400 mt-0.5">
                      {activeSubject.hasPractical
                        ? (isRtl ? `${activeSubject.practicalWeeks.length} مختبرات مسجلة` : `${activeSubject.practicalWeeks.length} labs registered`)
                        : (isRtl ? 'لا يوجد مختبر عملي لهذه المادة' : 'No practical lab for this subject')}
                    </p>
                  </div>
                </div>
                {activeSubject.hasPractical && (
                  <div className="w-8 h-8 rounded-full bg-sky-100 dark:bg-sky-900/40 flex items-center justify-center text-sky-700 dark:text-sky-300">
                    {isRtl ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>
                )}
              </button>
            </div>

            {/* Cancel / Close button */}
            <button
              onClick={() => {
                setShowModeModal(false);
                setActiveSubjectId(null);
              }}
              className="w-full py-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 font-bold text-xs transition-colors cursor-pointer"
            >
              {isRtl ? 'إلغاء' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------
          4. WEEKLY ATTENDANCE BREAKDOWN (سجل الأسابيع)
          ------------------------------------------------------------- */}
      {selectedMode && activeSubject && (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-150">
          {/* Header Bar with Back Button */}
          <div className="bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 rounded-2xl p-4 shadow-sm flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                onClick={handleBackToSubjects}
                className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors cursor-pointer"
                title={isRtl ? 'الرجوع للمواد' : 'Back to subjects'}
              >
                {isRtl ? <ArrowRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
              </button>

              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-black text-slate-900 dark:text-stone-100">
                    {isRtl ? activeSubject.nameAr : activeSubject.nameEn}
                  </h2>
                  <span className={`px-2 py-0.5 rounded-md text-[11px] font-black ${
                    selectedMode === 'theory'
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                      : 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300'
                  }`}>
                    {selectedMode === 'theory' ? (isRtl ? 'نظري' : 'Theory') : (isRtl ? 'عملي' : 'Practical')}
                  </span>
                </div>
                <p className="text-xs font-bold text-slate-400 dark:text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  <span>{isRtl ? `كروبك الأصلي: ${userGroup}` : `Your original group: ${userGroup}`}</span>
                  {((selectedMode === 'theory' ? activeSubject.theoryDoctor : activeSubject.practicalDoctor) || activeSubject.doctorName) && (
                    <>
                      <span>•</span>
                      <span className="text-slate-600 dark:text-zinc-300 font-bold">
                        {(selectedMode === 'theory' ? activeSubject.theoryDoctor : activeSubject.practicalDoctor) || activeSubject.doctorName}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="text-end">
              <span className="text-[11px] font-bold text-slate-400 block">
                {isRtl ? 'نسبة الالتزام' : 'Rate'}
              </span>
              <span className="text-base font-black text-teal-600 dark:text-teal-400">
                {attendancePercentage}%
              </span>
            </div>
          </div>

          {/* Quick Filter Info Note */}
          <div className="px-1 flex items-center justify-between text-xs font-bold text-slate-400 dark:text-zinc-500">
            <span>{isRtl ? 'سجل حضور المحاضرات الأسبوعية:' : 'Weekly Attendance Timeline:'}</span>
            <span>{isRtl ? `${completedWeeks} حضور • ${missedWeeks} غياب` : `${completedWeeks} present • ${missedWeeks} absent`}</span>
          </div>

          {/* Weeks Cards Grid / List */}
          <div className="space-y-3">
            {currentWeeksList.map((week) => {
              // Status Badge Resolution
              let statusBadge = null;
              if (week.status === 'attended') {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-black bg-emerald-50 text-emerald-700 border border-emerald-200/80 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60">
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{isRtl ? 'حضور مؤكد لهذه المحاضرة' : 'Confirmed for this lecture'}</span>
                  </span>
                );
              } else if (week.status === 'substituted') {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-black bg-indigo-50 text-indigo-700 border border-indigo-200/80 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-800/60 shadow-sm">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                    <span>{isRtl ? `تعويض في كروب (${week.attendedGroup}) ⚡` : `Substituted in (${week.attendedGroup}) ⚡`}</span>
                  </span>
                );
              } else if (week.status === 'absent') {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-black bg-rose-50 text-rose-700 border border-rose-200/80 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800/60">
                    <span>{isRtl ? 'غائب ✗' : 'Absent ✗'}</span>
                  </span>
                );
              } else if (week.status === 'pending') {
                statusBadge = <span className="rounded-xl bg-amber-50 p-2 text-xs font-bold text-amber-800">{stateLabel(week.state)}<span className="block break-all font-mono">{week.receiptId}</span></span>;
              } else {
                statusBadge = (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-500 dark:bg-zinc-700/60 dark:text-zinc-400">
                    <Clock className="w-3 h-3" />
                    <span>{isRtl ? 'قادمة ⏱' : 'Upcoming ⏱'}</span>
                  </span>
                );
              }

              return (
                <div
                  key={week.occurrenceId}
                  className="bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700/90 rounded-2xl p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3.5"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5">
                      <span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 text-xs font-black flex items-center justify-center font-mono">
                        {week.weekNumber}
                      </span>
                      <h4 className="font-black text-sm text-slate-900 dark:text-stone-100">
                        {week.title}
                      </h4>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-zinc-400 font-bold px-1">
                      {week.topic}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center sm:justify-end gap-2.5 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 dark:border-zinc-700/60">
                    {/* Date and time pill */}
                    {week.date && (
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-400 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-700/30 px-2.5 py-1 rounded-xl">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>{week.date}</span>
                        {week.time && <span>• {week.time}</span>}
                        {week.location && <span>• {week.location}</span>}
                      </div>
                    )}

                    {/* Status Badge */}
                    {statusBadge}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------
          5. LIVE CAMERA SCANNER MODAL (QrScannerModal)
          ------------------------------------------------------------- */}
      {scannerOpen && (
        <QrScannerModal
          lang={lang}
          onScan={handleScanSuccess}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {/* -------------------------------------------------------------
          6. VERIFIED RECEIPT SUCCESS POPUP
          ------------------------------------------------------------- */}
      {scanSuccessSheet?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white p-6 shadow-2xl dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 text-center space-y-4 animate-in zoom-in-95">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
              <CheckCircle2 className="h-9 w-9" />
            </div>

            <div>
              <span className="inline-block px-3 py-1 rounded-full text-xs font-black bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                {isRtl ? 'تم الحفظ على هذا الجهاز' : 'Saved on this device'}
              </span>
              <h3 className="mt-2 text-lg font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'بانتظار المزامنة والتحقق' : 'Awaiting sync and verification'}
              </h3>
              <p className="text-xs font-bold text-slate-500 dark:text-zinc-400 mt-1">
                {scanSuccessSheet.lectureTitle}
              </p>
              <p className="text-xs text-teal-600 dark:text-teal-400 font-bold mt-0.5">
                {scanSuccessSheet.subjectName} • {scanSuccessSheet.time}
              </p>
            </div>

            <div className="p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-700/60 text-xs text-slate-500 space-y-1">
              <div className="flex justify-between font-bold">
                <span>{isRtl ? 'رقم الإيصال:' : 'Receipt ID:'}</span>
                <span className="max-w-[65%] break-all font-mono text-slate-800 dark:text-zinc-200">{scanSuccessSheet.receiptId}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>{isRtl ? 'كروب الحساب:' : 'Account group:'}</span>
                <span className="font-mono text-emerald-600 font-black">{scanSuccessSheet.group}</span>
              </div>
            </div>

            <button
              onClick={() => setScanSuccessSheet(null)}
              className="w-full py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-sm shadow-md transition-all active:scale-[0.98] cursor-pointer"
            >
              {isRtl ? 'حسناً، تم الحفظ' : 'Done'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

