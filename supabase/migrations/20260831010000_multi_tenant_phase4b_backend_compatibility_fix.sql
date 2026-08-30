-- Multi-Tenant Phase 4B Backend Compatibility Fix.
--
-- Additive follow-up to 20260831000000 - does not modify that or any other
-- historical migration. Fixes the two blockers found during local
-- verification of the Phase 4B Frontend Cutover (see CURRENT_STATUS.md).
--
-- PART A - NULL-COORDINATOR COMPATIBILITY (9 _core functions).
-- 9 of 20260831000000's Section 2 _core functions read their `coordinator`
-- snapshot RAW before inserting it into election_day_reminder_events/
-- election_day_ride_status_events (`coordinator` is NOT NULL on both) -
-- election_day_voters.coordinator is nullable by design (a voter may be
-- imported before coordinator allocation runs), so any of these against a
-- coordinator-less voter raised a live 23502 not-null-violation
-- (confirmed empirically against the local stack, not just read in the
-- SQL). 6 of the 9 (election_day_set_reminder_core/close_reminder_core/
-- cancel_reminder_core/set_voted_core/set_non_voting_reason_core, plus the
-- non-RPC-predecessor election_day_set_ride_arranged_core) are genuine
-- Phase 4B regressions - their legacy counterparts are confirmed null-safe
-- (the RPCs via the exact `coalesce(coordinator, '')` fix already shipped
-- in 20260812090200_election_day_reminder_lifecycle_null_coordinator_
-- hardening.sql "Coordinator Allocation Management Phase 2"; setRideArranged's
-- legacy 3-REST-call path via client-side coercion in
-- SupabaseElectionDayApi's toVoter()). election_day_record_no_answer_core/
-- record_call_answered_core/extend_no_answer_streak_threshold_core have
-- this exact same missing-coalesce gap already in their CURRENT legacy RPCs
-- too (not a new regression for these 3) - fixed here in the new trusted
-- _core path only, per this fix's own scope; the legacy RPCs themselves are
-- deliberately left untouched.
--
-- Fix technique: identical to 20260812090200's own fix - coalesce at the
-- `select ... into v_coordinator` point, so every downstream read of
-- v_coordinator (used only for the audit-trail INSERT in every one of these
-- functions) is never null. No other business logic, permission check,
-- transaction boundary, event semantics, or response contract changes -
-- every function body below is byte-identical to its 20260831000000
-- definition except that one `coordinator` -> `coalesce(coordinator, '')`
-- substitution. `create or replace function` on an unchanged signature
-- preserves the function's existing ACL (Postgres does not reset
-- privileges on a same-signature replace) - the explicit revokes below are
-- re-asserted anyway, matching this project's own established paranoid
-- convention for anything touching a privileged function, not because
-- Postgres requires it here.
--
-- PART B - requiresFollowUp on create/update non-voting-reason.
-- election_day_create_non_voting_reason_core/_v3/_owner_v3 and
-- update_non_voting_reason_core/_v3/_owner_v3 (20260831000000) never
-- accepted a p_requires_follow_up parameter at all, unlike the legacy RPCs
-- they'd replace - the live "ניהול סיבות אי-הצבעה" create/update UI form
-- always sends this field. Adds a 4th parameter
-- (`p_requires_follow_up boolean default true`, matching the legacy RPC's
-- own default) to each - a NEW function overload (Postgres identifies a
-- function by name + argument list; a changed argument count is a distinct
-- function, not a replacement of the 3-arg version), so it needs its own
-- explicit revoke/grant (CLAUDE.md's permanent guardrail: every new
-- privileged function must explicitly revoke from PUBLIC/anon/authenticated
-- then grant only to the intended role). The existing 3-arg versions are
-- left completely untouched (not dropped, not altered) -
-- src/services/api/index.ts still routes createNonVotingReason/
-- updateNonVotingReason to the legacy RPC path; this migration only makes
-- the trusted path capable of the cutover, it does not perform the cutover
-- itself (frontend delegation change is explicitly out of scope for this
-- migration).
begin;

-- ============================================================================
-- PART A - NULL-COORDINATOR COMPATIBILITY
-- ============================================================================

create or replace function public.election_day_set_ride_arranged_core(
  p_workspace_id uuid, p_id uuid, p_arranged boolean
)
returns setof public.election_day_voters
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
  v_contact_name text;
  v_coordinator text;
begin
  select ride_arranged, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_before, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'VOTER_NOT_FOUND';
  end if;

  update public.election_day_voters
  set ride_arranged = p_arranged,
      ride_arranged_at = case when p_arranged then now() else null end,
      updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  insert into public.election_day_ride_status_events
    (workspace_id, contact_id, contact_name, coordinator, from_arranged, to_arranged)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, v_before, p_arranged);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_set_ride_arranged_core(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_reminder_core(p_workspace_id uuid, p_id uuid, p_reminder_at timestamptz, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  if v_old_reminder_at is not null and v_old_reminder_at = p_reminder_at then
    return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = p_reminder_at, reminder_closed_at = null, reminder_closed_reason = null, reminder_closed_by = null, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  if v_old_reminder_at is not null then
    insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'rescheduled', v_old_reminder_at, null, p_actor_name);
  end if;

  insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'created', p_reminder_at, null, p_actor_name);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_set_reminder_core(uuid, uuid, timestamptz, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_close_reminder_core(p_workspace_id uuid, p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;
  if v_old_reminder_at is null then
    return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = null, reminder_closed_at = now(), reminder_closed_reason = 'handled', reminder_closed_by = p_actor_name, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'handled', p_actor_name);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_close_reminder_core(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_cancel_reminder_core(p_workspace_id uuid, p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;
  if v_old_reminder_at is null then
    return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = null, reminder_closed_at = now(), reminder_closed_reason = 'cancelled', reminder_closed_by = p_actor_name, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'cancelled', v_old_reminder_at, null, p_actor_name);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_cancel_reminder_core(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_voted_core(p_workspace_id uuid, p_id uuid, p_voted boolean, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text; v_close boolean;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  v_close := p_voted and v_old_reminder_at is not null;

  update public.election_day_voters
  set voted = p_voted,
      voted_at = case when p_voted then now() else null end,
      reminder_at = case when v_close then null else reminder_at end,
      reminder_closed_at = case when v_close then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close then 'voted' else reminder_closed_reason end,
      reminder_closed_by = case when v_close then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  if v_close then
    insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'voted', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_set_voted_core(uuid, uuid, boolean, text) from public, anon, authenticated, service_role;

-- Shared by BOTH split actions (general setNonVotingReason + closeCallAsNoAnswer).
create or replace function public.election_day_set_non_voting_reason_core(p_workspace_id uuid, p_id uuid, p_reason_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text;
  v_requires_follow_up boolean; v_close boolean;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  if p_reason_id is not null then
    select requires_follow_up into v_requires_follow_up
    from public.election_day_not_voting_reasons
    where id = p_reason_id and workspace_id = p_workspace_id;
  end if;

  v_close := p_reason_id is not null and coalesce(v_requires_follow_up, true) = false and v_old_reminder_at is not null;

  update public.election_day_voters
  set not_voting_reason_id = p_reason_id,
      not_voting_reason_set_at = case when p_reason_id is not null then now() else null end,
      not_voting_reason_set_by = case when p_reason_id is not null then p_actor_name else null end,
      reminder_at = case when v_close then null else reminder_at end,
      reminder_closed_at = case when v_close then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close then 'case_closed' else reminder_closed_reason end,
      reminder_closed_by = case when v_close then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  if v_close then
    insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'case_closed', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_core(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_record_no_answer_core(p_workspace_id uuid, p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_contact_name text; v_coordinator text; v_pending uuid; v_streak integer; v_threshold integer;
begin
  select first_name || ' ' || last_name, coalesce(coordinator, ''), pending_call_id, no_answer_streak, no_answer_streak_threshold
    into v_contact_name, v_coordinator, v_pending, v_streak, v_threshold
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  if v_pending is null or v_pending <> p_call_id or v_streak >= v_threshold then
    return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
    return;
  end if;

  update public.election_day_voters
  set no_answer_streak = no_answer_streak + 1, pending_call_id = null, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'no_answer', p_actor_name);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_record_no_answer_core(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_record_call_answered_core(p_workspace_id uuid, p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_contact_name text; v_coordinator text; v_pending uuid;
begin
  select first_name || ' ' || last_name, coalesce(coordinator, ''), pending_call_id
    into v_contact_name, v_coordinator, v_pending
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  if v_pending is null or v_pending <> p_call_id then
    return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
    return;
  end if;

  update public.election_day_voters
  set no_answer_streak = 0, no_answer_streak_threshold = 3, pending_call_id = null, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id;

  insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'answered', p_actor_name);

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_record_call_answered_core(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_extend_no_answer_streak_threshold_core(p_workspace_id uuid, p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_contact_name text; v_coordinator text;
begin
  select first_name || ' ' || last_name, coalesce(coordinator, '') into v_contact_name, v_coordinator
  from public.election_day_voters where id = p_id and workspace_id = p_workspace_id for update;
  if not found then raise exception 'VOTER_NOT_FOUND'; end if;

  update public.election_day_voters
  set no_answer_streak_threshold = no_answer_streak_threshold + 3, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
    and no_answer_streak = no_answer_streak_threshold and no_answer_streak_threshold = 3;

  if found then
    insert into public.election_day_reminder_events (workspace_id, contact_id, contact_name, coordinator, event_type, actor_name)
    values (p_workspace_id, p_id, v_contact_name, v_coordinator, 'streak_extended', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_extend_no_answer_streak_threshold_core(uuid, uuid, text) from public, anon, authenticated, service_role;

commit;

-- ============================================================================
-- PART B - requiresFollowUp ON CREATE/UPDATE NON-VOTING-REASON (4-arg overloads)
-- ============================================================================
begin;

create or replace function public.election_day_create_non_voting_reason_core(
  p_workspace_id uuid, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_next_sort integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if p_name is null or btrim(p_name) = '' then raise exception 'REASON_NAME_REQUIRED'; end if;

  select coalesce(max(sort_order), -1) + 1 into v_next_sort
  from public.election_day_not_voting_reasons where workspace_id = p_workspace_id;

  insert into public.election_day_not_voting_reasons (workspace_id, name, description, sort_order, requires_follow_up)
  values (p_workspace_id, btrim(p_name), coalesce(p_description, ''), v_next_sort, coalesce(p_requires_follow_up, true))
  returning id into v_id;

  return (select r from public.election_day_not_voting_reasons r where r.id = v_id);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_core(uuid, text, text, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_update_non_voting_reason_core(
  p_workspace_id uuid, p_id uuid, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if not exists (select 1 from public.election_day_not_voting_reasons where id = p_id and workspace_id = p_workspace_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'REASON_NAME_REQUIRED'; end if;

  update public.election_day_not_voting_reasons
  set name = btrim(p_name), description = coalesce(p_description, ''), requires_follow_up = coalesce(p_requires_follow_up, true)
  where id = p_id and workspace_id = p_workspace_id;

  return (select r from public.election_day_not_voting_reasons r where r.id = p_id);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_core(uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_create_non_voting_reason_v3(
  p_session_hash bytea, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_create_non_voting_reason_core(v_workspace_id, p_name, p_description, p_requires_follow_up);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_v3(bytea, text, text, boolean) from public, anon, authenticated;
grant execute on function public.election_day_create_non_voting_reason_v3(bytea, text, text, boolean) to service_role;

create or replace function public.election_day_create_non_voting_reason_owner_v3(
  p_auth_user_id uuid, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_create_non_voting_reason_core(v_workspace_id, p_name, p_description, p_requires_follow_up);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_owner_v3(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.election_day_create_non_voting_reason_owner_v3(uuid, text, text, boolean) to service_role;

create or replace function public.election_day_update_non_voting_reason_v3(
  p_session_hash bytea, p_id uuid, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_update_non_voting_reason_core(v_workspace_id, p_id, p_name, p_description, p_requires_follow_up);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_v3(bytea, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.election_day_update_non_voting_reason_v3(bytea, uuid, text, text, boolean) to service_role;

create or replace function public.election_day_update_non_voting_reason_owner_v3(
  p_auth_user_id uuid, p_id uuid, p_name text, p_description text, p_requires_follow_up boolean default true
)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_update_non_voting_reason_core(v_workspace_id, p_id, p_name, p_description, p_requires_follow_up);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_owner_v3(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.election_day_update_non_voting_reason_owner_v3(uuid, uuid, text, text, boolean) to service_role;

commit;
