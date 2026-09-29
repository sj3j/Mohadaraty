import { useState, useEffect, useCallback } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '../lib/firebase';
import {
  AcademicCalendar,
  DEFAULT_CALENDAR,
  PhaseInfo,
  ProgressionGate,
  baghdadToday,
  progressionGate,
  resolvePhase,
} from '../../shared/academicCalendar';

/**
 * The academic calendar and the phase it puts the app in right now.
 *
 * The phase is recomputed locally from the dates rather than read from a stored
 * flag, so a break pauses the app on time even if the nightly rollover never
 * fires. Only the archive write depends on that job.
 *
 * Recomputes on three triggers: a change to the saved calendar, the tab coming
 * back to the foreground, and the next Baghdad midnight - so a tab left open
 * across a boundary does not sit in yesterday's phase.
 */
export function useAcademicPhase() {
  const [calendar, setCalendar] = useState<AcademicCalendar>(DEFAULT_CALENDAR);
  const [today, setToday] = useState(() => baghdadToday(DEFAULT_CALENDAR.timezone));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let unsubSnapshot: (() => void) | null = null;

    const subscribe = () => {
      if (unsubSnapshot) {
        unsubSnapshot();
        unsubSnapshot = null;
      }
      unsubSnapshot = onSnapshot(
        doc(db, 'app_settings', 'academicCalendar'),
        snap => {
          const data = snap.exists() ? (snap.data() as Partial<AcademicCalendar>) : null;
          setCalendar(
            data && Array.isArray(data.terms) && data.terms.length > 0
              ? {
                  yearLabel: data.yearLabel || DEFAULT_CALENDAR.yearLabel,
                  timezone: data.timezone || DEFAULT_CALENDAR.timezone,
                  terms: data.terms,
                  resultsDate: data.resultsDate ?? null,
                  resitResultsDate: data.resitResultsDate ?? null,
                  progressionStages: data.progressionStages ?? null,
                }
              : DEFAULT_CALENDAR,
          );
          setIsLoading(false);
        },
        err => {
          if (err?.code !== 'permission-denied') {
            console.error('Error loading academic calendar:', err);
          }
          setCalendar(DEFAULT_CALENDAR);
          setIsLoading(false);
        },
      );
    };

    subscribe();
    const unsubAuth = onAuthStateChanged(auth, () => {
      subscribe();
    });

    return () => {
      if (unsubSnapshot) unsubSnapshot();
      unsubAuth();
    };
  }, []);

  // Keep `today` honest for a long-lived tab.
  useEffect(() => {
    const tick = () => setToday(baghdadToday(calendar.timezone));
    tick();

    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);

    // Fire just after the next local midnight, then hourly as a cheap backstop
    // against clock drift and suspended timers.
    const now = new Date();
    const msToMidnight = new Date(now).setHours(24, 0, 30, 0) - now.getTime();
    const timeout = setTimeout(tick, Math.max(1000, msToMidnight));
    const interval = setInterval(tick, 60 * 60 * 1000);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [calendar.timezone]);

  const phase: PhaseInfo = resolvePhase(calendar, today);
  /** Which end-of-year question, if any, is open. 'closed' until results dates are set. */
  const gate: ProgressionGate = progressionGate(calendar, today);

  const saveCalendar = useCallback(async (next: AcademicCalendar) => {
    await setDoc(doc(db, 'app_settings', 'academicCalendar'), {
      ...next,
      updatedAt: new Date().toISOString(),
    }, { merge: false });
  }, []);

  return { calendar, phase, gate, yearLabel: calendar.yearLabel, today, isLoading, saveCalendar };
}
