import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { attendanceSessionId } from '../shared/attendanceOffline';

const database = new PGlite();
const sessions: Array<{ id: string; challenge: string; tokenHash: string }> = Array.from({ length: 8 }, () => ({ id: randomUUID(), challenge: randomUUID(), tokenHash: 'c'.repeat(64) }));
const device = 'a'.repeat(64);
const sharedInstallation = 'b'.repeat(64);

before(async () => {
  await database.exec('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  for (const path of [
    'supabase/migrations/20261014083458_simosan_attendance_reliability.sql',
    'supabase/migrations/20261015073458_attendance_device_policy.sql',
    'supabase/migrations/20261015155756_attendance_offline_sessions.sql',
    'supabase/migrations/20261018160000_attendance_late_receipts_key_rotation.sql',
  ]) {
    try {
      await database.exec(readFileSync(path, 'utf8'));
    } catch (error: any) {
      throw new Error(`${path}: ${error.message} (position ${error.position || 'unknown'})`);
    }
  }
  await database.exec("insert into attendance_terms(id,calendar_term_id,year_label,name_ar,name_en,start_date,end_date) values ('term','term','2026','term','term','2026-01-01','2026-12-31');");
  for (const [index, session] of sessions.entries()) {
    await database.query("insert into attendance_occurrences(id,term_id,stage_id,timetable_session_id,lecture_date,title,start_at,end_at,audience_groups) values ($1,'term','stage_3',$1,'2026-10-15','Lecture',now(),now()+interval '1 hour',array['A'])", [`lecture-${index}`]);
    if (index === 5) await database.query("update attendance_occurrences set start_at=now()-interval '38 hours',end_at=now()-interval '37 hours' where id=$1", [`lecture-${index}`]);
    await database.query("insert into attendance_sessions(id,request_id,occurrence_id,professor_uid,expected_headcount,reconciliation_deadline) values ($1,$2,$3,'doctor',1,now()+interval '7 days')", [session.id, randomUUID(), `lecture-${index}`]);
    for (const [student, subgroup] of [['student-a', 'A'], ['student-b', 'B']]) {
      await database.query('insert into attendance_session_roster(session_id,roster_student_id,official_name,subgroup) values ($1,$2,$2,$3)', [session.id, student, subgroup]);
    }
    await database.query("insert into attendance_challenges(id,session_id,token_hash,qr_token,key_id) values ($1,$2,$3,$4,'test')", [session.challenge, session.id, createHash('sha256').update(session.id).digest('hex'), 'fixture.'.repeat(12)]);
    session.tokenHash = createHash('sha256').update(session.id).digest('hex');
  }
});
after(async () => { await database.close(); });

function input(sessionIndex: number, student = 'student-a', installation: string | null = sharedInstallation, enrolledDevice: string | null = device) {
  return { requestId: randomUUID(), sessionIndex, student, installation, enrolledDevice };
}

async function submit(receipt: ReturnType<typeof input>, flags: string[] = []) {
  const session = sessions[receipt.sessionIndex];
  const result = await database.query<{ result: any }>('select attendance_submit_receipt($1,$2,$3,$4,$5,$6,$7,$8,null,$9,false,$10) as result', [
    receipt.requestId, receipt.student, receipt.student, createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), session.id,
    session.challenge, session.tokenHash, receipt.installation, receipt.enrolledDevice, JSON.stringify({ flags, timingConfidence: 'unknown' }),
  ]);
  return result.rows[0].result;
}

async function review(receiptId: string, enrollDevice: boolean, requestId = randomUUID(), allowLateConfirmation = false) {
  const result = await database.query<{ result: any }>("select attendance_resolve_review($1,$2,'doctor','confirm','College ID checked',1,$3,$4) as result", [requestId, receiptId, enrollDevice, allowLateConfirmation]);
  return result.rows[0].result;
}

test('first device requires supervised enrollment; subsequent lectures work', async () => {
  const first = input(0);
  assert.equal((await submit(first)).reason, 'device_enrollment_required');
  await assert.rejects(review(first.requestId, false), /device_enrollment_required/);
  assert.equal((await review(first.requestId, true)).recordStatus, 'confirmed');
  for (const sessionIndex of [1, 2]) assert.equal((await submit(input(sessionIndex))).resolution, 'confirmed');
  const count = await database.query<{ total: number }>("select count(*)::int total from attendance_records where roster_student_id='student-a'");
  assert.equal(count.rows[0].total, 3);
});

test('second student on the same installation requires manual attendance, even after void', async () => {
  const second = input(0, 'student-b');
  assert.equal((await submit(second)).reason, 'device_session_conflict');
  await assert.rejects(review(second.requestId, true), /device_conflict_requires_manual_attendance/);
  const first = await database.query<{ review_flags: string[] }>('select review_flags from attendance_records where session_id=$1', [sessions[0].id]);
  assert.ok(first.rows[0].review_flags.includes('shared_installation'));
  await database.query("update attendance_records set status='voided',revision=revision+1 where session_id=$1", [sessions[0].id]);
  assert.equal((await submit(input(0, 'student-b'))).reason, 'device_session_conflict');
  const manual = await database.query<{ result: any }>("select attendance_manual_record($1,$2,'doctor','student-b','Phone battery empty; ID checked',1) result", [randomUUID(), sessions[0].id]);
  assert.equal(manual.rows[0].result.record.entry_method, 'manual');
  assert.equal((await submit(second)).recordStatus, 'confirmed');
});

test('retries return current voided state without restoring attendance', async () => {
  const receipt = input(3);
  await submit(receipt);
  await database.query("update attendance_records set status='voided',revision=revision+1 where session_id=$1", [sessions[3].id]);
  const results = await Promise.all(Array.from({ length: 10 }, () => submit(receipt)));
  assert.ok(results.every(result => result.recordStatus === 'voided'));
  const count = await database.query<{ total: number }>('select count(*)::int total from attendance_records where session_id=$1', [sessions[3].id]);
  assert.equal(count.rows[0].total, 1);
});

test('GPS and reconnect warnings do not block an approved device', async () => {
  assert.equal((await submit(input(4), ['reported_off_campus', 'rapid_reconnect', 'location_permission_unavailable'])).resolution, 'confirmed');
  const result = await database.query<{ review_flags: string[] }>('select review_flags from attendance_records where session_id=$1', [sessions[4].id]);
  assert.ok(result.rows[0].review_flags.includes('reported_off_campus'));
});

test('another phone cannot acquire trust just by logging in', async () => {
  const changed = input(1, 'student-a', 'd'.repeat(64), 'e'.repeat(64));
  await submit(changed);
  const pending = await database.query<{ reason: string }>('select reason from attendance_receipts where request_id=$1', [changed.requestId]);
  assert.equal(pending.rows[0].reason, 'device_change_required');
  await assert.rejects(review(changed.requestId, false), /device_enrollment_required/);
});

test('full roster retains visitors without making them expected absentees', async () => {
  const result = await database.query<{ expected_attendee: boolean }>("select expected_attendee from attendance_session_roster where session_id=$1 and roster_student_id='student-b'", [sessions[2].id]);
  assert.equal(result.rows[0].expected_attendee, false);
  const legacy = input(2, 'student-b', null, null);
  assert.equal((await submit(legacy)).reason, 'device_unverified');
});

test('anonymous and authenticated browser roles cannot read or invoke attendance', async () => {
  for (const role of ['anon', 'authenticated']) {
    await database.exec(`set role ${role}`);
    try {
      await assert.rejects(database.query('select * from attendance_enrolled_devices'), /permission denied/);
      await assert.rejects(database.query('select * from attendance_offline_grants'), /permission denied/);
      await assert.rejects(database.query('select attendance_receipt_result($1)', [randomUUID()]), /permission denied/);
    } finally {
      await database.exec('reset role');
    }
  }
});

test('36-hour deadline is fixed to scheduled end and closure never extends it', async () => {
  await database.query("update attendance_sessions set status='ended',reconciliation_deadline=now()+interval '7 days' where id=$1", [sessions[5].id]);
  const deadline = await database.query<{ fixed: boolean }>("select session.reconciliation_deadline=occurrence.end_at+interval '36 hours' as fixed from attendance_sessions session join attendance_occurrences occurrence on occurrence.id=session.occurrence_id where session.id=$1", [sessions[5].id]);
  assert.equal(deadline.rows[0].fixed, true);
  const late = input(5);
  const lateResult = await submit(late);
  assert.equal(lateResult.reason, 'late_arrival');
  assert.equal(lateResult.resolution, 'needs_review');
  await assert.rejects(review(late.requestId, true, randomUUID(), false), /late_receipt_requires_explicit_confirmation/);
  const lateReviewed = await review(late.requestId, true, randomUUID(), true);
  assert.equal(lateReviewed.recordStatus, 'confirmed');
  const result = await database.query<{ result: any }>("select attendance_manual_record($1,$2,'doctor','student-b','Independent lecturer evidence',1) result", [randomUUID(), sessions[5].id]);
  assert.equal(result.rows[0].result.record.entry_method, 'manual');
});

test('receipt committed at exact deadline is eligible; acknowledged retry after deadline survives', async () => {
  await database.exec('begin');
  const receipt = input(6);
  try {
    await database.query("update attendance_occurrences set end_at=now()-interval '36 hours',start_at=now()-interval '37 hours' where id='lecture-6'");
    await database.exec('alter table attendance_sessions disable trigger attendance_fixed_deadline');
    await database.query('update attendance_sessions set reconciliation_deadline=now() where id=$1', [sessions[6].id]);
    await database.exec('alter table attendance_sessions enable trigger attendance_fixed_deadline');
    assert.equal((await submit(receipt)).resolution, 'confirmed');
    await database.exec('commit');
  } catch (error) { await database.exec('rollback'); throw error; }
  assert.equal((await submit(receipt)).recordStatus, 'confirmed');
  assert.equal((await submit(input(6, 'student-b'))).reason, 'late_arrival');
});

test('review uses receipt arrival, not professor review time', async () => {
  const timely = input(7, 'student-b', 'f'.repeat(64), 'f'.repeat(64));
  assert.equal((await submit(timely)).reason, 'device_enrollment_required');
  await database.exec('alter table attendance_sessions disable trigger attendance_fixed_deadline');
  await database.query('update attendance_sessions set reconciliation_deadline=(select received_at from attendance_receipts where request_id=$1) where id=$2', [timely.requestId, sessions[7].id]);
  await database.exec('alter table attendance_sessions enable trigger attendance_fixed_deadline');
  assert.equal((await review(timely.requestId, true)).recordStatus, 'confirmed');
});

test('student-first upload imports an authorized offline session atomically and preserves its fixed deadline', async () => {
  const grantId = randomUUID();
  const occurrenceId = 'offline-first-upload';
  const sessionId = attendanceSessionId(occurrenceId);
  const occurrence = { id: occurrenceId, termId: 'term', stageId: 'stage_3', timetableSessionId: 'theory', mode: 'theory', lectureDate: '2026-10-15', title: 'Offline lecture',
    startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), audienceGroups: ['A'] };
  const term = { id: 'term', calendarTermId: 'term', yearLabel: '2026', nameAr: 'term', nameEn: 'term', startDate: '2026-01-01', endDate: '2026-12-31' };
  const roster = [{ studentId: 'student-a', officialName: 'Verified roster name', subgroup: 'A' }, { studentId: 'student-b', officialName: 'Visiting student', subgroup: 'B' }];
  await database.query("insert into attendance_offline_grants(id,professor_uid,stage_id,token_hash,term,occurrences,roster,session_ids) values ($1,'doctor','stage_3',$2,$3,$4,$5,$6)", [
    grantId, 'a'.repeat(64), JSON.stringify(term), JSON.stringify({ [occurrenceId]: occurrence }), JSON.stringify(roster), JSON.stringify({ [occurrenceId]: sessionId }),
  ]);
  const challenge = randomUUID();
  const importSession = (challengeId = challenge, tokenHash = 'b'.repeat(64), requestedSession = sessionId) => database.query<{ result: any }>('select attendance_import_offline_session($1,$2,$3,$4,$5,$6,$7,60) result', [grantId, 'a'.repeat(64), occurrenceId, requestedSession, challengeId, 'signed.offline.token.'.repeat(4), tokenHash]);
  await assert.rejects(importSession(challenge, 'b'.repeat(64), randomUUID()), /invalid_offline_occurrence/);
  assert.equal((await importSession()).rows[0].result.sessionId, sessionId);
  assert.equal((await database.query<{ mode: string }>('select mode from attendance_occurrences where id=$1', [occurrenceId])).rows[0].mode, 'theory');
  const index = sessions.push({ id: sessionId, challenge, tokenHash: 'b'.repeat(64) }) - 1;
  assert.equal((await submit(input(index))).resolution, 'confirmed');
  await importSession();
  const nextChallenge = randomUUID();
  await importSession(nextChallenge, 'c'.repeat(64));
  await assert.rejects(importSession(nextChallenge, 'd'.repeat(64)), /invalid_challenge/);
  const deadline = await database.query<{ value: string }>('select reconciliation_deadline::text value from attendance_sessions where id=$1', [sessionId]);
  assert.equal(Date.parse(deadline.rows[0].value), Date.parse(occurrence.endAt) + 36 * 3600000);
  const names = await database.query<{ official_name: string }>('select official_name from attendance_session_roster where session_id=$1 order by roster_student_id', [sessionId]);
  assert.equal(names.rows[0].official_name, 'Verified roster name');
  await database.query('update attendance_offline_grants set revoked_at=now() where id=$1', [grantId]);
  await assert.rejects(importSession(randomUUID()), /invalid_offline_grant/);
});

test('session edits are idempotent without being invalidated by student uploads', async () => {
  const session = sessions[2];
  const before = await database.query<{ revision: number }>('select revision from attendance_sessions where id=$1', [session.id]);
  await submit(input(2));
  const command = randomUUID();
  const update = (notes: string, actor = 'doctor') => database.query<{ result: any }>("select attendance_update_session($1,$2,$3,$4,null,$5,null,'') result", [command, session.id, actor, before.rows[0].revision, notes]);
  await update('Saved notes');
  assert.equal((await update('Saved notes')).rows[0].result.existing, true);
  await assert.rejects(update('Changed payload'), /idempotency_conflict/);
  await assert.rejects(update('Saved notes', 'another-doctor'), /idempotency_conflict/);
});

test('key rotation preserves enrolled device identity and resolves alias to canonical device', async () => {
  const nonce = 'n'.repeat(32);
  const challengeResult = await database.query<{ id: string }>(
    "select attendance_create_key_rotation_challenge('student-a', $1) as id",
    [nonce]
  );
  const challengeId = challengeResult.rows[0].id;
  assert.ok(challengeId);

  const newDevice = 'c'.repeat(64);
  const commitResult = await database.query<{ result: any }>(
    "select attendance_commit_key_rotation($1, 'student-a', 'student-a', $2, $3, $4) as result",
    [challengeId, device, newDevice, JSON.stringify({ nonce, rotatedAt: new Date().toISOString() })]
  );
  assert.equal(commitResult.rows[0].result.rotated, true);
  assert.equal(commitResult.rows[0].result.canonicalDeviceDigest, device);

  // Submitting with rotated alias device succeeds as confirmed without requiring new device enrollment
  const receiptWithRotatedKey = input(2, 'student-a', sharedInstallation, newDevice);
  assert.equal((await submit(receiptWithRotatedKey)).resolution, 'confirmed');

  // Challenge cannot be reused
  await assert.rejects(
    database.query(
      "select attendance_commit_key_rotation($1, 'student-a', 'student-a', $2, $3, $4) as result",
      [challengeId, device, newDevice, JSON.stringify({})]
    ),
    /challenge_already_consumed/
  );
});

