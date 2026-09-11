-- Platform Stage 6: aggregate-only cross-workspace read backend for the
-- Multi-Entity Owner.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- Stage 5 made the Multi-Entity Owner a real, server-verified principal that
-- may see WHICH workspaces are currently assigned to the seat - metadata only.
-- Stage 6 adds the first business read: per-workspace AGGREGATE COUNTS of the
-- election-day contact list, and nothing else. No row, no person, no free text
-- ever leaves the database through anything here.
--
-- ============================================================================
-- SCOPE - additive only
-- ============================================================================
--   functions ............... +3 new, 0 replaced
--     multi_entity_compute_workspace_aggregate(uuid, uuid)  NO role (internal)
--     multi_entity_get_workspace_aggregate(uuid, uuid)      service_role
--     multi_entity_list_workspace_aggregates(uuid)          service_role
--   tables / columns / constraints / indexes / triggers / RLS policies / ACLs .. 0
--
-- ============================================================================
-- AGGREGATE CONTRACT (mirrors existing business definitions exactly)
-- ============================================================================
-- Source: public.election_day_voters rows of ONE workspace (the election-day
-- contact list). Every metric is a count; percentages are a client concern.
--
--   contacts_total       count(*)                    = dashboard stats.total
--   voted                voted = true                = dashboard stats.voted
--                        ("voted always wins", followUpStatus.ts)
--   follow_up_closed     not voted AND the contact's reason (of the SAME
--                        workspace) has requires_follow_up = false
--                                                    = stats.closed /
--                        resolveFollowUpStatus "closed". Inactive reasons
--                        still count: the workspace's reason list the
--                        dashboard resolves against is unfiltered by
--                        is_active. A reason id that does not resolve inside
--                        the workspace counts as remaining, never closed.
--   follow_up_remaining  contacts_total - voted - follow_up_closed
--                                                    = stats.remaining; the
--                        same predicate as election_day_voter_is_remaining
--                        (which is NOT reused: it has no workspace
--                        containment on the reason lookup)
--   ride_completed       ride_completed                                   \
--   ride_arranged        ride_arranged AND NOT ride_completed              > = rideStatusBreakdown.ts:
--   ride_needed          ride_requested AND NOT arranged AND NOT completed/  one bucket per contact,
--                                                                          most-advanced stage wins
--
-- Deliberately EXCLUDED (never computed here): coordinator breakdown
-- (person names), per-reason breakdown (workspace-authored free-text labels,
-- sensitive categories), turnout pace / any timestamp series, reminder and
-- call-attempt metrics (client-clock-relative), and every identifying or
-- free-text column (names, phone, address, city, masad, notes, login_code).
--
-- ============================================================================
-- PRIVACY / INFERENCE RULES (enforced HERE, not in the API)
-- ============================================================================
--   1. ACTIVE workspaces only. The approved architecture scopes the
--      Multi-Entity view to "assigned ACTIVE workspaces"; active is the
--      existing derived definition election_end_at > now(). An ended
--      assignment is returned with report_status 'ended' and NO counts.
--   2. Minimum reportable population: a workspace with fewer than 10
--      contacts (0 and 1 included) is returned with report_status
--      'suppressed' and NO counts at all - not even its total.
--   3. Only 'reported' rows carry numbers, so any cross-workspace total can
--      be built solely from released rows; differencing totals against
--      per-workspace rows can never recover a suppressed workspace.
--
-- ============================================================================
-- AUTHORIZATION (Stage 5 contract)
-- ============================================================================
-- The internal compute function calls multi_entity_assert_workspace_assigned
-- as its FIRST statement, in the same call - and, the function being STABLE,
-- the same snapshot - as the aggregate read. There is no "check, then read in
-- another request" path. The list function derives the workspace set from the
-- assignment rows itself (no client-supplied list exists) and still runs the
-- gate for every workspace. Every p_auth_user_id comes from the server-side
-- verifier (api/platform/_multiEntityAuth.ts: getUser -> getClaims aal2 ->
-- resolver); nothing is cached and nothing is read from JWT claims.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- Production and the local stacks carry a pg_default_acl that auto-grants
-- EXECUTE on new public functions to anon/authenticated/service_role, and
-- `revoke ... from public` alone does not undo it. Every function below
-- revokes EXECUTE from PUBLIC, anon and authenticated BY EXACT SIGNATURE (the
-- internal one from service_role too). After applying to Production, read
-- pg_proc.proacl there directly.
-- ============================================================================

begin;

-- ===========================================================================
-- 1. multi_entity_compute_workspace_aggregate - INTERNAL (no role).
-- ===========================================================================
create or replace function public.multi_entity_compute_workspace_aggregate(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz,
  report_status text,
  contacts_total integer,
  voted integer,
  follow_up_closed integer,
  follow_up_remaining integer,
  ride_needed integer,
  ride_arranged integer,
  ride_completed integer
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  -- Minimum reportable population (privacy rule 2).
  c_min_reportable constant integer := 10;
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
  -- The Stage 5 gate, in this call's snapshot: raises UNAUTHORIZED (not the
  -- current exclusive seat holder) or WORKSPACE_NOT_ASSIGNED (unassigned OR
  -- nonexistent - identical by design).
  perform public.multi_entity_assert_workspace_assigned(p_auth_user_id, p_workspace_id);

  select w.id, w.name, w.election_end_at, a.assigned_at
    into v_ws_id, v_ws_name, v_ws_end, v_assigned_at
  from public.multi_entity_assignments a
  join public.election_workspaces w on w.id = a.workspace_id
  where a.workspace_id = p_workspace_id;

  if not found then
    -- Unreachable after the gate; fail closed with the gate's own answer.
    raise exception 'WORKSPACE_NOT_ASSIGNED';
  end if;

  -- Privacy rule 1: ended workspaces release no counts (and are not read).
  if not (v_ws_end > pg_catalog.now()) then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'ended'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  -- One scan of this workspace's rows. The reason join is on its primary key
  -- AND the voter's own workspace, so it matches at most one row (no double
  -- counting) and a foreign-workspace reason can never close a case.
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

  -- Privacy rule 2: small populations release nothing, not even the total.
  if v_total < c_min_reportable then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'suppressed'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'reported'::text,
    v_total, v_voted, v_closed, v_total - v_voted - v_closed,
    v_needed, v_arranged, v_completed;
end;
$fn$;

comment on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) is
  'Stage 6 INTERNAL: aggregate counts for ONE workspace, gated FIRST by multi_entity_assert_workspace_assigned in the same STABLE snapshot. report_status: ''ended'' (election_end_at <= now(), no counts), ''suppressed'' (fewer than 10 contacts, no counts - not even the total) or ''reported'' (contacts_total, voted, follow_up_closed, follow_up_remaining, ride_needed, ride_arranged, ride_completed - the dashboard definitions). Never returns a row, a person, free text or login_code. Granted to NO role, service_role included.';

revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from public;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from anon;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from authenticated;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from service_role;

-- ===========================================================================
-- 2. multi_entity_get_workspace_aggregate - one workspace (client-supplied
--    id, UNTRUSTED: authorized solely by the gate inside the compute call).
-- ===========================================================================
create or replace function public.multi_entity_get_workspace_aggregate(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz,
  report_status text,
  contacts_total integer,
  voted integer,
  follow_up_closed integer,
  follow_up_remaining integer,
  ride_needed integer,
  ride_arranged integer,
  ride_completed integer
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  return query
    select c.workspace_id, c.name, c.election_end_at, c.assigned_at, c.report_status,
           c.contacts_total, c.voted, c.follow_up_closed, c.follow_up_remaining,
           c.ride_needed, c.ride_arranged, c.ride_completed
    from public.multi_entity_compute_workspace_aggregate(p_auth_user_id, p_workspace_id) c;
end;
$fn$;

comment on function public.multi_entity_get_workspace_aggregate(uuid, uuid) is
  'Stage 6: aggregate counts for ONE workspace for a SERVER-VERIFIED auth_user_id. Raises UNAUTHORIZED or WORKSPACE_NOT_ASSIGNED (unassigned OR nonexistent - identical) from the in-snapshot gate. Same row shape and privacy rules as multi_entity_compute_workspace_aggregate. Read-only. service_role-only.';

revoke all on function public.multi_entity_get_workspace_aggregate(uuid, uuid) from public;
revoke all on function public.multi_entity_get_workspace_aggregate(uuid, uuid) from anon;
revoke all on function public.multi_entity_get_workspace_aggregate(uuid, uuid) from authenticated;
grant execute on function public.multi_entity_get_workspace_aggregate(uuid, uuid) to service_role;

-- ===========================================================================
-- 3. multi_entity_list_workspace_aggregates - every CURRENTLY assigned
--    workspace; the set is derived here, never supplied by a client.
-- ===========================================================================
create or replace function public.multi_entity_list_workspace_aggregates(
  p_auth_user_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz,
  report_status text,
  contacts_total integer,
  voted integer,
  follow_up_closed integer,
  follow_up_remaining integer,
  ride_needed integer,
  ride_arranged integer,
  ride_completed integer
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  -- Self-authorizing even with zero assignments: a non-holder is refused,
  -- never answered with an empty list.
  perform 1 from public.multi_entity_resolve_owner_context(p_auth_user_id);

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
    order by w.name asc, w.id asc;
end;
$fn$;

comment on function public.multi_entity_list_workspace_aggregates(uuid) is
  'Stage 6: aggregate counts for every workspace CURRENTLY assigned to the Multi-Entity seat, for a SERVER-VERIFIED auth_user_id. Raises UNAUTHORIZED for a non-holder (even with zero assignments); zero assignments -> zero rows. The workspace set is derived from multi_entity_assignments inside this call; the per-workspace gate runs for each one in the same snapshot. Ordered name asc, workspace_id asc. Read-only. service_role-only.';

revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from public;
revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from anon;
revoke all on function public.multi_entity_list_workspace_aggregates(uuid) from authenticated;
grant execute on function public.multi_entity_list_workspace_aggregates(uuid) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - Supabase CLI migrations have no automatic "down").
-- Revert the APPLICATION first: the deployed app calls these RPCs.
--
--   drop function if exists public.multi_entity_list_workspace_aggregates(uuid);
--   drop function if exists public.multi_entity_get_workspace_aggregate(uuid, uuid);
--   drop function if exists public.multi_entity_compute_workspace_aggregate(uuid, uuid);
-- ============================================================================
