import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttendanceDoctorWorkspace, AttendanceSessionSnapshot, AttendanceRecordView } from '../../../shared/attendance';
import { parseUnverifiedAttendanceQr } from '../../../shared/attendance';
import {
  getDoctorAttendanceWorkspace, getAttendanceSessionSnapshot, getOfflineAttendancePack,
  prepareOfflineAttendance, createAttendanceSession, createOfflineAttendanceSession,
  updateAttendanceSession, markAttendanceManually, setAttendanceRecordStatus,
  listDoctorAttendanceCommands, subscribeAttendanceChanges, resolveAttendanceReview,
  type DoctorAttendanceCommand,
} from '../../services/attendanceService';
import type { AttendanceCellStatus, StudentAttendanceRow } from './types';

export function useDoctorAttendance(ownerUid: string, isRtl: boolean, stageId?: string) {
  const [workspace, setWorkspace] = useState<AttendanceDoctorWorkspace | null>(null);
  const [snapshot, setSnapshot] = useState<AttendanceSessionSnapshot | null>(null);
  const [commands, setCommands] = useState<DoctorAttendanceCommand[]>([]);
  const [occurrenceId, selectOccurrence] = useState('');
  const [qrToken, setQrToken] = useState('');
  const [offlineReady, setOfflineReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const actionRunning = useRef(false);
  const errorMessage = (failure: unknown) => {
    const code = failure instanceof Error ? failure.message : 'attendance_unavailable';
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
    return code;
  };
  const refresh = useCallback(async () => {
    const result = await getDoctorAttendanceWorkspace(ownerUid, stageId);
    const pack = await getOfflineAttendancePack(ownerUid, result.stageId);
    if (!active.current) return;
    setWorkspace(result);
    setOfflineReady(!!pack);
  }, [ownerUid, stageId]);
  useEffect(() => {
    active.current = true;
    void refresh().catch(failure => setError(errorMessage(failure)));
    const reloadCommands = () => { void listDoctorAttendanceCommands(ownerUid).then(data => { if (active.current) setCommands(data); }).catch(failure => setError(errorMessage(failure))); };
    reloadCommands();
    const unsubscribe = subscribeAttendanceChanges(reloadCommands);
    return () => { active.current = false; unsubscribe(); };
  }, [ownerUid, refresh]);
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
        if (live) setSnapshot(data);
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
  const prepare = () => run(async () => {
    if (!workspace) return;
    await prepareOfflineAttendance(workspace.stageId, ownerUid);
    setOfflineReady(true);
  });
  const start = (expectedHeadcount: number) => run(async () => {
    if (!workspace || !occurrenceId) throw new Error('select_lecture');
    if (!Number.isInteger(expectedHeadcount) || expectedHeadcount < 1) throw new Error('invalid_headcount');
    const input = { stageId: workspace.stageId, occurrenceId, expectedHeadcount };
    const result = offlineReady
      ? await createOfflineAttendanceSession(input, ownerUid)
      : await createAttendanceSession({ ...input, notes: '', requestId: crypto.randomUUID() });
    const data = await getAttendanceSessionSnapshot(result.sessionId, ownerUid);
    if (data.session.status !== 'active') throw new Error('session_not_editable');
    setWorkspace(current => current ? { ...current, sessions: [...current.sessions.filter(session => session.id !== data.session.id), data.session] } : current);
    setSnapshot(data);
    setQrToken(result.qrToken);
    setCommands(await listDoctorAttendanceCommands(ownerUid));
  });
  const saveSession = (patch: Record<string, unknown>) => run(async () => {
    if (!snapshot) throw new Error('select_active_session');
    await updateAttendanceSession(snapshot.session.id, { ...patch, requestId: crypto.randomUUID(), expectedRevision: snapshot.session.revision }, ownerUid);
    setSnapshot(await getAttendanceSessionSnapshot(snapshot.session.id, ownerUid));
    if (patch.status === 'ended') setQrToken('');
  });
  const records = [...(workspace?.records || []).filter(record => record.sessionId !== snapshot?.session.id), ...(snapshot?.records || [])];
  const sessions = [...(workspace?.sessions || []).filter(session => session.id !== snapshot?.session.id), ...(snapshot ? [snapshot.session] : [])];
  const students: StudentAttendanceRow[] = (workspace?.roster || []).map(student => {
    const attendance: StudentAttendanceRow['attendance'] = {};
    for (const session of sessions) {
      const record = records.find(item => item.sessionId === session.id && item.rosterStudentId === student.studentId);
      const queued = commands.find(command => (!command.kind || command.kind === 'manual') && command.sessionId === session.id && command.input.studentId === student.studentId && command.status !== 'synced');
      if (record) attendance[session.occurrenceId] = record.status === 'confirmed' ? 'present' : 'voided';
      else if (queued) attendance[session.occurrenceId] = 'pending';
      else if (!workspace?.offline && session.status === 'finalized' && (!session.occurrence.audienceGroups.length || session.occurrence.audienceGroups.includes(student.subgroup))) attendance[session.occurrenceId] = 'absent';
    }
    return { studentId: student.studentId, name: student.officialName, group: student.subgroup, examCode: student.rosterIdentifier, attendance };
  });
  const updateCell = (studentId: string, targetOccurrenceId: string, status: AttendanceCellStatus) => run(async () => {
    const reason = window.prompt(isRtl ? 'سبب التعديل (يسجل في سجل التدقيق):' : 'Reason for correction (audited):')?.trim();
    if (!reason) return;
    let session = sessions.find(item => item.occurrenceId === targetOccurrenceId);
    if (!session) {
      if (!workspace) throw new Error('attendance_workspace_unavailable');
      const value = window.prompt(isRtl ? 'كم طالباً حضر فعلياً لهذه المحاضرة؟' : 'How many students were physically present for this lecture?');
      if (value == null) return;
      const expectedHeadcount = Number(value);
      if (!Number.isInteger(expectedHeadcount) || expectedHeadcount < 1 || expectedHeadcount > 10000) throw new Error('invalid_headcount');
      const input = { stageId: workspace.stageId, occurrenceId: targetOccurrenceId, expectedHeadcount };
      const created = offlineReady
        ? await createOfflineAttendanceSession(input, ownerUid)
        : await createAttendanceSession({ ...input, notes: '', requestId: crypto.randomUUID() });
      const data = await getAttendanceSessionSnapshot(created.sessionId, ownerUid);
      session = data.session;
      setWorkspace(current => current ? { ...current, sessions: [...current.sessions, data.session] } : current);
    }
    const record = records.find(item => item.sessionId === session.id && item.rosterStudentId === studentId);
    if (status === 'present' && !record) await markAttendanceManually(session.id, { studentId, reason, expectedRevision: session.revision, requestId: crypto.randomUUID() }, ownerUid);
    else if (record) await setAttendanceRecordStatus(record.id, status === 'present' ? 'restore' : 'void', { reason, expectedRevision: record.revision, requestId: crypto.randomUUID() });
    const data = await getAttendanceSessionSnapshot(session.id, ownerUid);
    setWorkspace(current => current ? { ...current, records: [...current.records.filter(item => item.sessionId !== session.id), ...data.records] } : current);
    if (session.id === snapshot?.session.id) setSnapshot(data);
    setCommands(await listDoctorAttendanceCommands(ownerUid));
  });
  const review = (requestId: string, enrollDevice: boolean, decision: 'confirm' | 'reject') => run(async () => {
    if (!snapshot) return;
    const reason = window.prompt(isRtl ? 'سبب القرار والتحقق من هوية الطالب:' : 'Decision reason and identity check:')?.trim();
    if (!reason) return;
    await resolveAttendanceReview(requestId, { decision, reason, enrollDevice, expectedRevision: snapshot.session.revision, requestId: crypto.randomUUID() });
    setSnapshot(await getAttendanceSessionSnapshot(snapshot.session.id, ownerUid));
  });
  return { workspace, snapshot, commands, occurrenceId, selectOccurrence, qrToken, offlineReady, error, busy, prepare, start, saveSession, students, updateCell, review, refresh: () => run(refresh) };
}
