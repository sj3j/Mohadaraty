import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import 'fake-indexeddb/auto';
import { attendanceInstallation, signDeviceReceipt, signOfflineAttendanceQr } from '../src/services/attendanceCrypto';
import { commitAttendanceCapture, commitDoctorAttendanceSession, dbGet, getAttendanceReceipt, openDb, STORE_ATTENDANCE_COMMANDS, STORE_ATTENDANCE_OUTBOX, STORE_META } from '../src/lib/localDb';
import { parseUnverifiedAttendanceQr, type AttendanceMine, type AttendanceOfflinePermitClaims, type AttendanceQrClaims, type LocalAttendanceReceipt } from '../shared/attendance';
import { attendanceSessionId, verifyOfflineAttendanceToken } from '../shared/attendanceOffline';
import { verifyAttendanceDevice } from '../shared/attendanceDevice';
import { studentAttendanceRows } from '../shared/attendanceSchedule';
import { attendanceErrorResponse, canManageOccurrence } from '../shared/attendanceApi';
import { createAttendanceDoctorAdminHandlers, validateDoctorAssignments } from '../shared/attendanceDoctorAdmin';
import { createLatestDoctorListRefresher } from '../src/components/doctor/doctorAccountList';
import { matchEmergencyOccurrence, matchEmergencyStudent } from '../shared/attendanceEmergency';

process.env.ATTENDANCE_INSTALLATION_SECRET = 'test-only-installation-secret-that-is-long-enough';

test('emergency matching accepts only one exact lecture and one exact student', () => {
  const occurrence = { id: 'lecture-1', stageId: 'stage_3', lectureDate: '2026-10-25', startTime: '09:00', title: 'أخلاقيات الصيدلة' } as any;
  const draft = { stageId: 'stage_3', lectureTitle: 'اخلاقيات الصيدلة', lectureDate: '2026-10-25', startTime: '09:00' };
  assert.equal(matchEmergencyOccurrence(draft, [occurrence])?.id, occurrence.id);
  assert.equal(matchEmergencyOccurrence(draft, [occurrence, { ...occurrence, id: 'lecture-2' }]), null);
  const roster = [{ studentId: 'a', officialName: 'علي احمد', rosterIdentifier: 'C-123', subgroup: 'A' },
    { studentId: 'b', officialName: 'علي احمد', rosterIdentifier: 'C-456', subgroup: 'A' }];
  assert.equal(matchEmergencyStudent('C-123', roster)?.studentId, 'a');
  assert.equal(matchEmergencyStudent('علي أحمد', roster), null);
  assert.equal(matchEmergencyStudent('unknown', roster), null);
});

test('V2 offline QR omits the count while V1 receipts remain verifiable', async () => {
  const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKey = (await attendanceInstallation()).publicKey;
  const permit: AttendanceOfflinePermitClaims = { typ: 'simosan-offline-permit', id: crypto.randomUUID(), professorUid: 'doctor', stageId: 'stage_3', publicKey };
  const permitToken = jwt.sign(permit, signing.privateKey, { algorithm: 'ES256' });
  const occurrenceId = 'term:stage_3:2026-10-25:lecture';
  const base = { typ: 'simosan-attendance' as const, sessionId: attendanceSessionId(occurrenceId), challengeId: crypto.randomUUID(),
    occurrenceId, stageId: 'stage_3', lectureDate: '2026-10-25', title: 'Lecture', startTime: '09:00', endTime: '10:00' };
  const v2 = await signOfflineAttendanceQr(permitToken, { ...base, v: 2 });
  assert.equal(parseUnverifiedAttendanceQr(v2)?.expectedHeadcount, undefined);
  assert.equal(verifyOfflineAttendanceToken(v2, () => permit)?.claims.v, 2);
  const v1 = await signOfflineAttendanceQr(permitToken, { ...base, v: 1, expectedHeadcount: 60 });
  assert.equal(verifyOfflineAttendanceToken(v1, () => permit)?.claims.expectedHeadcount, 60);
});

test('an older lecturer list response cannot overwrite a newer refresh', async () => {
  const resolvers: Array<(value: { doctors: string[]; truncated: boolean }) => void> = [];
  const applied: string[][] = [];
  const refresh = createLatestDoctorListRefresher<string>(
    () => new Promise<{ doctors: string[]; truncated: boolean }>(resolve => resolvers.push(resolve)),
    result => applied.push(result.doctors),
  );

  const initial = refresh();
  const afterCreate = refresh();
  resolvers[1]({ doctors: ['ghazwan'], truncated: false });
  assert.equal((await afterCreate).applied, true);
  resolvers[0]({ doctors: [], truncated: false });
  assert.equal((await initial).applied, false);
  assert.deepEqual(applied, [['ghazwan']]);
});

test('an obsolete failed list request does not replace a successful refresh with an error', async () => {
  let rejectInitial!: (error: Error) => void;
  let calls = 0;
  const applied: string[][] = [];
  const refresh = createLatestDoctorListRefresher<string>(
    () => ++calls === 1 ? new Promise((_, reject) => { rejectInitial = reject; })
      : Promise.resolve({ doctors: ['ghazwan'], truncated: false }),
    result => applied.push(result.doctors),
  );
  const initial = refresh();
  await refresh();
  rejectInitial(new Error('old request failed'));
  assert.equal((await initial).applied, false);
  assert.deepEqual(applied, [['ghazwan']]);
});

test('a current failed list refresh preserves the list and reports failure', async () => {
  let fail = false;
  const applied: string[][] = [];
  const refresh = createLatestDoctorListRefresher<string>(async () => {
    if (fail) throw new Error('refresh failed');
    return { doctors: ['ghazwan'], truncated: false };
  }, result => applied.push(result.doctors));
  await refresh();
  fail = true;
  await assert.rejects(refresh(), /refresh failed/);
  assert.deepEqual(applied, [['ghazwan']]);
});

test('a missing Supabase attendance schema returns a deployable configuration error', () => {
  assert.deepEqual(
    attendanceErrorResponse({ code: 'PGRST205', message: "Could not find the table 'public.attendance_occurrences' in the schema cache" }),
    { status: 503, error: 'attendance_schema_missing' },
  );
  assert.deepEqual(attendanceErrorResponse({ code: '42P01', message: 'relation does not exist' }), {
    status: 503,
    error: 'attendance_schema_missing',
  });
});

test('doctor subject slots require explicit, non-overlapping stage timetable assignments', () => {
  const subjects = [{ id: 'subject-one', nameAr: 'الأول', nameEn: 'One' }, { id: 'subject-two', nameAr: 'الثاني', nameEn: 'Two' }];
  const slots = [{ id: 'slot-theory', kind: 'theory' }, { id: 'slot-practical', kind: 'practical' }];
  assert.deepEqual(validateDoctorAssignments([{ id: 'subject-one', type: 'theoretical', timetableSessionIds: ['slot-theory'] }], subjects, slots)[0].timetableSessionIds, ['slot-theory']);
  assert.throws(() => validateDoctorAssignments([{ id: 'subject-one', type: 'theoretical', timetableSessionIds: ['slot-practical'] }], subjects, slots));
  assert.throws(() => validateDoctorAssignments([
    { id: 'subject-one', type: 'both', timetableSessionIds: ['slot-theory'] },
    { id: 'subject-two', type: 'both', timetableSessionIds: ['slot-theory'] },
  ], subjects, slots));
});
test('retrying a completed lecturer creation returns the same account without provisioning again', async () => {
  const requestId = crypto.randomUUID();
  const uid = `attendance-doctor-${requestId}`;
  const subject = { id: 'subject', nameAr: 'Subject', nameEn: 'Subject' };
  const assignments = [{ ...subject, type: 'theoretical', timetableSessionIds: ['slot'] }];
  const body = { requestId, name: 'Lecturer', email: 'lecturer@example.com', password: 'test-only-password', stageId: 'stage', subjects: assignments };
  const profile = { name: body.name, email: body.email, stageId: body.stageId, subjects: assignments, timetableSessionIds: ['slot'] };
  const hash = crypto.createHash('sha256').update(JSON.stringify(profile))
    .update(crypto.scryptSync(body.password, requestId, 32).toString('hex')).digest('hex');
  const documents: Record<string, any> = {
    'users/master': { role: 'master_admin' }, 'stages/stage': {},
    'timetables/stage': { sessions: [{ id: 'slot', kind: 'theory' }] },
    [`attendanceDoctorCommands/${requestId}`]: { actorUid: 'master', hash, uid, status: 'complete' },
    [`attendanceDoctors/${uid}`]: { enabled: true },
  };
  const reference = (path: string) => ({ get: async () => ({ exists: path in documents, data: () => documents[path] }) });
  const database = {
    collection: (name: string) => ({ doc: (id: string) => reference(`${name}/${id}`),
      where: () => ({ get: async () => ({ docs: [{ id: subject.id, data: () => subject }] }) }),
    }),
    runTransaction: (run: any) => run({ get: (ref: any) => ref.get(), create: () => assert.fail('must not recreate command') }),
  };
  let enabled = 0;
  const admin = { firestore: () => database, auth: () => ({
    createUser: () => assert.fail('must not recreate Auth account'),
    updateUser: async (id: string) => { assert.equal(id, uid); enabled++; },
  }) };
  const handler = createAttendanceDoctorAdminHandlers({ admin }).create;
  const responses: any[] = [];
  const response = { status: (code: number) => { assert.fail(`unexpected HTTP ${code}`); }, json: (value: any) => responses.push(value) };
  await handler({ user: { uid: 'master' }, body }, response);
  await handler({ user: { uid: 'master' }, body }, response);
  assert.deepEqual(responses, [{ uid }, { uid }]);
  assert.equal(enabled, 2);
});

test('student token and client-supplied doctor role cannot provision lecturers', async () => {
  const admin = { firestore: () => ({ collection: (name: string) => {
    assert.equal(name, 'users');
    return { doc: () => ({ get: async () => ({ data: () => ({ role: 'student' }) }) }) };
  } }) };
  const handler = createAttendanceDoctorAdminHandlers({ admin }).create;
  let responseStatus = 0;
  await handler({ user: { uid: 'student', email: 'student@example.com', email_verified: false }, body: { role: 'doctor' } }, {
    status(code: number) { responseStatus = code; return this; }, json(value: any) { assert.equal(value.error, 'forbidden'); },
  });
  assert.equal(responseStatus, 403);
});
const serverKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const occurrenceId = 'term:stage_3:2026-10-15:theory';
const claims: AttendanceQrClaims = { v: 1, typ: 'simosan-attendance', sessionId: attendanceSessionId(occurrenceId), challengeId: crypto.randomUUID(), occurrenceId,
  stageId: 'stage_3', lectureDate: '2026-10-15', title: 'علم الأدوية — محاضرة نظرية', startTime: '09:00', endTime: '10:00', expectedHeadcount: 60 };

function receipt(sessionId: string): LocalAttendanceReceipt {
  return { requestId: crypto.randomUUID(), ownerUid: 'student', qrToken: 'signed-evidence', sessionId, occurrenceId, stageId: 'stage_3',
    occurrence: { id: occurrenceId, stageId: 'stage_3', lectureDate: '2026-10-15', title: 'Pharmacology', startTime: '09:00', endTime: '10:00' },
    installationId: 'installation', savedAt: 1, updatedAt: 1, status: 'pending', attemptCount: 0 };
}

test('offline lecturer credential is verifiable without either device clock', async () => {
  const installation = await attendanceInstallation();
  const permitClaims: AttendanceOfflinePermitClaims = { typ: 'simosan-offline-permit', id: crypto.randomUUID(), professorUid: 'doctor', stageId: 'stage_3', publicKey: installation.publicKey };
  const permit = jwt.sign(permitClaims, serverKeys.privateKey, { algorithm: 'ES256', noTimestamp: true });
  const token = await signOfflineAttendanceQr(permit, claims);
  assert.ok(Buffer.byteLength(token) <= 2330);
  assert.deepEqual(parseUnverifiedAttendanceQr(token), claims);
  const verifyPermit = (value: string) => jwt.verify(value, serverKeys.publicKey, { algorithms: ['ES256'] }) as AttendanceOfflinePermitClaims;
  const originalNow = Date.now;
  try {
    for (const hours of [-17520, -3, 3, 17520]) {
      Date.now = () => originalNow() + hours * 3600000;
      assert.deepEqual(verifyOfflineAttendanceToken(token, verifyPermit)?.claims, claims);
    }
  } finally { Date.now = originalNow; }
  const pieces = token.split('.');
  pieces[1] = Buffer.from(JSON.stringify({ ...claims, expectedHeadcount: 1000 })).toString('base64url');
  assert.throws(() => verifyOfflineAttendanceToken(pieces.join('.'), verifyPermit), /invalid_qr/);
  const foreign = await signOfflineAttendanceQr(permit, { ...claims, stageId: 'stage_4' });
  assert.throws(() => verifyOfflineAttendanceToken(foreign, verifyPermit), /invalid_qr/);
});

test('installation key persists across reopen and its signed receipt verifies server-side', async () => {
  const installation = await attendanceInstallation();
  assert.equal(installation.privateKey.extractable, false);
  const captured = { ...receipt('reopen-session'), installationId: installation.value, devicePublicKey: installation.publicKey };
  const signature = await signDeviceReceipt(installation, captured);
  const saved = await commitAttendanceCapture({ ...captured, deviceSignature: signature });
  const database = await openDb();
  database.onversionchange?.call(database, new IDBVersionChangeEvent('versionchange'));
  const reopened = await attendanceInstallation();
  assert.equal(reopened.value, installation.value);
  const restored = await getAttendanceReceipt<LocalAttendanceReceipt>(saved.receipt.requestId);
  assert.equal(restored?.deviceSignature, signature);
  assert.ok(verifyAttendanceDevice(restored).deviceDigest);
});

test('request success followed by abort never reports a durable receipt or keeps its lock', async () => {
  const captured = receipt('aborted-session');
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: any, key?: IDBValidKey) {
    const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    if (this.name === STORE_ATTENDANCE_OUTBOX) request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(commitAttendanceCapture(captured)); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal(await getAttendanceReceipt(captured.requestId), undefined);
  const replacement = await commitAttendanceCapture({ ...receipt('aborted-session'), ownerUid: 'other-student' });
  assert.equal(replacement.receipt.localDeviceConflict, false);
});

test('offline doctor session snapshot and import command commit together', async () => {
  const command = { requestId: crypto.randomUUID(), ownerUid: 'doctor', kind: 'import', input: { qrToken: 'immutable-code' } };
  await commitDoctorAttendanceSession({ key: 'offline-snapshot', data: { roster: ['Official name'] } }, command);
  assert.ok(await dbGet(STORE_META, 'offline-snapshot'));
  const saved = await dbGet<typeof command & { localOrder: number }>(STORE_ATTENDANCE_COMMANDS, command.requestId);
  assert.equal(saved?.input.qrToken, command.input.qrToken);
  assert.ok(saved!.localOrder > 0);
});

test('pending evidence creates its exact dated row before history is available', () => {
  const pending = receipt('schedule-session');
  const rows = studentAttendanceRows(null, [pending]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'pending');
  assert.equal(rows[0].occurrence.id, occurrenceId);
  const mine = { offline: false, occurrences: [], sessions: [{ id: pending.sessionId, occurrenceId, occurrence: { ...pending.occurrence, audienceGroups: [] }, status: 'finalized' }], records: [] } as unknown as AttendanceMine;
  assert.equal(studentAttendanceRows(mine, [pending])[0].state, 'pending');
  assert.equal(studentAttendanceRows(mine, [])[0].state, 'absent');
  assert.equal(studentAttendanceRows({ ...mine, offline: true }, [])[0].state, 'none');
  assert.equal(studentAttendanceRows({ ...mine, historyComplete: false }, [])[0].state, 'none');
});

test('doctor display role never grants access without an authoritative exact timetable assignment', () => {
  const occurrence: any = { stageId: 'stage_3', timetableSessionId: 'theory' };
  const actor: any = { uid: 'doctor', staff: { role: 'doctor', permissions: {}, staffDisabled: false }, student: null };
  assert.equal(canManageOccurrence(actor, occurrence), false);
  actor.doctor = { stageId: 'stage_3', timetableSessionIds: ['theory'] };
  assert.equal(canManageOccurrence(actor, occurrence), true);
  assert.equal(canManageOccurrence(actor, { ...occurrence, stageId: 'stage_4' }), false);
  assert.equal(canManageOccurrence(actor, { ...occurrence, timetableSessionId: 'practical' }), false);
});
