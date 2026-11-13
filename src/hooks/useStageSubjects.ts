import { useState, useEffect } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Subject } from '../types';
import { useStageContext } from '../contexts/StageContext';

const CACHE_KEY_PREFIX = 'mohadaraty_stage_subjects_';

function getLocalCachedSubjects(stageId: string | null): Subject[] {
  if (!stageId || typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${CACHE_KEY_PREFIX}${stageId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {}
  return [];
}

/**
 * Active subjects for the current stage, ordered, across both courses.
 *
 * Uses real-time onSnapshot with Firestore persistent local cache (IndexedDB)
 * and an immediate localStorage fallback. This guarantees subjects are loaded
 * with 0ms delay even on cold boots, flaky mobile networks, or offline mode,
 * preventing any fallback to legacy stage 3 hardcoded categories.
 */
export function useStageSubjects() {
  const { effectiveStageId } = useStageContext();
  const [subjects, setSubjects] = useState<Subject[]>(() => getLocalCachedSubjects(effectiveStageId));
  const [isLoading, setIsLoading] = useState(() => !subjects.length);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!effectiveStageId) {
      setSubjects([]);
      setIsLoading(false);
      return;
    }

    // Hydrate immediately from localStorage cache if not yet set for this stageId
    const localCached = getLocalCachedSubjects(effectiveStageId);
    if (localCached.length > 0) {
      setSubjects(localCached);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }

    const q = query(
      collection(db, 'subjects'),
      where('stageId', '==', effectiveStageId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map(d => d.data() as Subject)
          .filter(s => s.isActive !== false)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        // Avoid blowing away valid cached subjects with an empty cache snapshot offline
        if (list.length > 0 || !snap.metadata.fromCache) {
          setSubjects(list);
          if (list.length > 0) {
            try {
              localStorage.setItem(`${CACHE_KEY_PREFIX}${effectiveStageId}`, JSON.stringify(list));
            } catch {}
          }
        }
        setIsLoading(false);
        setError(null);
      },
      (err) => {
        console.warn('Error listening to stage subjects:', err);
        setError(err);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [effectiveStageId]);

  return { subjects, isLoading, error };
}
