alter table public.attendance_session_roster add column expected_attendee boolean not null default true;
alter table public.attendance_receipts add column device_digest text;
alter table public.attendance_receipts add column local_device_conflict boolean not null default false;
alter table public.attendance_receipts add column review_flags text[] not null default '{}';
alter table public.attendance_receipts add column advisory jsonb not null default '{}';
alter table public.attendance_records add column advisory jsonb not null default '{}';

create table public.attendance_device_claims (
  session_id uuid not null references public.attendance_sessions(id) on delete restrict,
  installation_digest text not null check (length(installation_digest) = 64),
  roster_student_id text not null,
  claimed_at timestamptz not null default now(),
  primary key (session_id, installation_digest),
  foreign key (session_id, roster_student_id) references public.attendance_session_roster(session_id, roster_student_id)
);
create index attendance_device_claims_student_idx on public.attendance_device_claims (session_id, roster_student_id);

create table public.attendance_enrolled_devices (
  roster_student_id text primary key,
  device_digest text not null unique check (length(device_digest) = 64),
  approved_by text not null,
  approved_at timestamptz not null default now(),
  source_receipt_id uuid not null references public.attendance_receipts(request_id)
);
create index attendance_enrolled_devices_receipt_idx on public.attendance_enrolled_devices(source_receipt_id);

create table public.attendance_commands (
  request_id uuid primary key,
  actor_uid text not null,
  action text not null,
  target text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.attendance_device_claims enable row level security;
alter table public.attendance_enrolled_devices enable row level security;
alter table public.attendance_commands enable row level security;
revoke all on public.attendance_device_claims, public.attendance_enrolled_devices, public.attendance_commands from public, anon, authenticated;
grant select, insert, update on public.attendance_device_claims, public.attendance_enrolled_devices, public.attendance_commands to service_role;

create function public.attendance_claim_command(p_request_id uuid, p_actor_uid text, p_action text, p_target text, p_payload jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_existing public.attendance_commands%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('attendance-command:' || p_request_id::text, 0));
  insert into public.attendance_commands values (p_request_id, p_actor_uid, p_action, p_target, p_payload, now()) on conflict do nothing;
  select * into strict v_existing from public.attendance_commands where request_id = p_request_id;
  if v_existing.actor_uid <> p_actor_uid or v_existing.action <> p_action or v_existing.target <> p_target or v_existing.payload <> p_payload then
    raise exception using errcode = '22023', message = 'idempotency_conflict';
  end if;
end;
$$;

create function public.attendance_roster_audience()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_groups text[];
begin
  select occurrence.audience_groups into v_groups from public.attendance_sessions session
  join public.attendance_occurrences occurrence on occurrence.id = session.occurrence_id where session.id = new.session_id;
  new.expected_attendee := cardinality(v_groups) = 0 or new.subgroup = any(v_groups);
  return new;
end;
$$;
create trigger attendance_roster_audience_before_insert before insert on public.attendance_session_roster
for each row execute function public.attendance_roster_audience();

create function public.attendance_receipt_result(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_receipt public.attendance_receipts%rowtype; v_record public.attendance_records%rowtype;
begin
  select * into strict v_receipt from public.attendance_receipts where request_id = p_request_id;
  select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
  return jsonb_build_object(
    'requestId', p_request_id, 'resolution', case when v_record.status = 'voided' then 'needs_review' when v_record.status = 'confirmed' then 'confirmed' else v_receipt.resolution end,
    'reason', case when v_record.status = 'voided' then 'record_voided' else v_receipt.reason end,
    'recordId', v_record.id, 'recordStatus', v_record.status, 'revision', v_record.revision,
    'receivedAt', v_receipt.received_at, 'reviewFlags', v_receipt.review_flags
  );
end;
$$;

drop function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz);
create function public.attendance_submit_receipt(
  p_request_id uuid, p_actor_uid text, p_roster_student_id text, p_payload_hash text,
  p_session_id uuid, p_challenge_id uuid, p_token_hash text, p_installation_digest text,
  p_client_reported_at timestamptz, p_device_digest text, p_local_device_conflict boolean, p_advisory jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_session public.attendance_sessions%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_receipt public.attendance_receipts%rowtype;
  v_claim text;
  v_enrolled text;
  v_resolution text := 'needs_review';
  v_reason text;
  v_flags text[] := '{}';
  v_received_at timestamptz := now();
begin
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'receipt', p_session_id::text, jsonb_build_object('hash', p_payload_hash));
  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || p_roster_student_id, 0));
  if p_device_digest is not null then perform pg_advisory_xact_lock(hashtextextended('attendance-device:' || p_device_digest, 0)); end if;
  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception 'unknown_session'; end if;
  select * into v_receipt from public.attendance_receipts where request_id = p_request_id;
  if found then
    if v_receipt.actor_uid <> p_actor_uid or v_receipt.payload_hash <> p_payload_hash then raise exception 'idempotency_conflict'; end if;
    return public.attendance_receipt_result(p_request_id);
  end if;
  if not exists (select 1 from public.attendance_challenges where id = p_challenge_id and session_id = p_session_id and token_hash = p_token_hash and revoked_at is null) then
    raise exception 'invalid_challenge';
  end if;
  select array_agg(flag) into v_flags from jsonb_array_elements_text(coalesce(p_advisory->'flags', '[]')) flag;
  v_flags := coalesce(v_flags, '{}');
  select * into v_roster from public.attendance_session_roster where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if v_received_at > v_session.reconciliation_deadline then
    v_resolution := 'invalid_evidence'; v_reason := 'submission_deadline_passed';
  elsif not found then v_reason := 'roster_not_snapshotted';
  elsif p_device_digest is null or p_installation_digest is null then v_reason := 'device_unverified';
  else
    insert into public.attendance_device_claims(session_id, installation_digest, roster_student_id)
    values (p_session_id, p_installation_digest, p_roster_student_id) on conflict do nothing;
    select roster_student_id into v_claim from public.attendance_device_claims where session_id = p_session_id and installation_digest = p_installation_digest;
    if v_claim <> p_roster_student_id or p_local_device_conflict then
      v_reason := 'device_session_conflict';
      v_flags := v_flags || array['shared_installation'];
      update public.attendance_records set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag), revision = revision + 1
      where session_id = p_session_id and installation_digest = p_installation_digest;
      update public.attendance_receipts set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag)
      where session_id = p_session_id and installation_digest = p_installation_digest;
    else
      select device_digest into v_enrolled from public.attendance_enrolled_devices where roster_student_id = p_roster_student_id;
      if not found then v_reason := 'device_enrollment_required';
      elsif v_enrolled <> p_device_digest then v_reason := 'device_change_required';
      elsif v_session.status in ('cancelled', 'finalized') then v_reason := 'session_' || v_session.status;
      else
        if not v_roster.expected_attendee then v_flags := v_flags || array['visiting_subgroup']; end if;
        insert into public.attendance_records(session_id, roster_student_id, student_uid, official_name_snapshot, entry_method, installation_digest, review_flags, advisory, client_reported_at)
        values (p_session_id, p_roster_student_id, p_actor_uid, v_roster.official_name, 'qr', p_installation_digest, v_flags, p_advisory, p_client_reported_at)
        on conflict (session_id, roster_student_id) do nothing returning * into v_record;
        if found then
          v_resolution := 'confirmed'; v_reason := 'accepted';
          insert into public.attendance_audit_events(session_id, record_id, actor_uid, action, reason, after_state)
          values (p_session_id, v_record.id, p_actor_uid, 'qr_confirmed', v_reason, to_jsonb(v_record));
        else
          select * into v_record from public.attendance_records where session_id = p_session_id and roster_student_id = p_roster_student_id;
          if v_record.status = 'confirmed' then v_resolution := 'already_recorded'; v_reason := 'duplicate_student_session';
          else v_reason := 'record_voided'; end if;
        end if;
      end if;
    end if;
  end if;
  insert into public.attendance_receipts(request_id, session_id, challenge_id, actor_uid, roster_student_id, payload_hash, installation_digest, device_digest, local_device_conflict, received_at, resolution, reason, record_id, review_flags, advisory)
  values (p_request_id, p_session_id, p_challenge_id, p_actor_uid, p_roster_student_id, p_payload_hash, p_installation_digest, p_device_digest, p_local_device_conflict, v_received_at, v_resolution, v_reason, v_record.id, v_flags, p_advisory);
  return public.attendance_receipt_result(p_request_id);
end;
$$;

drop function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint);
create function public.attendance_resolve_review(p_request_id uuid, p_receipt_id uuid, p_actor_uid text, p_decision text, p_reason text, p_expected_revision bigint, p_enroll_device boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_receipt public.attendance_receipts%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_before jsonb;
  v_claim text;
begin
  if p_decision not in ('confirm', 'reject') or length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid_review'; end if;
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'review', p_receipt_id::text, jsonb_build_object('decision', p_decision, 'reason', p_reason, 'enroll', p_enroll_device));
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id;
  if not found then raise exception 'receipt_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || v_receipt.roster_student_id, 0));
  if v_receipt.device_digest is not null then perform pg_advisory_xact_lock(hashtextextended('attendance-device:' || v_receipt.device_digest, 0)); end if;
  perform 1 from public.attendance_sessions where id = v_receipt.session_id for update;
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id for update;
  if exists (select 1 from public.attendance_audit_events where request_id = p_request_id) then return public.attendance_receipt_result(p_receipt_id); end if;
  if v_receipt.resolution <> 'needs_review' then raise exception 'receipt_not_reviewable'; end if;
  v_before := to_jsonb(v_receipt);
  if p_decision = 'confirm' then
    if exists (select 1 from public.attendance_sessions where id = v_receipt.session_id and (status = 'cancelled' or v_receipt.received_at > reconciliation_deadline)) then raise exception 'receipt_not_eligible'; end if;
    select roster_student_id into v_claim from public.attendance_device_claims where session_id = v_receipt.session_id and installation_digest = v_receipt.installation_digest;
    if v_receipt.local_device_conflict or v_claim is distinct from v_receipt.roster_student_id or v_receipt.device_digest is null then raise exception 'device_conflict_requires_manual_attendance'; end if;
    select * into v_roster from public.attendance_session_roster where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if not found then raise exception 'student_not_in_roster'; end if;
    select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if found and v_record.status = 'voided' then raise exception 'record_voided_use_restore'; end if;
    if p_enroll_device then
      if exists (select 1 from public.attendance_enrolled_devices where device_digest = v_receipt.device_digest and roster_student_id <> v_receipt.roster_student_id) then raise exception 'device_enrolled_to_another_student'; end if;
      insert into public.attendance_audit_events(session_id, actor_uid, action, reason, before_state, after_state)
      values (v_receipt.session_id, p_actor_uid, 'device_identity_verified', p_reason,
        (select to_jsonb(device) from public.attendance_enrolled_devices device where roster_student_id = v_receipt.roster_student_id),
        jsonb_build_object('studentId', v_receipt.roster_student_id, 'deviceDigest', v_receipt.device_digest));
      insert into public.attendance_enrolled_devices(roster_student_id, device_digest, approved_by, source_receipt_id)
      values (v_receipt.roster_student_id, v_receipt.device_digest, p_actor_uid, p_receipt_id)
      on conflict (roster_student_id) do update set device_digest = excluded.device_digest, approved_by = excluded.approved_by, approved_at = now(), source_receipt_id = excluded.source_receipt_id;
    elsif not exists (select 1 from public.attendance_enrolled_devices where roster_student_id = v_receipt.roster_student_id and device_digest = v_receipt.device_digest) then
      raise exception 'device_enrollment_required';
    end if;
    insert into public.attendance_records(session_id, roster_student_id, student_uid, official_name_snapshot, entry_method, installation_digest, received_at, review_flags, advisory)
    values (v_receipt.session_id, v_receipt.roster_student_id, v_receipt.actor_uid, v_roster.official_name, 'qr', v_receipt.installation_digest, v_receipt.received_at, v_receipt.review_flags || array['professor_reviewed'], v_receipt.advisory)
    on conflict (session_id, roster_student_id) do nothing;
    select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    update public.attendance_receipts set resolution = 'confirmed', reason = 'professor_confirmed', record_id = v_record.id where request_id = p_receipt_id;
  else
    update public.attendance_receipts set resolution = 'invalid_evidence', reason = 'professor_rejected' where request_id = p_receipt_id;
  end if;
  insert into public.attendance_audit_events(request_id, session_id, record_id, actor_uid, action, reason, before_state, after_state)
  values (p_request_id, v_receipt.session_id, v_record.id, p_actor_uid, 'review_' || p_decision, p_reason, v_before, public.attendance_receipt_result(p_receipt_id));
  return public.attendance_receipt_result(p_receipt_id);
end;
$$;

create or replace function public.attendance_manual_record(p_request_id uuid, p_session_id uuid, p_actor_uid text, p_roster_student_id text, p_reason text, p_expected_revision bigint)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare v_roster public.attendance_session_roster%rowtype; v_record public.attendance_records%rowtype; v_status text;
begin
  if length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid_reason'; end if;
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'manual', p_session_id::text, jsonb_build_object('studentId', p_roster_student_id, 'reason', p_reason));
  select status into v_status from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception 'unknown_session'; end if;
  if exists (select 1 from public.attendance_audit_events where request_id = p_request_id) then
    select * into v_record from public.attendance_records where session_id = p_session_id and roster_student_id = p_roster_student_id;
    return jsonb_build_object('record', to_jsonb(v_record), 'existing', true);
  end if;
  if v_status = 'cancelled' then raise exception 'session_cancelled'; end if;
  select * into v_roster from public.attendance_session_roster where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if not found then raise exception 'student_not_in_roster'; end if;
  select * into v_record from public.attendance_records where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if found and v_record.status = 'voided' then raise exception 'record_voided_use_restore'; end if;
  insert into public.attendance_records(session_id, roster_student_id, student_uid, official_name_snapshot, entry_method)
  values (p_session_id, p_roster_student_id, p_roster_student_id, v_roster.official_name, 'manual') on conflict do nothing;
  select * into v_record from public.attendance_records where session_id = p_session_id and roster_student_id = p_roster_student_id;
  update public.attendance_receipts set resolution = 'confirmed', reason = 'professor_manual_confirmation', record_id = v_record.id
  where session_id = p_session_id and roster_student_id = p_roster_student_id and resolution = 'needs_review';
  insert into public.attendance_audit_events(request_id, session_id, record_id, actor_uid, action, reason, after_state)
  values (p_request_id, p_session_id, v_record.id, p_actor_uid, 'manual_confirmed', p_reason, to_jsonb(v_record));
  return jsonb_build_object('record', to_jsonb(v_record), 'existing', false);
end;
$$;

revoke execute on function public.attendance_claim_command(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_roster_audience() from public, anon, authenticated;
revoke execute on function public.attendance_receipt_result(uuid) from public, anon, authenticated;
revoke execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.attendance_claim_command(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.attendance_roster_audience() to service_role;
grant execute on function public.attendance_receipt_result(uuid) to service_role;
grant execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) to service_role;
grant execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean) to service_role;
