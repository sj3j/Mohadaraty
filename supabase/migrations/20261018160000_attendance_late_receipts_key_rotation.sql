-- Migration: 20261018160000_attendance_late_receipts_key_rotation.sql
-- Late receipts review path and authenticated device key rotation with alias lineage.

create table if not exists public.attendance_key_rotation_challenges (
  id uuid primary key default gen_random_uuid(),
  actor_uid text not null,
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table if not exists public.attendance_key_aliases (
  alias_digest text primary key,
  canonical_device_digest text not null,
  roster_student_id text not null,
  created_at timestamptz not null default now()
);

alter table public.attendance_key_rotation_challenges enable row level security;
alter table public.attendance_key_aliases enable row level security;
alter table public.attendance_audit_events alter column session_id drop not null;

create or replace function public.attendance_create_key_rotation_challenge(
  p_actor_uid text,
  p_nonce text
)
returns uuid language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_challenge_id uuid;
begin
  if length(trim(p_nonce)) < 16 or length(p_nonce) > 256 then raise exception 'invalid_nonce'; end if;
  insert into public.attendance_key_rotation_challenges(actor_uid, nonce, expires_at)
  values (p_actor_uid, p_nonce, now() + interval '10 minutes')
  returning id into v_challenge_id;
  return v_challenge_id;
end;
$$;

create or replace function public.attendance_commit_key_rotation(
  p_challenge_id uuid,
  p_actor_uid text,
  p_roster_student_id text,
  p_old_device_digest text,
  p_new_device_digest text,
  p_rotation_proof jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_challenge public.attendance_key_rotation_challenges%rowtype;
  v_enrolled text;
  v_canonical text;
begin
  select * into v_challenge from public.attendance_key_rotation_challenges
  where id = p_challenge_id and actor_uid = p_actor_uid for update;
  if not found then raise exception 'challenge_not_found'; end if;
  if v_challenge.consumed_at is not null then raise exception 'challenge_already_consumed'; end if;
  if now() > v_challenge.expires_at then raise exception 'challenge_expired'; end if;

  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || p_roster_student_id, 0));

  select device_digest into v_enrolled from public.attendance_enrolled_devices
  where roster_student_id = p_roster_student_id for update;
  if not found then raise exception 'device_enrollment_required'; end if;

  -- Resolve canonical device digest if old key was itself an alias
  select canonical_device_digest into v_canonical from public.attendance_key_aliases
  where alias_digest = p_old_device_digest;
  v_canonical := coalesce(v_canonical, p_old_device_digest);

  if v_enrolled <> v_canonical and v_enrolled <> p_old_device_digest then
    raise exception 'old_key_mismatch';
  end if;

  -- Map new key alias to canonical device identity
  insert into public.attendance_key_aliases(alias_digest, canonical_device_digest, roster_student_id)
  values (p_new_device_digest, v_canonical, p_roster_student_id)
  on conflict (alias_digest) do nothing;

  update public.attendance_key_rotation_challenges
  set consumed_at = now()
  where id = p_challenge_id;

  insert into public.attendance_audit_events(actor_uid, action, reason, before_state, after_state)
  values (
    p_actor_uid,
    'device_key_rotated',
    'Proof of possession verified key rotation',
    jsonb_build_object('studentId', p_roster_student_id, 'oldDeviceDigest', p_old_device_digest, 'canonicalDeviceDigest', v_canonical),
    jsonb_build_object('studentId', p_roster_student_id, 'newDeviceDigest', p_new_device_digest, 'proof', p_rotation_proof)
  );

  return jsonb_build_object(
    'rotated', true,
    'canonicalDeviceDigest', v_canonical,
    'newDeviceDigest', p_new_device_digest
  );
end;
$$;

create or replace function public.attendance_submit_receipt(
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
  v_effective_device text;
  v_resolution text := 'needs_review';
  v_reason text;
  v_flags text[] := '{}';
  v_received_at timestamptz := now();
  v_is_late boolean := false;
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
  if not found then
    v_reason := 'roster_not_snapshotted';
  else
    -- Resolve alias to canonical device digest if present
    select canonical_device_digest into v_effective_device from public.attendance_key_aliases where alias_digest = p_device_digest;
    v_effective_device := coalesce(v_effective_device, p_device_digest);

    if v_received_at > v_session.reconciliation_deadline then
      v_is_late := true;
      v_resolution := 'needs_review';
      v_reason := 'late_arrival';
      v_flags := v_flags || array['late_arrival'];
    end if;

    if p_device_digest is null or p_installation_digest is null then
      if not v_is_late then v_reason := 'device_unverified'; end if;
    else
      insert into public.attendance_device_claims(session_id, installation_digest, roster_student_id)
      values (p_session_id, p_installation_digest, p_roster_student_id) on conflict do nothing;
      select roster_student_id into v_claim from public.attendance_device_claims where session_id = p_session_id and installation_digest = p_installation_digest;
      if v_claim <> p_roster_student_id or p_local_device_conflict then
        v_flags := v_flags || array['shared_installation'];
        if not v_is_late then v_reason := 'device_session_conflict'; end if;
        update public.attendance_records set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag), revision = revision + 1
        where session_id = p_session_id and installation_digest = p_installation_digest;
        update public.attendance_receipts set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag)
        where session_id = p_session_id and installation_digest = p_installation_digest;
      else
        select device_digest into v_enrolled from public.attendance_enrolled_devices where roster_student_id = p_roster_student_id;
        if not found then
          if not v_is_late then v_reason := 'device_enrollment_required'; end if;
        elsif v_enrolled <> v_effective_device then
          if not v_is_late then v_reason := 'device_change_required'; end if;
        elsif v_session.status in ('cancelled', 'finalized') then
          if not v_is_late then v_reason := 'session_' || v_session.status; end if;
        elsif not v_is_late then
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
  end if;
  insert into public.attendance_receipts(request_id, session_id, challenge_id, actor_uid, roster_student_id, payload_hash, installation_digest, device_digest, local_device_conflict, received_at, resolution, reason, record_id, review_flags, advisory)
  values (p_request_id, p_session_id, p_challenge_id, p_actor_uid, p_roster_student_id, p_payload_hash, p_installation_digest, p_device_digest, p_local_device_conflict, v_received_at, v_resolution, v_reason, v_record.id, v_flags, p_advisory);
  return public.attendance_receipt_result(p_request_id);
end;
$$;

drop function if exists public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean);
create or replace function public.attendance_resolve_review(
  p_request_id uuid, p_receipt_id uuid, p_actor_uid text, p_decision text, p_reason text,
  p_expected_revision bigint, p_enroll_device boolean default false, p_allow_late_confirmation boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_receipt public.attendance_receipts%rowtype;
  v_roster public.attendance_session_roster%rowtype;
  v_record public.attendance_records%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_before jsonb;
  v_claim text;
  v_effective_device text;
  v_is_late boolean := false;
begin
  if p_decision not in ('confirm', 'reject') or length(trim(p_reason)) not between 1 and 1000 then raise exception 'invalid_review'; end if;
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'review', p_receipt_id::text, jsonb_build_object('decision', p_decision, 'reason', p_reason, 'enroll', p_enroll_device, 'allowLate', p_allow_late_confirmation));
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id;
  if not found then raise exception 'receipt_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || v_receipt.roster_student_id, 0));
  if v_receipt.device_digest is not null then perform pg_advisory_xact_lock(hashtextextended('attendance-device:' || v_receipt.device_digest, 0)); end if;
  select * into v_session from public.attendance_sessions where id = v_receipt.session_id for update;
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id for update;
  if exists (select 1 from public.attendance_audit_events where request_id = p_request_id) then return public.attendance_receipt_result(p_receipt_id); end if;
  if v_receipt.resolution <> 'needs_review' then raise exception 'receipt_not_reviewable'; end if;
  v_before := to_jsonb(v_receipt);

  -- Resolve alias
  select canonical_device_digest into v_effective_device from public.attendance_key_aliases where alias_digest = v_receipt.device_digest;
  v_effective_device := coalesce(v_effective_device, v_receipt.device_digest);

  if v_receipt.received_at > v_session.reconciliation_deadline then
    v_is_late := true;
  end if;

  if p_decision = 'confirm' then
    if v_session.status = 'cancelled' then raise exception 'receipt_not_eligible'; end if;
    if v_is_late and not p_allow_late_confirmation then raise exception 'late_receipt_requires_explicit_confirmation'; end if;

    select roster_student_id into v_claim from public.attendance_device_claims where session_id = v_receipt.session_id and installation_digest = v_receipt.installation_digest;
    if v_receipt.local_device_conflict or v_claim is distinct from v_receipt.roster_student_id or v_receipt.device_digest is null then raise exception 'device_conflict_requires_manual_attendance'; end if;
    select * into v_roster from public.attendance_session_roster where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if not found then raise exception 'student_not_in_roster'; end if;
    select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if found and v_record.status = 'voided' then raise exception 'record_voided_use_restore'; end if;
    if p_enroll_device then
      if exists (select 1 from public.attendance_enrolled_devices where device_digest = v_effective_device and roster_student_id <> v_receipt.roster_student_id) then raise exception 'device_enrolled_to_another_student'; end if;
      insert into public.attendance_audit_events(session_id, actor_uid, action, reason, before_state, after_state)
      values (v_receipt.session_id, p_actor_uid, 'device_identity_verified', p_reason,
        (select to_jsonb(device) from public.attendance_enrolled_devices device where roster_student_id = v_receipt.roster_student_id),
        jsonb_build_object('studentId', v_receipt.roster_student_id, 'deviceDigest', v_effective_device));
      insert into public.attendance_enrolled_devices(roster_student_id, device_digest, approved_by, source_receipt_id)
      values (v_receipt.roster_student_id, v_effective_device, p_actor_uid, p_receipt_id)
      on conflict (roster_student_id) do update set device_digest = excluded.device_digest, approved_by = excluded.approved_by, approved_at = now(), source_receipt_id = excluded.source_receipt_id;
    elsif not exists (select 1 from public.attendance_enrolled_devices where roster_student_id = v_receipt.roster_student_id and device_digest = v_effective_device) then
      raise exception 'device_enrollment_required';
    end if;
    insert into public.attendance_records(session_id, roster_student_id, student_uid, official_name_snapshot, entry_method, installation_digest, received_at, review_flags, advisory)
    values (v_receipt.session_id, v_receipt.roster_student_id, v_receipt.actor_uid, v_roster.official_name, 'qr', v_receipt.installation_digest, v_receipt.received_at, v_receipt.review_flags || array['professor_reviewed'], v_receipt.advisory)
    on conflict (session_id, roster_student_id) do nothing;
    select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    update public.attendance_receipts
    set resolution = 'confirmed',
        reason = case when v_is_late then 'professor_late_confirmation' else 'professor_confirmed' end,
        record_id = v_record.id
    where request_id = p_receipt_id;
  else
    update public.attendance_receipts
    set resolution = 'invalid_evidence',
        reason = case when v_is_late then 'professor_late_rejection' else 'professor_rejected' end
    where request_id = p_receipt_id;
  end if;
  insert into public.attendance_audit_events(request_id, session_id, record_id, actor_uid, action, reason, before_state, after_state)
  values (
    p_request_id,
    v_receipt.session_id,
    v_record.id,
    p_actor_uid,
    case when p_decision = 'confirm' and v_is_late then 'review_confirm_late' else 'review_' || p_decision end,
    p_reason,
    v_before,
    public.attendance_receipt_result(p_receipt_id)
  );
  return public.attendance_receipt_result(p_receipt_id);
end;
$$;

-- Migrate historical submission_deadline_passed receipts to reviewable late_arrival
update public.attendance_receipts
set resolution = 'needs_review',
    reason = 'late_arrival',
    review_flags = array(select distinct flag from unnest(review_flags || array['late_arrival']) flag)
where resolution = 'invalid_evidence' and reason = 'submission_deadline_passed';

-- Security grants: gateway-only execution, revoke from public/anon/authenticated
revoke all on public.attendance_key_rotation_challenges from public, anon, authenticated;
revoke all on public.attendance_key_aliases from public, anon, authenticated;
grant all on public.attendance_key_rotation_challenges to service_role;
grant all on public.attendance_key_aliases to service_role;

revoke execute on function public.attendance_create_key_rotation_challenge(text, text) from public, anon, authenticated;
revoke execute on function public.attendance_commit_key_rotation(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean, boolean) from public, anon, authenticated;

grant execute on function public.attendance_create_key_rotation_challenge(text, text) to service_role;
grant execute on function public.attendance_commit_key_rotation(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) to service_role;
grant execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean, boolean) to service_role;
