-- Simosan attendance is accessed only through the Firebase-authenticated HTTP
-- gateway. Browser roles receive no table or function privileges.

create table public.attendance_terms (
  id text primary key,
  calendar_term_id text not null,
  year_label text not null,
  name_ar text not null,
  name_en text not null,
  start_date date not null,
  end_date date not null,
  timezone text not null default 'Asia/Baghdad',
  created_at timestamptz not null default now(),
  constraint attendance_terms_id_length check (char_length(id) between 1 and 200),
  constraint attendance_terms_dates check (end_date >= start_date),
  constraint attendance_terms_timezone check (timezone = 'Asia/Baghdad')
);

create table public.attendance_occurrences (
  id text primary key,
  term_id text not null references public.attendance_terms(id) on delete restrict,
  stage_id text not null,
  timetable_session_id text not null,
  lecture_date date not null,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  audience_groups text[] not null default '{}',
  location text,
  teacher text,
  cancelled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint attendance_occurrences_id_length check (char_length(id) between 1 and 512),
  constraint attendance_occurrences_stage_length check (char_length(stage_id) between 1 and 100),
  constraint attendance_occurrences_title_length check (char_length(title) between 1 and 500),
  constraint attendance_occurrences_time_order check (end_at > start_at)
);

create index attendance_occurrences_stage_date_idx
  on public.attendance_occurrences (stage_id, lecture_date, start_at);
create index attendance_occurrences_term_id_idx
  on public.attendance_occurrences (term_id);

create table public.attendance_sessions (
  id uuid primary key,
  request_id uuid not null unique,
  occurrence_id text not null unique references public.attendance_occurrences(id) on delete restrict,
  professor_uid text not null,
  expected_headcount integer not null,
  notes text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  finalized_at timestamptz,
  reconciliation_deadline timestamptz not null,
  revision bigint not null default 1,
  constraint attendance_sessions_headcount check (expected_headcount between 1 and 10000),
  constraint attendance_sessions_notes_length check (char_length(notes) <= 2000),
  constraint attendance_sessions_status check (status in ('active', 'ended', 'finalized', 'cancelled')),
  constraint attendance_sessions_revision check (revision > 0)
);

create index attendance_sessions_professor_created_idx
  on public.attendance_sessions (professor_uid, created_at desc);
create index attendance_sessions_status_deadline_idx
  on public.attendance_sessions (status, reconciliation_deadline);

create table public.attendance_session_roster (
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  roster_student_id text not null,
  official_name text not null,
  roster_identifier text not null default '',
  subgroup text not null default '',
  primary key (session_id, roster_student_id),
  constraint attendance_roster_id_length check (char_length(roster_student_id) between 1 and 320),
  constraint attendance_roster_name_length check (char_length(official_name) between 1 and 300),
  constraint attendance_roster_identifier_length check (char_length(roster_identifier) <= 100),
  constraint attendance_roster_subgroup_length check (char_length(subgroup) <= 30)
);

create index attendance_session_roster_name_idx
  on public.attendance_session_roster (session_id, official_name);

create table public.attendance_challenges (
  id uuid primary key,
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  token_hash text not null unique,
  qr_token text not null,
  key_id text not null,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz,
  revocation_reason text,
  constraint attendance_challenges_hash_length check (char_length(token_hash) = 64),
  constraint attendance_challenges_token_length check (char_length(qr_token) between 32 and 4096),
  constraint attendance_challenges_key_length check (char_length(key_id) between 1 and 100),
  constraint attendance_challenges_revoke_reason_length check (
    revocation_reason is null or char_length(revocation_reason) <= 500
  )
);

create index attendance_challenges_session_idx
  on public.attendance_challenges (session_id, issued_at desc);

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.attendance_sessions(id) on delete restrict,
  roster_student_id text not null,
  student_uid text not null,
  official_name_snapshot text not null,
  entry_method text not null,
  status text not null default 'confirmed',
  received_at timestamptz not null default now(),
  decided_at timestamptz not null default now(),
  client_reported_at timestamptz,
  scan_time_confidence text not null default 'unknown',
  installation_digest text,
  review_flags text[] not null default '{}',
  revision bigint not null default 1,
  constraint attendance_records_unique_student unique (session_id, roster_student_id),
  constraint attendance_records_roster_fk foreign key (session_id, roster_student_id)
    references public.attendance_session_roster(session_id, roster_student_id) on delete restrict,
  constraint attendance_records_method check (entry_method in ('qr', 'manual')),
  constraint attendance_records_status check (status in ('confirmed', 'voided')),
  constraint attendance_records_confidence check (scan_time_confidence = 'unknown'),
  constraint attendance_records_name_length check (char_length(official_name_snapshot) between 1 and 300),
  constraint attendance_records_installation_length check (
    installation_digest is null or char_length(installation_digest) = 64
  ),
  constraint attendance_records_revision check (revision > 0)
);

create index attendance_records_student_session_idx
  on public.attendance_records (roster_student_id, session_id);
create index attendance_records_session_received_idx
  on public.attendance_records (session_id, received_at, id);
create index attendance_records_installation_idx
  on public.attendance_records (session_id, installation_digest)
  where installation_digest is not null;

create table public.attendance_receipts (
  request_id uuid primary key,
  session_id uuid not null references public.attendance_sessions(id) on delete restrict,
  challenge_id uuid not null references public.attendance_challenges(id) on delete restrict,
  actor_uid text not null,
  roster_student_id text,
  payload_hash text not null,
  installation_digest text,
  received_at timestamptz not null default now(),
  resolution text not null,
  reason text not null,
  record_id uuid references public.attendance_records(id) on delete set null,
  constraint attendance_receipts_hash_length check (char_length(payload_hash) = 64),
  constraint attendance_receipts_resolution check (
    resolution in ('confirmed', 'already_recorded', 'needs_review', 'invalid_evidence')
  ),
  constraint attendance_receipts_reason_length check (char_length(reason) between 1 and 100),
  constraint attendance_receipts_installation_length check (
    installation_digest is null or char_length(installation_digest) = 64
  )
);

create index attendance_receipts_actor_received_idx
  on public.attendance_receipts (actor_uid, received_at desc);
create index attendance_receipts_session_resolution_idx
  on public.attendance_receipts (session_id, resolution, received_at);
create index attendance_receipts_record_id_idx
  on public.attendance_receipts (record_id)
  where record_id is not null;

create table public.attendance_audit_events (
  id bigint generated always as identity primary key,
  request_id uuid unique,
  session_id uuid not null references public.attendance_sessions(id) on delete restrict,
  record_id uuid references public.attendance_records(id) on delete set null,
  actor_uid text not null,
  action text not null,
  reason text not null default '',
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now(),
  constraint attendance_audit_action_length check (char_length(action) between 1 and 100),
  constraint attendance_audit_reason_length check (char_length(reason) <= 1000)
);

create index attendance_audit_session_created_idx
  on public.attendance_audit_events (session_id, created_at desc, id desc);
create index attendance_audit_record_created_idx
  on public.attendance_audit_events (record_id, created_at desc)
  where record_id is not null;

alter table public.attendance_terms enable row level security;
alter table public.attendance_occurrences enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.attendance_session_roster enable row level security;
alter table public.attendance_challenges enable row level security;
alter table public.attendance_records enable row level security;
alter table public.attendance_receipts enable row level security;
alter table public.attendance_audit_events enable row level security;

revoke all on table public.attendance_terms from public, anon, authenticated;
revoke all on table public.attendance_occurrences from public, anon, authenticated;
revoke all on table public.attendance_sessions from public, anon, authenticated;
revoke all on table public.attendance_session_roster from public, anon, authenticated;
revoke all on table public.attendance_challenges from public, anon, authenticated;
revoke all on table public.attendance_records from public, anon, authenticated;
revoke all on table public.attendance_receipts from public, anon, authenticated;
revoke all on table public.attendance_audit_events from public, anon, authenticated;
revoke all on sequence public.attendance_audit_events_id_seq from public, anon, authenticated;

grant select, insert, update on table public.attendance_terms to service_role;
grant select, insert, update on table public.attendance_occurrences to service_role;
grant select, insert, update on table public.attendance_sessions to service_role;
grant select, insert on table public.attendance_session_roster to service_role;
grant select, insert, update on table public.attendance_challenges to service_role;
grant select, insert, update on table public.attendance_records to service_role;
grant select, insert, update on table public.attendance_receipts to service_role;
grant select, insert on table public.attendance_audit_events to service_role;
grant usage, select on sequence public.attendance_audit_events_id_seq to service_role;

create or replace function public.attendance_create_session(
  p_term jsonb,
  p_occurrence jsonb,
  p_session jsonb,
  p_roster jsonb,
  p_challenge jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_session_id uuid := (p_session->>'id')::uuid;
  v_request_id uuid := (p_session->>'requestId')::uuid;
  v_occurrence_id text := p_occurrence->>'id';
  v_existing public.attendance_sessions%rowtype;
  v_qr_token text;
begin
  select * into v_existing
  from public.attendance_sessions
  where request_id = v_request_id;

  if found then
    if v_existing.occurrence_id <> v_occurrence_id then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    select qr_token into v_qr_token
    from public.attendance_challenges
    where session_id = v_existing.id
    order by issued_at desc
    limit 1;
    return jsonb_build_object(
      'sessionId', v_existing.id,
      'revision', v_existing.revision,
      'status', v_existing.status,
      'qrToken', v_qr_token,
      'existing', true
    );
  end if;

  insert into public.attendance_terms (
    id, calendar_term_id, year_label, name_ar, name_en,
    start_date, end_date, timezone
  ) values (
    p_term->>'id', p_term->>'calendarTermId', p_term->>'yearLabel',
    p_term->>'nameAr', p_term->>'nameEn',
    (p_term->>'startDate')::date, (p_term->>'endDate')::date,
    coalesce(p_term->>'timezone', 'Asia/Baghdad')
  )
  on conflict (id) do update set
    name_ar = excluded.name_ar,
    name_en = excluded.name_en,
    end_date = excluded.end_date;

  insert into public.attendance_occurrences (
    id, term_id, stage_id, timetable_session_id, lecture_date, title,
    start_at, end_at, audience_groups, location, teacher
  ) values (
    v_occurrence_id, p_occurrence->>'termId', p_occurrence->>'stageId',
    p_occurrence->>'timetableSessionId', (p_occurrence->>'lectureDate')::date,
    p_occurrence->>'title', (p_occurrence->>'startAt')::timestamptz,
    (p_occurrence->>'endAt')::timestamptz,
    array(select jsonb_array_elements_text(coalesce(p_occurrence->'audienceGroups', '[]'::jsonb))),
    nullif(p_occurrence->>'location', ''), nullif(p_occurrence->>'teacher', '')
  ) on conflict (id) do nothing;

  insert into public.attendance_sessions (
    id, request_id, occurrence_id, professor_uid, expected_headcount,
    notes, status, reconciliation_deadline
  ) values (
    v_session_id, v_request_id, v_occurrence_id, p_session->>'professorUid',
    (p_session->>'expectedHeadcount')::integer, coalesce(p_session->>'notes', ''),
    'active', (p_session->>'reconciliationDeadline')::timestamptz
  )
  on conflict (occurrence_id) do nothing
  returning id into v_session_id;

  if v_session_id is null then
    select * into v_existing
    from public.attendance_sessions
    where occurrence_id = v_occurrence_id;
    select qr_token into v_qr_token
    from public.attendance_challenges
    where session_id = v_existing.id
    order by issued_at desc
    limit 1;
    return jsonb_build_object(
      'sessionId', v_existing.id,
      'revision', v_existing.revision,
      'status', v_existing.status,
      'qrToken', v_qr_token,
      'existing', true
    );
  end if;

  insert into public.attendance_session_roster (
    session_id, roster_student_id, official_name, roster_identifier, subgroup
  )
  select
    v_session_id,
    item->>'studentId',
    item->>'officialName',
    coalesce(item->>'rosterIdentifier', ''),
    coalesce(item->>'subgroup', '')
  from jsonb_array_elements(coalesce(p_roster, '[]'::jsonb)) item;

  insert into public.attendance_challenges (
    id, session_id, token_hash, qr_token, key_id
  ) values (
    (p_challenge->>'id')::uuid, v_session_id, p_challenge->>'tokenHash',
    p_challenge->>'qrToken', p_challenge->>'keyId'
  );

  insert into public.attendance_audit_events (
    request_id, session_id, actor_uid, action, after_state
  ) values (
    v_request_id, v_session_id, p_session->>'professorUid', 'session_created',
    jsonb_build_object('occurrenceId', v_occurrence_id, 'headcount', (p_session->>'expectedHeadcount')::integer)
  );

  return jsonb_build_object(
    'sessionId', v_session_id,
    'revision', 1,
    'status', 'active',
    'qrToken', p_challenge->>'qrToken',
    'existing', false
  );
end;
$$;

create or replace function public.attendance_submit_receipt(
  p_request_id uuid,
  p_actor_uid text,
  p_roster_student_id text,
  p_payload_hash text,
  p_session_id uuid,
  p_challenge_id uuid,
  p_token_hash text,
  p_installation_digest text,
  p_client_reported_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_existing_receipt public.attendance_receipts%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_resolution text;
  v_reason text;
  v_inserted boolean := false;
  v_received_at timestamptz := now();
begin
  select * into v_existing_receipt
  from public.attendance_receipts
  where request_id = p_request_id;

  if found then
    if v_existing_receipt.actor_uid <> p_actor_uid
       or v_existing_receipt.payload_hash <> p_payload_hash then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    if v_existing_receipt.record_id is not null then
      select * into v_record from public.attendance_records where id = v_existing_receipt.record_id;
    end if;
    return jsonb_build_object(
      'requestId', p_request_id,
      'receiptId', p_request_id,
      'resolution', case when v_record.status = 'voided' then 'needs_review' else v_existing_receipt.resolution end,
      'reason', case when v_record.status = 'voided' then 'record_voided' else v_existing_receipt.reason end,
      'recordId', v_existing_receipt.record_id,
      'recordStatus', v_record.status,
      'receivedAt', v_existing_receipt.received_at,
      'revision', v_record.revision
    );
  end if;

  select * into v_session
  from public.attendance_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'unknown_session';
  end if;

  if not exists (
    select 1 from public.attendance_challenges
    where id = p_challenge_id
      and session_id = p_session_id
      and token_hash = p_token_hash
      and revoked_at is null
  ) then
    raise exception using errcode = '22023', message = 'invalid_challenge';
  end if;

  select * into v_roster
  from public.attendance_session_roster
  where session_id = p_session_id and roster_student_id = p_roster_student_id;

  if not found then
    v_resolution := 'needs_review';
    v_reason := 'roster_not_snapshotted';
  elsif v_session.status = 'cancelled' then
    v_resolution := 'needs_review';
    v_reason := 'session_cancelled';
  elsif v_session.status = 'finalized' then
    v_resolution := 'needs_review';
    v_reason := 'session_finalized';
  elsif v_received_at > v_session.reconciliation_deadline then
    v_resolution := 'needs_review';
    v_reason := 'outside_reconciliation_window';
  else
    insert into public.attendance_records (
      session_id, roster_student_id, student_uid, official_name_snapshot,
      entry_method, status, received_at, decided_at, client_reported_at,
      installation_digest
    ) values (
      p_session_id, p_roster_student_id, p_actor_uid, v_roster.official_name,
      'qr', 'confirmed', v_received_at, v_received_at, p_client_reported_at,
      p_installation_digest
    )
    on conflict (session_id, roster_student_id) do nothing
    returning * into v_record;

    if found then
      v_inserted := true;
      v_resolution := 'confirmed';
      v_reason := 'accepted';
    else
      select * into v_record
      from public.attendance_records
      where session_id = p_session_id and roster_student_id = p_roster_student_id;
      if v_record.status = 'confirmed' then
        v_resolution := 'already_recorded';
        v_reason := 'duplicate_student_session';
      else
        v_resolution := 'needs_review';
        v_reason := 'record_voided';
      end if;
    end if;

    if v_inserted and p_installation_digest is not null and exists (
      select 1 from public.attendance_records r
      where r.session_id = p_session_id
        and r.installation_digest = p_installation_digest
        and r.roster_student_id <> p_roster_student_id
    ) then
      update public.attendance_records
      set review_flags = array(
            select distinct flag
            from unnest(review_flags || array['shared_installation']) flag
          ),
          revision = revision + 1
      where session_id = p_session_id and installation_digest = p_installation_digest;
      select * into v_record from public.attendance_records where id = v_record.id;
    end if;
  end if;

  insert into public.attendance_receipts (
    request_id, session_id, challenge_id, actor_uid, roster_student_id,
    payload_hash, installation_digest, received_at, resolution, reason, record_id
  ) values (
    p_request_id, p_session_id, p_challenge_id, p_actor_uid, p_roster_student_id,
    p_payload_hash, p_installation_digest, v_received_at, v_resolution, v_reason,
    v_record.id
  );

  if v_inserted then
    update public.attendance_sessions
    set revision = revision + 1
    where id = p_session_id;
    insert into public.attendance_audit_events (
      session_id, record_id, actor_uid, action, reason, after_state
    ) values (
      p_session_id, v_record.id, p_actor_uid, 'qr_confirmed', v_reason,
      to_jsonb(v_record)
    );
  end if;

  return jsonb_build_object(
    'requestId', p_request_id,
    'receiptId', p_request_id,
    'resolution', v_resolution,
    'reason', v_reason,
    'recordId', v_record.id,
    'recordStatus', v_record.status,
    'receivedAt', v_received_at,
    'revision', v_record.revision
  );
end;
$$;

create or replace function public.attendance_manual_record(
  p_request_id uuid,
  p_session_id uuid,
  p_actor_uid text,
  p_roster_student_id text,
  p_reason text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_audit public.attendance_audit_events%rowtype;
begin
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    if v_audit.session_id <> p_session_id or v_audit.action <> 'manual_confirmed' then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    select * into v_record from public.attendance_records where id = v_audit.record_id;
    return jsonb_build_object('record', to_jsonb(v_record), 'revision', (select revision from public.attendance_sessions where id = p_session_id), 'existing', true);
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception using errcode = '22023', message = 'unknown_session'; end if;
  if v_session.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'revision_conflict'; end if;
  if v_session.status in ('finalized', 'cancelled') then raise exception using errcode = '22023', message = 'session_not_editable'; end if;

  select * into v_roster from public.attendance_session_roster
  where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if not found then raise exception using errcode = '22023', message = 'student_not_in_roster'; end if;

  select * into v_record from public.attendance_records
  where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if found and v_record.status = 'voided' then raise exception using errcode = '22023', message = 'record_voided_use_restore'; end if;

  if not found then
    insert into public.attendance_records (
      session_id, roster_student_id, student_uid, official_name_snapshot,
      entry_method, status
    ) values (
      p_session_id, p_roster_student_id, p_roster_student_id, v_roster.official_name,
      'manual', 'confirmed'
    ) returning * into v_record;
  end if;

  update public.attendance_sessions set revision = revision + 1 where id = p_session_id returning * into v_session;
  insert into public.attendance_audit_events (
    request_id, session_id, record_id, actor_uid, action, reason, after_state
  ) values (
    p_request_id, p_session_id, v_record.id, p_actor_uid, 'manual_confirmed', p_reason,
    to_jsonb(v_record)
  );
  return jsonb_build_object('record', to_jsonb(v_record), 'revision', v_session.revision, 'existing', false);
end;
$$;

create or replace function public.attendance_set_record_status(
  p_request_id uuid,
  p_record_id uuid,
  p_actor_uid text,
  p_status text,
  p_reason text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_record public.attendance_records%rowtype;
  v_before jsonb;
  v_audit public.attendance_audit_events%rowtype;
begin
  if p_status not in ('confirmed', 'voided') then raise exception using errcode = '22023', message = 'invalid_record_status'; end if;
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    if v_audit.record_id <> p_record_id or v_audit.action <>
      case when p_status = 'voided' then 'record_voided' else 'record_restored' end then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    select * into v_record from public.attendance_records where id = v_audit.record_id;
    return jsonb_build_object('record', to_jsonb(v_record), 'revision', (select revision from public.attendance_sessions where id = v_record.session_id), 'existing', true);
  end if;

  select * into v_record from public.attendance_records where id = p_record_id;
  if not found then raise exception using errcode = '22023', message = 'record_not_found'; end if;
  select * into v_session from public.attendance_sessions where id = v_record.session_id for update;
  if v_session.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'revision_conflict'; end if;
  if v_session.status = 'finalized' then raise exception using errcode = '22023', message = 'session_finalized'; end if;

  v_before := to_jsonb(v_record);
  update public.attendance_records
  set status = p_status, decided_at = now(), revision = revision + 1
  where id = p_record_id
  returning * into v_record;
  update public.attendance_sessions set revision = revision + 1 where id = v_record.session_id returning * into v_session;
  insert into public.attendance_audit_events (
    request_id, session_id, record_id, actor_uid, action, reason, before_state, after_state
  ) values (
    p_request_id, v_record.session_id, v_record.id, p_actor_uid,
    case when p_status = 'voided' then 'record_voided' else 'record_restored' end,
    p_reason, v_before, to_jsonb(v_record)
  );
  return jsonb_build_object('record', to_jsonb(v_record), 'revision', v_session.revision, 'existing', false);
end;
$$;

create or replace function public.attendance_update_session(
  p_request_id uuid,
  p_session_id uuid,
  p_actor_uid text,
  p_expected_revision bigint,
  p_expected_headcount integer,
  p_notes text,
  p_next_status text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_before jsonb;
  v_audit public.attendance_audit_events%rowtype;
begin
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    if v_audit.session_id <> p_session_id then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    select * into v_session from public.attendance_sessions where id = p_session_id;
    return jsonb_build_object('session', to_jsonb(v_session), 'existing', true);
  end if;

  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception using errcode = '22023', message = 'unknown_session'; end if;
  if v_session.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'revision_conflict'; end if;
  if p_expected_headcount is not null and (p_expected_headcount < 1 or p_expected_headcount > 10000) then
    raise exception using errcode = '22023', message = 'invalid_headcount';
  end if;
  if p_notes is not null and char_length(p_notes) > 2000 then raise exception using errcode = '22023', message = 'notes_too_long'; end if;
  if p_next_status is not null and p_next_status not in ('active', 'ended', 'finalized', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid_session_status';
  end if;
  if v_session.status in ('finalized', 'cancelled') and coalesce(p_next_status, v_session.status) <> v_session.status then
    raise exception using errcode = '22023', message = 'session_not_editable';
  end if;
  if p_next_status = 'finalized' and (
    now() < v_session.reconciliation_deadline or exists (
      select 1 from public.attendance_receipts
      where session_id = p_session_id and resolution = 'needs_review'
    )
  ) then raise exception using errcode = '22023', message = 'session_not_ready_to_finalize'; end if;

  v_before := to_jsonb(v_session);
  update public.attendance_sessions set
    expected_headcount = coalesce(p_expected_headcount, expected_headcount),
    notes = coalesce(p_notes, notes),
    status = coalesce(p_next_status, status),
    ended_at = case when p_next_status = 'ended' and ended_at is null then now() else ended_at end,
    reconciliation_deadline = case
      when p_next_status = 'ended' then greatest(reconciliation_deadline, now() + interval '7 days')
      else reconciliation_deadline
    end,
    finalized_at = case when p_next_status = 'finalized' then now() else finalized_at end,
    revision = revision + 1
  where id = p_session_id
  returning * into v_session;

  insert into public.attendance_audit_events (
    request_id, session_id, actor_uid, action, reason, before_state, after_state
  ) values (
    p_request_id, p_session_id, p_actor_uid,
    case when p_next_status is null then 'session_updated' else 'session_' || p_next_status end,
    p_reason, v_before, to_jsonb(v_session)
  );
  return jsonb_build_object('session', to_jsonb(v_session), 'existing', false);
end;
$$;

create or replace function public.attendance_resolve_review(
  p_request_id uuid,
  p_receipt_id uuid,
  p_actor_uid text,
  p_decision text,
  p_reason text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_receipt public.attendance_receipts%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_audit public.attendance_audit_events%rowtype;
begin
  if p_decision not in ('confirm', 'reject') then
    raise exception using errcode = '22023', message = 'invalid_review_decision';
  end if;
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id;
    if not found or v_audit.session_id <> v_receipt.session_id or v_audit.action <>
      case when p_decision = 'confirm' then 'review_confirmed' else 'review_rejected' end then
      raise exception using errcode = '22023', message = 'idempotency_conflict';
    end if;
    if v_receipt.record_id is not null then
      select * into v_record from public.attendance_records where id = v_receipt.record_id;
    end if;
    return jsonb_build_object(
      'receipt', to_jsonb(v_receipt),
      'record', case when v_record.id is null then null else to_jsonb(v_record) end,
      'revision', (select revision from public.attendance_sessions where id = v_receipt.session_id),
      'existing', true
    );
  end if;

  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id for update;
  if not found then raise exception using errcode = '22023', message = 'receipt_not_found'; end if;
  if v_receipt.resolution <> 'needs_review' then
    raise exception using errcode = '22023', message = 'receipt_not_reviewable';
  end if;
  select * into v_session from public.attendance_sessions where id = v_receipt.session_id for update;
  if v_session.revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'revision_conflict';
  end if;
  if v_session.status = 'finalized' then
    raise exception using errcode = '22023', message = 'session_finalized';
  end if;

  if p_decision = 'confirm' then
    select * into v_roster from public.attendance_session_roster
    where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if not found then raise exception using errcode = '22023', message = 'student_not_in_session_roster'; end if;

    insert into public.attendance_records (
      session_id, roster_student_id, student_uid, official_name_snapshot,
      entry_method, status, received_at, decided_at, installation_digest,
      review_flags
    ) values (
      v_receipt.session_id, v_receipt.roster_student_id, v_receipt.actor_uid,
      v_roster.official_name, 'qr', 'confirmed', v_receipt.received_at, now(),
      v_receipt.installation_digest, array['professor_reviewed']
    )
    on conflict (session_id, roster_student_id) do update set
      status = 'confirmed',
      decided_at = now(),
      revision = public.attendance_records.revision + 1,
      review_flags = array(
        select distinct flag
        from unnest(public.attendance_records.review_flags || array['professor_reviewed']) flag
      )
    returning * into v_record;

    update public.attendance_receipts set
      resolution = 'confirmed', reason = 'professor_confirmed', record_id = v_record.id
    where request_id = p_receipt_id
    returning * into v_receipt;
  else
    update public.attendance_receipts set
      resolution = 'invalid_evidence', reason = 'professor_rejected'
    where request_id = p_receipt_id
    returning * into v_receipt;
  end if;

  update public.attendance_sessions set revision = revision + 1
  where id = v_receipt.session_id returning * into v_session;
  insert into public.attendance_audit_events (
    request_id, session_id, record_id, actor_uid, action, reason, after_state
  ) values (
    p_request_id, v_receipt.session_id, v_record.id, p_actor_uid,
    case when p_decision = 'confirm' then 'review_confirmed' else 'review_rejected' end,
    p_reason, jsonb_build_object('receipt', to_jsonb(v_receipt), 'record', to_jsonb(v_record))
  );
  return jsonb_build_object(
    'receipt', to_jsonb(v_receipt),
    'record', case when v_record.id is null then null else to_jsonb(v_record) end,
    'revision', v_session.revision,
    'existing', false
  );
end;
$$;

revoke execute on function public.attendance_create_session(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.attendance_manual_record(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.attendance_set_record_status(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.attendance_update_session(uuid, uuid, text, bigint, integer, text, text, text) from public, anon, authenticated;
revoke execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;

grant execute on function public.attendance_create_session(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.attendance_manual_record(uuid, uuid, text, text, text, bigint) to service_role;
grant execute on function public.attendance_set_record_status(uuid, uuid, text, text, text, bigint) to service_role;
grant execute on function public.attendance_update_session(uuid, uuid, text, bigint, integer, text, text, text) to service_role;
grant execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint) to service_role;
