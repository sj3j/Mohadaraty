update public.attendance_sessions session set reconciliation_deadline = occurrence.end_at + interval '36 hours'
from public.attendance_occurrences occurrence where occurrence.id = session.occurrence_id;

create function public.attendance_fixed_deadline()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    select end_at + interval '36 hours' into strict new.reconciliation_deadline
    from public.attendance_occurrences where id = new.occurrence_id;
  else
    new.reconciliation_deadline := old.reconciliation_deadline;
    if new.occurrence_id <> old.occurrence_id then raise exception 'invalid_occurrence_change'; end if;
    if old.status = 'ended' and new.status = 'active' then raise exception 'session_not_editable'; end if;
  end if;
  return new;
end;
$$;
create trigger attendance_fixed_deadline before insert or update on public.attendance_sessions
for each row execute function public.attendance_fixed_deadline();

create table public.attendance_offline_grants (
  id uuid primary key,
  professor_uid text not null,
  stage_id text not null,
  token_hash text not null unique check (length(token_hash) = 64),
  term jsonb not null,
  occurrences jsonb not null,
  roster jsonb not null,
  session_ids jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index attendance_offline_grants_professor_idx on public.attendance_offline_grants(professor_uid, stage_id);
alter table public.attendance_offline_grants enable row level security;
revoke all on public.attendance_offline_grants from public, anon, authenticated;
grant select, insert, update on public.attendance_offline_grants to service_role;

create function public.attendance_import_offline_session(p_grant_id uuid, p_grant_hash text, p_occurrence_id text, p_session_id uuid, p_challenge_id uuid, p_qr_token text, p_token_hash text, p_headcount integer)
returns jsonb language plpgsql security invoker set search_path = '' set statement_timeout = '10s' as $$
declare
  v_grant public.attendance_offline_grants%rowtype;
  v_occurrence jsonb;
  v_result jsonb;
begin
  select * into v_grant from public.attendance_offline_grants where id = p_grant_id and token_hash = p_grant_hash and revoked_at is null for share;
  if not found then raise exception 'invalid_offline_grant'; end if;
  v_occurrence := v_grant.occurrences->p_occurrence_id;
  if v_occurrence is null or (v_grant.session_ids->>p_occurrence_id)::uuid is distinct from p_session_id then raise exception 'invalid_offline_occurrence'; end if;
  perform pg_advisory_xact_lock(hashtextextended('attendance-occurrence:' || p_occurrence_id, 0));
  v_result := public.attendance_create_session(v_grant.term, v_occurrence,
    jsonb_build_object('id', p_session_id, 'requestId', p_session_id, 'professorUid', v_grant.professor_uid,
      'expectedHeadcount', p_headcount, 'notes', '', 'reconciliationDeadline', (v_occurrence->>'endAt')::timestamptz + interval '36 hours'),
    v_grant.roster,
    jsonb_build_object('id', p_challenge_id, 'tokenHash', p_token_hash, 'qrToken', p_qr_token, 'keyId', 'offline:' || p_grant_id::text));
  if (v_result->>'sessionId')::uuid <> p_session_id then raise exception 'offline_session_conflict'; end if;
  perform 1 from public.attendance_sessions where id = p_session_id for update;
  insert into public.attendance_challenges(id, session_id, token_hash, qr_token, key_id)
  values(p_challenge_id, p_session_id, p_token_hash, p_qr_token, 'offline:' || p_grant_id::text)
  on conflict (id) do nothing;
  if not exists (select 1 from public.attendance_challenges where id = p_challenge_id and session_id = p_session_id and token_hash = p_token_hash and revoked_at is null) then raise exception 'invalid_challenge'; end if;
  return v_result;
end;
$$;
revoke execute on function public.attendance_fixed_deadline() from public, anon, authenticated;
revoke execute on function public.attendance_import_offline_session(uuid, text, text, uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.attendance_fixed_deadline() to service_role;
grant execute on function public.attendance_import_offline_session(uuid, text, text, uuid, uuid, text, text, integer) to service_role;
