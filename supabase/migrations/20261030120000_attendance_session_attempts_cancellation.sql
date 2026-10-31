-- Audited cancellation and repeatable attempts for a scheduled lecture.
-- Cancelled attempts remain queryable, while only one non-cancelled attempt
-- may exist for an occurrence at a time.

alter table public.attendance_sessions
  add column if not exists attempt_generation integer not null default 1,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_occurrence_id_key;

create unique index if not exists attendance_sessions_current_occurrence_idx
  on public.attendance_sessions (occurrence_id)
  where status <> 'cancelled';

create unique index if not exists attendance_sessions_occurrence_generation_idx
  on public.attendance_sessions (occurrence_id, attempt_generation);

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_attempt_generation_check;
alter table public.attendance_sessions
  add constraint attendance_sessions_attempt_generation_check check (attempt_generation > 0);

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_cancellation_reason_check;
alter table public.attendance_sessions
  add constraint attendance_sessions_cancellation_reason_check check (
    cancellation_reason is null or char_length(cancellation_reason) between 1 and 1000
  );

alter table public.attendance_offline_grants
  add column if not exists attempt_generations jsonb not null default '{}'::jsonb;

-- Once cancelled, the session row is immutable. The cancellation update itself
-- is allowed because the old status is not yet cancelled.
create or replace function public.attendance_fixed_deadline()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    select end_at + interval '36 hours' into strict new.reconciliation_deadline
      from public.attendance_occurrences where id = new.occurrence_id;
  else
    if old.status = 'cancelled' then
      raise exception using errcode = '22023', message = 'session_cancelled';
    end if;
    new.reconciliation_deadline := old.reconciliation_deadline;
    if new.occurrence_id <> old.occurrence_id then raise exception 'invalid_occurrence_change'; end if;
    if old.status = 'ended' and new.status = 'active' then raise exception 'session_not_editable'; end if;
  end if;
  return new;
end;
$$;

-- A retry for evidence acknowledged before cancellation must report the audited
-- cancellation, not reinterpret the now-voided record as reviewable evidence.
create or replace function public.attendance_receipt_result(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_receipt public.attendance_receipts%rowtype;
  v_record public.attendance_records%rowtype;
  v_cancelled boolean := false;
begin
  select * into strict v_receipt from public.attendance_receipts where request_id = p_request_id;
  select * into v_record from public.attendance_records
    where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
  select status = 'cancelled' into v_cancelled from public.attendance_sessions where id = v_receipt.session_id;
  return jsonb_build_object(
    'requestId', p_request_id,
    'resolution', case when v_cancelled then 'invalid_evidence' when v_record.status = 'voided' then 'needs_review' when v_record.status = 'confirmed' then 'confirmed' else v_receipt.resolution end,
    'reason', case when v_cancelled then 'session_cancelled' when v_record.status = 'voided' then 'record_voided' else v_receipt.reason end,
    'recordId', v_record.id,
    'recordStatus', v_record.status,
    'revision', v_record.revision,
    'reviewRevision', v_receipt.review_revision,
    'receivedAt', v_receipt.received_at,
    'reviewFlags', v_receipt.review_flags
  );
end;
$$;

-- Preserve the established public signature. The implementation now serializes
-- creation per occurrence and assigns the next generation after cancellation.
create or replace function public.attendance_create_session(
  p_term jsonb, p_occurrence jsonb, p_session jsonb, p_roster jsonb, p_challenge jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_session_id uuid := (p_session->>'id')::uuid;
  v_request_id uuid := (p_session->>'requestId')::uuid;
  v_occurrence_id text := p_occurrence->>'id';
  v_existing public.attendance_sessions%rowtype;
  v_qr_token text;
  v_generation integer;
  v_requested_generation integer := nullif(p_session->>'attemptGeneration', '')::integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('attendance-occurrence:' || v_occurrence_id, 0));

  select * into v_existing from public.attendance_sessions where request_id = v_request_id;
  if found then
    if v_existing.occurrence_id <> v_occurrence_id then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    select qr_token into v_qr_token from public.attendance_challenges
      where session_id = v_existing.id order by issued_at desc limit 1;
    return jsonb_build_object('sessionId', v_existing.id, 'revision', v_existing.revision,
      'status', v_existing.status, 'qrToken', v_qr_token, 'existing', true,
      'attemptGeneration', v_existing.attempt_generation);
  end if;

  select * into v_existing from public.attendance_sessions
    where occurrence_id = v_occurrence_id and status <> 'cancelled'
    order by attempt_generation desc limit 1;
  if found then
    select qr_token into v_qr_token from public.attendance_challenges
      where session_id = v_existing.id and revoked_at is null order by issued_at desc limit 1;
    return jsonb_build_object('sessionId', v_existing.id, 'revision', v_existing.revision,
      'status', v_existing.status, 'qrToken', v_qr_token, 'existing', true,
      'attemptGeneration', v_existing.attempt_generation);
  end if;

  select coalesce(max(attempt_generation), 0) + 1 into v_generation
    from public.attendance_sessions where occurrence_id = v_occurrence_id;
  if v_requested_generation is not null and v_requested_generation <> v_generation then
    raise exception using errcode = '40001', message = 'attendance_attempt_conflict';
  end if;

  insert into public.attendance_terms (
    id, calendar_term_id, year_label, name_ar, name_en, start_date, end_date, timezone
  ) values (
    p_term->>'id', p_term->>'calendarTermId', p_term->>'yearLabel', p_term->>'nameAr',
    p_term->>'nameEn', (p_term->>'startDate')::date, (p_term->>'endDate')::date,
    coalesce(p_term->>'timezone', 'Asia/Baghdad')
  ) on conflict (id) do update set name_ar = excluded.name_ar, name_en = excluded.name_en,
    end_date = excluded.end_date;

  insert into public.attendance_occurrences (
    id, term_id, stage_id, timetable_session_id, mode, lecture_date, title,
    start_at, end_at, audience_groups, location, teacher
  ) values (
    v_occurrence_id, p_occurrence->>'termId', p_occurrence->>'stageId',
    p_occurrence->>'timetableSessionId', coalesce(p_occurrence->>'mode', 'other'),
    (p_occurrence->>'lectureDate')::date, p_occurrence->>'title',
    (p_occurrence->>'startAt')::timestamptz, (p_occurrence->>'endAt')::timestamptz,
    array(select jsonb_array_elements_text(coalesce(p_occurrence->'audienceGroups', '[]'::jsonb))),
    nullif(p_occurrence->>'location', ''), nullif(p_occurrence->>'teacher', '')
  ) on conflict (id) do nothing;

  insert into public.attendance_sessions (
    id, request_id, occurrence_id, professor_uid, expected_headcount, notes,
    status, reconciliation_deadline, attempt_generation
  ) values (
    v_session_id, v_request_id, v_occurrence_id, p_session->>'professorUid',
    (p_session->>'expectedHeadcount')::integer, coalesce(p_session->>'notes', ''),
    'active', (p_session->>'reconciliationDeadline')::timestamptz, v_generation
  );

  insert into public.attendance_session_roster (
    session_id, roster_student_id, official_name, roster_identifier, subgroup
  ) select v_session_id, item->>'studentId', item->>'officialName',
      coalesce(item->>'rosterIdentifier', ''), coalesce(item->>'subgroup', '')
    from jsonb_array_elements(coalesce(p_roster, '[]'::jsonb)) item;

  insert into public.attendance_challenges (id, session_id, token_hash, qr_token, key_id)
    values ((p_challenge->>'id')::uuid, v_session_id, p_challenge->>'tokenHash',
      p_challenge->>'qrToken', p_challenge->>'keyId');

  insert into public.attendance_audit_events (
    request_id, session_id, actor_uid, action, after_state
  ) values (
    v_request_id, v_session_id, p_session->>'professorUid', 'session_created',
    jsonb_build_object('occurrenceId', v_occurrence_id,
      'physicalHeadcount', p_session->'physicalHeadcount', 'attemptGeneration', v_generation)
  );

  return jsonb_build_object('sessionId', v_session_id, 'revision', 1, 'status', 'active',
    'qrToken', p_challenge->>'qrToken', 'existing', false,
    'attemptGeneration', v_generation);
end;
$$;

create or replace function public.attendance_cancel_session(
  p_request_id uuid, p_session_id uuid, p_actor_uid text,
  p_expected_revision bigint, p_reason text
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_before jsonb;
  v_audit public.attendance_audit_events%rowtype;
begin
  if p_reason is null or char_length(trim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'invalid_reason';
  end if;
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'session_cancel',
    p_session_id::text, jsonb_build_object('reason', trim(p_reason)));
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    select * into v_session from public.attendance_sessions where id = p_session_id;
    return jsonb_build_object('session', to_jsonb(v_session), 'existing', true);
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception using errcode = '22023', message = 'unknown_session'; end if;
  if v_session.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'revision_conflict';
  end if;
  if v_session.status = 'cancelled' then
    raise exception using errcode = '22023', message = 'session_cancelled';
  end if;

  v_before := to_jsonb(v_session);
  update public.attendance_challenges set revoked_at = coalesce(revoked_at, now()),
    revocation_reason = coalesce(revocation_reason, 'session_cancelled')
    where session_id = p_session_id;
  update public.attendance_records set status = 'voided', decided_at = now(),
    review_flags = array(select distinct flag from unnest(review_flags || array['session_cancelled']) flag),
    revision = revision + 1 where session_id = p_session_id and status <> 'voided';
  update public.attendance_receipts set resolution = 'invalid_evidence', reason = 'session_cancelled',
    review_flags = array(select distinct flag from unnest(review_flags || array['session_cancelled']) flag)
    where session_id = p_session_id;
  update public.attendance_offline_grants set revoked_at = coalesce(revoked_at, now())
    where revoked_at is null and occurrences ? v_session.occurrence_id;
  update public.attendance_sessions set status = 'cancelled', cancelled_at = now(),
    cancellation_reason = trim(p_reason), ended_at = coalesce(ended_at, now()), revision = revision + 1
    where id = p_session_id returning * into v_session;

  insert into public.attendance_audit_events (
    request_id, session_id, actor_uid, action, reason, before_state, after_state
  ) values (p_request_id, p_session_id, p_actor_uid, 'session_cancelled', trim(p_reason),
    v_before, to_jsonb(v_session));
  return jsonb_build_object('session', to_jsonb(v_session), 'existing', false);
end;
$$;

revoke execute on function public.attendance_cancel_session(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.attendance_cancel_session(uuid, uuid, text, bigint, text)
  to service_role;

