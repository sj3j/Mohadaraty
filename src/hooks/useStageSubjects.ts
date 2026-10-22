import { useState, useEffect } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Subject } from '../types';
import { useStageContext } from '../contexts/StageContext';

/**
 * Active subjects for the current stage, ordered, across both courses.
 *
 * Returns an empty list for a stage whose curriculum has not been set up yet;
 * callers should fall back to the legacy CATEGORIES picker in that case.
 */
export function useStageSubjects() {
  const { effectiveStageId, isAuthenticated } = useStageContext();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!effectiveStageId || !isAuthenticated) {
        setSubjects([]);
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const snap = await getDocs(
          query(collection(db, 'subjects'), where('stageId', '==', effectiveStageId))
        );
        if (cancelled) return;
        const list = snap.docs
          .map(d => d.data() as Subject)
          .filter(s => s.isActive !== false)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setSubjects(list);
      } catch (err) {
        console.error('Error loading stage subjects:', err);
        if (!cancelled) setSubjects([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [effectiveStageId, isAuthenticated]);

  return { subjects, isLoading };
}
