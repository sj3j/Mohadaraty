-- Physical attendance is optional and independent from the QR protocol.
alter table public.attendance_sessions
  add column if not exists physical_headcount integer;

alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_physical_headcount_check;
alter table public.attendance_sessions
  add constraint attendance_sessions_physical_headcount_check
  check (physical_headcount is null or physical_headcount between 0 and 10000);

alter table public.attendance_offline_grants add column if not exists expires_at timestamptz;

-- Preserve the historic value for reporting; new sessions use the nullable column.
update public.attendance_sessions
  set physical_headcount = expected_headcount
  where physical_headcount is null;

create function public.attendance_create_session_v2(
  p_term jsonb, p_occurrence jsonb, p_session jsonb, p_roster jsonb, p_challenge jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare v_result jsonb; v_count integer;
begin
  v_count := (p_session->>'physicalHeadcount')::integer;
  if v_count is not null and (v_count < 0 or v_count > 10000) then
    raise exception using errcode = '22023', message = 'invalid_headcount';
  end if;
  v_result := public.attendance_create_session(p_term, p_occurrence,
    p_session || jsonb_build_object('expectedHeadcount', 1), p_roster, p_challenge);
  if coalesce((v_result->>'existing')::boolean, false) = false then
    update public.attendance_sessions set physical_headcount = v_count
      where id = (v_result->>'sessionId')::uuid;
  end if;
  return v_result;
end;
$$;

revoke execute on function public.attendance_create_session_v2(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_create_session_v2(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

create function public.attendance_update_session_v2(
  p_request_id uuid, p_session_id uuid, p_actor_uid text, p_expected_revision bigint,
  p_physical_headcount integer, p_notes text, p_next_status text, p_reason text,
  p_physical_headcount_set boolean
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare v_session public.attendance_sessions%rowtype; v_before jsonb; v_audit public.attendance_audit_events%rowtype;
begin
  perform public.attendance_claim_command(p_request_id, p_actor_uid, 'session_update', p_session_id::text,
    jsonb_build_object('physicalHeadcount', p_physical_headcount, 'notes', p_notes, 'status', p_next_status, 'reason', p_reason));
  select * into v_audit from public.attendance_audit_events where request_id = p_request_id;
  if found then
    if v_audit.session_id <> p_session_id then raise exception using errcode = '22023', message = 'idempotency_conflict'; end if;
    select * into v_session from public.attendance_sessions where id = p_session_id;
    return jsonb_build_object('session', to_jsonb(v_session), 'existing', true);
  end if;
  select * into v_session from public.attendance_sessions where id = p_session_id for update;
  if not found then raise exception using errcode = '22023', message = 'unknown_session'; end if;
  if v_session.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'revision_conflict'; end if;
  if p_physical_headcount is not null and (p_physical_headcount < 0 or p_physical_headcount > 10000) then raise exception using errcode = '22023', message = 'invalid_headcount'; end if;
  if p_notes is not null and char_length(p_notes) > 2000 then raise exception using errcode = '22023', message = 'notes_too_long'; end if;
  if p_next_status is not null and p_next_status not in ('active', 'ended', 'finalized', 'cancelled') then raise exception using errcode = '22023', message = 'invalid_session_status'; end if;
  if v_session.status in ('finalized', 'cancelled') and coalesce(p_next_status, v_session.status) <> v_session.status then raise exception using errcode = '22023', message = 'session_not_editable'; end if;
  if p_next_status = 'finalized' and (now() < v_session.reconciliation_deadline or exists (select 1 from public.attendance_receipts where session_id = p_session_id and resolution = 'needs_review')) then raise exception using errcode = '22023', message = 'session_not_ready_to_finalize'; end if;
  v_before := to_jsonb(v_session);
  update public.attendance_sessions set
    physical_headcount = case when p_physical_headcount_set then p_physical_headcount else physical_headcount end,
    notes = coalesce(p_notes, notes), status = coalesce(p_next_status, status),
    ended_at = case when p_next_status = 'ended' and ended_at is null then now() else ended_at end,
    finalized_at = case when p_next_status = 'finalized' then now() else finalized_at end,
    revision = revision + 1
  where id = p_session_id returning * into v_session;
  insert into public.attendance_audit_events(request_id, session_id, actor_uid, action, reason, before_state, after_state)
  values (p_request_id, p_session_id, p_actor_uid, case when p_next_status is null then 'session_updated' else 'session_' || p_next_status end, p_reason, v_before, to_jsonb(v_session));
  return jsonb_build_object('session', to_jsonb(v_session), 'existing', false);
end;
$$;

revoke execute on function public.attendance_update_session_v2(uuid, uuid, text, bigint, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.attendance_update_session_v2(uuid, uuid, text, bigint, integer, text, text, text, boolean) to service_role;

-- A static QR remains valid evidence, but evidence first received after a server-recorded
-- close must be reviewed rather than silently becoming a confirmed record.
alter function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb)
  rename to attendance_submit_receipt_before_session_close_review;

create function public.attendance_submit_receipt(
  p_request_id uuid, p_actor_uid text, p_roster_student_id text, p_payload_hash text,
  p_session_id uuid, p_challenge_id uuid, p_token_hash text, p_installation_digest text,
  p_client_reported_at timestamptz, p_device_digest text, p_local_device_conflict boolean, p_advisory jsonb
)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '5s' as $$
declare v_closed boolean; v_existing boolean; v_result jsonb;
begin
  select status = 'ended' into v_closed from public.attendance_sessions where id = p_session_id;
  select exists(select 1 from public.attendance_receipts where request_id = p_request_id) into v_existing;
  v_result := public.attendance_submit_receipt_before_session_close_review(
    p_request_id, p_actor_uid, p_roster_student_id, p_payload_hash, p_session_id, p_challenge_id,
    p_token_hash, p_installation_digest, p_client_reported_at, p_device_digest, p_local_device_conflict,
    case when coalesce(v_closed, false) and not v_existing
      then jsonb_set(p_advisory, '{locationStatus}', '"session_ended"'::jsonb)
      else p_advisory end
  );
  if coalesce(v_closed, false) and not v_existing and v_result->>'reason' = 'location_unavailable' then
    update public.attendance_receipts set reason = 'session_ended',
      review_flags = array(select distinct flag from unnest(review_flags || array['session_ended']) flag)
      where request_id = p_request_id;
    return public.attendance_receipt_result(p_request_id);
  end if;
  return v_result;
end;
$$;

revoke execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.attendance_submit_receipt(uuid, text, text, text, uuid, uuid, text, text, timestamptz, text, boolean, jsonb) to service_role;
