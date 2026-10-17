import crypto from 'node:crypto';
import { isMasterAdminEmail } from './masterAdmins.js';
import type { AttendanceDoctorSubject } from './attendance.js';

export function validateDoctorAssignments(input: unknown, subjects: any[], sessions: any[]): AttendanceDoctorSubject[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) throw new Error('invalid_subject_assignments');
  const usedSubjects = new Set<string>();
  const usedSessions = new Set<string>();
  return input.map(item => {
    const subject = subjects.find(candidate => candidate.id === item?.id);
    if (!subject || usedSubjects.has(subject.id) || !['theoretical', 'practical', 'both'].includes(item.type)
      || !Array.isArray(item.timetableSessionIds) || !item.timetableSessionIds.length || item.timetableSessionIds.length > 100) throw new Error('invalid_subject_assignments');
    if (Array.isArray(subject.types) && subject.types.length && (
      (item.type === 'theoretical' && !subject.types.includes('theoretical'))
      || (item.type === 'practical' && !subject.types.includes('practical'))
      || (item.type === 'both' && (!subject.types.includes('theoretical') || !subject.types.includes('practical')))
    )) throw new Error('invalid_subject_mode');
    usedSubjects.add(subject.id);
    const ids = item.timetableSessionIds.map((id: unknown) => {
      const session = sessions.find(candidate => candidate.id === id);
      if (!session || usedSessions.has(session.id) || (item.type !== 'both' && session.kind !== (item.type === 'theoretical' ? 'theory' : 'practical'))
        || (Array.isArray(subject.types) && subject.types.length && !subject.types.includes(session.kind === 'theory' ? 'theoretical' : session.kind))) throw new Error('invalid_timetable_assignment');
      usedSessions.add(session.id);
      return session.id;
    });
    return { id: subject.id, nameAr: String(subject.nameAr || ''), nameEn: String(subject.nameEn || subject.nameAr || ''), type: item.type, timetableSessionIds: ids };
  });
}

export function createAttendanceDoctorAdminHandlers({ admin }: { admin: any }) {
  const db = () => admin.firestore();
  async function requireMaster(req: any) {
    const token = req.user || {};
    if (!token.uid) throw Object.assign(new Error('forbidden'), { status: 403 });
    const profile = await db().collection('users').doc(token.uid).get();
    const data = profile.data() || {};
    const master = token.email_verified === true && isMasterAdminEmail(token.email);
    if (data.staffDisabled === true || !(master || data.role === 'master_admin' || data.isMasterAdmin === true)) throw Object.assign(new Error('forbidden'), { status: 403 });
  }
  const handle = (action: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
    try { await requireMaster(req); await action(req, res); }
    catch (failure: any) {
      const code = String(failure?.code || failure?.message || 'doctor_request_failed');
      const known = /^(invalid_|unknown_|idempotency_|account_|auth\/email-already-exists)/.test(code);
      res.status(failure?.status || (known ? 400 : 503)).json({ error: known || failure?.status === 403 ? code : 'doctor_request_failed' });
    }
  };
  async function options(stageId: string) {
    if (!stageId || stageId.includes('/') || stageId.length > 100) throw new Error('invalid_stage');
    const [stage, subjects, timetable] = await Promise.all([
      db().collection('stages').doc(stageId).get(),
      db().collection('subjects').where('stageId', '==', stageId).get(),
      db().collection('timetables').doc(stageId).get(),
    ]);
    if (!stage.exists) throw new Error('unknown_stage');
    return {
      subjects: subjects.docs.map((doc: any) => ({ ...doc.data(), id: doc.data().id || doc.id })).filter((subject: any) => subject.isActive !== false),
      sessions: timetable.data()?.sessions || [],
    };
  }
  return {
    options: handle(async (req, res) => { res.json(await options(String(req.query.stageId || ''))); }),
    list: handle(async (_req, res) => {
      const result = await db().collection('attendanceDoctors').orderBy('name').limit(201).get();
      res.json({ doctors: result.docs.slice(0, 200).map((doc: any) => ({ uid: doc.id, ...doc.data() })), truncated: result.size > 200 });
    }),
    create: handle(async (req, res) => {
      const input = req.body || {};
      const name = String(input.name || '').trim();
      const email = String(input.email || '').trim().toLowerCase();
      const password = String(input.password || '');
      if (!/^[0-9a-f-]{36}$/i.test(input.requestId || '') || name.length < 3 || name.length > 150
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
        || password.length < 12 || password.length > 128) throw new Error('invalid_doctor_account');
      const stageId = String(input.stageId || '');
      const available = await options(stageId);
      const subjects = validateDoctorAssignments(input.subjects, available.subjects, available.sessions);
      const uid = `attendance-doctor-${input.requestId}`;
      const profile = { name, email, stageId, subjects, timetableSessionIds: subjects.flatMap(subject => subject.timetableSessionIds) };
      const passwordVerifier = crypto.scryptSync(password, input.requestId, 32).toString('hex');
      const hash = crypto.createHash('sha256').update(JSON.stringify(profile)).update(passwordVerifier).digest('hex');
      const commandRef = db().collection('attendanceDoctorCommands').doc(input.requestId);
      const command = await db().runTransaction(async (transaction: any) => {
        const existing = await transaction.get(commandRef);
        if (existing.exists) {
          if (existing.data().actorUid !== req.user.uid || existing.data().hash !== hash) throw new Error('idempotency_conflict');
          return existing.data();
        }
        transaction.create(commandRef, { actorUid: req.user.uid, hash, uid, status: 'pending', createdAt: new Date().toISOString() });
        return { status: 'pending' };
      });
      if (command.status === 'complete') {
        const authorization = await db().collection('attendanceDoctors').doc(uid).get();
        if (authorization.data()?.enabled === true) await admin.auth().updateUser(uid, { disabled: false });
        res.json({ uid }); return;
      }
      const slotRefs = subjects.flatMap(subject => subject.timetableSessionIds.map(slotId => ({ subjectId: subject.id,
        ref: db().collection('attendanceSubjectSlots').doc(crypto.createHash('sha256').update(stageId).update('\0').update(slotId).digest('hex')),
      })));
      const claimed = await Promise.all(slotRefs.map(slot => slot.ref.get()));
      if (claimed.some((slot, index) => slot.exists && slot.data().subjectId !== slotRefs[index].subjectId)) throw new Error('invalid_timetable_assignment');
      try { await admin.auth().createUser({ uid, email, password, displayName: name, disabled: true }); }
      catch (failure: any) {
        if (!['auth/uid-already-exists', 'auth/email-already-exists'].includes(failure?.code)) throw failure;
        const existing = await admin.auth().getUserByEmail(email);
        if (existing.uid !== uid) throw new Error('account_email_already_used');
      }
      await db().runTransaction(async (transaction: any) => {
        const current = await transaction.get(commandRef);
        if (current.data()?.status === 'complete') return;
        const slots = subjects.flatMap(subject => subject.timetableSessionIds.map(slotId => ({ subject, slotId,
          ref: db().collection('attendanceSubjectSlots').doc(crypto.createHash('sha256').update(stageId).update('\0').update(slotId).digest('hex')),
        })));
        const existingSlots = await Promise.all(slots.map(slot => transaction.get(slot.ref)));
        for (let index = 0; index < slots.length; index++) {
          if (existingSlots[index].exists && existingSlots[index].data().subjectId !== slots[index].subject.id) throw new Error('invalid_timetable_assignment');
        }
        for (const slot of slots) transaction.set(slot.ref, {
          stageId, timetableSessionId: slot.slotId, subjectId: slot.subject.id,
          nameAr: slot.subject.nameAr, nameEn: slot.subject.nameEn, type: slot.subject.type,
        });
        transaction.set(db().collection('users').doc(uid), { uid, name, email, role: 'doctor', stageId, assignedStageId: stageId, assignedSubjects: subjects, staffDisabled: false, permissions: {} });
        transaction.set(db().collection('attendanceDoctors').doc(uid), { ...profile, enabled: true, createdBy: req.user.uid, createdAt: new Date().toISOString() });
        transaction.update(commandRef, { status: 'complete', completedAt: new Date().toISOString() });
      });
      await admin.auth().updateUser(uid, { disabled: false });
      res.json({ uid });
    }),
    disable: handle(async (req, res) => {
      const uid = String(req.params.uid || '');
      if (!uid || uid.includes('/')) throw new Error('invalid_doctor');
      const ref = db().collection('attendanceDoctors').doc(uid);
      await db().runTransaction(async (transaction: any) => {
        const current = await transaction.get(ref);
        if (!current.exists) throw new Error('unknown_doctor');
        transaction.update(ref, { enabled: false });
        transaction.update(db().collection('users').doc(uid), { staffDisabled: true });
        transaction.create(db().collection('attendanceDoctorAudit').doc(), { actorUid: req.user.uid, doctorUid: uid, action: 'disable', createdAt: new Date().toISOString() });
      });
      await admin.auth().updateUser(uid, { disabled: true });
      await admin.auth().revokeRefreshTokens(uid);
      res.json({ disabled: true });
    }),
  };
}
