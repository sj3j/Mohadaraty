import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import type { UserProfile } from '../../types';
import type { StageTimetableDoc, TimetableSession } from '../../../shared/timetable';
import {
  buildAttendanceOccurrences,
  type AttendanceBootstrap,
  type AttendanceOccurrenceCandidate,
} from '../../../shared/attendance';
import { DEFAULT_CALENDAR, type AcademicCalendar } from '../../../shared/academicCalendar';
import type { LectureColumn } from './types';

export const STAGES_LIST = [
  { id: 'stage_1', nameAr: 'المرحلة الأولى', nameEn: 'First Stage' },
  { id: 'stage_2', nameAr: 'المرحلة الثانية', nameEn: 'Second Stage' },
  { id: 'stage_3', nameAr: 'المرحلة الثالثة', nameEn: 'Third Stage' },
  { id: 'stage_4', nameAr: 'المرحلة الرابعة', nameEn: 'Fourth Stage' },
  { id: 'stage_5', nameAr: 'المرحلة الخامسة', nameEn: 'Fifth Stage' },
] as const;

export const STAGE_NAME_MAP: Record<string, { ar: string; en: string }> = Object.fromEntries(
  STAGES_LIST.map(s => [s.id, { ar: s.nameAr, en: s.nameEn }])
);

/**
 * Normalizes teacher/doctor names to handle titles, tashkeel, alefs, and spacing.
 */
export function normalizeTeacherName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/(^|\s)(أستاذ\s*مساعد|استاذ\s*مساعد|أ\.م\.د|ا\.م\.د|أ\.د|ا\.د|أستاذة|استاذة|أستاذ|استاذ|دكتورة|دكتور|م\.م|مدرس|د\.|د\/|dr\.|doctor)\s*/gi, ' ')
    .replace(/(^|\s)د\s+/gi, ' ')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Checks whether a timetable session's teacher string belongs to the doctor.
 */
export function matchesDoctorTeacher(teacher: string | undefined | null, doctorName: string | undefined | null): boolean {
  if (!teacher || !doctorName) return false;
  const normTeacher = normalizeTeacherName(teacher);
  const normDoctor = normalizeTeacherName(doctorName);
  if (!normTeacher || !normDoctor) return false;

  if (normTeacher === normDoctor) return true;

  if (normTeacher.length >= 3 && normDoctor.length >= 3) {
    if (normTeacher.includes(normDoctor) || normDoctor.includes(normTeacher)) return true;
  }

  const teacherTokens = normTeacher.split(' ').filter(t => t.length >= 3);
  const doctorTokens = normDoctor.split(' ').filter(t => t.length >= 3);
  if (teacherTokens.length === 0 || doctorTokens.length === 0) return false;

  if (teacherTokens.length >= 2 && doctorTokens.length >= 2) {
    return teacherTokens[0] === doctorTokens[0] && (
      teacherTokens[1] === doctorTokens[1] ||
      teacherTokens.slice(1).some(t => doctorTokens.slice(1).includes(t))
    );
  }

  return teacherTokens[0] === doctorTokens[0];
}

interface UseDoctorCrossStageTimetableParams {
  user: UserProfile;
  primaryStageId?: string;
  primaryOccurrences: AttendanceOccurrenceCandidate[];
  referenceDate?: string;
  term?: AttendanceBootstrap['term'] | null;
}

export function useDoctorCrossStageTimetable({
  user,
  primaryStageId,
  primaryOccurrences,
  referenceDate,
  term,
}: UseDoctorCrossStageTimetableParams) {
  const [calendar, setCalendar] = useState<AcademicCalendar>(() => {
    if (term) {
      return {
        yearLabel: term.yearLabel,
        timezone: term.timezone,
        terms: [{
          id: term.calendarTermId || term.id,
          nameAr: term.nameAr,
          nameEn: term.nameEn,
          startDate: term.startDate,
          endDate: term.endDate,
          examsStart: null,
          examsEnd: null,
        }],
        resultsDate: null,
        resitResultsDate: null,
        progressionStages: null,
      };
    }
    return DEFAULT_CALENDAR;
  });

  const [timetables, setTimetables] = useState<Record<string, StageTimetableDoc>>({});
  const [loading, setLoading] = useState(true);

  // 1. Listen to app_settings/academicCalendar to have up-to-date term bounds
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'app_settings', 'academicCalendar'), (snap) => {
      if (snap.exists()) {
        const data = snap.data() as Partial<AcademicCalendar>;
        if (Array.isArray(data.terms) && data.terms.length > 0) {
          setCalendar({
            yearLabel: data.yearLabel || DEFAULT_CALENDAR.yearLabel,
            timezone: data.timezone || DEFAULT_CALENDAR.timezone,
            terms: data.terms,
            resultsDate: data.resultsDate ?? null,
            resitResultsDate: data.resitResultsDate ?? null,
            progressionStages: data.progressionStages ?? null,
          });
        }
      }
    }, (err) => {
      console.warn('[useDoctorCrossStageTimetable] calendar error:', err);
    });
    return () => unsub();
  }, []);

  // 2. Listen to published timetables across all 5 stages
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    let loadedCount = 0;

    STAGES_LIST.forEach(stage => {
      const unsub = onSnapshot(doc(db, 'timetables', stage.id), (snap) => {
        if (snap.exists()) {
          setTimetables(prev => ({ ...prev, [stage.id]: snap.data() as StageTimetableDoc }));
        }
        loadedCount++;
        if (loadedCount >= STAGES_LIST.length) {
          setLoading(false);
        }
      }, (err) => {
        console.warn(`[useDoctorCrossStageTimetable] error loading timetable for ${stage.id}:`, err);
        loadedCount++;
        if (loadedCount >= STAGES_LIST.length) {
          setLoading(false);
        }
      });
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach(u => u());
    };
  }, []);

  const today = referenceDate || new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Baghdad',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // 3. Aggregate all lectures of this doctor across all stages, both theoretical and practical
  const allLectures: LectureColumn[] = useMemo(() => {
    const result: LectureColumn[] = [];
    const seenIds = new Set<string>();

    // A. Start with primary occurrences already loaded from doctor attendance workspace (includes theory & practical)
    primaryOccurrences.forEach((occ, index) => {
      if (!seenIds.has(occ.id)) {
        seenIds.add(occ.id);
        const stageId = occ.stageId || primaryStageId || 'stage_3';
        result.push({
          id: occ.id,
          number: index + 1,
          date: occ.lectureDate,
          title: occ.title,
          mode: occ.mode === 'practical' ? 'practical' : 'theoretical',
          time: occ.startTime,
          endTime: occ.endTime,
          day: occ.day,
          audienceGroups: occ.audienceGroups || [],
          location: occ.location,
          stageId,
          stageName: STAGE_NAME_MAP[stageId]?.ar || stageId,
          teacher: occ.teacher || user.name,
        });
      }
    });

    // B. Check each stage's timetable for sessions taught by the doctor
    STAGES_LIST.forEach(stage => {
      const timetableDoc = timetables[stage.id];
      if (!timetableDoc?.sessions?.length) return;

      // Filter sessions where teacher matches doctor
      const matchingSessions = timetableDoc.sessions.filter(session =>
        matchesDoctorTeacher(session.teacher, user.name)
      );

      if (matchingSessions.length === 0) return;

      // Generate dated occurrences using academic calendar
      const occurrences = buildAttendanceOccurrences(
        calendar,
        { ...timetableDoc, sessions: matchingSessions },
        stage.id,
        today,
        8,
        4
      );

      occurrences.forEach((occ) => {
        if (!seenIds.has(occ.id)) {
          seenIds.add(occ.id);
          result.push({
            id: occ.id,
            number: result.length + 1,
            date: occ.lectureDate,
            title: occ.title,
            mode: occ.mode === 'practical' ? 'practical' : 'theoretical',
            time: occ.startTime,
            endTime: occ.endTime,
            day: occ.day,
            audienceGroups: occ.audienceGroups || [],
            location: occ.location,
            stageId: stage.id,
            stageName: stage.nameAr,
            teacher: occ.teacher || user.name,
          });
        }
      });
    });

    // Sort chronologically: by date, then by start time
    return result.sort((a, b) => {
      const cmpDate = a.date.localeCompare(b.date);
      if (cmpDate !== 0) return cmpDate;
      return (a.time || '').localeCompare(b.time || '');
    });
  }, [primaryOccurrences, primaryStageId, timetables, calendar, today, user.name]);

  return {
    lectures: allLectures,
    loading,
    totalStagesCount: new Set(allLectures.map(l => l.stageId)).size,
  };
}
