import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const database = new PGlite();
const sessions = Array.from({ length: 5 }, () => ({ id: randomUUID(), challenge: randomUUID(), tokenHash: 'c'.repeat(64) }));
const device = 'a'.repeat(64);
const sharedInstallation = 'b'.repeat(64);

before(async () => {
  await database.exec('create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;');
  for (const path of ['supabase/migrations/20261014083458_simosan_attendance_reliability.sql', 'supabase/migrations/20261015073458_attendance_device_policy.sql']) {
    await database.exec(readFileSync(path, 'utf8'));
  }
  await database.exec("insert into attendance_terms(id,calendar_term_id,year_label,name_ar,name_en,start_date,end_date) values ('term','term','2026','term','term','2026-01-01','2026-12-31');");
  for (const [index, session] of sessions.entries()) {
    await database.query("insert into attendance_occurrences(id,term_id,stage_id,timetable_session_id,lecture_date,title,start_at,end_at,audience_groups) values ($1,'term','stage_3',$1,'2026-10-15','Lecture',now(),now()+interval '1 hour',array['A'])", [`lecture-${index}`]);
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

async function review(receiptId: string, enrollDevice: boolean, requestId = randomUUID()) {
  const result = await database.query<{ result: any }>("select attendance_resolve_review($1,$2,'doctor','confirm','College ID checked',1,$3) as result", [requestId, receiptId, enrollDevice]);
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
      await assert.rejects(database.query('select attendance_receipt_result($1)', [randomUUID()]), /permission denied/);
    } finally {
      await database.exec('reset role');
    }
  }
});
