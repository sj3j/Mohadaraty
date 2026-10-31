import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttendanceMine, LocalAttendanceReceipt } from '../../../shared/attendance';
import { studentAttendanceRows } from '../../../shared/attendanceSchedule';
import { getMyAttendance, listLocalAttendanceReceipts, subscribeAttendanceChanges, syncAttendanceReceipts } from '../../services/attendanceService';

export function useStudentAttendance(ownerUid: string, subgroup?: string) {
  const [mine, setMine] = useState<AttendanceMine | null>(null);
  const [receipts, setReceipts] = useState<LocalAttendanceReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastSuccessfulSync, setLastSuccessfulSync] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const local = await listLocalAttendanceReceipts(ownerUid);
      if (current !== generation.current) return;
      setReceipts(local);
      const data = await getMyAttendance(ownerUid);
      const updated = await listLocalAttendanceReceipts(ownerUid);
      if (current !== generation.current) return;
      setMine(data);
      setReceipts(updated);
      setError(data.unavailableReason || '');
      if (!data.offline) setLastSuccessfulSync(new Date().toISOString());
    } catch (failure) {
      if (current === generation.current) setError(failure instanceof Error ? failure.message : 'attendance_unavailable');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [ownerUid]);
  useEffect(() => {
    setMine(null);
    setReceipts([]);
    setLoading(true);
    void refresh();
    const unsubscribe = subscribeAttendanceChanges(() => {
      void listLocalAttendanceReceipts(ownerUid).then(setReceipts).catch(() => undefined);
    });
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', foreground);
    const timer = window.setInterval(foreground, 120000);
    return () => {
      generation.current++;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [ownerUid, refresh]);
  const retry = async () => { await syncAttendanceReceipts(ownerUid); await refresh(); };
  const pendingCount = receipts.filter(receipt => ['pending', 'syncing', 'waiting_for_login', 'review'].includes(receipt.status)).length;
  return { mine, receipts, rows: studentAttendanceRows(mine, receipts, subgroup), loading, error, pendingCount, lastSuccessfulSync, refresh, retry };
}
