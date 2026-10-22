-- Signed scan-location proof and automatic on-campus confirmation.
-- This is additive: existing V1 receipts remain reviewable and historical
-- records are deliberately not reclassified.

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
  v_claim text; v_enrolled text; v_effective_device text;
  v_resolution text := 'needs_review'; v_reason text := 'location_unavailable';
  v_flags text[] := '{}'; v_received_at timestamptz := now();
  v_is_late boolean := false;
  v_auto_enrolled boolean := false;
  v_location_verified boolean := coalesce(
    p_advisory->>'locationStatus' = 'on_campus'
    and (p_advisory->>'signedLocationProofVersion')::integer = 2, false);
begin
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'receipt', p_session_id::text,
    jsonb_build_object('hash', p_payload_hash));
  perform pg_advisory_xact_lock(hashtextextended('attendance-student:' || p_roster_student_id, 0));
  if p_device_digest is not null then
    perform pg_advisory_xact_lock(hashtextextended('attendance-device:' || p_device_digest, 0));
  end if;
  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception 'unknown_session'; end if;
  select * into v_receipt from public.attendance_receipts where request_id = p_request_id;
  if found then
    if v_receipt.actor_uid <> p_actor_uid or v_receipt.payload_hash <> p_payload_hash then raise exception 'idempotency_conflict'; end if;
    return public.attendance_receipt_result(p_request_id);
  end if;
  if not exists (select 1 from public.attendance_challenges
      where id = p_challenge_id and session_id = p_session_id and token_hash = p_token_hash and revoked_at is null) then
    raise exception 'invalid_challenge';
  end if;
  select coalesce(array_agg(flag), '{}') into v_flags
    from jsonb_array_elements_text(coalesce(p_advisory->'flags', '[]')) flag;
  select * into v_roster from public.attendance_session_roster
    where session_id = p_session_id and roster_student_id = p_roster_student_id;
  if not found then
    v_reason := 'roster_not_snapshotted';
  elsif v_received_at > v_session.reconciliation_deadline then
    v_is_late := true; v_reason := 'late_arrival'; v_flags := v_flags || array['late_arrival'];
    -- A late receipt remains review-only, but must retain the same shared-device
    -- protection as a timely receipt before a doctor can approve it.
    if p_device_digest is null or p_installation_digest is null then
      v_reason := 'device_unverified';
    else
      select canonical_device_digest into v_effective_device from public.attendance_key_aliases
        where alias_digest = p_device_digest;
      v_effective_device := coalesce(v_effective_device, p_device_digest);
      insert into public.attendance_device_claims(session_id, installation_digest, roster_student_id)
        values (p_session_id, p_installation_digest, p_roster_student_id) on conflict do nothing;
      select roster_student_id into v_claim from public.attendance_device_claims
        where session_id = p_session_id and installation_digest = p_installation_digest;
      if v_claim <> p_roster_student_id or p_local_device_conflict then
        v_reason := 'device_session_conflict';
        v_flags := v_flags || array['shared_installation'];
      end if;
    end if;
  elsif p_device_digest is null or p_installation_digest is null then
    v_reason := 'device_unverified';
  else
    select canonical_device_digest into v_effective_device from public.attendance_key_aliases
      where alias_digest = p_device_digest;
    v_effective_device := coalesce(v_effective_device, p_device_digest);
    insert into public.attendance_device_claims(session_id, installation_digest, roster_student_id)
      values (p_session_id, p_installation_digest, p_roster_student_id) on conflict do nothing;
    select roster_student_id into v_claim from public.attendance_device_claims
      where session_id = p_session_id and installation_digest = p_installation_digest;
    if v_claim <> p_roster_student_id or p_local_device_conflict then
      v_reason := 'device_session_conflict'; v_flags := v_flags || array['shared_installation'];
      update public.attendance_records set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag), revision = revision + 1
        where session_id = p_session_id and installation_digest = p_installation_digest;
      update public.attendance_receipts set review_flags = array(select distinct flag from unnest(review_flags || array['shared_installation']) flag)
        where session_id = p_session_id and installation_digest = p_installation_digest;
    elsif v_session.status in ('cancelled', 'finalized') then
      v_reason := 'session_' || v_session.status;
    elsif not v_location_verified then
      v_reason := case when p_advisory->>'locationStatus' = 'off_campus' then 'reported_off_campus' else 'location_unavailable' end;
    else
      select device_digest into v_enrolled from public.attendance_enrolled_devices
        where roster_student_id = p_roster_student_id for update;
      if found and v_enrolled <> v_effective_device then
        v_reason := 'device_change_required';
      else
        if not found then
          if exists (select 1 from public.attendance_enrolled_devices where device_digest = v_effective_device and roster_student_id <> p_roster_student_id) then
            v_reason := 'device_enrolled_to_another_student';
          else
            -- Insert after the receipt below: source_receipt_id is required and FK-protected.
            v_auto_enrolled := true;
          end if;
        end if;
        if v_reason = 'location_unavailable' then
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
  if v_auto_enrolled then
    insert into public.attendance_enrolled_devices(roster_student_id, device_digest, approved_by, source_receipt_id)
      values (p_roster_student_id, v_effective_device, p_actor_uid, p_request_id);
    insert into public.attendance_audit_events(session_id, actor_uid, action, reason, after_state)
      values (p_session_id, p_actor_uid, 'device_auto_enrolled', 'signed_on_campus_receipt',
        jsonb_build_object('studentId', p_roster_student_id, 'deviceDigest', v_effective_device));
  end if;
  return public.attendance_receipt_result(p_request_id);
end;
$$;

revoke execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) to service_role;
