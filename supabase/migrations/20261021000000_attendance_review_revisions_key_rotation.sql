-- Migration: 20261021000000_attendance_review_revisions_key_rotation.sql
-- Review concurrency protection, review revision tracking, and hardened key rotation challenge/commit idempotency.

-- 1. Add review_revision to attendance_receipts and canonical_fingerprint to attendance_key_aliases
alter table public.attendance_receipts add column if not exists review_revision bigint not null default 1;
alter table public.attendance_key_aliases add column if not exists canonical_fingerprint text;

-- 2. Update attendance_receipt_result to include reviewRevision
create or replace function public.attendance_receipt_result(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_receipt public.attendance_receipts%rowtype;
  v_record public.attendance_records%rowtype;
begin
  select * into strict v_receipt from public.attendance_receipts where request_id = p_request_id;
  select * into v_record from public.attendance_records where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
  return jsonb_build_object(
    'requestId', p_request_id,
    'resolution', case when v_record.status = 'voided' then 'needs_review' when v_record.status = 'confirmed' then 'confirmed' else v_receipt.resolution end,
    'reason', case when v_record.status = 'voided' then 'record_voided' else v_receipt.reason end,
    'recordId', v_record.id,
    'recordStatus', v_record.status,
    'revision', v_record.revision,
    'reviewRevision', v_receipt.review_revision,
    'receivedAt', v_receipt.received_at,
    'reviewFlags', v_receipt.review_flags
  );
end;
$$;

-- 3. Hardened Key Rotation Challenge Generation (server-enforced nonce)
create or replace function public.attendance_create_key_rotation_challenge(
  p_actor_uid text,
  p_nonce text
)
returns uuid language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare
  v_challenge_id uuid;
begin
  if length(trim(p_nonce)) < 16 or length(p_nonce) > 256 then
    raise exception 'invalid_nonce';
  end if;
  insert into public.attendance_key_rotation_challenges(actor_uid, nonce, expires_at)
  values (p_actor_uid, p_nonce, now() + interval '10 minutes')
  returning id into v_challenge_id;
  return v_challenge_id;
end;
$$;

-- 4. Hardened Key Rotation Commit with Nonce Verification, Alias Validation, and Identical Retry Idempotency
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
  v_existing_alias text;
  v_existing_student text;
  v_canonical_fingerprint text;
  v_recorded_audit public.attendance_audit_events%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || p_roster_student_id, 0));

  select * into v_challenge from public.attendance_key_rotation_challenges
  where id = p_challenge_id and actor_uid = p_actor_uid for update;
  if not found then
    raise exception 'challenge_not_found';
  end if;

  -- Resolve canonical device digest if old key was itself an alias
  select canonical_device_digest, canonical_fingerprint into v_canonical, v_canonical_fingerprint from public.attendance_key_aliases
  where alias_digest = p_old_device_digest;
  v_canonical := coalesce(v_canonical, p_old_device_digest);

  -- Check if challenge was already consumed
  if v_challenge.consumed_at is not null then
    -- Check if this is an identical retry (exact same device digests and matching challenge nonce)
    select canonical_device_digest, roster_student_id into v_existing_alias, v_existing_student
    from public.attendance_key_aliases
    where alias_digest = p_new_device_digest;

    if found and v_existing_alias = v_canonical and v_existing_student = p_roster_student_id
       and (p_rotation_proof->>'nonce') = v_challenge.nonce then
      -- Identical retry returns recorded result
      return jsonb_build_object(
        'rotated', true,
        'canonicalDeviceDigest', v_canonical,
        'newDeviceDigest', p_new_device_digest,
        'existing', true
      );
    end if;

    raise exception 'challenge_already_consumed';
  end if;

  if now() > v_challenge.expires_at then
    raise exception 'challenge_expired';
  end if;

  -- Enforce nonce match
  if (p_rotation_proof->>'nonce') is distinct from v_challenge.nonce then
    raise exception 'invalid_challenge_nonce';
  end if;

  select device_digest into v_enrolled from public.attendance_enrolled_devices
  where roster_student_id = p_roster_student_id for update;
  if not found then
    raise exception 'device_enrollment_required';
  end if;

  if v_enrolled <> v_canonical and v_enrolled <> p_old_device_digest then
    raise exception 'old_key_mismatch';
  end if;

  -- Ensure new alias does not belong to another student/device
  select roster_student_id into v_existing_student from public.attendance_key_aliases
  where alias_digest = p_new_device_digest;
  if found and v_existing_student <> p_roster_student_id then
    raise exception 'alias_enrolled_to_another_student';
  end if;

  select roster_student_id into v_existing_student from public.attendance_enrolled_devices
  where device_digest = p_new_device_digest;
  if found and v_existing_student <> p_roster_student_id then
    raise exception 'device_enrolled_to_another_student';
  end if;

  -- Map new key alias to canonical device identity
  insert into public.attendance_key_aliases(alias_digest, canonical_device_digest, roster_student_id, canonical_fingerprint)
  values (p_new_device_digest, v_canonical, p_roster_student_id, coalesce(v_canonical_fingerprint, p_rotation_proof->'oldKey'->>'fingerprint', v_canonical))
  on conflict (alias_digest) do update
  set canonical_device_digest = excluded.canonical_device_digest,
      roster_student_id = excluded.roster_student_id,
      canonical_fingerprint = excluded.canonical_fingerprint;

  update public.attendance_key_rotation_challenges
  set consumed_at = now()
  where id = p_challenge_id;

  insert into public.attendance_audit_events(actor_uid, action, reason, before_state, after_state)
  values (
    p_actor_uid,
    'device_key_rotated',
    'Proof of possession verified key rotation',
    jsonb_build_object('studentId', p_roster_student_id, 'oldDeviceDigest', p_old_device_digest, 'canonicalDeviceDigest', v_canonical),
    jsonb_build_object('studentId', p_roster_student_id, 'newDeviceDigest', p_new_device_digest, 'challengeId', p_challenge_id, 'proof', p_rotation_proof)
  );

  return jsonb_build_object(
    'rotated', true,
    'canonicalDeviceDigest', v_canonical,
    'newDeviceDigest', p_new_device_digest
  );
end;
$$;

-- 5. Hardened Resolve Review with Revision Concurrency Protection
drop function if exists public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean, boolean);
create or replace function public.attendance_resolve_review(
  p_request_id uuid,
  p_receipt_id uuid,
  p_actor_uid text,
  p_decision text,
  p_reason text,
  p_expected_revision bigint,
  p_enroll_device boolean default false,
  p_allow_late_confirmation boolean default false
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
  v_recorded_audit public.attendance_audit_events%rowtype;
begin
  if p_decision not in ('confirm', 'reject') or length(trim(p_reason)) not between 1 and 1000 then
    raise exception 'invalid_review';
  end if;

  -- Lock session and receipt
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id;
  if not found then
    raise exception 'receipt_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || v_receipt.roster_student_id, 0));
  if v_receipt.device_digest is not null then
    perform pg_advisory_xact_lock(hashtextextended('attendance-device:' || v_receipt.device_digest, 0));
  end if;

  select * into v_session from public.attendance_sessions where id = v_receipt.session_id for update;
  select * into v_receipt from public.attendance_receipts where request_id = p_receipt_id for update;

  -- Check idempotency: identical completed request returns recorded result
  select * into v_recorded_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    return public.attendance_receipt_result(p_receipt_id);
  end if;

  perform public.attendance_claim_command(
    p_request_id, p_actor_uid, 'review', p_receipt_id::text,
    jsonb_build_object('decision', p_decision, 'reason', p_reason, 'enroll', p_enroll_device, 'allowLate', p_allow_late_confirmation, 'expectedRevision', p_expected_revision)
  );

  -- Concurrency check on review revision
  if v_receipt.review_revision <> p_expected_revision then
    raise exception 'concurrency_conflict';
  end if;

  if v_receipt.resolution <> 'needs_review' then
    raise exception 'receipt_not_reviewable';
  end if;
  v_before := to_jsonb(v_receipt);

  -- Resolve alias
  select canonical_device_digest into v_effective_device from public.attendance_key_aliases where alias_digest = v_receipt.device_digest;
  v_effective_device := coalesce(v_effective_device, v_receipt.device_digest);

  if v_receipt.received_at > v_session.reconciliation_deadline then
    v_is_late := true;
  end if;

  if p_decision = 'confirm' then
    if v_session.status = 'cancelled' then
      raise exception 'receipt_not_eligible';
    end if;
    if v_is_late and not p_allow_late_confirmation then
      raise exception 'late_receipt_requires_explicit_confirmation';
    end if;

    select roster_student_id into v_claim from public.attendance_device_claims
    where session_id = v_receipt.session_id and installation_digest = v_receipt.installation_digest;

    if v_receipt.local_device_conflict or v_claim is distinct from v_receipt.roster_student_id or v_receipt.device_digest is null then
      raise exception 'device_conflict_requires_manual_attendance';
    end if;

    select * into v_roster from public.attendance_session_roster
    where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if not found then
      raise exception 'student_not_in_roster';
    end if;

    select * into v_record from public.attendance_records
    where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;
    if found and v_record.status = 'voided' then
      raise exception 'record_voided_use_restore';
    end if;

    if p_enroll_device then
      if exists (select 1 from public.attendance_enrolled_devices where device_digest = v_effective_device and roster_student_id <> v_receipt.roster_student_id) then
        raise exception 'device_enrolled_to_another_student';
      end if;
      insert into public.attendance_audit_events(session_id, actor_uid, action, reason, before_state, after_state)
      values (
        v_receipt.session_id, p_actor_uid, 'device_identity_verified', p_reason,
        (select to_jsonb(device) from public.attendance_enrolled_devices device where roster_student_id = v_receipt.roster_student_id),
        jsonb_build_object('studentId', v_receipt.roster_student_id, 'deviceDigest', v_effective_device)
      );
      insert into public.attendance_enrolled_devices(roster_student_id, device_digest, approved_by, source_receipt_id)
      values (v_receipt.roster_student_id, v_effective_device, p_actor_uid, p_receipt_id)
      on conflict (roster_student_id) do update
      set device_digest = excluded.device_digest, approved_by = excluded.approved_by, approved_at = now(), source_receipt_id = excluded.source_receipt_id;
    elsif not exists (select 1 from public.attendance_enrolled_devices where roster_student_id = v_receipt.roster_student_id and device_digest = v_effective_device) then
      raise exception 'device_enrollment_required';
    end if;

    insert into public.attendance_records(session_id, roster_student_id, student_uid, official_name_snapshot, entry_method, installation_digest, received_at, review_flags, advisory)
    values (v_receipt.session_id, v_receipt.roster_student_id, v_receipt.actor_uid, v_roster.official_name, 'qr', v_receipt.installation_digest, v_receipt.received_at, v_receipt.review_flags || array['professor_reviewed'], v_receipt.advisory)
    on conflict (session_id, roster_student_id) do nothing;

    select * into v_record from public.attendance_records
    where session_id = v_receipt.session_id and roster_student_id = v_receipt.roster_student_id;

    update public.attendance_receipts
    set resolution = 'confirmed',
        reason = case when v_is_late then 'professor_late_confirmation' else 'professor_confirmed' end,
        record_id = v_record.id,
        review_revision = v_receipt.review_revision + 1
    where request_id = p_receipt_id;
  else
    update public.attendance_receipts
    set resolution = 'invalid_evidence',
        reason = case when v_is_late then 'professor_late_rejection' else 'professor_rejected' end,
        review_revision = v_receipt.review_revision + 1
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

-- 6. Grant & Security Configuration
revoke execute on function public.attendance_create_key_rotation_challenge(text, text) from public, anon, authenticated;
grant execute on function public.attendance_create_key_rotation_challenge(text, text) to service_role;

revoke execute on function public.attendance_commit_key_rotation(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_commit_key_rotation(uuid, text, text, text, text, jsonb) to service_role;

revoke execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean, boolean) from public, anon, authenticated;
grant execute on function public.attendance_resolve_review(uuid, uuid, text, text, text, bigint, boolean, boolean) to service_role;

revoke execute on function public.attendance_receipt_result(uuid) from public, anon, authenticated;
grant execute on function public.attendance_receipt_result(uuid) to service_role;
