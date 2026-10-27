import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttendanceDoctorWorkspace, AttendanceSessionSnapshot, AttendanceRecordView } from '../../../shared/attendance';
import { parseUnverifiedAttendanceQr } from '../../../shared/attendance';
import {
  getDoctorAttendanceWorkspace, getAttendanceSessionSnapshot, getAttendanceSessionQr,
  ensureOfflineAttendancePrepared, createAttendanceSession, createOfflineAttendanceSession,
  updateAttendanceSession, markAttendanceManually, setAttendanceRecordStatus,
  listDoctorAttendanceCommands, subscribeAttendanceChanges, resolveAttendanceReview,
  type DoctorAttendanceCommand,
} from '../../services/attendanceService';
import { secureRequestId } from '../../lib/secureRandom';
import type { AttendanceCellStatus, StudentAttendanceRow } from './types';

export function useDoctorAttendance(ownerUid: string, isRtl: boolean, stageId?: string) {
  const [workspace, setWorkspace] = useState<AttendanceDoctorWorkspace | null>(null);
  const [snapshot, setSnapshot] = useState<AttendanceSessionSnapshot | null>(null);
  const [commands, setCommands] = useState<DoctorAttendanceCommand[]>([]);
  const [occurrenceId, selectOccurrence] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [offlineReady, setOfflineReady] = useState(false);
  const [offlineOccurrenceIds, setOfflineOccurrenceIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const actionRunning = useRef(false);
  const errorMessage = (failure: unknown) => {
    const raw = failure instanceof Error ? failure.message : String(failure || 'attendance_unavailable');
    const code = raw.replace(/^Error:\s*/, '').trim();

    if (code === 'attendance_schema_missing') {
      return isRtl
        ? 'قاعدة بيانات الحضور غير مكتملة الإعداد. يرجى التواصل مع مسؤول النظام.'
        : 'The attendance database setup is incomplete. Contact the system administrator.';
    }
    if (code === 'attendance_not_configured') {
      return isRtl
        ? 'خدمة الحضور غير مهيأة على الخادم. يرجى التواصل مع مسؤول النظام.'
        : 'The attendance service is not configured on the server. Contact the system administrator.';
    }
    if (code === 'manage_attendance_forbidden' || code === 'forbidden') {
      return isRtl
        ? 'ليس لديك صلاحية لإدارة الحضور لهذه المرحلة أو المواد. يرجى مراجعة مسؤول النظام.'
        : 'You do not have permission to manage attendance for this stage or subject. Contact the system administrator.';
    }
    if (code === 'no_active_academic_term') {
      return isRtl
        ? 'لا يوجد فصل دراسي نشط حالياً لتسجيل الحضور.'
        : 'There is no active academic term for attendance.';
    }
    if (code === 'attendance_request_failed') {
      return isRtl
        ? 'تعذر إتمام طلب الحضور. يرجى المحاولة مرة أخرى.'
        : 'The attendance request failed. Please try again.';
    }
    if (code === 'offline_setup_required') {
      return isRtl
        ? 'هذه المحاضرة غير مجهزة على الجهاز أو انتهى تصريح الأوفلاين. اتصل بالإنترنت أو احفظ مسودة حضور يدوية للطوارئ.'
        : 'This lecture is not prepared on this device or its offline permit has expired. Connect or save an emergency manual draft.';
    }
    if (code === 'Failed to fetch' || code.includes('NetworkError') || code === 'network_error' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      return isRtl
        ? 'تعذر الاتصال بالخادم. يرجى التحقق من اتصال الإنترنت أو استخدام الحزمة غير المتصلة.'
        : 'Cannot connect to the server. Check your internet connection or use the offline pack.';
    }
    return code;
  };
  const refresh = useCallback(async () => {
    const result = await getDoctorAttendanceWorkspace(ownerUid, stageId);
    const pack = await ensureOfflineAttendancePrepared(result.stageId, ownerUid);
    const savedCommands = await listDoctorAttendanceCommands(ownerUid);
    const savedSessions = await Promise.all(savedCommands.filter(command => command.kind === 'import').map(command =>
      getAttendanceSessionSnapshot(command.sessionId, ownerUid).then(data => data.session).catch(() => null)));
    const sessions = [...result.sessions];
    for (const session of savedSessions) if (session && !sessions.some(item => item.id === session.id)) sessions.push(session);
    if (!active.current) return;
    setWorkspace({ ...result, sessions });
    setCommands(savedCommands);
    setOfflineReady(!!pack);
    setOfflineOccurrenceIds(pack?.bootstrap.occurrences.map(item => item.id) || []);
    setError('');
  }, [ownerUid, stageId]);
  useEffect(() => {
    active.current = true;
    void refresh().catch(failure => setError(errorMessage(failure)));
    const reloadCommands = () => { void listDoctorAttendanceCommands(ownerUid).then(data => { if (active.current) setCommands(data); }).catch(failure => setError(errorMessage(failure))); };
    reloadCommands();
    const unsubscribe = subscribeAttendanceChanges(reloadCommands);
    return () => { active.current = false; unsubscribe(); };
  }, [ownerUid, refresh]);
  useEffect(() => {
    const online = () => { void refresh().catch(failure => setError(errorMessage(failure))); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [refresh]);
  const selectedSession = workspace?.sessions.find(session => session.occurrenceId === occurrenceId);
  const importedSessionId = commands.find(command => command.kind === 'import' && parseUnverifiedAttendanceQr(String(command.input.qrToken || ''))?.occurrenceId === occurrenceId)?.sessionId;
  const sessionId = selectedSession?.id || importedSessionId;
  useEffect(() => {
    let live = true;
    let fetching = false;
    setSnapshot(null);
    setQrToken(current => parseUnverifiedAttendanceQr(current)?.occurrenceId === occurrenceId ? current : '');
    const reload = async () => {
      if (!sessionId || fetching) return;
      fetching = true;
      try {
        const data = await getAttendanceSessionSnapshot(sessionId, ownerUid);
        if (live) {
          setSnapshot(data);
          if (data.session.status === 'active') {
            void getAttendanceSessionQr(sessionId, ownerUid).then(token => { if (live) setQrToken(token); }).catch(() => undefined);
          } else setQrToken('');
        }
      } catch (failure) { if (live) setError(errorMessage(failure)); }
      finally { fetching = false; }
    };
    void reload();
    const unsubscribe = subscribeAttendanceChanges(() => { void reload(); });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, 10000);
    return () => { live = false; unsubscribe(); window.clearInterval(timer); };
  }, [sessionId, occurrenceId, ownerUid]);
  const run = async (action: () => Promise<void>) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); actionRunning.current = false; }
  };
  const start = (physicalHeadcount: number | null = null) => run(async () => {
    if (!workspace || !occurrenceId) throw new Error('select_lecture');
    if (physicalHeadcount != null && (!Number.isInteger(physicalHeadcount) || physicalHeadcount < 0 || physicalHeadcount > 10000)) throw new Error('invalid_headcount');
    const input = { stageId: workspace.stageId, occurrenceId, physicalHeadcount };
    const result = workspace.offline || (offlineReady && offlineOccurrenceIds.includes(occurrenceId))
      ? await createOfflineAttendanceSession(input, ownerUid)
      : await createAttendanceSession({ ...input, notes: '', requestId: secureRequestId() });
    const data = await getAttendanceSessionSnapshot(result.sessionId, ownerUid);
    if (data.session.status !== 'active') throw new Error('session_not_editable');
    setWorkspace(current => current ? { ...current, sessions: [...current.sessions.filter(session => session.id !== data.session.id), data.session] } : current);
    setSnapshot(data);
    setQrToken(result.qrToken);
    setCommands(await listDoctorAttendanceCommands(ownerUid));
  });
  const saveSession = (patch: Record<string, unknown>) => run(async () => {
    if (!snapshot) throw new Error('select_active_session');
    await updateAttendanceSession(snapshot.session.id, { ...patch, requestId: secureRequestId(), expectedRevision: snapshot.session.revision }, ownerUid);
    const updated = await getAttendanceSessionSnapshot(snapshot.session.id, ownerUid);
    setSnapshot(updated);
    setWorkspace(current => current ? { ...current, sessions: current.sessions.map(session => session.id === updated.session.id ? updated.session : session) } : current);
    if (patch.status === 'ended') setQrToken('');
  });
  const refreshQr = () => run(async () => {
    if (!sessionId) throw new Error('select_active_session');
    const token = await getAttendanceSessionQr(sessionId, ownerUid);
    setQrToken(token);
  });
  const records = [...(workspace?.records || []).filter(record => record.sessionId !== snapshot?.session.id), ...(snapshot?.records || [])];
  const sessions = [...(workspace?.sessions || []).filter(session => session.id !== snapshot?.session.id), ...(snapshot ? [snapshot.session] : [])];
  const students: StudentAttendanceRow[] = (workspace?.roster || []).map(student => {
    const attendance: StudentAttendanceRow['attendance'] = {};
    const studentRecords: Record<string, AttendanceRecordView> = {};
    for (const session of sessions) {
      const record = records.find(item => item.sessionId === session.id && item.rosterStudentId === student.studentId);
      const queued = commands.find(command => (!command.kind || command.kind === 'manual') && command.sessionId === session.id && command.input.studentId === student.studentId && command.status !== 'synced');
      if (record) {
        studentRecords[session.occurrenceId] = record;
        attendance[session.occurrenceId] = record.status === 'confirmed' ? 'present' : 'voided';
      }
      else if (queued) attendance[session.occurrenceId] = 'pending';
      else if (!workspace?.offline && session.status === 'finalized' && (!session.occurrence.audienceGroups.length || session.occurrence.audienceGroups.includes(student.subgroup))) attendance[session.occurrenceId] = 'absent';
    }
    return { studentId: student.studentId, name: student.officialName, group: student.subgroup, examCode: student.rosterIdentifier, attendance, records: studentRecords };
  });
  const updateCell = (studentId: string, targetOccurrenceId: string, status: AttendanceCellStatus, customReason?: string) => run(async () => {
    const defaultReason = status === 'present'
      ? (isRtl ? 'تسجيل يدوي بواسطة التدريسي' : 'Manual check-in by lecturer')
      : (isRtl ? 'إلغاء يدوي بواسطة التدريسي' : 'Manual void by lecturer');
    const reason = (customReason || defaultReason).trim();
    let session = sessions.find(item => item.occurrenceId === targetOccurrenceId);
    if (!session) {
      if (!workspace) throw new Error('attendance_workspace_unavailable');
      const input = { stageId: workspace.stageId, occurrenceId: targetOccurrenceId, physicalHeadcount: null };
      const created = workspace.offline || (offlineReady && offlineOccurrenceIds.includes(targetOccurrenceId))
        ? await createOfflineAttendanceSession(input, ownerUid)
        : await createAttendanceSession({ ...input, notes: '', requestId: secureRequestId() });
      const data = await getAttendanceSessionSnapshot(created.sessionId, ownerUid);
      session = data.session;
      setWorkspace(current => current ? { ...current, sessions: [...current.sessions, data.session] } : current);
    }
    const record = records.find(item => item.sessionId === session.id && item.rosterStudentId === studentId);
    if (status === 'present' && !record) await markAttendanceManually(session.id, { studentId, reason, expectedRevision: session.revision, requestId: secureRequestId() }, ownerUid);
    else if (record) await setAttendanceRecordStatus(record.id, status === 'present' ? 'restore' : 'void', { reason, expectedRevision: record.revision, requestId: secureRequestId() });
    const data = await getAttendanceSessionSnapshot(session.id, ownerUid);
    setWorkspace(current => current ? { ...current, records: [...current.records.filter(item => item.sessionId !== session.id), ...data.records] } : current);
    if (session.id === snapshot?.session.id) setSnapshot(data);
    setCommands(await listDoctorAttendanceCommands(ownerUid));
  });
  const review = (requestId: string, enrollDevice: boolean, decision: 'confirm' | 'reject', allowLateConfirmation?: boolean) => run(async () => {
    if (!snapshot) return;
    const reason = window.prompt(isRtl ? 'سبب القرار والتحقق من هوية الطالب:' : 'Decision reason and identity check:')?.trim();
    const targetReceipt = snapshot.reviewReceipts.find(r => r.requestId === requestId);
    await resolveAttendanceReview(requestId, { decision, reason, enrollDevice, allowLateConfirmation: allowLateConfirmation === true, expectedRevision: targetReceipt?.reviewRevision || 1, requestId: secureRequestId() });
    setSnapshot(await getAttendanceSessionSnapshot(snapshot.session.id, ownerUid));
  });
  return { workspace, snapshot, commands, occurrenceId, selectOccurrence, qrToken, offlineReady, error, busy, start, saveSession, refreshQr, students, updateCell, review, refresh: () => run(refresh) };
}
