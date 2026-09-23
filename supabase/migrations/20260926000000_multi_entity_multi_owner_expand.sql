-- ===========================================================================
-- KOLBOX Multi-Entity - from ONE seat to MANY owners.  *** EXPAND PHASE ***
--
-- ROLLOUT SHAPE: EXPAND -> DEPLOY -> VERIFY -> CONTRACT.
--   This migration is the EXPAND half and is SAFE TO APPLY WHILE THE CURRENT
--   APPLICATION IS STILL SERVING PRODUCTION. It only ADDS capability. Every
--   function signature the deployed code calls keeps existing, keeps its
--   grants, and keeps its observable behaviour; every response key the
--   deployed code reads keeps being returned. The new code is deployed after
--   this, and only once it is verified does 20260927000000 (CONTRACT) remove
--   the compatibility layer.
--
--   The reverse order - dropping the old signatures first - would have taken
--   the live console down for the whole window between migration and deploy,
--   because `platform_assign_workspace(uuid,uuid)` would no longer exist and
--   `platform_get_multi_entity_state` would no longer return `seat`.
--
-- WHY THIS EXISTS. 20260823010000 created `multi_entity_owner` as a true
-- singleton - `id boolean primary key` + `check (id)` - because the product
-- cardinality at the time was literally "exactly ONE Multi-Entity Owner
-- exists at a time". That premise is now gone: several people must hold the
-- Multi-Entity capability CONCURRENTLY, each seeing their own set of
-- workspaces, and the same workspace may legitimately be visible to more than
-- one of them.
--
-- WHAT DOES **NOT** CHANGE - and this is the whole point of the design:
--   * There is NO new permission model, and no per-owner capability flags.
--     Every Multi-Entity Owner has exactly the capabilities the single seat
--     had: aggregate counts, for assigned workspaces, and nothing else.
--   * The ONLY thing that distinguishes two owners is WHICH WORKSPACES are
--     assigned to them.
--   * Every privacy rule stays in the database and stays untouched: `ended`
--     and `suppressed` still yield metrics NULL, the entitlement check still
--     runs before any Election Day data is read, and no coordinator,
--     per-reason, time-series or person-level metric is added.
--   * Exclusivity is unchanged: an identity that already holds the Platform
--     Owner or Election Owner role still cannot become a Multi-Entity Owner
--     (`multi_entity_auth_user_held_by`), and that helper is untouched - it
--     answers 'multi_entity' for ANY row in the table, which is already the
--     correct answer for N rows.
--
-- THE AUTHORIZATION CHANGE, STATED PLAINLY. Until now
-- `multi_entity_assignments` deliberately carried NO owner column: with one
-- seat, "assigned" and "assigned to me" were the same sentence, and the
-- absence of the column is what made a seat REPLACEMENT inherit every
-- assignment for free. With N owners those two sentences diverge, and an
-- assignment row that names no owner would mean "visible to every
-- Multi-Entity Owner" - a silent cross-tenant widening. So the column becomes
-- mandatory, and EVERY read path filters on it. This migration therefore
-- makes isolation STRICTER, never looser: before it, one owner saw every
-- assigned workspace; after it, each owner sees only their own.
--
-- BACKFILL / COMPATIBILITY. The existing seat row (if any) keeps its
-- auth_user_id, name, e-mail, phone and created_at, and is simply given a
-- generated `owner_id`. Every existing assignment row is attributed to that
-- owner. The result is a one-owner installation that behaves exactly as it
-- did - same person, same workspaces, same numbers - and can now have more
-- owners added beside it. Nothing is deleted and no row is recreated.
--
-- If assignments exist with NO owner row at all, this migration REFUSES
-- rather than guessing: such rows cannot be attributed, and silently
-- deleting them or leaving them unowned are both worse than stopping.
--
-- ROLLBACK NOTE (manual, destructive - it cannot preserve multi-owner data).
-- While only EXPAND has been applied, rolling back the APPLICATION alone is
-- enough and needs no DB change at all: the previous deployment's contract is
-- still fully present. A DB rollback is only needed to undo the schema:
--   drop function if exists public.platform_remove_multi_entity_owner(uuid,uuid);
--   drop function if exists public.platform_provision_multi_entity_owner_v2(uuid,uuid,text,text,text,uuid);
--   drop function if exists public.platform_assign_workspace_v2(uuid,uuid,uuid);
--   drop function if exists public.platform_unassign_workspace_v2(uuid,uuid,uuid);
--   drop function if exists public.platform_multi_entity_sole_owner();
--   -- then restore the 20260910010000 / 20260911000000 definitions of
--   -- platform_provision_multi_entity_owner, platform_assign_workspace,
--   -- platform_unassign_workspace, platform_get_multi_entity_state and the
--   -- 20260912000000 multi_entity_* reader functions, delete every
--   -- multi_entity_owner row but one, drop multi_entity_assignments.owner_id,
--   -- restore the unique(workspace_id) constraint and the boolean id/PK.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Replay gates - the objects this migration rewrites must already exist.
-- ---------------------------------------------------------------------------
do $gate$
begin
  if to_regclass('public.multi_entity_owner') is null then
    raise exception 'MULTI_OWNER_GATE_FAILED: public.multi_entity_owner is missing - 20260823010000 must be applied first';
  end if;
  if to_regclass('public.multi_entity_assignments') is null then
    raise exception 'MULTI_OWNER_GATE_FAILED: public.multi_entity_assignments is missing';
  end if;
  if to_regclass('public.multi_entity_audit') is null then
    raise exception 'MULTI_OWNER_GATE_FAILED: public.multi_entity_audit is missing - 20260910010000 must be applied first';
  end if;
  if to_regprocedure('public.multi_entity_auth_user_held_by(uuid)') is null then
    raise exception 'MULTI_OWNER_GATE_FAILED: multi_entity_auth_user_held_by(uuid) is missing';
  end if;
end;
$gate$;

-- ---------------------------------------------------------------------------
-- 1. multi_entity_owner - a real table with a real primary key.
--
--    The boolean `id` column and its singleton CHECK are what enforced "at
--    most one row"; both go. auth_user_id keeps its UNIQUE constraint - one
--    Auth account may still hold at most ONE Multi-Entity seat, which is a
--    different (and still correct) rule from "there is at most one seat".
-- ---------------------------------------------------------------------------
alter table public.multi_entity_owner
  drop constraint if exists multi_entity_owner_singleton;

alter table public.multi_entity_owner
  add column if not exists owner_id uuid not null default pg_catalog.gen_random_uuid();

do $pk$
begin
  -- The old PK is on the boolean column; swap it for owner_id, then drop the
  -- column. Guarded so a re-run is a no-op rather than an error.
  if exists (
    select 1 from pg_constraint
    where conname = 'multi_entity_owner_pkey'
      and conrelid = 'public.multi_entity_owner'::regclass
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) then
    alter table public.multi_entity_owner drop constraint multi_entity_owner_pkey;
    alter table public.multi_entity_owner add constraint multi_entity_owner_pkey primary key (owner_id);
  end if;
end;
$pk$;

alter table public.multi_entity_owner drop column if exists id;

comment on table public.multi_entity_owner is
  'Multi-Entity Owners. MANY rows (this table was a singleton until 20260926000000). Every owner has identical capabilities - aggregate counts for assigned workspaces only - and is distinguished from every other owner solely by the rows in multi_entity_assignments that name them. auth_user_id stays UNIQUE: one Auth account holds at most one seat. RLS-enabled, zero policies, no table privileges for any role - every access goes through a SECURITY DEFINER function.';

-- ---------------------------------------------------------------------------
-- 2. multi_entity_assignments - owner-specific, and many-to-many.
--
--    The old UNIQUE(workspace_id) said "a workspace belongs to at most one
--    assignment", which under one owner meant "at most one owner". It is
--    replaced by UNIQUE(owner_id, workspace_id) - the same idempotence
--    guarantee, now per owner - so two owners MAY hold the same workspace.
-- ---------------------------------------------------------------------------
alter table public.multi_entity_assignments
  add column if not exists owner_id uuid;

do $backfill$
declare
  v_owner_count integer;
  v_owner_id uuid;
  v_orphans integer;
begin
  select pg_catalog.count(*) into v_owner_count from public.multi_entity_owner;

  select pg_catalog.count(*) into v_orphans
  from public.multi_entity_assignments where owner_id is null;

  if v_orphans = 0 then
    return; -- nothing to attribute (fresh replay, or already backfilled)
  end if;

  if v_owner_count = 0 then
    raise exception
      'MULTI_OWNER_BACKFILL_FAILED: % assignment row(s) exist with no multi_entity_owner to attribute them to. Resolve by hand before applying.', v_orphans;
  end if;

  if v_owner_count > 1 then
    -- Unreachable while the singleton CHECK was in force, but this migration
    -- has just dropped it - so assert rather than pick one arbitrarily.
    raise exception
      'MULTI_OWNER_BACKFILL_FAILED: % owners already exist but % assignment row(s) are unattributed; attribution is ambiguous.', v_owner_count, v_orphans;
  end if;

  select m.owner_id into v_owner_id from public.multi_entity_owner m;

  -- The whole compatibility promise, in one statement: every workspace the
  -- existing seat holder could see, they still see.
  update public.multi_entity_assignments
     set owner_id = v_owner_id
   where owner_id is null;
end;
$backfill$;

alter table public.multi_entity_assignments
  alter column owner_id set not null;

alter table public.multi_entity_assignments
  drop constraint if exists multi_entity_assignments_workspace_id_key;

alter table public.multi_entity_assignments
  drop constraint if exists multi_entity_assignments_owner_id_fkey;

alter table public.multi_entity_assignments
  add constraint multi_entity_assignments_owner_id_fkey
  foreign key (owner_id) references public.multi_entity_owner(owner_id) on delete cascade;

alter table public.multi_entity_assignments
  drop constraint if exists multi_entity_assignments_owner_workspace_key;

alter table public.multi_entity_assignments
  add constraint multi_entity_assignments_owner_workspace_key
  unique (owner_id, workspace_id);

-- The workspace side of the join is no longer unique, so it needs its own
-- index for the "who can see this workspace" direction the console renders.
create index if not exists multi_entity_assignments_workspace_id_idx
  on public.multi_entity_assignments (workspace_id);

comment on table public.multi_entity_assignments is
  'Which workspaces each Multi-Entity Owner may see, in aggregate. Owner-specific since 20260926000000: the owner_id column is what makes one owner''s scope different from another''s, and every read path filters on it. UNIQUE(owner_id, workspace_id) keeps assignment idempotent per owner while deliberately allowing the SAME workspace to be assigned to several owners. ON DELETE CASCADE from multi_entity_owner: removing an owner removes their visibility and nothing else.';

-- ---------------------------------------------------------------------------
-- 3. multi_entity_audit - attribute every event to an owner, and record
--    removal as its own action.
-- ---------------------------------------------------------------------------
alter table public.multi_entity_audit
  add column if not exists owner_id uuid;

-- Widened by DROP + ADD under the SAME NAME - the 20260911000000 pattern,
-- and it is load-bearing. That migration's own replay gate resolves this
-- constraint by DEFINITION PATTERN (contains 'provisioned' and 'unassigned',
-- does NOT contain 'IS NOT NULL') and then asserts the resolved name is
-- exactly 'multi_entity_audit_action_check'. Adding a SECOND check matching
-- that pattern, or renaming this one, would make a later replay of 4B pick an
-- arbitrary row and fail with 'unexpected action CHECK name'. The shape CHECK
-- rewritten below is safe by the same test: it contains 'IS NOT NULL'.
alter table public.multi_entity_audit
  drop constraint multi_entity_audit_action_check;

alter table public.multi_entity_audit
  add constraint multi_entity_audit_action_check check (
    action = any (array[
      'provisioned', 'replaced', 'removed', 'assigned', 'unassigned',
      'previous_auth_deleted', 'previous_auth_delete_failed',
      'provisioning_auth_minted', 'provisioning_orphan_deleted',
      'provisioning_orphan_delete_failed'
    ])
  );

-- 'removed' carries the departing holder in previous_auth_user_id, exactly as
-- 'replaced' does, so the existing purge path needs no new shape.
alter table public.multi_entity_audit
  drop constraint if exists multi_entity_audit_previous_auth_shape;

alter table public.multi_entity_audit
  add constraint multi_entity_audit_previous_auth_shape check (
    (action = any (array['replaced', 'removed', 'previous_auth_deleted', 'previous_auth_delete_failed']))
      = (previous_auth_user_id is not null)
  );

comment on column public.multi_entity_audit.owner_id is
  'Which Multi-Entity Owner the event concerns. Nullable: rows written before 20260926000000 pre-date per-owner attribution, and the auth-cleanup actions concern an Auth account rather than a live owner row. A snapshot, never a foreign key - the audit outlives the owner it names.';

-- ---------------------------------------------------------------------------
-- 4. Reader functions - identical contracts, now scoped to ONE owner.
--
--    Signatures are unchanged except for resolve_owner_context, which gains
--    owner_id (so callers never have to re-derive it). Every one of these is
--    keyed by p_auth_user_id already, which is why the blast radius is small:
--    the only real edit is an owner_id predicate on the assignment join.
-- ---------------------------------------------------------------------------
drop function if exists public.multi_entity_resolve_owner_context(uuid);

create function public.multi_entity_resolve_owner_context(p_auth_user_id uuid)
returns table(owner_id uuid, auth_user_id uuid, name text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- One definition of principal-role resolution: the Stage 4B helper. Only
  -- 'multi_entity' is acceptable - 'platform' / 'election' mean the identity
  -- also holds another owner role (D-8), NULL / 'pending_owner' mean it does
  -- not hold a seat at all. Unchanged by multi-owner: it answers for ANY row.
  if public.multi_entity_auth_user_held_by(p_auth_user_id)
       is distinct from 'multi_entity' then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select m.owner_id, m.auth_user_id, m.name
    from public.multi_entity_owner m
    where m.auth_user_id = p_auth_user_id;

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$fn$;

comment on function public.multi_entity_resolve_owner_context(uuid) is
  'Resolves one Multi-Entity Owner from their Auth id, returning owner_id alongside the display metadata. Raises UNAUTHORIZED for a null id, an identity holding another principal role, or an identity holding no seat. service_role only.';

revoke all on function public.multi_entity_resolve_owner_context(uuid) from public;
revoke all on function public.multi_entity_resolve_owner_context(uuid) from anon;
revoke all on function public.multi_entity_resolve_owner_context(uuid) from authenticated;
grant execute on function public.multi_entity_resolve_owner_context(uuid) to service_role;

create or replace function public.multi_entity_assert_workspace_assigned(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
begin
  -- Seat + exclusivity first; raises UNAUTHORIZED on any failure.
  select c.owner_id into v_owner_id
  from public.multi_entity_resolve_owner_context(p_auth_user_id) c;

  -- Assigned-TO-THIS-OWNER-and-existing is the ONLY accepting state. A NULL
  -- id, a workspace assigned to a DIFFERENT owner, an unassigned workspace
  -- and a nonexistent workspace are all indistinguishable to the caller by
  -- design (no enumeration).
  if p_workspace_id is null or not exists (
    select 1
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    where a.workspace_id = p_workspace_id
      and a.owner_id = v_owner_id
  ) then
    raise exception 'WORKSPACE_NOT_ASSIGNED';
  end if;
end;
$fn$;

comment on function public.multi_entity_assert_workspace_assigned(uuid, uuid) is
  'THE workspace-scope gate for the Multi-Entity principal. Owner-specific since 20260926000000. Must be called inside the body of every workspace-scoped read, in the same transaction as the read. Granted to NO role - callable only from inside another SECURITY DEFINER body.';

revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from public;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from anon;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from authenticated;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from service_role;

create or replace function public.multi_entity_list_assigned_workspaces(p_auth_user_id uuid)
returns table(workspace_id uuid, name text, election_end_at timestamptz, assigned_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
begin
  -- Self-authorizing: never trusts that the caller already checked the seat.
  select c.owner_id into v_owner_id
  from public.multi_entity_resolve_owner_context(p_auth_user_id) c;

  -- Authorization metadata ONLY - never login_code (a workspace credential)
  -- and never any business column. Total order (name, then id) so the list
  -- is stable across reloads even when two workspaces share a name.
  return query
    select w.id, w.name, w.election_end_at, a.assigned_at
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    where a.owner_id = v_owner_id
    order by w.name asc, w.id asc;
end;
$fn$;

revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from public;
revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from anon;
revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from authenticated;
grant execute on function public.multi_entity_list_assigned_workspaces(uuid) to service_role;

create or replace function public.multi_entity_get_assigned_workspace(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table(workspace_id uuid, name text, election_end_at timestamptz, assigned_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
begin
  -- The gate and the read share this call's snapshot - no TOCTOU.
  perform public.multi_entity_assert_workspace_assigned(p_auth_user_id, p_workspace_id);

  select c.owner_id into v_owner_id
  from public.multi_entity_resolve_owner_context(p_auth_user_id) c;

  return query
    select w.id, w.name, w.election_end_at, a.assigned_at
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    where a.workspace_id = p_workspace_id
      and a.owner_id = v_owner_id;
end;
$fn$;

revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from public;
revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from anon;
revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from authenticated;
grant execute on function public.multi_entity_get_assigned_workspace(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Aggregate readers - same privacy rules, now per owner.
--    `assigned_at` is now the CALLING owner's own assignment timestamp, which
--    is the only one meaningful to them when a workspace has several owners.
-- ---------------------------------------------------------------------------
create or replace function public.multi_entity_compute_workspace_aggregate(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table(
  workspace_id uuid, name text, election_end_at timestamptz, assigned_at timestamptz,
  report_status text, contacts_total integer, voted integer,
  follow_up_closed integer, follow_up_remaining integer,
  ride_needed integer, ride_arranged integer, ride_completed integer
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  c_min_reportable constant integer := 10;
  v_owner_id uuid;
  v_ws_id uuid;
  v_ws_name text;
  v_ws_end timestamptz;
  v_assigned_at timestamptz;
  v_total integer;
  v_voted integer;
  v_closed integer;
  v_completed integer;
  v_arranged integer;
  v_needed integer;
begin
  perform public.multi_entity_assert_workspace_assigned(p_auth_user_id, p_workspace_id);

  select c.owner_id into v_owner_id
  from public.multi_entity_resolve_owner_context(p_auth_user_id) c;

  select w.id, w.name, w.election_end_at, a.assigned_at
    into v_ws_id, v_ws_name, v_ws_end, v_assigned_at
  from public.multi_entity_assignments a
  join public.election_workspaces w on w.id = a.workspace_id
  where a.workspace_id = p_workspace_id
    and a.owner_id = v_owner_id;

  if not found then
    raise exception 'WORKSPACE_NOT_ASSIGNED';
  end if;

  if not (v_ws_end > pg_catalog.now()) then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'ended'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  -- Stage 9: platform entitlement, before any Election Day data is read.
  if not public.election_day_workspace_has_module(p_workspace_id, 'election_day') then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'unavailable'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  select pg_catalog.count(*)::integer,
         (pg_catalog.count(*) filter (where v.voted))::integer,
         (pg_catalog.count(*) filter (where not v.voted and r.requires_follow_up = false))::integer,
         (pg_catalog.count(*) filter (where v.ride_completed))::integer,
         (pg_catalog.count(*) filter (where v.ride_arranged and not v.ride_completed))::integer,
         (pg_catalog.count(*) filter (where v.ride_requested and not v.ride_arranged and not v.ride_completed))::integer
    into v_total, v_voted, v_closed, v_completed, v_arranged, v_needed
  from public.election_day_voters v
  left join public.election_day_not_voting_reasons r
    on r.id = v.not_voting_reason_id
   and r.workspace_id = v.workspace_id
  where v.workspace_id = p_workspace_id;

  if v_total < c_min_reportable then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'suppressed'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'reported'::text,
    v_total, v_voted, v_closed, (v_total - v_voted - v_closed),
    v_needed, v_arranged, v_completed;
end;
$fn$;

revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from public;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from anon;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from authenticated;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from service_role;

create or replace function public.multi_entity_list_workspace_aggregates(p_auth_user_id uuid)
returns table(
  workspace_id uuid, name text, election_end_at timestamptz, assigned_at timestamptz,
  report_status text, contacts_total integer, voted integer,
  follow_up_closed integer, follow_up_remaining integer,
  ride_needed integer, ride_arranged integer, ride_completed integer
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
begin
  -- Self-authorizing even with zero assignments: a non-holder is refused,
  -- never answered with an empty list.
  select c.owner_id into v_owner_id
  from public.multi_entity_resolve_owner_context(p_auth_user_id) c;

  -- Total order (name, then id) so the result is deterministic even when two
  -- workspaces share a name. The gate still runs per workspace inside the
  -- compute call, all within this one snapshot.
  return query
    select c.workspace_id, c.name, c.election_end_at, c.assigned_at, c.report_status,
           c.contacts_total, c.voted, c.follow_up_closed, c.follow_up_remaining,
           c.ride_needed, c.ride_arranged, c.ride_completed
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    cross join lateral public.multi_entity_compute_workspace_aggregate(p_auth_user_id, a.workspace_id) c
    where a.owner_id = v_owner_id
    order by w.name asc, w.id asc;
end;
$fn$;

revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from public;
revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from anon;
revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from authenticated;
grant execute on function public.multi_entity_list_workspace_aggregates(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. NEW owner-addressed operations (_v2), used by the NEW application.
--
--    EXPAND RULE. These are ADDED alongside the existing signatures; nothing
--    the currently-deployed application calls is dropped or changed in this
--    migration. The `_v2` suffix is this project's established way of
--    introducing a replacement contract without breaking the running one
--    (election_day_login_v3, election_day_list_permission_users_v3, ...).
--
--    Why not a DEFAULT parameter on the existing function instead? Because a
--    5-argument call would then be ambiguous between the old function and a
--    6-argument one with a default, and Postgres refuses such a call outright
--    ("function is not unique"). Every currently-deployed call site makes a
--    5-argument call, so that would break Production the moment this applied.
-- ---------------------------------------------------------------------------

-- ADD a new owner, or REPLACE the identity behind an existing one.
-- p_owner_id null  -> add a new owner (the multi-owner behaviour)
-- p_owner_id given -> replace THAT owner's Auth identity, keeping their
--                     assignments, which is what the singleton's "replace"
--                     did for the one seat that existed.
create or replace function public.platform_provision_multi_entity_owner_v2(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_platform_owner_id uuid;
  v_name  text;
  v_email text;
  v_phone text;
  v_owner_id uuid;
  v_existing_auth uuid;
  v_already  boolean := false;
  v_replaced boolean := false;
  v_previous uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Defence in depth. api/platform/session.ts has already verified the caller
  -- through the full three-check Platform Owner chain; this re-resolves it
  -- independently so the RPC is not authorized by its caller's word.
  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_auth_user_id is null then
    raise exception 'MISSING_AUTH_USER_ID';
  end if;

  v_name  := btrim(coalesce(p_name, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_name = '' then
    raise exception 'MISSING_OWNER_NAME';
  end if;
  if v_email = '' then
    raise exception 'MISSING_OWNER_EMAIL';
  end if;
  if pg_catalog.length(v_name) > 200 then
    raise exception 'OWNER_NAME_TOO_LONG';
  end if;
  if pg_catalog.length(v_email) > 254 then
    raise exception 'OWNER_EMAIL_TOO_LONG';
  end if;

  -- Serialize owner creation/replacement against itself. Still ONE lock for
  -- the whole Multi-Entity owner set: these are rare administrative writes,
  -- and a single lock keeps the "is this identity already a principal" checks
  -- below race-free without a per-owner locking scheme to reason about. The
  -- legacy wrapper takes the SAME lock, so old and new callers serialize
  -- against each other during the overlap window.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_seat')::bigint
  );

  -- ---- Principal separation, cross-principal only -------------------------
  -- public.multi_entity_owner is DELIBERATELY not checked here: it is this
  -- function's own target table. The same-identity vs different-identity
  -- distinction is made by the branches below.
  if exists (
    select 1 from public.platform_owners po where po.auth_user_id = p_auth_user_id
  ) then
    raise exception 'IDENTITY_ALREADY_PRINCIPAL';
  end if;

  if exists (
    select 1 from public.election_owners o where o.auth_user_id = p_auth_user_id
  ) then
    raise exception 'IDENTITY_ALREADY_PRINCIPAL';
  end if;

  -- ---- Actionable pending Election Owner access ---------------------------
  -- Mirrors election_day_provision_workspace's own actionability test EXACTLY
  -- (status <> 'consumed' AND expires_at > now()); see 20260910010000 for the
  -- full reasoning, which is unchanged by multi-owner.
  if exists (
    select 1 from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = p_auth_user_id
      and pa.status <> 'consumed'
      and pa.expires_at > pg_catalog.now()
  ) then
    raise exception 'IDENTITY_PENDING_ELECTION_OWNER';
  end if;

  if p_owner_id is null then
    -- ---- ADD -------------------------------------------------------------
    -- An identity that already holds a DIFFERENT owner row would violate the
    -- auth_user_id UNIQUE constraint; report it as the domain fact instead.
    select m.owner_id into v_existing_auth
    from public.multi_entity_owner m
    where m.auth_user_id = p_auth_user_id;

    if v_existing_auth is not null then
      -- Idempotent re-add of the same identity: refresh display metadata
      -- only. No audit row - no owner was created.
      v_already := true;
      v_owner_id := v_existing_auth;

      update public.multi_entity_owner
         set name = v_name, phone = v_phone, email = v_email
       where owner_id = v_owner_id;
    else
      insert into public.multi_entity_owner (auth_user_id, name, phone, email)
      values (p_auth_user_id, v_name, v_phone, v_email)
      returning public.multi_entity_owner.owner_id into v_owner_id;

      insert into public.multi_entity_audit
        (action, owner_id, seat_auth_user_id, acting_platform_owner_id, acting_auth_user_id)
      values
        ('provisioned', v_owner_id, p_auth_user_id, v_platform_owner_id, p_platform_owner_auth_user_id);
    end if;
  else
    -- ---- REPLACE a named owner's identity --------------------------------
    select m.owner_id, m.auth_user_id into v_owner_id, v_existing_auth
    from public.multi_entity_owner m
    where m.owner_id = p_owner_id
    for update;

    if v_owner_id is null then
      raise exception 'MULTI_ENTITY_OWNER_NOT_FOUND';
    end if;

    if v_existing_auth = p_auth_user_id then
      v_already := true;
      update public.multi_entity_owner
         set name = v_name, phone = v_phone, email = v_email
       where owner_id = v_owner_id;
    else
      -- UPDATE IN PLACE, never delete+insert, so this owner's assignments
      -- carry over to the new holder untouched.
      v_already  := true;
      v_replaced := true;
      v_previous := v_existing_auth;

      update public.multi_entity_owner
         set auth_user_id = p_auth_user_id,
             name = v_name,
             phone = v_phone,
             email = v_email
       where owner_id = v_owner_id;

      insert into public.multi_entity_audit
        (action, owner_id, seat_auth_user_id, previous_auth_user_id,
         acting_platform_owner_id, acting_auth_user_id)
      values
        ('replaced', v_owner_id, p_auth_user_id, v_previous,
         v_platform_owner_id, p_platform_owner_auth_user_id);
    end if;
  end if;

  -- previous_auth_user_id is returned so the caller can, as a SEPARATE and
  -- separately-approved operation, purge the replaced Auth account. This
  -- function never deletes an Auth account and never touches auth.* at all.
  return pg_catalog.jsonb_build_object(
    'owner_id', v_owner_id,
    'already_existed', v_already,
    'replaced', v_replaced,
    'previous_auth_user_id', v_previous,
    'seat_auth_user_id', p_auth_user_id
  );
end;
$fn$;

comment on function public.platform_provision_multi_entity_owner_v2(uuid, uuid, text, text, text, uuid) is
  'Adds a Multi-Entity Owner (p_owner_id null) or replaces the Auth identity behind an existing one (p_owner_id given, assignments preserved). Re-resolves the Platform Owner independently. Never touches auth.*. service_role only.';

revoke all on function public.platform_provision_multi_entity_owner_v2(uuid, uuid, text, text, text, uuid) from public;
revoke all on function public.platform_provision_multi_entity_owner_v2(uuid, uuid, text, text, text, uuid) from anon;
revoke all on function public.platform_provision_multi_entity_owner_v2(uuid, uuid, text, text, text, uuid) from authenticated;
grant execute on function public.platform_provision_multi_entity_owner_v2(uuid, uuid, text, text, text, uuid) to service_role;

-- REMOVE an owner. With one seat, "replace" WAS revocation; with many owners
-- revoking one of them needs its own operation. New capability only - nothing
-- deployed today calls it.
create or replace function public.platform_remove_multi_entity_owner(
  p_platform_owner_auth_user_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_platform_owner_id uuid;
  v_auth_user_id uuid;
  v_assignments integer;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_owner_id is null then
    raise exception 'MULTI_ENTITY_OWNER_NOT_FOUND';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_seat')::bigint
  );

  select m.auth_user_id into v_auth_user_id
  from public.multi_entity_owner m
  where m.owner_id = p_owner_id
  for update;

  if v_auth_user_id is null then
    raise exception 'MULTI_ENTITY_OWNER_NOT_FOUND';
  end if;

  select pg_catalog.count(*)::integer into v_assignments
  from public.multi_entity_assignments a
  where a.owner_id = p_owner_id;

  -- The audit row is written BEFORE the delete so the owner_id it snapshots
  -- still resolves while this statement runs; the column is a snapshot, not a
  -- foreign key, so it stays readable afterwards.
  insert into public.multi_entity_audit
    (action, owner_id, previous_auth_user_id, acting_platform_owner_id, acting_auth_user_id)
  values
    ('removed', p_owner_id, v_auth_user_id, v_platform_owner_id, p_platform_owner_auth_user_id);

  -- Assignments go with them, by ON DELETE CASCADE: an owner's assignments
  -- are their visibility and mean nothing without them. Other owners'
  -- assignments to the SAME workspaces are untouched.
  delete from public.multi_entity_owner where owner_id = p_owner_id;

  -- Like replacement, this never deletes an Auth account - the caller purges
  -- it as a separate, separately-approved operation.
  return pg_catalog.jsonb_build_object(
    'removed', true,
    'owner_id', p_owner_id,
    'previous_auth_user_id', v_auth_user_id,
    'assignments_removed', v_assignments
  );
end;
$fn$;

comment on function public.platform_remove_multi_entity_owner(uuid, uuid) is
  'Revokes ONE Multi-Entity Owner: writes a ''removed'' audit row, deletes the owner and (by cascade) their assignments, and returns their Auth id for the separate purge step. Never touches auth.*. Other owners assigned to the same workspaces are unaffected. service_role only.';

revoke all on function public.platform_remove_multi_entity_owner(uuid, uuid) from public;
revoke all on function public.platform_remove_multi_entity_owner(uuid, uuid) from anon;
revoke all on function public.platform_remove_multi_entity_owner(uuid, uuid) from authenticated;
grant execute on function public.platform_remove_multi_entity_owner(uuid, uuid) to service_role;

-- ASSIGN / UNASSIGN, now naming which owner the visibility is for.
create or replace function public.platform_assign_workspace_v2(
  p_platform_owner_auth_user_id uuid,
  p_owner_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_platform_owner_id uuid;
  v_workspace_name text;
  v_assignment_id uuid;
  v_audit_id uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null then
    raise exception 'INVALID_WORKSPACE_ID';
  end if;

  -- Fail closed rather than pre-staging visibility for an owner that is not
  -- there. Named owner, not "any owner exists" - assigning to a nonexistent
  -- owner must not silently succeed because some OTHER owner happens to exist.
  if p_owner_id is null or not exists (
    select 1 from public.multi_entity_owner m where m.owner_id = p_owner_id
  ) then
    raise exception 'MULTI_ENTITY_OWNER_NOT_PROVISIONED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_assign_' || p_owner_id::text || '_' || p_workspace_id::text)::bigint
  );

  select w.name into v_workspace_name
  from public.election_workspaces w
  where w.id = p_workspace_id;

  if v_workspace_name is null then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  -- Deliberately NOT filtered by is_active: ACTIVE is clock-derived, and a
  -- workspace assigned while active must remain assigned after it ends.
  select a.id into v_assignment_id
  from public.multi_entity_assignments a
  where a.workspace_id = p_workspace_id
    and a.owner_id = p_owner_id;

  if v_assignment_id is not null then
    -- Idempotent no-op writes NO audit row.
    return pg_catalog.jsonb_build_object(
      'assignment_id', v_assignment_id,
      'already_assigned', true,
      'audit_id', null
    );
  end if;

  insert into public.multi_entity_assignments (owner_id, workspace_id)
  values (p_owner_id, p_workspace_id)
  returning public.multi_entity_assignments.id into v_assignment_id;

  insert into public.multi_entity_audit
    (action, owner_id, workspace_id_snapshot, workspace_name_snapshot,
     acting_platform_owner_id, acting_auth_user_id)
  values
    ('assigned', p_owner_id, p_workspace_id, v_workspace_name,
     v_platform_owner_id, p_platform_owner_auth_user_id)
  returning public.multi_entity_audit.id into v_audit_id;

  return pg_catalog.jsonb_build_object(
    'assignment_id', v_assignment_id,
    'already_assigned', false,
    'audit_id', v_audit_id
  );
end;
$fn$;

revoke all on function public.platform_assign_workspace_v2(uuid, uuid, uuid) from public;
revoke all on function public.platform_assign_workspace_v2(uuid, uuid, uuid) from anon;
revoke all on function public.platform_assign_workspace_v2(uuid, uuid, uuid) from authenticated;
grant execute on function public.platform_assign_workspace_v2(uuid, uuid, uuid) to service_role;

create or replace function public.platform_unassign_workspace_v2(
  p_platform_owner_auth_user_id uuid,
  p_owner_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_platform_owner_id uuid;
  v_workspace_name text;
  v_assignment_id uuid;
  v_audit_id uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null or p_owner_id is null then
    raise exception 'INVALID_WORKSPACE_ID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_assign_' || p_owner_id::text || '_' || p_workspace_id::text)::bigint
  );

  select a.id into v_assignment_id
  from public.multi_entity_assignments a
  where a.workspace_id = p_workspace_id
    and a.owner_id = p_owner_id;

  if v_assignment_id is null then
    -- Absent is not an error. Removing visibility that is already absent is a
    -- successful no-op, and writes no audit row.
    return pg_catalog.jsonb_build_object('removed', false, 'audit_id', null);
  end if;

  -- Snapshot the name BEFORE the delete so the audit row stays readable even
  -- after the workspace itself is eventually hard-deleted.
  select w.name into v_workspace_name
  from public.election_workspaces w
  where w.id = p_workspace_id;

  -- Scoped to THIS owner: unassigning one owner must never remove another
  -- owner's visibility of the same workspace.
  delete from public.multi_entity_assignments
  where workspace_id = p_workspace_id
    and owner_id = p_owner_id;

  insert into public.multi_entity_audit
    (action, owner_id, workspace_id_snapshot, workspace_name_snapshot,
     acting_platform_owner_id, acting_auth_user_id)
  values
    ('unassigned', p_owner_id, p_workspace_id, coalesce(v_workspace_name, '(deleted workspace)'),
     v_platform_owner_id, p_platform_owner_auth_user_id)
  returning public.multi_entity_audit.id into v_audit_id;

  return pg_catalog.jsonb_build_object('removed', true, 'audit_id', v_audit_id);
end;
$fn$;

revoke all on function public.platform_unassign_workspace_v2(uuid, uuid, uuid) from public;
revoke all on function public.platform_unassign_workspace_v2(uuid, uuid, uuid) from anon;
revoke all on function public.platform_unassign_workspace_v2(uuid, uuid, uuid) from authenticated;
grant execute on function public.platform_unassign_workspace_v2(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6b. COMPATIBILITY SHIMS - the exact signatures the CURRENTLY DEPLOYED
--     application calls, kept working for the whole overlap window.
--
--     Each one resolves "the" owner the only way that is meaningful to a
--     caller that cannot name one - the SOLE owner - and delegates to its
--     _v2 counterpart, so there is one implementation of the behaviour and
--     the two can never drift.
--
--     With zero owners they raise exactly what they raised before. With TWO
--     OR MORE they raise MULTI_ENTITY_OWNER_AMBIGUOUS rather than guessing:
--     a caller that cannot say which owner it means must not be allowed to
--     grant or revoke the wrong person's visibility. That state is only
--     reachable once the NEW code has added a second owner, by which point
--     the old code is on its way out - and a loud error is the correct
--     outcome, not a silent mis-assignment.
--
--     ALL of this is removed by the CONTRACT migration (20260927000000),
--     after the new code is deployed and verified.
-- ---------------------------------------------------------------------------
create or replace function public.platform_multi_entity_sole_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
  v_owner_id uuid;
begin
  select pg_catalog.count(*) into v_count from public.multi_entity_owner;
  if v_count = 0 then
    return null;
  end if;
  if v_count > 1 then
    raise exception 'MULTI_ENTITY_OWNER_AMBIGUOUS';
  end if;
  select m.owner_id into v_owner_id from public.multi_entity_owner m;
  return v_owner_id;
end;
$fn$;

comment on function public.platform_multi_entity_sole_owner() is
  'COMPATIBILITY ONLY (EXPAND phase, 20260926000000 -> removed by 20260927000000). Resolves the single Multi-Entity Owner for legacy callers that cannot name one; raises MULTI_ENTITY_OWNER_AMBIGUOUS when several exist. Granted to NO role - callable only from inside another SECURITY DEFINER body.';

revoke all on function public.platform_multi_entity_sole_owner() from public;
revoke all on function public.platform_multi_entity_sole_owner() from anon;
revoke all on function public.platform_multi_entity_sole_owner() from authenticated;
revoke all on function public.platform_multi_entity_sole_owner() from service_role;

-- LEGACY create-or-replace-the-seat, byte-identical in OBSERVABLE behaviour
-- to the 20260910010000 original: no owner -> add; same identity -> idempotent
-- refresh; different identity -> replace the sole owner, assignments carried.
create or replace function public.platform_provision_multi_entity_owner(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid := public.platform_multi_entity_sole_owner();
begin
  return public.platform_provision_multi_entity_owner_v2(
    p_platform_owner_auth_user_id, p_auth_user_id, p_name, p_email, p_phone, v_owner_id
  );
end;
$fn$;

comment on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) is
  'COMPATIBILITY ONLY (EXPAND phase - removed by 20260927000000). The pre-multi-owner create-or-replace contract, delegating to platform_provision_multi_entity_owner_v2 against the sole owner. service_role only.';

revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from public;
revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from anon;
revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from authenticated;
grant execute on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) to service_role;

create or replace function public.platform_assign_workspace(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid := public.platform_multi_entity_sole_owner();
begin
  -- Unchanged legacy contract: with no owner at all this is the same refusal
  -- the original raised before it looked at anything else.
  if v_owner_id is null then
    raise exception 'MULTI_ENTITY_OWNER_NOT_PROVISIONED';
  end if;
  return public.platform_assign_workspace_v2(
    p_platform_owner_auth_user_id, v_owner_id, p_workspace_id
  );
end;
$fn$;

comment on function public.platform_assign_workspace(uuid, uuid) is
  'COMPATIBILITY ONLY (EXPAND phase - removed by 20260927000000). Assigns to the sole Multi-Entity Owner for callers that cannot name one. service_role only.';

revoke all on function public.platform_assign_workspace(uuid, uuid) from public;
revoke all on function public.platform_assign_workspace(uuid, uuid) from anon;
revoke all on function public.platform_assign_workspace(uuid, uuid) from authenticated;
grant execute on function public.platform_assign_workspace(uuid, uuid) to service_role;

create or replace function public.platform_unassign_workspace(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid := public.platform_multi_entity_sole_owner();
begin
  -- The original treated "nothing to remove" as a successful no-op, and so
  -- must this: with no owner there is no assignment to remove.
  if v_owner_id is null then
    return pg_catalog.jsonb_build_object('removed', false, 'audit_id', null);
  end if;
  return public.platform_unassign_workspace_v2(
    p_platform_owner_auth_user_id, v_owner_id, p_workspace_id
  );
end;
$fn$;

comment on function public.platform_unassign_workspace(uuid, uuid) is
  'COMPATIBILITY ONLY (EXPAND phase - removed by 20260927000000). Unassigns from the sole Multi-Entity Owner for callers that cannot name one. service_role only.';

revoke all on function public.platform_unassign_workspace(uuid, uuid) from public;
revoke all on function public.platform_unassign_workspace(uuid, uuid) from anon;
revoke all on function public.platform_unassign_workspace(uuid, uuid) from authenticated;
grant execute on function public.platform_unassign_workspace(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The console's state read - EXPAND shape: the new keys ALONGSIDE the old.
--
--    `owners` (new) is every owner with their own assignments, and each
--    workspace reports WHICH owners hold it.
--
--    `seat`, `is_assigned` and `assigned_at` (legacy) are kept so the
--    CURRENTLY DEPLOYED console keeps rendering correctly for the whole
--    overlap window. They are removed by the CONTRACT migration.
--
--    `seat` is the SOLE owner, or null when there is none - and deliberately
--    also null once a second owner exists, because there is then no single
--    correct answer and showing an arbitrary one would be worse than showing
--    none. The old console then offers to provision, which routes to the
--    legacy shim, which raises MULTI_ENTITY_OWNER_AMBIGUOUS: a visible error
--    rather than a silent mis-assignment.
-- ---------------------------------------------------------------------------
create or replace function public.platform_get_multi_entity_state(
  p_platform_owner_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_owners jsonb;
  v_seat jsonb;
  v_owner_count integer;
  v_workspaces jsonb;
  v_pending_cleanup jsonb;
  v_pending_orphans jsonb;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'owner_id', m.owner_id,
               'auth_user_id', m.auth_user_id,
               'name', m.name,
               'email', m.email,
               'phone', m.phone,
               'created_at', m.created_at,
               'updated_at', m.updated_at,
               'assigned_workspace_ids', coalesce(
                 (select pg_catalog.jsonb_agg(a.workspace_id order by a.assigned_at)
                    from public.multi_entity_assignments a
                   where a.owner_id = m.owner_id),
                 '[]'::jsonb
               )
             )
             order by m.created_at, m.owner_id
           ),
           '[]'::jsonb
         )
    into v_owners
  from public.multi_entity_owner m;

  -- LEGACY `seat`, for the overlap window only.
  select pg_catalog.count(*) into v_owner_count from public.multi_entity_owner;
  if v_owner_count = 1 then
    select pg_catalog.jsonb_build_object(
             'auth_user_id', m.auth_user_id,
             'name', m.name,
             'email', m.email,
             'phone', m.phone,
             'created_at', m.created_at,
             'updated_at', m.updated_at
           )
      into v_seat
    from public.multi_entity_owner m;
  else
    v_seat := null;
  end if;

  -- is_active is DERIVED from election_end_at, never stored. login_code is
  -- included because election_workspaces.name carries no uniqueness constraint
  -- of any kind - it is a tenant SELECTOR, not a secret.
  --
  -- `is_assigned` / `assigned_at` are LEGACY and mean "to anyone" / "the
  -- earliest"; with one owner they are exact, which is the only state the
  -- old console can be in without erroring anyway.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'workspace_id', w.id,
               'name', w.name,
               'login_code', w.login_code,
               'election_end_at', w.election_end_at,
               'is_active', (w.election_end_at > pg_catalog.now()),
               'assigned_owner_ids', coalesce(
                 (select pg_catalog.jsonb_agg(a.owner_id order by a.assigned_at)
                    from public.multi_entity_assignments a
                   where a.workspace_id = w.id),
                 '[]'::jsonb
               ),
               'is_assigned', exists (
                 select 1 from public.multi_entity_assignments a where a.workspace_id = w.id
               ),
               'assigned_at', (
                 select pg_catalog.min(a.assigned_at)
                   from public.multi_entity_assignments a
                  where a.workspace_id = w.id
               )
             )
             order by w.created_at
           ),
           '[]'::jsonb
         )
    into v_workspaces
  from public.election_workspaces w;

  -- REPLACEMENT / REMOVAL orphans: an account displaced from an owner row
  -- that was never purged. Grouped by previous_auth_user_id, not per event
  -- row: the terminal-success index is unique on the id, so one success
  -- settles every event naming that id, and an id displaced more than once
  -- must still produce exactly one entry.
  --
  -- WIDENED for multi-owner: 'removed' joins 'replaced'. A removed owner's
  -- Auth account is displaced in exactly the same way a replaced one is, and
  -- without this the queue would silently stop offering them - the account
  -- would linger forever with no path to cleanup.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'previous_auth_user_id', p.auth_user_id,
               'replaced_at', p.replaced_at,
               'failure_count', p.failure_count,
               'last_cleanup_attempt_at', p.last_attempt_at
             )
             order by p.replaced_at, p.auth_user_id
           ),
           '[]'::jsonb
         )
    into v_pending_cleanup
  from (
    select r.previous_auth_user_id as auth_user_id,
           pg_catalog.max(r.performed_at) as replaced_at,
           (select pg_catalog.count(*) from public.multi_entity_audit f
             where f.action = 'previous_auth_delete_failed'
               and f.previous_auth_user_id = r.previous_auth_user_id) as failure_count,
           (select pg_catalog.max(f.performed_at) from public.multi_entity_audit f
             where f.action = 'previous_auth_delete_failed'
               and f.previous_auth_user_id = r.previous_auth_user_id) as last_attempt_at
    from public.multi_entity_audit r
    where r.action in ('replaced', 'removed')
      and not exists (
        select 1 from public.multi_entity_audit s
        where s.action = 'previous_auth_deleted'
          and s.previous_auth_user_id = r.previous_auth_user_id
      )
      -- An identity that has since become a principal again is NOT an orphan.
      and public.multi_entity_auth_user_held_by(r.previous_auth_user_id) is null
    group by r.previous_auth_user_id
  ) p;

  -- PROVISIONING orphans: an account minted for an attempt that never became
  -- an owner. The mint row stays forever - eligibility is derived from
  -- immutable facts, never by amending or deleting history. Unchanged by
  -- multi-owner except that 'provisioned' now fires per ADDED owner, which is
  -- exactly the fact this predicate already wanted.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'auth_user_id', o.auth_user_id,
               'minted_at', o.minted_at,
               'attempted_email', o.attempted_email,
               'failure_count', o.failure_count,
               'last_cleanup_attempt_at', o.last_attempt_at
             )
             order by o.minted_at, o.auth_user_id
           ),
           '[]'::jsonb
         )
    into v_pending_orphans
  from (
    select m.orphan_auth_user_id as auth_user_id,
           pg_catalog.max(m.performed_at) as minted_at,
           (pg_catalog.array_agg(m.attempted_email
              order by m.performed_at desc, m.id desc))[1] as attempted_email,
           (select pg_catalog.count(*) from public.multi_entity_audit f
             where f.action = 'provisioning_orphan_delete_failed'
               and f.orphan_auth_user_id = m.orphan_auth_user_id) as failure_count,
           (select pg_catalog.max(f.performed_at) from public.multi_entity_audit f
             where f.action = 'provisioning_orphan_delete_failed'
               and f.orphan_auth_user_id = m.orphan_auth_user_id) as last_attempt_at
    from public.multi_entity_audit m
    where m.action = 'provisioning_auth_minted'
      and not exists (
        select 1 from public.multi_entity_audit s
        where s.action = 'provisioning_orphan_deleted'
          and s.orphan_auth_user_id = m.orphan_auth_user_id
      )
      and not exists (
        select 1 from public.multi_entity_audit t
        where t.action in ('provisioned', 'replaced')
          and t.seat_auth_user_id = m.orphan_auth_user_id
      )
      and public.multi_entity_auth_user_held_by(m.orphan_auth_user_id) is null
    group by m.orphan_auth_user_id
  ) o;

  return pg_catalog.jsonb_build_object(
    'owners', v_owners,
    'seat', v_seat,
    'workspaces', v_workspaces,
    'pending_auth_cleanup', v_pending_cleanup,
    'pending_provisioning_orphans', v_pending_orphans
  );
end;
$fn$;

comment on function public.platform_get_multi_entity_state(uuid) is
  'The Platform console''s Multi-Entity read. EXPAND shape (20260926000000): `owners` (every owner with their own assigned workspace ids) and per-workspace `assigned_owner_ids`, ALONGSIDE the legacy `seat` / `is_assigned` / `assigned_at` keys the previous deployment still reads. The legacy keys are removed by 20260927000000. service_role only.';

revoke all on function public.platform_get_multi_entity_state(uuid) from public;
revoke all on function public.platform_get_multi_entity_state(uuid) from anon;
revoke all on function public.platform_get_multi_entity_state(uuid) from authenticated;
grant execute on function public.platform_get_multi_entity_state(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7b. The purge guard must recognise REMOVAL as a displacement event.
--
--     Without this, removing an owner would leave their Auth account
--     permanently unpurgeable: the guard binds the destructive delete to a
--     'replaced' audit row, which a removal does not write. Everything else
--     about the guard is unchanged - including that a displaced identity
--     which has since become a principal again is still refused.
-- ---------------------------------------------------------------------------
create or replace function public.platform_check_auth_user_purgeable(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_held_by text;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_auth_user_id is null then
    raise exception 'INVALID_AUTH_CLEANUP_TARGET';
  end if;

  -- (a) Already recorded as purged - a RECORD fact, deliberately distinct from
  -- the caller's own WORLD fact of whether the account is absent.
  if exists (
    select 1 from public.multi_entity_audit a
    where a.action = 'previous_auth_deleted'
      and a.previous_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', true,
      'reason', 'ALREADY_COMPLETED',
      'held_by', null
    );
  end if;

  -- (b) Bind this destructive operation to a real displacement event. WIDENED
  -- for multi-owner: 'removed' displaces an identity exactly as 'replaced'
  -- does. The error code stays NOT_A_REPLACED_PRINCIPAL so existing handler
  -- and console mappings keep working unchanged.
  if not exists (
    select 1 from public.multi_entity_audit a
    where a.action in ('replaced', 'removed')
      and a.previous_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'NOT_A_REPLACED_PRINCIPAL',
      'held_by', null
    );
  end if;

  -- (c) Live linkages, via the shared helper.
  v_held_by := public.multi_entity_auth_user_held_by(p_auth_user_id);

  if v_held_by is not null then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'AUTH_USER_STILL_HELD',
      'held_by', v_held_by
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'purgeable', true,
    'already_completed', false,
    'reason', null,
    'held_by', null
  );
end;
$fn$;

revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from public;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from anon;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from authenticated;
grant execute on function public.platform_check_auth_user_purgeable(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Post-condition - fail the migration rather than leave a half-applied
--    authorization model behind, AND prove the compatibility layer is intact.
-- ---------------------------------------------------------------------------
do $verify$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'multi_entity_owner_singleton'
      and conrelid = 'public.multi_entity_owner'::regclass
  ) then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: the singleton CHECK is still present';
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'multi_entity_assignments_workspace_id_key'
      and conrelid = 'public.multi_entity_assignments'::regclass
  ) then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: unique(workspace_id) still present - two owners could not share a workspace';
  end if;

  if exists (
    select 1 from public.multi_entity_assignments where owner_id is null
  ) then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: unattributed assignment rows remain';
  end if;

  -- NEW capability present.
  if to_regprocedure('public.platform_remove_multi_entity_owner(uuid,uuid)') is null
     or to_regprocedure('public.platform_provision_multi_entity_owner_v2(uuid,uuid,text,text,text,uuid)') is null
     or to_regprocedure('public.platform_assign_workspace_v2(uuid,uuid,uuid)') is null
     or to_regprocedure('public.platform_unassign_workspace_v2(uuid,uuid,uuid)') is null then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: a _v2 operation is missing';
  end if;

  -- OLD contract STILL present - this is the whole point of EXPAND. If any of
  -- these is missing, applying this migration would break the deployment that
  -- is currently serving Production.
  if to_regprocedure('public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)') is null
     or to_regprocedure('public.platform_assign_workspace(uuid,uuid)') is null
     or to_regprocedure('public.platform_unassign_workspace(uuid,uuid)') is null then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: a legacy signature the deployed application calls is missing';
  end if;

  if not has_function_privilege('service_role', 'public.platform_assign_workspace(uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.platform_unassign_workspace(uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)', 'execute') then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: a legacy signature lost its service_role grant';
  end if;

  -- The scope gate must remain callable by NO role at all.
  if has_function_privilege('authenticated', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute')
     or has_function_privilege('anon', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute')
     or has_function_privilege('service_role', 'public.multi_entity_assert_workspace_assigned(uuid,uuid)', 'execute') then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: the workspace-scope gate is executable by a role';
  end if;

  -- The sole-owner helper is an internal shim and must be reachable by no role.
  if has_function_privilege('service_role', 'public.platform_multi_entity_sole_owner()', 'execute')
     or has_function_privilege('anon', 'public.platform_multi_entity_sole_owner()', 'execute')
     or has_function_privilege('authenticated', 'public.platform_multi_entity_sole_owner()', 'execute') then
    raise exception 'MULTI_OWNER_VERIFY_FAILED: the compatibility helper is executable by a role';
  end if;
end;
$verify$;
