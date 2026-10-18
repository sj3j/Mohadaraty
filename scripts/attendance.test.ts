import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import {
  ATTENDANCE_QR_VERSION,
  attendanceWeekStart,
  buildAttendanceOccurrences,
  canonicalAttendanceState,
  parseUnverifiedAttendanceQr,
  type AttendanceQrClaims,
  type LocalAttendanceReceipt,
} from '../shared/attendance';
import { signAttendanceQr, verifyAttendanceQr } from '../shared/attendanceApi';
import { DEFAULT_CALENDAR } from '../shared/academicCalendar';
import type { StageTimetableDoc } from '../shared/timetable';

let failed = 0;
const check = (name: string, test: () => void) => {
  try {
    test();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL  ${name}`, error);
  }
};

const timetable: StageTimetableDoc = {
  stageId: 'stage_3',
  sessions: [{
    id: 'physiology-1', day: 0, start: '09:00', end: '10:30', title: 'Physiology I',
    kind: 'theory', groups: [], source: 'human',
  }],
};

const occurrences = buildAttendanceOccurrences(DEFAULT_CALENDAR, timetable, 'stage_3', '2026-10-14', 0, 0);
check('dated occurrence comes from explicit server date', () => {
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].lectureDate, '2026-10-11');
  assert.equal(occurrences[0].startAt, '2026-10-11T06:00:00.000Z');
  assert.match(occurrences[0].id, /2026-10-11:physiology-1$/);
});
check('Saturday week boundary is deterministic', () => {
  assert.equal(attendanceWeekStart('2026-10-14'), '2026-10-10');
  assert.equal(attendanceWeekStart('2026-10-10'), '2026-10-10');
});

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.ATTENDANCE_QR_PRIVATE_KEY = privateKey;
process.env.ATTENDANCE_QR_KEY_ID = 'test-key';
process.env.ATTENDANCE_QR_PUBLIC_KEYS_JSON = JSON.stringify({ 'test-key': publicKey });

const claims: AttendanceQrClaims = {
  v: ATTENDANCE_QR_VERSION,
  typ: 'simosan-attendance',
  sessionId: crypto.randomUUID(),
  challengeId: crypto.randomUUID(),
  occurrenceId: occurrences[0].id,
  stageId: 'stage_3',
  lectureDate: occurrences[0].lectureDate,
  title: occurrences[0].title,
  startTime: occurrences[0].startTime,
  endTime: occurrences[0].endTime,
};
const signed = signAttendanceQr(claims);

check('QR contains no client-clock expiry decision', () => {
  const decoded = jwt.decode(signed) as any;
  assert.equal(decoded.exp, undefined);
  assert.equal(decoded.iat, undefined);
  assert.deepEqual(verifyAttendanceQr(signed), claims);
});
check('clock shifts of years do not affect verification', () => {
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() - 2 * 365 * 86_400_000;
    assert.deepEqual(verifyAttendanceQr(signed), claims);
    Date.now = () => originalNow() + 2 * 365 * 86_400_000;
    assert.deepEqual(verifyAttendanceQr(signed), claims);
  } finally {
    Date.now = originalNow;
  }
});
check('tampered QR is rejected while local parsing remains only a hint', () => {
  assert.deepEqual(parseUnverifiedAttendanceQr(signed), claims);
  const pieces = signed.split('.');
  pieces[1] = `${pieces[1].slice(0, -2)}aa`;
  assert.throws(() => verifyAttendanceQr(pieces.join('.')));
});

const pending: LocalAttendanceReceipt = {
  requestId: crypto.randomUUID(), ownerUid: 'student-1', qrToken: signed,
  sessionId: claims.sessionId, occurrenceId: claims.occurrenceId, stageId: claims.stageId,
  occurrence: { id: claims.occurrenceId, stageId: claims.stageId, lectureDate: claims.lectureDate, title: claims.title, startTime: claims.startTime, endTime: claims.endTime },
  installationId: crypto.randomUUID(), savedAt: 1, updatedAt: 1, status: 'pending', attemptCount: 0,
};
check('durable pending evidence outranks absence rendering', () => {
  assert.equal(canonicalAttendanceState(undefined, pending), 'pending');
  assert.equal(canonicalAttendanceState({
    id: 'record', sessionId: claims.sessionId, rosterStudentId: 'student-1', officialName: 'Student',
    entryMethod: 'qr', status: 'confirmed', receivedAt: '', decidedAt: '', reviewFlags: [], revision: 1,
  }, pending), 'confirmed');
});

const root = path.resolve(import.meta.dirname, '..');
const localDb = fs.readFileSync(path.join(root, 'src/lib/localDb.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/attendanceService.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014083458_simosan_attendance_reliability.sql'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const production = fs.readFileSync(path.join(root, 'api/index.ts'), 'utf8');

check('attendance IndexedDB acknowledgement waits for transaction completion', () => {
  assert.match(localDb, /durability:\s*'strict'/);
  assert.match(localDb, /tx\.oncomplete\s*=\s*\(\)\s*=>/);
  assert.doesNotMatch(service, /elapsedSeconds/);
});
check('retryable backend failures return receipts to pending', () => {
  assert.match(service, /'retry_later'/);
  assert.match(service, /authFailure \? 'waiting_for_login' : 'pending'/);
  assert.match(service, /missing_acknowledgement/);
});
check('Supabase is gateway-only and uses atomic idempotency constraints', () => {
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /revoke all on table public\.attendance_receipts from public, anon, authenticated/);
  assert.match(migration, /unique \(session_id, roster_student_id\)/);
  assert.match(migration, /attendance_resolve_review/);
  assert.doesNotMatch(migration, /now\(\) \+ interval '7 days'/);
  assert.match(migration, /shared_installation/);
});
check('development and production expose identical attendance routes and correct middleware order', () => {
  const routes = (source: string) => [...source.matchAll(/app\.(?:get|post|patch)\('([^']*attendance[^']*)'/g)].map(match => match[1]).sort();
  assert.deepEqual(routes(server), routes(production));
  assert.equal(routes(server).length, 18);
  assert.ok(routes(server).includes('/api/attendance/admin/readiness'));

  for (const [name, source] of [['server', server], ['production', production]] as const) {
    const middlewareIndex = source.indexOf("app.use('/api/attendance', (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store');");
    const firstRouteIndex = source.indexOf("app.get('/api/attendance/admin/readiness'");
    assert.ok(middlewareIndex !== -1, `${name} must contain private, no-store middleware`);
    assert.ok(firstRouteIndex !== -1, `${name} must contain readiness endpoint`);
    assert.ok(middlewareIndex < firstRouteIndex, `${name} middleware must precede first attendance route`);
  }
});

console.log(`\n${failed ? 'FAILED' : 'OK'} (${failed} failures)`);
process.exit(failed ? 1 : 0);
