-- Multi-Tenant Phase 4B: Backend EXPAND for the trusted voter/settings/
-- ride-coordinator/non-voting-reason domain (29 approved trusted actions).
--
-- Scope, exactly as approved across the full Phase 4B design closure:
--   - Dual principal: every action gets a `_core` (pure business logic,
--     workspace-scoped, no auth) + `_v3` (PermissionUser: session-hash
--     resolved actor/role/workspace, live permission check, NO reauth
--     step-up for routine actions) + `_owner_v3` (Owner: JWT-verified
--     auth_user_id resolved to workspace via election_day_resolve_owner_
--     context, intrinsic unconditional authority, no permission-string
--     check) wrapper - mirrors election_day_manage_coordinators_core/_v3/
--     _owner_v3's own already-proven shape (20260829030000), minus the
--     one-time reauth-proof step that shape uses (not required here -
--     approved decision: routine voter/ride/settings actions need no
--     password step-up for either principal).
--   - No client-supplied actor_name/actor_id/workspace_id/role/permissions
--     anywhere in a _v3/_owner_v3 signature - actor identity always comes
--     from election_day_resolve_session (PermissionUser: returns actor_id,
--     actor_name, role_id, workspace_id, confirmed live) or from
--     election_owners.name joined against the JWT-verified auth_user_id
--     (Owner - election_owners.name is a real, DB-stored, authoritative
--     column, confirmed present; election_day_resolve_owner_context itself
--     is left untouched, each Owner wrapper needing attribution does its
--     own tiny join rather than widening that shared function's contract).
--   - setNonVotingReason (general, voter.markVoted, accepts p_reason_id) and
--     closeCallAsNoAnswer (voter.viewPhone, accepts NO p_reason_id, resolves
--     the workspace's own 'לא עונה' row server-side, fails closed as
--     NO_ANSWER_REASON_NOT_CONFIGURED if absent) are two distinct trusted
--     actions sharing one election_day_set_non_voting_reason_core - per the
--     approved authorization-split closure. Confirmed live today:
--     workspace-local 'לא עונה' exists, requires_follow_up = false.
--   - setRideArranged becomes one atomic core function (voter UPDATE +
--     ride_status_events INSERT in one transaction) - fixes the pre-existing
--     gap where SupabaseElectionDayApi.setRideArranged issued 3 separate,
--     non-transactional REST calls.
--   - Read redaction: election_day_list_voters_core takes p_permissions
--     text[] - null means "no redaction" (Owner's intrinsic authority);
--     a PermissionUser's live permission array nulls every field the
--     resolved ELECTION_DAY_ROW_COLUMNS/permissionsMap.ts mapping excludes.
--   - Settings: new election_day_workspace_settings (workspace_id PK/FK,
--     deadline, updated_at), deterministic backfill (WHERE workspace_id IS
--     NOT NULL - copies Production's 1 real row, 0 rows on fresh DB, no
--     guessing), legacy election_day_settings left completely untouched
--     (still id boolean PK/CHECK, still workspace_id nullable), plus 3
--     bidirectional sync triggers (2 on the new table split by INSERT vs
--     UPDATE OF deadline to avoid an invalid combined-event WHEN referencing
--     OLD, 1 on the legacy table) - workspace match folded into the trigger
--     FUNCTION body (WHEN clauses cannot contain subqueries), same-
--     transaction, 1-hop-terminating (the return-trip write is always a
--     true no-op value-wise, so the receiving side's own WHEN/no-op stops
--     it), inert on fresh DB (legacy workspace_id is NULL, `= NULL` never
--     matches), never cross-workspace (function body's own WHERE clause).
--   - CoordinatorReminderSupervisionCard's read gets a backend/trusted-read
--     equivalent prepared (election_day_list_coordinators_v3 is already
--     exactly this - no new RPC needed, confirmed its authorization is
--     "any valid session," strictly no stricter than the legacy plain
--     SELECT it would replace) - frontend NOT cut over in this EXPAND.
--   - Legacy RPCs/`.update()` paths are 100% untouched - nothing revoked,
--     nothing dropped, no grant changed on any existing object.
--   - No RLS change. No frontend change. No Vercel/API file change (that is
--     this same package's own separate, additive TypeScript change, not
--     part of this SQL migration).
begin;

-- ============================================================================
-- SECTION 1 - SETTINGS: parallel per-workspace table + bidirectional sync
-- ============================================================================

create table if not exists public.election_day_workspace_settings (
  workspace_id uuid primary key references public.election_workspaces(id) on delete cascade,
  deadline     timestamptz,
  updated_at   timestamptz not null default now()
);

comment on table public.election_day_workspace_settings is
  'Multi-Tenant Phase 4B: per-workspace Election Day settings (currently just the countdown deadline), one row per workspace via PRIMARY KEY(workspace_id) - the structurally-correct replacement for election_day_settings'' impossible-to-extend boolean singleton PK. election_day_settings itself is left completely untouched and stays the frontend''s live read/write path until a separate, later, explicitly-approved frontend cutover + Contract retirement.';

drop trigger if exists election_day_workspace_settings_set_updated_at on public.election_day_workspace_settings;
create trigger election_day_workspace_settings_set_updated_at
  before update on public.election_day_workspace_settings
  for each row
  execute function public.election_day_set_updated_at();

alter table public.election_day_workspace_settings enable row level security;
-- No public policy: identical trust posture to every other Phase 3/4 v3-only
-- table (election_day_reauth_proofs, election_day_sessions) - reachable only
-- via the service_role-only _v3/_owner_v3 RPCs below, never anon/authenticated
-- directly. This is a NEW table with no legacy anon/authenticated consumer to
-- preserve compatibility for, unlike election_day_settings.

-- Deterministic one-time backfill: copies exactly the legacy row(s) that
-- already carry a real workspace_id. On Production: copies the 1 real row
-- (confirmed live: workspace_id = 59b8df26-f290-4065-beec-587f35827e76). On a
-- fresh reset: the seed migration's row has workspace_id = NULL (no default,
-- predates the Phase 1 column) - this copies 0 rows, no special-casing, no
-- guessing, same statement either way.
insert into public.election_day_workspace_settings (workspace_id, deadline, updated_at)
select workspace_id, deadline, updated_at
from public.election_day_settings
where workspace_id is not null
on conflict (workspace_id) do nothing;

-- ----------------------------------------------------------------------------
-- Sync trigger 1/3 - legacy -> new. UPDATE-only (the legacy row's only
-- lifecycle event; its own seed INSERT never needs syncing, that's what the
-- backfill above already did once). Valid WHEN: OLD is always defined for
-- UPDATE.
-- ----------------------------------------------------------------------------
create or replace function public.election_day_sync_settings_to_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is not null then
    insert into public.election_day_workspace_settings (workspace_id, deadline, updated_at)
    values (new.workspace_id, new.deadline, new.updated_at)
    on conflict (workspace_id) do update
      set deadline = excluded.deadline, updated_at = excluded.updated_at;
  end if;
  return new;
end;
$$;

comment on function public.election_day_sync_settings_to_workspace() is
  'Multi-Tenant Phase 4B settings overlap: propagates a legacy election_day_settings.deadline write into election_day_workspace_settings for the same (single, PK-bound) workspace. No-ops when workspace_id is null (fresh DB, not yet backfilled). Temporary - removed in the future Contract step that retires the legacy table.';

-- Trigger functions are never meant to be invoked directly via RPC (Postgres
-- itself rejects a direct call to a `returns trigger` function outside a
-- real trigger context) - explicit revoke added anyway, matching this
-- project's own non-negotiable guardrail (CLAUDE.md: every new privileged
-- function must explicitly REVOKE EXECUTE from PUBLIC/anon/authenticated by
-- name - no exception for functions a default ACL wouldn't practically let
-- an attacker exploit).
revoke all on function public.election_day_sync_settings_to_workspace() from public, anon, authenticated, service_role;

drop trigger if exists election_day_settings_sync_to_workspace on public.election_day_settings;
create trigger election_day_settings_sync_to_workspace
  after update of deadline on public.election_day_settings
  for each row
  when (old.deadline is distinct from new.deadline)
  execute function public.election_day_sync_settings_to_workspace();

-- ----------------------------------------------------------------------------
-- Sync trigger 2+3/3 - new -> legacy, split into a plain AFTER INSERT trigger
-- (no WHEN - OLD does not exist for INSERT) and a separate AFTER UPDATE OF
-- deadline trigger (WHEN referencing OLD is valid here). Both call the same
-- function; the workspace-match check lives in the function body's own
-- UPDATE ... WHERE (a WHEN clause cannot contain a subquery - this is why
-- the check cannot live in a WHEN condition at all), so only a write for the
-- workspace the legacy singleton currently represents ever touches it -
-- never a cross-workspace write.
-- ----------------------------------------------------------------------------
create or replace function public.election_day_sync_workspace_to_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.election_day_settings
  set deadline = new.deadline, updated_at = new.updated_at
  where id = true and workspace_id = new.workspace_id;
  return new;
end;
$$;

comment on function public.election_day_sync_workspace_to_settings() is
  'Multi-Tenant Phase 4B settings overlap: propagates a trusted election_day_workspace_settings write back into the legacy election_day_settings singleton, ONLY when the write''s workspace_id matches the legacy row''s own current workspace_id (checked in this function body''s UPDATE ... WHERE, never in a trigger WHEN clause - WHEN cannot contain a subquery). Keeps a post-cutover frontend rollback to the legacy .eq("id",true) read correct. Never touches the legacy row for any other workspace. Temporary - removed in the future Contract step.';

revoke all on function public.election_day_sync_workspace_to_settings() from public, anon, authenticated, service_role;

drop trigger if exists election_day_workspace_settings_sync_insert on public.election_day_workspace_settings;
create trigger election_day_workspace_settings_sync_insert
  after insert on public.election_day_workspace_settings
  for each row
  execute function public.election_day_sync_workspace_to_settings();

drop trigger if exists election_day_workspace_settings_sync_update on public.election_day_workspace_settings;
create trigger election_day_workspace_settings_sync_update
  after update of deadline on public.election_day_workspace_settings
  for each row
  when (old.deadline is distinct from new.deadline)
  execute function public.election_day_sync_workspace_to_settings();

-- ----------------------------------------------------------------------------
-- Trusted settings get/set - core + dual-principal wrappers.
-- ----------------------------------------------------------------------------
create or replace function public.election_day_get_settings_core(p_workspace_id uuid)
returns timestamptz
language sql
security definer
set search_path = ''
stable
as $$
  select deadline from public.election_day_workspace_settings where workspace_id = p_workspace_id;
$$;

revoke all on function public.election_day_get_settings_core(uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_settings_core(p_workspace_id uuid, p_deadline timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.election_day_workspace_settings (workspace_id, deadline)
  values (p_workspace_id, p_deadline)
  on conflict (workspace_id) do update set deadline = excluded.deadline;
  return p_deadline;
end;
$$;

revoke all on function public.election_day_set_settings_core(uuid, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.election_day_get_settings_v3(p_session_hash bytea)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  return public.election_day_get_settings_core(v_workspace_id);
end;
$$;

comment on function public.election_day_get_settings_v3(bytea) is
  'Multi-Tenant Phase 4B: PermissionUser-authorized settings read - any valid session (no permission-string check, matches election_day_list_coordinators_v3''s own read-access posture). Returns null deadline, not an error, when the workspace has no settings row yet - never depends on a workspace-creation flow having run first.';

revoke all on function public.election_day_get_settings_v3(bytea) from public;
revoke all on function public.election_day_get_settings_v3(bytea) from anon;
revoke all on function public.election_day_get_settings_v3(bytea) from authenticated;
grant execute on function public.election_day_get_settings_v3(bytea) to service_role;

create or replace function public.election_day_set_settings_v3(p_session_hash bytea, p_deadline timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select ('electionDay.manageSettings' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return public.election_day_set_settings_core(v_workspace_id, p_deadline);
end;
$$;

comment on function public.election_day_set_settings_v3(bytea, timestamptz) is
  'Multi-Tenant Phase 4B: PermissionUser-authorized settings write, requires electionDay.manageSettings on the resolved actor''s current role, read live. No password step-up (routine action). Upserts election_day_workspace_settings via election_day_set_settings_core - the bidirectional sync triggers above keep the legacy singleton current for rollback safety.';

revoke all on function public.election_day_set_settings_v3(bytea, timestamptz) from public;
revoke all on function public.election_day_set_settings_v3(bytea, timestamptz) from anon;
revoke all on function public.election_day_set_settings_v3(bytea, timestamptz) from authenticated;
grant execute on function public.election_day_set_settings_v3(bytea, timestamptz) to service_role;

create or replace function public.election_day_get_settings_owner_v3(p_auth_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_get_settings_core(v_workspace_id);
end;
$$;

revoke all on function public.election_day_get_settings_owner_v3(uuid) from public;
revoke all on function public.election_day_get_settings_owner_v3(uuid) from anon;
revoke all on function public.election_day_get_settings_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_get_settings_owner_v3(uuid) to service_role;

create or replace function public.election_day_set_settings_owner_v3(p_auth_user_id uuid, p_deadline timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_set_settings_core(v_workspace_id, p_deadline);
end;
$$;

comment on function public.election_day_set_settings_owner_v3(uuid, timestamptz) is
  'Multi-Tenant Phase 4B: Owner-authorized settings write - being the resolved Owner of the row''s own workspace IS the authorization (no permission-string check), mirroring election_day_manage_coordinators_owner_v3''s own approved, non-negotiable authorization decision. NOT wired into any live frontend route yet (no Owner Election Day UI exists).';

revoke all on function public.election_day_set_settings_owner_v3(uuid, timestamptz) from public;
revoke all on function public.election_day_set_settings_owner_v3(uuid, timestamptz) from anon;
revoke all on function public.election_day_set_settings_owner_v3(uuid, timestamptz) from authenticated;
grant execute on function public.election_day_set_settings_owner_v3(uuid, timestamptz) to service_role;

commit;

-- ============================================================================
-- SECTION 2 - VOTER MUTATIONS (15 trusted actions: the 14 approved voter
-- mutations with election_day_set_non_voting_reason split into 2 - general +
-- closeCallAsNoAnswer, per the approved authorization-split closure).
-- Business logic in every _core function below is copied verbatim from the
-- corresponding existing security-invoker/definer RPC (20260810120000,
-- 20260806190000, 20260820010000) - only the auth/parameter shape changes.
-- ============================================================================
begin;

-- ----------------------------------------------------------------------------
-- 2.1 setRideArranged - NEW: one atomic core (voter UPDATE + ride_status_
-- events INSERT in one function body/transaction), fixing the pre-existing
-- 3-separate-REST-calls non-atomicity in SupabaseElectionDayApi.setRideArranged.
-- ----------------------------------------------------------------------------
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
  select ride_arranged, first_name || ' ' || last_name, coordinator
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

-- ----------------------------------------------------------------------------
-- 2.2-2.15: shared voter-row helper cores. Each takes p_workspace_id first
-- (every WHERE clause is scoped by id AND workspace_id together, so a
-- cross-workspace p_id simply matches zero rows - VOTER_NOT_FOUND, never a
-- cross-workspace mutation).
-- ----------------------------------------------------------------------------
create or replace function public.election_day_set_ride_requested_core(p_workspace_id uuid, p_id uuid, p_requested boolean)
returns setof public.election_day_voters
language sql security definer set search_path = '' as $$
  update public.election_day_voters
  set ride_requested = p_requested,
      ride_requested_at = case when p_requested then now() else null end,
      updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
  returning *;
$$;
revoke all on function public.election_day_set_ride_requested_core(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_ride_completed_core(p_workspace_id uuid, p_id uuid, p_completed boolean)
returns setof public.election_day_voters
language sql security definer set search_path = '' as $$
  update public.election_day_voters
  set ride_completed = p_completed,
      ride_completed_at = case when p_completed then now() else null end,
      updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
  returning *;
$$;
revoke all on function public.election_day_set_ride_completed_core(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_notes_core(p_workspace_id uuid, p_id uuid, p_notes text)
returns setof public.election_day_voters
language sql security definer set search_path = '' as $$
  update public.election_day_voters
  set notes = p_notes, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
  returning *;
$$;
revoke all on function public.election_day_set_notes_core(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_phone_core(p_workspace_id uuid, p_id uuid, p_phone text)
returns setof public.election_day_voters
language sql security definer set search_path = '' as $$
  update public.election_day_voters
  set phone = p_phone, updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
  returning *;
$$;
revoke all on function public.election_day_set_phone_core(uuid, uuid, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_reminder_core(p_workspace_id uuid, p_id uuid, p_reminder_at timestamptz, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_old_reminder_at timestamptz; v_contact_name text; v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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

create or replace function public.election_day_increment_call_attempts_core(p_workspace_id uuid, p_id uuid)
returns setof public.election_day_voters
language sql security definer set search_path = '' as $$
  update public.election_day_voters
  set call_attempts = call_attempts + 1, last_call_attempt_at = now(), pending_call_id = gen_random_uuid(), updated_at = now()
  where id = p_id and workspace_id = p_workspace_id
  returning *;
$$;
revoke all on function public.election_day_increment_call_attempts_core(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_record_no_answer_core(p_workspace_id uuid, p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare
  v_contact_name text; v_coordinator text; v_pending uuid; v_streak integer; v_threshold integer;
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, no_answer_streak, no_answer_streak_threshold
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
  select first_name || ' ' || last_name, coordinator, pending_call_id
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
  select first_name || ' ' || last_name, coordinator into v_contact_name, v_coordinator
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
-- SECTION 3 - VOTER MUTATION WRAPPERS (_v3 / _owner_v3), 15 x 2 = 30
-- functions. Every _v3 resolves (actor_id, actor_name, role_id, workspace_id)
-- from election_day_resolve_session, checks the one live permission string
-- on the resolved role, then delegates - no p_actor_name/p_workspace_id
-- parameter anywhere. Every _owner_v3 resolves workspace_id from election_
-- day_resolve_owner_context and, where actor attribution is needed, joins
-- election_owners.name for the verified auth_user_id (that function itself
-- is left untouched - a small local join, not a widened shared contract).
-- No password step-up on any of these 30 (routine actions, approved).
-- ============================================================================
begin;

create or replace function public.election_day_set_ride_arranged_v3(p_session_hash bytea, p_id uuid, p_arranged boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageRide' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_ride_arranged_core(v_workspace_id, p_id, p_arranged);
end;
$$;
revoke all on function public.election_day_set_ride_arranged_v3(bytea, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_arranged_v3(bytea, uuid, boolean) to service_role;

create or replace function public.election_day_set_ride_arranged_owner_v3(p_auth_user_id uuid, p_id uuid, p_arranged boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_set_ride_arranged_core(v_workspace_id, p_id, p_arranged);
end;
$$;
revoke all on function public.election_day_set_ride_arranged_owner_v3(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_arranged_owner_v3(uuid, uuid, boolean) to service_role;

create or replace function public.election_day_set_ride_requested_v3(p_session_hash bytea, p_id uuid, p_requested boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageRide' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_ride_requested_core(v_workspace_id, p_id, p_requested);
end;
$$;
revoke all on function public.election_day_set_ride_requested_v3(bytea, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_requested_v3(bytea, uuid, boolean) to service_role;

create or replace function public.election_day_set_ride_requested_owner_v3(p_auth_user_id uuid, p_id uuid, p_requested boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_set_ride_requested_core(v_workspace_id, p_id, p_requested);
end;
$$;
revoke all on function public.election_day_set_ride_requested_owner_v3(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_requested_owner_v3(uuid, uuid, boolean) to service_role;

create or replace function public.election_day_set_ride_completed_v3(p_session_hash bytea, p_id uuid, p_completed boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageRide' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_ride_completed_core(v_workspace_id, p_id, p_completed);
end;
$$;
revoke all on function public.election_day_set_ride_completed_v3(bytea, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_completed_v3(bytea, uuid, boolean) to service_role;

create or replace function public.election_day_set_ride_completed_owner_v3(p_auth_user_id uuid, p_id uuid, p_completed boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_set_ride_completed_core(v_workspace_id, p_id, p_completed);
end;
$$;
revoke all on function public.election_day_set_ride_completed_owner_v3(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_ride_completed_owner_v3(uuid, uuid, boolean) to service_role;

create or replace function public.election_day_set_notes_v3(p_session_hash bytea, p_id uuid, p_notes text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.editNotes' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_notes_core(v_workspace_id, p_id, p_notes);
end;
$$;
revoke all on function public.election_day_set_notes_v3(bytea, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_set_notes_v3(bytea, uuid, text) to service_role;

create or replace function public.election_day_set_notes_owner_v3(p_auth_user_id uuid, p_id uuid, p_notes text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_set_notes_core(v_workspace_id, p_id, p_notes);
end;
$$;
revoke all on function public.election_day_set_notes_owner_v3(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_set_notes_owner_v3(uuid, uuid, text) to service_role;

create or replace function public.election_day_set_phone_v3(p_session_hash bytea, p_id uuid, p_phone text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.editPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_phone_core(v_workspace_id, p_id, p_phone);
end;
$$;
revoke all on function public.election_day_set_phone_v3(bytea, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_set_phone_v3(bytea, uuid, text) to service_role;

create or replace function public.election_day_set_phone_owner_v3(p_auth_user_id uuid, p_id uuid, p_phone text)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_set_phone_core(v_workspace_id, p_id, p_phone);
end;
$$;
revoke all on function public.election_day_set_phone_owner_v3(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_set_phone_owner_v3(uuid, uuid, text) to service_role;

create or replace function public.election_day_set_reminder_v3(p_session_hash bytea, p_id uuid, p_reminder_at timestamptz)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageReminder' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_reminder_core(v_workspace_id, p_id, p_reminder_at, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_reminder_v3(bytea, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.election_day_set_reminder_v3(bytea, uuid, timestamptz) to service_role;

create or replace function public.election_day_set_reminder_owner_v3(p_auth_user_id uuid, p_id uuid, p_reminder_at timestamptz)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_set_reminder_core(v_workspace_id, p_id, p_reminder_at, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_reminder_owner_v3(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.election_day_set_reminder_owner_v3(uuid, uuid, timestamptz) to service_role;

create or replace function public.election_day_close_reminder_v3(p_session_hash bytea, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageReminder' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_close_reminder_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_close_reminder_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_close_reminder_v3(bytea, uuid) to service_role;

create or replace function public.election_day_close_reminder_owner_v3(p_auth_user_id uuid, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_close_reminder_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_close_reminder_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_close_reminder_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_cancel_reminder_v3(p_session_hash bytea, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.manageReminder' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_cancel_reminder_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_cancel_reminder_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_cancel_reminder_v3(bytea, uuid) to service_role;

create or replace function public.election_day_cancel_reminder_owner_v3(p_auth_user_id uuid, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_cancel_reminder_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_cancel_reminder_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_cancel_reminder_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_set_voted_v3(p_session_hash bytea, p_id uuid, p_voted boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.markVoted' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_voted_core(v_workspace_id, p_id, p_voted, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_voted_v3(bytea, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_voted_v3(bytea, uuid, boolean) to service_role;

create or replace function public.election_day_set_voted_owner_v3(p_auth_user_id uuid, p_id uuid, p_voted boolean)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_set_voted_core(v_workspace_id, p_id, p_voted, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_voted_owner_v3(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_voted_owner_v3(uuid, uuid, boolean) to service_role;

-- General setNonVotingReason - voter.markVoted, accepts p_reason_id.
create or replace function public.election_day_set_non_voting_reason_v3(p_session_hash bytea, p_id uuid, p_reason_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.markVoted' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_set_non_voting_reason_core(v_workspace_id, p_id, p_reason_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_v3(bytea, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_set_non_voting_reason_v3(bytea, uuid, uuid) to service_role;

create or replace function public.election_day_set_non_voting_reason_owner_v3(p_auth_user_id uuid, p_id uuid, p_reason_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_set_non_voting_reason_core(v_workspace_id, p_id, p_reason_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_owner_v3(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_set_non_voting_reason_owner_v3(uuid, uuid, uuid) to service_role;

-- closeCallAsNoAnswer - voter.viewPhone, NO p_reason_id parameter. Resolves
-- the workspace's own 'לא עונה' row server-side; fails closed if absent -
-- structurally impossible for a viewPhone-only caller to set any other reason.
create or replace function public.election_day_close_call_as_no_answer_v3(p_session_hash bytea, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean; v_reason_id uuid;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;

  select id into v_reason_id from public.election_day_not_voting_reasons
  where workspace_id = v_workspace_id and name = 'לא עונה';
  if v_reason_id is null then raise exception 'NO_ANSWER_REASON_NOT_CONFIGURED'; end if;

  return query select * from public.election_day_set_non_voting_reason_core(v_workspace_id, p_id, v_reason_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_close_call_as_no_answer_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_close_call_as_no_answer_v3(bytea, uuid) to service_role;

create or replace function public.election_day_close_call_as_no_answer_owner_v3(p_auth_user_id uuid, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text; v_reason_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;

  select id into v_reason_id from public.election_day_not_voting_reasons
  where workspace_id = v_workspace_id and name = 'לא עונה';
  if v_reason_id is null then raise exception 'NO_ANSWER_REASON_NOT_CONFIGURED'; end if;

  return query select * from public.election_day_set_non_voting_reason_core(v_workspace_id, p_id, v_reason_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_close_call_as_no_answer_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_close_call_as_no_answer_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_increment_call_attempts_v3(p_session_hash bytea, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_increment_call_attempts_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_increment_call_attempts_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_increment_call_attempts_v3(bytea, uuid) to service_role;

create or replace function public.election_day_increment_call_attempts_owner_v3(p_auth_user_id uuid, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_increment_call_attempts_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_increment_call_attempts_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_increment_call_attempts_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_record_no_answer_v3(p_session_hash bytea, p_id uuid, p_call_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_record_no_answer_core(v_workspace_id, p_id, p_call_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_record_no_answer_v3(bytea, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_record_no_answer_v3(bytea, uuid, uuid) to service_role;

create or replace function public.election_day_record_no_answer_owner_v3(p_auth_user_id uuid, p_id uuid, p_call_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_record_no_answer_core(v_workspace_id, p_id, p_call_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_record_no_answer_owner_v3(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_record_no_answer_owner_v3(uuid, uuid, uuid) to service_role;

create or replace function public.election_day_record_call_answered_v3(p_session_hash bytea, p_id uuid, p_call_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_record_call_answered_core(v_workspace_id, p_id, p_call_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_record_call_answered_v3(bytea, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_record_call_answered_v3(bytea, uuid, uuid) to service_role;

create or replace function public.election_day_record_call_answered_owner_v3(p_auth_user_id uuid, p_id uuid, p_call_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_record_call_answered_core(v_workspace_id, p_id, p_call_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_record_call_answered_owner_v3(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_record_call_answered_owner_v3(uuid, uuid, uuid) to service_role;

create or replace function public.election_day_extend_no_answer_streak_threshold_v3(p_session_hash bytea, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_actor_name text; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id, r.actor_name into v_role_id, v_workspace_id, v_actor_name from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewPhone' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_extend_no_answer_streak_threshold_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_extend_no_answer_streak_threshold_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_extend_no_answer_streak_threshold_v3(bytea, uuid) to service_role;

create or replace function public.election_day_extend_no_answer_streak_threshold_owner_v3(p_auth_user_id uuid, p_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid; v_actor_name text;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  select o.name into v_actor_name from public.election_owners o where o.auth_user_id = p_auth_user_id;
  return query select * from public.election_day_extend_no_answer_streak_threshold_core(v_workspace_id, p_id, v_actor_name);
end;
$$;
revoke all on function public.election_day_extend_no_answer_streak_threshold_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_extend_no_answer_streak_threshold_owner_v3(uuid, uuid) to service_role;

commit;

-- ============================================================================
-- SECTION 4 - VOTER/EVENT READS (4 actions). election_day_list_voters_core
-- takes p_permissions text[] - null means unrestricted (Owner's intrinsic
-- authority, no redaction); a resolved PermissionUser role's live permissions
-- array nulls every field ELECTION_DAY_ROW_COLUMNS/permissionsMap.ts excludes.
-- ============================================================================
begin;

-- Column order below MUST exactly match public.election_day_voters' real
-- ordinal column order (`returns setof <table>` requires positional match,
-- confirmed the hard way via a fresh-reset LegacyMigrationApplyError on an
-- earlier draft that used the VoterRow TS-type order instead of the DB's
-- actual order - the two differ, e.g. created_at/updated_at sit between
-- voted_at and not_voting_reason_id in the DB, not at the end).
create or replace function public.election_day_list_voters_core(p_workspace_id uuid, p_permissions text[])
returns setof public.election_day_voters
language sql security definer set search_path = '' stable as $$
  select
    v.id,
    case when p_permissions is null or 'voter.viewMasad' = any(p_permissions) then v.masad else null end,
    case when p_permissions is null or 'voter.viewName' = any(p_permissions) then v.first_name else null end,
    case when p_permissions is null or 'voter.viewName' = any(p_permissions) then v.last_name else null end,
    case when p_permissions is null or 'voter.viewAddress' = any(p_permissions) then v.street else null end,
    case when p_permissions is null or 'voter.viewAddress' = any(p_permissions) then v.house_number else null end,
    case when p_permissions is null or 'voter.viewAddress' = any(p_permissions) then v.city else null end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.phone else null end,
    case when p_permissions is null or 'voter.viewCoordinator' = any(p_permissions) then v.coordinator else null end,
    case when p_permissions is null or 'voter.viewNotes' = any(p_permissions) then v.notes else null end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_requested else false end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_requested_at else null end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_arranged else false end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_arranged_at else null end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_completed else false end,
    case when p_permissions is null or 'voter.viewRideStatus' = any(p_permissions) then v.ride_completed_at else null end,
    case when p_permissions is null or 'voter.viewReminderStatus' = any(p_permissions) then v.reminder_at else null end,
    case when p_permissions is null or 'voter.viewVotedStatus' = any(p_permissions) then v.voted else false end,
    case when p_permissions is null or 'voter.viewVotedStatus' = any(p_permissions) then v.voted_at else null end,
    v.created_at,
    v.updated_at,
    case when p_permissions is null or 'voter.viewVotedStatus' = any(p_permissions) then v.not_voting_reason_id else null end,
    case when p_permissions is null or 'voter.viewVotedStatus' = any(p_permissions) then v.not_voting_reason_set_at else null end,
    case when p_permissions is null or 'voter.viewVotedStatus' = any(p_permissions) then v.not_voting_reason_set_by else null end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.call_attempts else 0 end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.call_attempts_threshold else 3 end,
    case when p_permissions is null or 'voter.viewReminderStatus' = any(p_permissions) then v.reminder_closed_at else null end,
    case when p_permissions is null or 'voter.viewReminderStatus' = any(p_permissions) then v.reminder_closed_reason else null end,
    case when p_permissions is null or 'voter.viewReminderStatus' = any(p_permissions) then v.reminder_closed_by else null end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.last_call_attempt_at else null end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.no_answer_streak else 0 end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.no_answer_streak_threshold else 3 end,
    case when p_permissions is null or 'voter.viewPhone' = any(p_permissions) then v.pending_call_id else null end,
    v.workspace_id
  from public.election_day_voters v
  where v.workspace_id = p_workspace_id;
$$;
revoke all on function public.election_day_list_voters_core(uuid, text[]) from public, anon, authenticated, service_role;

create or replace function public.election_day_list_voters_v3(p_session_hash bytea)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_permissions text[];
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select r.permissions into v_permissions from public.election_day_roles r where r.id = v_role_id;
  return query select * from public.election_day_list_voters_core(v_workspace_id, v_permissions);
end;
$$;
comment on function public.election_day_list_voters_v3(bytea) is
  'Multi-Tenant Phase 4B: PermissionUser-authorized voter list read - any valid session (no permission-string gate on the fetch itself, matches every other read in this domain), but every field excluded by the resolved role''s live permissions array is redacted server-side (never reaches the client), matching ELECTION_DAY_ROW_COLUMNS/permissionsMap.ts exactly.';
revoke all on function public.election_day_list_voters_v3(bytea) from public, anon, authenticated;
grant execute on function public.election_day_list_voters_v3(bytea) to service_role;

create or replace function public.election_day_list_voters_owner_v3(p_auth_user_id uuid)
returns setof public.election_day_voters
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_list_voters_core(v_workspace_id, null);
end;
$$;
comment on function public.election_day_list_voters_owner_v3(uuid) is
  'Multi-Tenant Phase 4B: Owner-authorized voter list read - intrinsic Owner authority, no field redaction (p_permissions = null). NOT wired into any live frontend route yet.';
revoke all on function public.election_day_list_voters_owner_v3(uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_voters_owner_v3(uuid) to service_role;

create or replace function public.election_day_list_reminder_events_core(p_workspace_id uuid, p_contact_id uuid)
returns setof public.election_day_reminder_events
language sql security definer set search_path = '' stable as $$
  select * from public.election_day_reminder_events
  where workspace_id = p_workspace_id and contact_id = p_contact_id
  order by created_at desc;
$$;
revoke all on function public.election_day_list_reminder_events_core(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_list_reminder_events_v3(p_session_hash bytea, p_contact_id uuid)
returns setof public.election_day_reminder_events
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('voter.viewReminderHistory' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_list_reminder_events_core(v_workspace_id, p_contact_id);
end;
$$;
revoke all on function public.election_day_list_reminder_events_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_reminder_events_v3(bytea, uuid) to service_role;

create or replace function public.election_day_list_reminder_events_owner_v3(p_auth_user_id uuid, p_contact_id uuid)
returns setof public.election_day_reminder_events
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_list_reminder_events_core(v_workspace_id, p_contact_id);
end;
$$;
revoke all on function public.election_day_list_reminder_events_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_reminder_events_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_list_ride_status_events_core(p_workspace_id uuid)
returns setof public.election_day_ride_status_events
language sql security definer set search_path = '' stable as $$
  select * from public.election_day_ride_status_events
  where workspace_id = p_workspace_id
  order by created_at desc;
$$;
revoke all on function public.election_day_list_ride_status_events_core(uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_list_ride_status_events_v3(p_session_hash bytea)
returns setof public.election_day_ride_status_events
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  return query select * from public.election_day_list_ride_status_events_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_ride_status_events_v3(bytea) from public, anon, authenticated;
grant execute on function public.election_day_list_ride_status_events_v3(bytea) to service_role;

create or replace function public.election_day_list_ride_status_events_owner_v3(p_auth_user_id uuid)
returns setof public.election_day_ride_status_events
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_list_ride_status_events_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_ride_status_events_owner_v3(uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_ride_status_events_owner_v3(uuid) to service_role;

create or replace function public.election_day_list_ride_coordinators_core(p_workspace_id uuid)
returns setof public.election_day_ride_coordinators
language sql security definer set search_path = '' stable as $$
  select * from public.election_day_ride_coordinators
  where workspace_id = p_workspace_id
  order by created_at asc;
$$;
revoke all on function public.election_day_list_ride_coordinators_core(uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_list_ride_coordinators_v3(p_session_hash bytea)
returns setof public.election_day_ride_coordinators
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  return query select * from public.election_day_list_ride_coordinators_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_ride_coordinators_v3(bytea) from public, anon, authenticated;
grant execute on function public.election_day_list_ride_coordinators_v3(bytea) to service_role;

create or replace function public.election_day_list_ride_coordinators_owner_v3(p_auth_user_id uuid)
returns setof public.election_day_ride_coordinators
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_list_ride_coordinators_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_ride_coordinators_owner_v3(uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_ride_coordinators_owner_v3(uuid) to service_role;

commit;

-- ============================================================================
-- SECTION 5 - RIDE-COORDINATOR ROSTER WRITES (2 actions).
-- ============================================================================
begin;

create or replace function public.election_day_add_ride_coordinator_core(p_workspace_id uuid, p_name text, p_phone text)
returns public.election_day_ride_coordinators
language sql security definer set search_path = '' as $$
  insert into public.election_day_ride_coordinators (workspace_id, name, phone)
  values (p_workspace_id, p_name, p_phone)
  returning *;
$$;
revoke all on function public.election_day_add_ride_coordinator_core(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_delete_ride_coordinator_core(p_workspace_id uuid, p_id uuid)
returns void
language sql security definer set search_path = '' as $$
  delete from public.election_day_ride_coordinators where id = p_id and workspace_id = p_workspace_id;
$$;
revoke all on function public.election_day_delete_ride_coordinator_core(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_add_ride_coordinator_v3(p_session_hash bytea, p_name text, p_phone text)
returns public.election_day_ride_coordinators
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageRideCoordinators' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_add_ride_coordinator_core(v_workspace_id, p_name, p_phone);
end;
$$;
revoke all on function public.election_day_add_ride_coordinator_v3(bytea, text, text) from public, anon, authenticated;
grant execute on function public.election_day_add_ride_coordinator_v3(bytea, text, text) to service_role;

create or replace function public.election_day_add_ride_coordinator_owner_v3(p_auth_user_id uuid, p_name text, p_phone text)
returns public.election_day_ride_coordinators
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_add_ride_coordinator_core(v_workspace_id, p_name, p_phone);
end;
$$;
revoke all on function public.election_day_add_ride_coordinator_owner_v3(uuid, text, text) from public, anon, authenticated;
grant execute on function public.election_day_add_ride_coordinator_owner_v3(uuid, text, text) to service_role;

create or replace function public.election_day_delete_ride_coordinator_v3(p_session_hash bytea, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageRideCoordinators' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  perform public.election_day_delete_ride_coordinator_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_delete_ride_coordinator_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_ride_coordinator_v3(bytea, uuid) to service_role;

create or replace function public.election_day_delete_ride_coordinator_owner_v3(p_auth_user_id uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  perform public.election_day_delete_ride_coordinator_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_delete_ride_coordinator_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_ride_coordinator_owner_v3(uuid, uuid) to service_role;

commit;

-- ============================================================================
-- SECTION 6 - NON-VOTING-REASON CATALOG (6 actions). Business logic copied
-- verbatim from 20260806162000's existing RPCs (advisory-lock guard,
-- REASON_IN_USE/REASON_NOT_FOUND/REORDER_ID_MISMATCH), workspace-scoped.
-- ============================================================================
begin;

create or replace function public.election_day_list_non_voting_reasons_core(p_workspace_id uuid)
returns setof public.election_day_not_voting_reasons
language sql security definer set search_path = '' stable as $$
  select * from public.election_day_not_voting_reasons
  where workspace_id = p_workspace_id
  order by sort_order asc, created_at asc;
$$;
revoke all on function public.election_day_list_non_voting_reasons_core(uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_create_non_voting_reason_core(p_workspace_id uuid, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_next_sort integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if p_name is null or btrim(p_name) = '' then raise exception 'REASON_NAME_REQUIRED'; end if;

  select coalesce(max(sort_order), -1) + 1 into v_next_sort
  from public.election_day_not_voting_reasons where workspace_id = p_workspace_id;

  insert into public.election_day_not_voting_reasons (workspace_id, name, description, sort_order)
  values (p_workspace_id, btrim(p_name), coalesce(p_description, ''), v_next_sort)
  returning id into v_id;

  return (select r from public.election_day_not_voting_reasons r where r.id = v_id);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_core(uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_update_non_voting_reason_core(p_workspace_id uuid, p_id uuid, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if not exists (select 1 from public.election_day_not_voting_reasons where id = p_id and workspace_id = p_workspace_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'REASON_NAME_REQUIRED'; end if;

  update public.election_day_not_voting_reasons
  set name = btrim(p_name), description = coalesce(p_description, '')
  where id = p_id and workspace_id = p_workspace_id;

  return (select r from public.election_day_not_voting_reasons r where r.id = p_id);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_core(uuid, uuid, text, text) from public, anon, authenticated, service_role;

create or replace function public.election_day_set_non_voting_reason_active_core(p_workspace_id uuid, p_id uuid, p_is_active boolean)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if not exists (select 1 from public.election_day_not_voting_reasons where id = p_id and workspace_id = p_workspace_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;

  update public.election_day_not_voting_reasons
  set is_active = p_is_active
  where id = p_id and workspace_id = p_workspace_id;

  return (select r from public.election_day_not_voting_reasons r where r.id = p_id);
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_active_core(uuid, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function public.election_day_delete_non_voting_reason_core(p_workspace_id uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_used_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);
  if not exists (select 1 from public.election_day_not_voting_reasons where id = p_id and workspace_id = p_workspace_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;

  select count(*) into v_used_count from public.election_day_voters
  where not_voting_reason_id = p_id and workspace_id = p_workspace_id;
  if v_used_count > 0 then raise exception 'REASON_IN_USE'; end if;

  delete from public.election_day_not_voting_reasons where id = p_id and workspace_id = p_workspace_id;
end;
$$;
revoke all on function public.election_day_delete_non_voting_reason_core(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.election_day_reorder_non_voting_reasons_core(p_workspace_id uuid, p_ordered_ids uuid[])
returns setof public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_existing_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons_' || p_workspace_id::text)::bigint);

  select count(*) into v_existing_count from public.election_day_not_voting_reasons where workspace_id = p_workspace_id;

  if p_ordered_ids is null
     or array_length(p_ordered_ids, 1) is distinct from v_existing_count
     or (select count(distinct x) from unnest(p_ordered_ids) as x) <> v_existing_count
     or exists (
       select 1 from unnest(p_ordered_ids) as x(rid)
       left join public.election_day_not_voting_reasons r on r.id = x.rid and r.workspace_id = p_workspace_id
       where r.id is null
     )
  then
    raise exception 'REORDER_ID_MISMATCH';
  end if;

  update public.election_day_not_voting_reasons as r
  set sort_order = o.new_order
  from (
    select rid, ordinality - 1 as new_order
    from unnest(p_ordered_ids) with ordinality as t(rid, ordinality)
  ) as o
  where r.id = o.rid and r.workspace_id = p_workspace_id;

  return query
    select r.* from public.election_day_not_voting_reasons r
    where r.workspace_id = p_workspace_id
    order by r.sort_order asc;
end;
$$;
revoke all on function public.election_day_reorder_non_voting_reasons_core(uuid, uuid[]) from public, anon, authenticated, service_role;

-- ---- v3 / owner_v3 wrappers ----

create or replace function public.election_day_list_non_voting_reasons_v3(p_session_hash bytea)
returns setof public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  return query select * from public.election_day_list_non_voting_reasons_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_non_voting_reasons_v3(bytea) from public, anon, authenticated;
grant execute on function public.election_day_list_non_voting_reasons_v3(bytea) to service_role;

create or replace function public.election_day_list_non_voting_reasons_owner_v3(p_auth_user_id uuid)
returns setof public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_list_non_voting_reasons_core(v_workspace_id);
end;
$$;
revoke all on function public.election_day_list_non_voting_reasons_owner_v3(uuid) from public, anon, authenticated;
grant execute on function public.election_day_list_non_voting_reasons_owner_v3(uuid) to service_role;

create or replace function public.election_day_create_non_voting_reason_v3(p_session_hash bytea, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_create_non_voting_reason_core(v_workspace_id, p_name, p_description);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_v3(bytea, text, text) from public, anon, authenticated;
grant execute on function public.election_day_create_non_voting_reason_v3(bytea, text, text) to service_role;

create or replace function public.election_day_create_non_voting_reason_owner_v3(p_auth_user_id uuid, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_create_non_voting_reason_core(v_workspace_id, p_name, p_description);
end;
$$;
revoke all on function public.election_day_create_non_voting_reason_owner_v3(uuid, text, text) from public, anon, authenticated;
grant execute on function public.election_day_create_non_voting_reason_owner_v3(uuid, text, text) to service_role;

create or replace function public.election_day_update_non_voting_reason_v3(p_session_hash bytea, p_id uuid, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_update_non_voting_reason_core(v_workspace_id, p_id, p_name, p_description);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_v3(bytea, uuid, text, text) from public, anon, authenticated;
grant execute on function public.election_day_update_non_voting_reason_v3(bytea, uuid, text, text) to service_role;

create or replace function public.election_day_update_non_voting_reason_owner_v3(p_auth_user_id uuid, p_id uuid, p_name text, p_description text)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_update_non_voting_reason_core(v_workspace_id, p_id, p_name, p_description);
end;
$$;
revoke all on function public.election_day_update_non_voting_reason_owner_v3(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.election_day_update_non_voting_reason_owner_v3(uuid, uuid, text, text) to service_role;

create or replace function public.election_day_set_non_voting_reason_active_v3(p_session_hash bytea, p_id uuid, p_is_active boolean)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return public.election_day_set_non_voting_reason_active_core(v_workspace_id, p_id, p_is_active);
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_active_v3(bytea, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_non_voting_reason_active_v3(bytea, uuid, boolean) to service_role;

create or replace function public.election_day_set_non_voting_reason_active_owner_v3(p_auth_user_id uuid, p_id uuid, p_is_active boolean)
returns public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return public.election_day_set_non_voting_reason_active_core(v_workspace_id, p_id, p_is_active);
end;
$$;
revoke all on function public.election_day_set_non_voting_reason_active_owner_v3(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.election_day_set_non_voting_reason_active_owner_v3(uuid, uuid, boolean) to service_role;

create or replace function public.election_day_delete_non_voting_reason_v3(p_session_hash bytea, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  perform public.election_day_delete_non_voting_reason_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_delete_non_voting_reason_v3(bytea, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_non_voting_reason_v3(bytea, uuid) to service_role;

create or replace function public.election_day_delete_non_voting_reason_owner_v3(p_auth_user_id uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  perform public.election_day_delete_non_voting_reason_core(v_workspace_id, p_id);
end;
$$;
revoke all on function public.election_day_delete_non_voting_reason_owner_v3(uuid, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_non_voting_reason_owner_v3(uuid, uuid) to service_role;

create or replace function public.election_day_reorder_non_voting_reasons_v3(p_session_hash bytea, p_ordered_ids uuid[])
returns setof public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
begin
  select r.role_id, r.workspace_id into v_role_id, v_workspace_id from public.election_day_resolve_session(p_session_hash) r;
  if v_workspace_id is null then raise exception 'UNAUTHORIZED'; end if;
  select ('electionDay.manageNonVotingReasons' = any(r.permissions)) into v_has_permission from public.election_day_roles r where r.id = v_role_id;
  if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
  return query select * from public.election_day_reorder_non_voting_reasons_core(v_workspace_id, p_ordered_ids);
end;
$$;
revoke all on function public.election_day_reorder_non_voting_reasons_v3(bytea, uuid[]) from public, anon, authenticated;
grant execute on function public.election_day_reorder_non_voting_reasons_v3(bytea, uuid[]) to service_role;

create or replace function public.election_day_reorder_non_voting_reasons_owner_v3(p_auth_user_id uuid, p_ordered_ids uuid[])
returns setof public.election_day_not_voting_reasons
language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id from public.election_day_resolve_owner_context(p_auth_user_id) r;
  return query select * from public.election_day_reorder_non_voting_reasons_core(v_workspace_id, p_ordered_ids);
end;
$$;
revoke all on function public.election_day_reorder_non_voting_reasons_owner_v3(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.election_day_reorder_non_voting_reasons_owner_v3(uuid, uuid[]) to service_role;

commit;
