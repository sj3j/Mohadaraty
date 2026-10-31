/**
 * Student attendance view. Signed QR captures are saved to IndexedDB before any
 * upload; pending evidence stays separate from server-confirmed attendance.
 * Exact dated occurrences and explicitly assigned subject slots drive this view.
 * Group substitution requires a separate authorized equivalence link.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { 
  Camera, CheckCircle2, BookOpen, FlaskConical, ChevronLeft, 
  ChevronRight, Calendar, Clock, AlertCircle, ArrowRight,
  ShieldCheck, Check, Sparkles, RefreshCw
} from 'lucide-react';
import type { Language, UserProfile } from '../../types';
import { captureAttendanceQr } from '../../services/attendanceService';
import QrScannerModal from './QrScannerModal';
import { useStudentAttendance } from './useStudentAttendance';
import { lectureTimingStatus, type StudentAttendanceRow } from '../../../shared/attendanceSchedule';
import { attendanceWeekStart } from '../../../shared/attendance';
import { baghdadToday } from '../../../shared/academicCalendar';
import type { AttendanceScanLocationEvidence } from '../../../shared/attendanceSecurity';
import {
  AttendanceLocationGateError,
  resolveAttendancePermissionBlock,
  retryAttendanceGpsEnablement,
  verifyAttendanceScanLocation,
  type AttendanceLocationGateFailure,
} from '../../services/attendanceLocationGate';

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
  endTime?: string;
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
 * Splits a normalized subject title into base title and optional level/number.
 * e.g. "pharmacology 2" -> { baseKey: "pharmacology", level: 2 }
 *      "pharmacology"   -> { baseKey: "pharmacology", level: null }
 */
export function extractBaseSubjectKey(normalizedTitle: string): { baseKey: string; level: number | null } {
  if (!normalizedTitle) return { baseKey: '', level: null };
  const match = normalizedTitle.match(/^(.*?)(?:\s+(\d+))$/);
  if (match) {
    return {
      baseKey: match[1].trim(),
      level: parseInt(match[2], 10),
    };
  }
  return {
    baseKey: normalizedTitle.trim(),
    level: null,
  };
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
    level: number | null;
    baseKey: string;
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
    const { baseKey: baseKeyAr, level: levelAr } = extractBaseSubjectKey(normAr);
    const { baseKey: baseKeyEn, level: levelEn } = extractBaseSubjectKey(normEn);
    const baseKey = baseKeyEn || baseKeyAr;
    const level = levelEn ?? levelAr;
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
        level,
        baseKey,
        theoryDoctors: new Set(),
        practicalDoctors: new Set(),
        theoryWeeks: [],
        practicalWeeks: [],
      });
    }

    const existing = canonicalMap.get(targetKey)!;
    if (!existing.nameAr && assignment.nameAr) existing.nameAr = cleanDisplaySubjectName(assignment.nameAr);
    if (!existing.nameEn && assignment.nameEn) existing.nameEn = cleanDisplaySubjectName(assignment.nameEn);
    if (existing.level === null && level !== null) existing.level = level;
    if (!existing.baseKey && baseKey) existing.baseKey = baseKey;

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
    const { baseKey, level: incomingLevel } = extractBaseSubjectKey(normTitle);
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

    // Base-key reconciliation: merge unnumbered variant (e.g. Pharmacology lab) with single numbered variant (Pharmacology II)
    if (!targetKey && baseKey) {
      for (const [cKey, cVal] of canonicalMap.entries()) {
        if (cVal.baseKey === baseKey) {
          // Reconcile if both have same level, or one is unnumbered (level === null)
          if (
            cVal.level === incomingLevel ||
            cVal.level === null ||
            incomingLevel === null
          ) {
            targetKey = cKey;
            // If incoming has specific level while existing was unadorned, upgrade to qualified title & code
            if (cVal.level === null && incomingLevel !== null) {
              cVal.level = incomingLevel;
              const cleanTitle = cleanDisplaySubjectName(occurrence.title) || occurrence.title;
              if (cleanTitle) {
                cVal.nameAr = cleanTitle;
                cVal.nameEn = cleanTitle;
              }
              if (occurrence.timetableSessionId) {
                cVal.code = occurrence.timetableSessionId;
              }
            }
            if (normTitle) {
              keyAliases.set(`ar:${normTitle}`, targetKey);
              keyAliases.set(`en:${normTitle}`, targetKey);
            }
            break;
          }
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
        level: incomingLevel,
        baseKey,
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
      endTime: occurrence.endTime,
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
  const attendanceTimezone = attendance.mine?.timezone || 'Asia/Baghdad';
  const [today, setToday] = useState(() => baghdadToday(attendanceTimezone));

  useEffect(() => {
    const updateToday = () => setToday(baghdadToday(attendanceTimezone));
    updateToday();
    const onVisible = () => { if (!document.hidden) updateToday(); };
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(updateToday, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, [attendanceTimezone]);

  // Scanner state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanGateBusy, setScanGateBusy] = useState(false);
  const [scanGateFailure, setScanGateFailure] = useState<AttendanceLocationGateFailure | null>(null);
  const [scanLocation, setScanLocation] = useState<AttendanceScanLocationEvidence | null>(null);
  const scanAttemptRef = useRef(0);
  const reopenOnForegroundRef = useRef(false);

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

  const runLocationGate = useCallback(async (
    verify: () => Promise<AttendanceScanLocationEvidence> = verifyAttendanceScanLocation,
  ) => {
    const attempt = ++scanAttemptRef.current;
    setScanGateBusy(true);
    setScanGateFailure(null);
    setScanError('');
    try {
      const evidence = await verify();
      if (attempt !== scanAttemptRef.current || document.visibilityState === 'hidden') return;
      setScanLocation(evidence);
      setScannerOpen(true);
      reopenOnForegroundRef.current = false;
    } catch (error) {
      if (attempt !== scanAttemptRef.current) return;
      setScanLocation(null);
      setScannerOpen(false);
      setScanGateFailure(error instanceof AttendanceLocationGateError ? error.kind : 'unavailable');
    } finally {
      if (attempt === scanAttemptRef.current) setScanGateBusy(false);
    }
  }, []);

  const closeScanner = useCallback(() => {
    scanAttemptRef.current += 1;
    reopenOnForegroundRef.current = false;
    setScannerOpen(false);
    setScanLocation(null);
    setScanGateBusy(false);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (scannerOpen || scanGateBusy) reopenOnForegroundRef.current = true;
        scanAttemptRef.current += 1;
        setScannerOpen(false);
        setScanLocation(null);
        setScanGateBusy(false);
        return;
      }
      if (reopenOnForegroundRef.current) {
        reopenOnForegroundRef.current = false;
        void runLocationGate();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [runLocationGate, scanGateBusy, scannerOpen]);

  useEffect(() => closeScanner, [closeScanner, user.uid]);

  const handlePermissionAction = async () => {
    setScanGateBusy(true);
    try {
      const action = await resolveAttendancePermissionBlock();
      if (action === 'foreground') {
        reopenOnForegroundRef.current = true;
        return;
      }
    } catch {
      setScanGateFailure('unavailable');
      setScanGateBusy(false);
      return;
    }
    await runLocationGate();
  };

  const handleScanSuccess = async (scannedValue: string) => {
    setScannerOpen(false);
    setScanError('');
    const locationEvidence = scanLocation;
    setScanLocation(null);
    if (!locationEvidence) {
      setScanError(isRtl ? 'يجب التحقق من الموقع قبل فتح الماسح.' : 'Location must be verified before scanning.');
      return;
    }
    try {
      const { receipt } = await captureAttendanceQr(scannedValue, user.uid, locationEvidence);
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
  const attendanceAvailabilityLabel = (() => {
    if (attendance.loading) return isRtl ? 'تحميل السجل المحفوظ…' : 'Loading saved records…';
    const reason = attendance.mine?.unavailableReason || attendance.error;
    if (reason === 'attendance_not_configured') return isRtl ? 'خدمة الحضور غير مهيأة على الخادم — الإيصالات المحلية محفوظة' : 'Attendance service is not configured — local receipts are retained';
    if (reason === 'attendance_schema_missing') return isRtl ? 'إعداد قاعدة بيانات الحضور غير مكتمل — الإيصالات المحلية محفوظة' : 'Attendance database setup is incomplete — local receipts are retained';
    if (reason === 'login_required') return isRtl ? 'سجّل الدخول لمزامنة الإيصالات المحفوظة' : 'Sign in to sync saved receipts';
    if (reason === 'attendance_temporarily_unavailable') return isRtl ? 'خدمة الحضور غير متاحة مؤقتاً — ستتم إعادة المحاولة' : 'Attendance service is temporarily unavailable — retry is automatic';
    if (attendance.mine?.offline || reason) return isRtl ? 'عرض البيانات المحفوظة — تعذر الوصول إلى الخادم' : 'Showing saved evidence — server unavailable';
    return isRtl ? 'سجل الحضور' : 'Attendance records';
  })();

  return (
    <div className="w-full space-y-6" dir={isRtl ? 'rtl' : 'ltr'}>
      {scanError && <p role="alert" className="rounded-2xl bg-rose-50 p-4 text-rose-800">{scanError}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-slate-100 p-3 text-xs dark:bg-zinc-800" aria-live="polite">
        <span>{attendanceAvailabilityLabel}{attendance.pendingCount > 0 ? ` · ${attendance.pendingCount} ${isRtl ? 'بانتظار المعالجة' : 'pending'}` : ''}{attendance.lastSuccessfulSync ? ` · ${isRtl ? 'آخر مزامنة' : 'Last sync'} ${new Date(attendance.lastSuccessfulSync).toLocaleTimeString(isRtl ? 'ar-IQ' : 'en-GB')}` : ''}</span>
        <button onClick={() => void attendance.retry().catch(() => setScanError(isRtl ? 'تعذرت المزامنة؛ الإيصالات محفوظة.' : 'Sync unavailable; saved receipts are retained.'))} className="flex items-center gap-1 font-bold"><RefreshCw className="h-4 w-4" />{isRtl ? 'مزامنة' : 'Sync'}</button>
      </div>
      {(attendance.mine?.cancelledSessions || []).map(session => (
        <div key={session.id} className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/20 dark:text-rose-200" role="status">
          <strong>{session.occurrence.title} — {session.occurrence.lectureDate}</strong>
          <p>{isRtl ? 'ألغى التدريسي جلسة الحضور هذه، ولا تدخل نتيجتها في إجمالياتك.' : 'The lecturer cancelled this attendance attempt. It is excluded from your totals.'}</p>
          {session.cancellationReason && <p>{isRtl ? 'السبب' : 'Reason'}: {session.cancellationReason}</p>}
        </div>
      ))}
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
            onClick={() => void runLocationGate()}
            disabled={scanGateBusy}
            className="w-full sm:w-auto sm:min-w-[340px] px-4 sm:px-8 py-3.5 sm:py-4 rounded-2xl bg-gradient-to-r from-emerald-600 via-teal-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white font-black text-sm sm:text-lg shadow-xl shadow-teal-700/20 flex items-center justify-center gap-2.5 sm:gap-3.5 active:scale-[0.98] transition-all border border-emerald-400/30 group cursor-pointer"
          >
            <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <Camera className="w-6 h-6 text-white" strokeWidth={2.5} />
            </div>
            <span className="tracking-tight">
              {scanGateBusy
                ? (isRtl ? 'جارٍ التحقق من الموقع…' : 'Verifying location…')
                : (isRtl ? 'تسجيل حضور بقارئ الباركود' : 'Record Attendance with QR Scanner')}
            </span>
          </button>
        </div>
      )}

      {/* -------------------------------------------------------------
          2. SUBJECTS CARDS (StatCard Aesthetic)
          ------------------------------------------------------------- */}
      {!selectedMode && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-black text-slate-800 dark:text-stone-200">
              {isRtl ? 'المواد الدراسية (اضغط لعرض السجل الأسبوعي)' : 'Academic Subjects'}
            </h2>
            <span className="text-xs font-bold text-slate-400 dark:text-zinc-500">
              {isRtl ? `كروبك الحالي: ${userGroup}` : `Your Group: ${userGroup}`}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            {subjects.map((subj) => (
                <div
                  key={subj.id}
                  onClick={() => handleCardClick(subj)}
                  className="group bg-white dark:bg-zinc-800 border-2 border-slate-100 dark:border-zinc-700 rounded-2xl p-3.5 sm:p-4 md:p-5 flex flex-col justify-between gap-3 sm:gap-3.5 shadow-sm transition-all hover:bg-slate-50 dark:hover:bg-zinc-700/50 hover:border-slate-200 dark:hover:border-zinc-600 cursor-pointer active:translate-y-px"
                >
                  <div className="flex items-start gap-3 sm:gap-3.5">
                    {/* StatCard colored icon container */}
                    <div className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center shrink-0 ${subj.iconBg}`}>
                      <BookOpen className={`w-5 h-5 ${subj.iconColor}`} strokeWidth={2.5} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
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

                      <h3 className="font-black text-slate-900 dark:text-stone-100 text-sm sm:text-base leading-snug mt-1 line-clamp-1">
                        {isRtl ? subj.nameAr : subj.nameEn}
                      </h3>

                      <p className="text-xs font-bold text-slate-400 dark:text-slate-500 mt-0.5">
                        {subj.doctorName}
                      </p>
                    </div>
                  </div>

                  {/* StatCard Footer Info */}
                  <div className="pt-2.5 sm:pt-3 border-t border-slate-100 dark:border-zinc-700/80 flex items-center justify-end text-xs font-bold">
                    <span className={`text-teal-600 dark:text-teal-400 font-black flex items-center gap-0.5 ${isRtl ? 'group-hover:-translate-x-1' : 'group-hover:translate-x-1'} transition-transform`}>
                      {isRtl ? 'عرض الأسابيع' : 'View weeks'}
                      {isRtl ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------
          3. ACTION MODAL: Pops two buttons (نظري و عملي)
          ------------------------------------------------------------- */}
      {showModeModal && activeSubject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl sm:rounded-3xl bg-white p-4 sm:p-6 shadow-2xl dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 space-y-5 animate-in zoom-in-95 duration-150 student-modal-panel">
            {/* Modal Header */}
            <div className="text-center space-y-1">
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
              const timing = week.date ? lectureTimingStatus(week.date, today) : null;
              const timingBadge = timing === 'past' ? (
                <span className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-black text-slate-600 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                  {isRtl ? 'فائتة' : 'Past'}
                </span>
              ) : timing === 'today' ? (
                <span className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-black text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                  {isRtl ? 'اليوم' : 'Today'}
                </span>
              ) : timing === 'upcoming' ? (
                <span className="inline-flex items-center rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-black text-sky-700 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300">
                  {isRtl ? 'قادمة' : 'Upcoming'}
                </span>
              ) : null;

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
                        {week.time && <span dir="ltr">• {week.time}{week.endTime ? ` – ${week.endTime}` : ''}</span>}
                        {week.location && <span>• {week.location}</span>}
                      </div>
                    )}

                    {timingBadge}
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
          onClose={closeScanner}
        />
      )}

      {scanGateFailure && !scannerOpen && (
        <div className="fixed inset-0 z-[125] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" dir={isRtl ? 'rtl' : 'ltr'}>
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl sm:rounded-3xl border border-slate-200 bg-white p-4 sm:p-6 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 student-modal-panel">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
              <AlertCircle className="h-6 w-6" />
            </div>
            <p className="font-bold leading-7 text-slate-800 dark:text-slate-100">
              {scanGateFailure === 'permission_denied'
                ? (isRtl ? 'لا يمكن فتح الكاميرا لتسجيل الحضور إلا بعد تفعيل صلاحية الموقع الجغرافي (GPS).' : 'The camera can only open for attendance after location (GPS) permission is enabled.')
                : scanGateFailure === 'gps_disabled'
                  ? (isRtl ? 'يرجى تشغيل الموقع الجغرافي (GPS) من شريط إشعارات الهاتف لفتح الماسح الضوئي.' : 'Turn on device location (GPS) to open the scanner.')
                  : scanGateFailure === 'timeout'
                    ? (isRtl ? 'انتهت مهلة تحديد الموقع. تأكد من السماح للموقع وحاول مرة أخرى.' : 'Location timed out. Check site permission and try again.')
                    : (isRtl ? 'تعذر التحقق من الموقع الجغرافي. تحقق من إعدادات الموقع وحاول مرة أخرى.' : 'Location could not be verified. Check location settings and try again.')}
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                disabled={scanGateBusy}
                onClick={() => void (scanGateFailure === 'permission_denied'
                  ? handlePermissionAction()
                  : scanGateFailure === 'gps_disabled'
                    ? runLocationGate(retryAttendanceGpsEnablement)
                    : runLocationGate())}
                className="rounded-xl bg-teal-600 px-4 py-3 font-black text-white disabled:opacity-60"
              >
                {scanGateBusy
                  ? (isRtl ? 'جارٍ التحقق…' : 'Checking…')
                  : scanGateFailure === 'permission_denied'
                    ? (isRtl ? 'تفعيل صلاحية الموقع' : 'Enable location permission')
                    : scanGateFailure === 'gps_disabled'
                      ? (isRtl ? 'تشغيل الـ GPS وإعادة المحاولة' : 'Turn on GPS and retry')
                      : (isRtl ? 'إعادة المحاولة' : 'Retry')}
              </button>
              <button onClick={() => { scanAttemptRef.current += 1; setScanGateFailure(null); setScanGateBusy(false); reopenOnForegroundRef.current = false; }} className="rounded-xl border border-slate-200 px-4 py-3 font-bold dark:border-zinc-700">
                {isRtl ? 'إلغاء' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------
          6. VERIFIED RECEIPT SUCCESS POPUP
          ------------------------------------------------------------- */}
      {scanSuccessSheet?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm rounded-2xl sm:rounded-3xl bg-white p-4 sm:p-6 shadow-2xl dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 text-center space-y-4 animate-in zoom-in-95 student-modal-panel">
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

