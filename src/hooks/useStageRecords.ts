import { useState, useEffect, useMemo } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Lecture, RecordItem } from '../types';
import { useStageContext } from '../contexts/StageContext';
import { recordBelongsToLecture } from '../components/lecture/LectureRecordingsSection';

type ListenerCallback = (records: RecordItem[]) => void;

interface StageSubscription {
  records: RecordItem[];
  listeners: Set<ListenerCallback>;
  unsubscribe: () => void;
}

// Module-level singleton subscriber cache per stageId to prevent N duplicate snapshot listeners
const stageSubscriptions = new Map<string, StageSubscription>();

function subscribeToStageRecords(stageId: string, callback: ListenerCallback): () => void {
  let sub = stageSubscriptions.get(stageId);

  if (!sub) {
    const listeners = new Set<ListenerCallback>();
    listeners.add(callback);

    const q = query(collection(db, 'records'), where('stageId', '==', stageId));
    const unsubscribeFirestore = onSnapshot(
      q,
      (snapshot) => {
        const records = snapshot.docs.map(
          (d) =>
            ({
              id: d.id,
              ...d.data({ serverTimestamps: 'estimate' }),
            } as RecordItem)
        );
        const currentSub = stageSubscriptions.get(stageId);
        if (currentSub) {
          currentSub.records = records;
          currentSub.listeners.forEach((cb) => {
            try {
              cb(records);
            } catch (err) {
              console.error('[useStageRecords] Callback error:', err);
            }
          });
        }
      },
      (error) => {
        console.warn(`[useStageRecords] Failed to listen to records for stage ${stageId}:`, error);
      }
    );

    sub = {
      records: [],
      listeners,
      unsubscribe: () => {
        unsubscribeFirestore();
        stageSubscriptions.delete(stageId);
      },
    };
    stageSubscriptions.set(stageId, sub);
  } else {
    sub.listeners.add(callback);
    if (sub.records.length > 0) {
      callback(sub.records);
    }
  }

  return () => {
    const currentSub = stageSubscriptions.get(stageId);
    if (!currentSub) return;
    currentSub.listeners.delete(callback);
    if (currentSub.listeners.size === 0) {
      currentSub.unsubscribe();
    }
  };
}

/**
 * Returns the active records for the target stage with a shared subscription cache.
 */
export function useStageRecords(customStageId?: string | null): RecordItem[] {
  const { effectiveStageId, isAuthenticated } = useStageContext();
  const targetStageId = customStageId || effectiveStageId;
  const [records, setRecords] = useState<RecordItem[]>(() => {
    if (!targetStageId) return [];
    return stageSubscriptions.get(targetStageId)?.records || [];
  });

  useEffect(() => {
    if (!targetStageId || !isAuthenticated) {
      setRecords([]);
      return;
    }

    const unsub = subscribeToStageRecords(targetStageId, (newRecords) => {
      setRecords(newRecords);
    });

    return unsub;
  }, [targetStageId, isAuthenticated]);

  return records;
}

/**
 * Returns true if the given lecture has at least one associated record.
 */
export function useLectureHasRecord(lecture: Lecture): boolean {
  const { effectiveStageId } = useStageContext();
  const targetStageId = lecture.stageId || effectiveStageId;
  const records = useStageRecords(targetStageId);

  return useMemo(() => {
    if (!records || records.length === 0) return false;
    return records.some((rec) => recordBelongsToLecture(rec, lecture, targetStageId || undefined));
  }, [records, lecture, targetStageId]);
}

