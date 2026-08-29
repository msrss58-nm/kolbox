-- Phase 3C Coordinator/Allocation - Dual-Principal Trusted V3 BACKEND EXPAND.
-- Approved authorization decision (final for this workstream, NOT Owner-only
-- unlike Roles): both an Election Owner (fixed Owner authority - being a
-- resolved Owner of the target workspace IS the authorization, no permission
-- check) and a PermissionUser whose CURRENT live role holds electionDay.
-- manageCoordinatorAllocation may perform all 4 mutations: manage
-- coordinators, apply initial allocation, rebalance assignments, end
-- coordinator activity. Plus a small trusted, workspace-scoped coordinator
-- read serving both principals, for a future cutover.
--
-- Strictly additive. Does NOT touch, modify, or retire election_day_manage_
-- coordinators_v2/_apply_initial_allocation_v2/_rebalance_assignments_v2/
-- _end_coordinator_activity_v2 (20260829020000, already workspace-contained
-- and live in Production) - those remain the frontend's only reachable path
-- until a separate, later, explicit frontend cutover. Does NOT touch
-- election_day_import_voters_v2, election_day_sync_coordinators_from_voters,
-- any RLS policy, any table grant, or any Users/Roles trusted infrastructure.
-- No frontend code calls anything in this migration.
--
-- ============================================================================
-- TRUST INFRASTRUCTURE REUSED, VERBATIM, FROM THE TWO ALREADY-PROVEN SYSTEMS
-- (verified by direct source inspection before writing this migration - see
-- this workstream's own report for the full per-function citation trail):
-- ============================================================================
--   PermissionUser chain: election_day_resolve_session(p_session_hash)
--     (20260826010000) -> election_day_verify_and_consume_reauth_proof_v3
--     (p_session_hash, p_proof_hash, p_action) (20260828000000, ONE-TIME
--     consume via DELETE...RETURNING) -> live electionDay.
--     manageCoordinatorAllocation check on the resolved role, read live every
--     call (same "never cached, never proof-snapshotted" discipline as every
--     _v2 RPC in this project).
--   Owner chain: election_day_verify_and_consume_owner_proof(p_auth_user_id,
--     p_proof_hash, p_action) (20260828060000, ONE-TIME consume, live-
--     re-resolves election_owners on every call) -> NO permission check -
--     being a resolved Owner of the proof's own workspace IS the
--     authorization, mirroring election_day_create_role_owner_v3's own
--     evidence-based precedent (20260828070000) exactly, per this
--     workstream's approved, non-negotiable authorization decision.
-- Neither table/helper is modified by this migration. No third identity or
-- proof system is introduced - both existing, already-empirically-proven
-- one-time-consume mechanisms are reused exactly as designed for Users v3
-- and Roles Owner v3.
--
-- Proof/action isolation is STRUCTURAL, not just convention: PermissionUser
-- proofs live in election_day_reauth_proofs (consumed only by election_day_
-- verify_and_consume_reauth_proof_v3); Owner proofs live in the completely
-- separate election_owner_reauth_proofs (consumed only by election_day_
-- verify_and_consume_owner_proof). A proof minted for one principal type can
-- never be looked up, let alone consumed, by the other principal's consume
-- helper - there is no shared table or shared lookup path between them. The
-- same action name (e.g. 'manage_coordinators') is used for both principals
-- below purely for naming clarity; it creates no cross-principal reuse risk,
-- since each consume helper only ever queries its own dedicated table.
--
-- NULL-workspace fail-closed is now STRUCTURAL, stronger than the _v2
-- ACTOR_WORKSPACE_REQUIRED runtime check: election_day_login_v2 (the only
-- way to obtain a v3 PermissionUser session) already refuses to create a
-- session at all for a NULL-workspace user (raises UNAUTHORIZED - verified
-- by direct inspection of its body, 20260826010000); election_owners.
-- workspace_id is NOT NULL at the schema level (20260823010000). A v3
-- wrapper below can therefore never resolve a NULL v_workspace_id from
-- either consume helper - there is no runtime guard to write because the
-- precondition is already unreachable, not merely checked.
--
-- ============================================================================
-- DUAL-PRINCIPAL DB DESIGN - smallest maintainable shape found: one INTERNAL-
-- ONLY, postgres-owned "core" function per operation (5 total: the 4
-- mutations + 1 read), containing the actual business logic (copied verbatim
-- from the already-workspace-contained _v2 bodies, 20260829020000, with
-- workspace_id/executed_by now PARAMETERS instead of self-derived from a
-- proof), plus two thin principal-specific wrappers per operation (session+
-- proof for PermissionUser, auth_user_id+proof for Owner) that each resolve
-- their own trust chain, then call the SAME core function. This avoids
-- duplicating the real business logic 8 times while keeping each principal's
-- own trust/authorization resolution completely separate and unconfusable -
-- neither wrapper ever calls the other's consume helper, and neither ever
-- accepts a client-supplied workspace_id/actor identity of any kind. Every
-- core function is granted to NO role at all (matching election_day_verify_
-- and_consume_owner_proof's own internal-helper precedent) - callable only
-- from inside a wrapper's own SECURITY DEFINER body (both owned by postgres,
-- which bypasses ACL checks for a nested call).
--
-- Business semantics preserved EXACTLY from the just-verified, live-in-
-- Production _v2 containment bodies (20260829020000) - validation/error
-- codes, coordinator business rules (identity-safety guards, name-collision
-- checks), deterministic allocation/rebalance slicing, audit-row shape,
-- participation guards, LAST_ACTIVE_COORDINATOR (workspace-local), full
-- transaction atomicity, workspace isolation via workspace_id = p_workspace_id
-- filters throughout. The ONLY behavioral difference from the _v2 bodies:
-- `executed_by_id`/`executed_by_owner_id_snapshot`/`executed_by_name_snapshot`
-- on the 3 audit-writing operations are now supplied by the caller - a
-- PermissionUser-executed call sets executed_by_id (its own existing,
-- unchanged FK to election_day_permission_users) and leaves the new
-- executed_by_owner_id_snapshot NULL; an Owner-executed call sets the new
-- executed_by_owner_id_snapshot (a plain uuid VALUE snapshot of the Owner's
-- own election_owners.id, deliberately carrying NO foreign key of any kind)
-- and leaves executed_by_id NULL. Durable attribution to the exact acting
-- principal is preserved for BOTH principal types - see the executed_by_
-- owner_id_snapshot column added just below this header for the full,
-- two-round pre-commit finding trail (round 1: an earlier draft left
-- Owner-executed rows attributable only via the mutable executed_by_name_
-- snapshot; round 2: an earlier fix for round 1 added a NULLABLE FK'd
-- column, itself found to lose the identifier on Owner deletion via its own
-- ON DELETE SET NULL - replaced with the current FK-free snapshot design,
-- which no deletion of any kind can ever erase). executed_by_name_snapshot
-- itself remains unchanged - still populated on every row, still the
-- human-readable display snapshot, complementary to the stable identifier
-- now captured for both principal types.
--
-- Shared advisory-lock domain preserved EXACTLY: every core function that
-- mutates coordinator/voter state acquires pg_advisory_xact_lock(hashtext(
-- 'election_day_voter_allocation_mutation')::bigint) in the SAME relative
-- position as its _v2 counterpart (after auth/workspace resolution and pure
-- input-shape validation, before any row lock) - no new lock key. Because
-- this is the identical key already used by the 4 live _v2 RPCs and by
-- election_day_import_voters_v2, every v3 core function continues to
-- serialize against all of them automatically, with zero additional wiring -
-- Postgres advisory locks are process/session-scoped by key, not by which
-- function acquired them.
--
-- Trusted read (election_day_list_coordinators_core + its two wrappers):
-- inspected the current listCoordinators() frontend read (globally
-- unscoped, no workspace filter, no caller-identity check, plain SELECT
-- against a SELECT-only-granted table) - this migration does NOT change that
-- live path or its RLS at all (explicitly out of scope), but adds the
-- smallest additive workspace-scoped trusted read both principals will need
-- for a future cutover, mirroring election_day_list_permission_users_v3''s
-- own "no reauth proof required for a read" precedent exactly.
--
-- ============================================================================
-- SECURITY GUARDRAILS (uniform, per CLAUDE.md''s Permanent Engineering
-- Guardrail - a bare `revoke ... from public` alone is not sufficient on
-- this project''s own hosted Production instance): every function below
-- explicitly REVOKEs EXECUTE from PUBLIC, anon, and authenticated by name.
-- Every wrapper additionally GRANTs EXECUTE to service_role only - the
-- browser''s own anon key can never call any of them directly. Every core
-- function gets NO grant to any role, including service_role.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI''s migration runner pipelines
-- a file''s statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- SCHEMA - election_day_coordinator_operations.executed_by_owner_id_snapshot.
-- Pre-commit security/audit gate finding, ROUND 1: an Owner-executed
-- operation's audit row previously carried ONLY executed_by_id = NULL /
-- executed_by_name_snapshot = the Owner's own (mutable, re-editable) name -
-- insufficient durable attribution to the exact Owner principal. The
-- existing executed_by_id column cannot be reused for this (it is FK'd
-- specifically to election_day_permission_users, and overloading it with an
-- election_owners id would blur two distinct principal types onto one FK,
-- the exact anti-pattern election_owner_reauth_proofs was deliberately kept
-- as its own table to avoid - see 20260828060000's own header). No existing
-- polymorphic actor-audit mechanism exists anywhere in this schema to reuse
-- instead (Users/Roles v3 Owner mutations have no operations/audit table of
-- their own at all - this table is unique to Coordinator/Allocation).
--
-- ROUND 2 (this text, final): a first fix added a NULLABLE FK'd column
-- (`references election_owners(id) on delete set null`) - itself found, in
-- a second pre-commit pass, to NOT actually provide durable attribution:
-- deleting the Owner row (a legitimate, expected lifecycle event - Owners
-- can be removed while their workspace and its operational history persist)
-- would silently NULL the column via its own ON DELETE SET NULL clause,
-- losing the exact identifier and falling back to the mutable name snapshot
-- - exactly the gap this column exists to close. Fixed by making this a
-- true SNAPSHOT column instead: a plain `uuid` with NO foreign key of any
-- kind, so no DELETE on election_owners (or anything else) can ever erase,
-- null out, cascade into, or block-via-RESTRICT this value - it is captured
-- once, at write time, and is then permanently immune to the referenced
-- row's later lifecycle, exactly like executed_by_name_snapshot's own
-- existing "frozen at write time, never re-derived" design intent (see that
-- column's own comment) - just capturing a stable identifier instead of a
-- mutable name. This is the SAME pattern election_day_coordinator_operation_
-- items already uses for voter_name_snapshot/from_coordinator_name_snapshot/
-- to_coordinator_name_snapshot (frozen text captured alongside a nullable,
-- ON-DELETE-SET-NULL FK to the live row) - applied here to a stable
-- identifier rather than a display string, since a plain uuid has no
-- separate "display" form to also capture.
--
-- Exactly one of (executed_by_id, executed_by_owner_id_snapshot) is non-null
-- on any row written from this point forward: a PermissionUser-executed
-- operation sets executed_by_id (its own existing, unchanged FK to election_
-- day_permission_users - still ON DELETE SET NULL, since that FK was never
-- the problem this fix addresses) and leaves executed_by_owner_id_snapshot
-- NULL; an Owner-executed operation sets executed_by_owner_id_snapshot (the
-- Owner's own election_owners.id, captured as a value with no FK at all) and
-- leaves executed_by_id NULL. executed_by_name_snapshot remains populated on
-- every row exactly as before (unchanged column, unchanged semantics) - a
-- human-readable display snapshot, complementary to, never a substitute for,
-- the stable identifier now captured in whichever of the two id columns
-- applies. PermissionUser audit semantics are otherwise byte-for-byte
-- unchanged; workspace scoping in every mutation core is unaffected (this is
-- an audit-column addition only, not a business-logic or authorization
-- change). election_day_coordinator_operations.workspace_id itself remains
-- unwritten by every caller (v2 and v3 alike) - an already-tracked,
-- deliberately separate, out-of-scope gap, not touched here. Owner deletion
-- itself is never blocked or affected by this column in any way - there is
-- no FK/RESTRICT of any kind on it, by design.
alter table public.election_day_coordinator_operations
  add column executed_by_owner_id_snapshot uuid;

comment on column public.election_day_coordinator_operations.executed_by_owner_id_snapshot is
  'Durable SNAPSHOT of the exact Election Owner principal (election_owners.id) that executed this operation, when the actor was an Owner rather than a PermissionUser (NULL otherwise). Deliberately a plain uuid with NO foreign key of any kind - captured once, at write time, exactly like executed_by_name_snapshot''s own "frozen, never re-derived" design intent - so a later deletion of the Owner row can never null out, cascade into, or otherwise erase this value, and Owner deletion is never blocked by it either. Sibling to executed_by_id (which stays NULL for an Owner-executed row, and keeps its own unchanged, still-FK''d-and-ON-DELETE-SET-NULL relationship to election_day_permission_users - that FK was never the problem this column exists to solve). Exactly one of (executed_by_id, executed_by_owner_id_snapshot) is populated per row.';

-- ============================================================================
-- CORE 1 - election_day_manage_coordinators_core. Business logic copied
-- verbatim from the live-in-Production election_day_manage_coordinators_v2
-- (20260829020000) - identical add/edit/remove/link/relink/unlink/
-- update_phone behavior, identical workspace-scoped integrity checks,
-- identical error codes. Never writes election_day_coordinator_operations -
-- no executed_by parameter needed, matching the _v2 body exactly.
-- ============================================================================
create or replace function public.election_day_manage_coordinators_core(
  p_workspace_id uuid,
  p_actions jsonb
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_ids uuid[];
  v_action jsonb;
  v_action_type text;
  v_coordinator_id uuid;
  v_display_name text;
  v_linked_name text;
  v_existing_linked_name text;
  v_current_display_name text;
  v_current_identity_names text[];
  v_phone_raw text;
  v_phone_digits text;
  v_phone_normalized text;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_actions is null or jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) = 0 then
    raise exception 'NO_ACTIONS';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct x.id order by x.id)
    into v_lock_ids
  from jsonb_array_elements(p_actions) as elem
  cross join lateral (select nullif(elem->>'coordinator_id', '')::uuid as id) as x
  where x.id is not null;

  if v_lock_ids is not null then
    perform 1 from public.election_day_coordinators
    where id = any(v_lock_ids)
      and workspace_id = p_workspace_id
    order by id
    for update;
  end if;

  for v_action in select * from jsonb_array_elements(p_actions)
  loop
    v_action_type := v_action->>'action';
    v_coordinator_id := nullif(v_action->>'coordinator_id', '')::uuid;
    v_display_name := nullif(btrim(v_action->>'display_name'), '');
    v_linked_name := nullif(btrim(v_action->>'linked_assignment_name'), '');

    if v_action_type = 'add' then
      if v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where (c.display_name = v_display_name or c.linked_assignment_name = v_display_name)
          and c.workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      v_phone_raw := nullif(btrim(v_action->>'phone'), '');
      if v_phone_raw is not null then
        v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
        if left(v_phone_digits, 3) = '972' and length(v_phone_digits) = 12 then
          v_phone_normalized := '0' || substr(v_phone_digits, 4);
        elsif length(v_phone_digits) = 9 and left(v_phone_digits, 1) <> '0' then
          v_phone_normalized := '0' || v_phone_digits;
        else
          v_phone_normalized := v_phone_digits;
        end if;
        if v_phone_normalized !~ '^0[0-9]{8,9}$' then
          raise exception 'INVALID_COORDINATOR_PHONE';
        end if;
      else
        v_phone_normalized := null;
      end if;

      insert into public.election_day_coordinators (display_name, phone, workspace_id)
      values (v_display_name, v_phone_normalized, p_workspace_id);

    elsif v_action_type = 'edit' then
      if v_coordinator_id is null or v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_current_identity_names := array_remove(array[v_current_display_name, v_existing_linked_name], null);

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
          and v.workspace_id = p_workspace_id
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
          and u.workspace_id = p_workspace_id
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and (c.display_name = v_display_name or c.linked_assignment_name = v_display_name)
          and c.workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      update public.election_day_coordinators
      set display_name = v_display_name
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

    elsif v_action_type = 'remove' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_current_identity_names := array_remove(array[v_current_display_name, v_existing_linked_name], null);

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
          and v.workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_HAS_ASSIGNED_VOTERS';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
          and u.workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_HAS_LOGIN_ACCOUNT';
      end if;

      delete from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

    elsif v_action_type in ('link', 'relink') then
      if v_coordinator_id is null or v_linked_name is null then
        raise exception 'INVALID_LINK';
      end if;

      if not exists (
        select 1 from public.election_day_coordinators
        where id = v_coordinator_id
          and workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.status = 'active'
          and c.id <> v_coordinator_id
          and c.display_name = v_linked_name
          and c.workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and c.linked_assignment_name = v_linked_name
          and c.workspace_id = p_workspace_id
      ) then
        raise exception 'ASSIGNMENT_ALREADY_LINKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = v_linked_name
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

    elsif v_action_type = 'unlink' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      select linked_assignment_name into v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = null
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

    elsif v_action_type = 'update_phone' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if not exists (
        select 1 from public.election_day_coordinators
        where id = v_coordinator_id
          and workspace_id = p_workspace_id
      ) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_phone_raw := nullif(btrim(v_action->>'phone'), '');
      if v_phone_raw is not null then
        v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
        if left(v_phone_digits, 3) = '972' and length(v_phone_digits) = 12 then
          v_phone_normalized := '0' || substr(v_phone_digits, 4);
        elsif length(v_phone_digits) = 9 and left(v_phone_digits, 1) <> '0' then
          v_phone_normalized := '0' || v_phone_digits;
        else
          v_phone_normalized := v_phone_digits;
        end if;
        if v_phone_normalized !~ '^0[0-9]{8,9}$' then
          raise exception 'INVALID_COORDINATOR_PHONE';
        end if;
      else
        v_phone_normalized := null;
      end if;

      update public.election_day_coordinators
      set phone = v_phone_normalized
      where id = v_coordinator_id
        and workspace_id = p_workspace_id;

    else
      raise exception 'INVALID_ACTION';
    end if;
  end loop;

  return query
    select * from public.election_day_coordinators
    where workspace_id = p_workspace_id
    order by created_at asc, id asc;
end;
$$;

comment on function public.election_day_manage_coordinators_core(uuid, jsonb) is
  'Phase 3C Dual-Principal V3: INTERNAL-ONLY shared business core for manage_coordinators, called by both election_day_manage_coordinators_v3 (PermissionUser) and _owner_v3 (Owner). Business logic copied verbatim from the live-in-Production election_day_manage_coordinators_v2 (20260829020000) - identical add/edit/remove/link/relink/unlink/update_phone behavior and workspace-scoped integrity checks, parameterized by p_workspace_id instead of self-deriving it. Not granted to any role, including service_role - callable only from inside a wrapper''s own SECURITY DEFINER body.';

revoke all on function public.election_day_manage_coordinators_core(uuid, jsonb) from public;
revoke all on function public.election_day_manage_coordinators_core(uuid, jsonb) from anon;
revoke all on function public.election_day_manage_coordinators_core(uuid, jsonb) from authenticated;
revoke all on function public.election_day_manage_coordinators_core(uuid, jsonb) from service_role;

-- ============================================================================
-- CORE 2 - election_day_apply_initial_allocation_core. Business logic copied
-- verbatim from election_day_apply_initial_allocation_v2 (20260829020000).
-- ============================================================================
create or replace function public.election_day_apply_initial_allocation_core(
  p_workspace_id uuid,
  p_assignments jsonb,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
)
returns table (
  operation_id uuid,
  allocated_count integer,
  remaining_unassigned_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elem jsonb;
  v_coordinator_id uuid;
  v_quantity integer;
  v_sum_quantities integer := 0;
  v_lock_ids uuid[];
  v_locked_coordinator_count integer;
  v_unassigned_count integer;
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'INVALID_ASSIGNMENT_SHAPE';
  end if;

  for v_elem in select * from jsonb_array_elements(p_assignments)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;

    begin
      v_coordinator_id := (v_elem->>'coordinator_id')::uuid;
      v_quantity := (v_elem->>'quantity')::integer;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;

    if v_quantity < 0 then
      raise exception 'NEGATIVE_QUANTITY';
    end if;

    v_sum_quantities := v_sum_quantities + v_quantity;
  end loop;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_assignments) elem
  ) <> jsonb_array_length(p_assignments) then
    raise exception 'DUPLICATE_COORDINATOR_IN_ASSIGNMENTS';
  end if;

  if v_sum_quantities <= 0 then
    raise exception 'NO_MEANINGFUL_ASSIGNMENT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct (elem->>'coordinator_id')::uuid order by (elem->>'coordinator_id')::uuid)
    into v_lock_ids
  from jsonb_array_elements(p_assignments) elem;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = p_workspace_id
  order by id
  for update;
  get diagnostics v_locked_coordinator_count = row_count;

  if v_locked_coordinator_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = p_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  perform 1
  from public.election_day_voters
  where coordinator is null
    and workspace_id = p_workspace_id
  order by created_at asc, id asc
  for update;
  get diagnostics v_unassigned_count = row_count;

  if v_unassigned_count = 0 then
    raise exception 'NO_UNASSIGNED_VOTERS';
  end if;

  if v_sum_quantities <> v_unassigned_count then
    raise exception 'ALLOCATION_COUNT_MISMATCH';
  end if;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null
    and workspace_id = p_workspace_id;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, null, null)
  returning id into v_operation_id;

  with ordered_voters as (
    select v.id, v.first_name || ' ' || v.last_name as full_name,
           row_number() over (order by v.created_at asc, v.id asc) as rn
    from public.election_day_voters v
    where v.id = any(v_locked_voter_ids)
  ),
  ordered_assignments as (
    select (elem->>'coordinator_id')::uuid as coordinator_id,
           (elem->>'quantity')::integer as quantity,
           ordinality
    from jsonb_array_elements(p_assignments) with ordinality as t(elem, ordinality)
  ),
  ranged_assignments as (
    select coordinator_id, quantity,
      coalesce(sum(quantity) over (order by ordinality rows between unbounded preceding and 1 preceding), 0) as range_start
    from ordered_assignments
  ),
  assignment_map as (
    select ov.id as voter_id, ov.full_name, ra.coordinator_id
    from ranged_assignments ra
    join ordered_voters ov
      on ov.rn > ra.range_start and ov.rn <= ra.range_start + ra.quantity
  ),
  updated as (
    update public.election_day_voters v
    set coordinator = c.display_name
    from assignment_map am
    join public.election_day_coordinators c
      on c.id = am.coordinator_id and c.workspace_id = p_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.coordinator_id, c.display_name as coordinator_display_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, null, null, u.coordinator_id, u.coordinator_display_name
  from updated u;

  return query select v_operation_id, v_unassigned_count, 0;
end;
$$;

comment on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3: INTERNAL-ONLY shared business core for apply_initial_allocation. Business logic copied verbatim from election_day_apply_initial_allocation_v2 (20260829020000), parameterized by p_workspace_id/p_executed_by_id/p_executed_by_owner_id_snapshot/p_executed_by_name instead of self-deriving them from a proof. Exactly one of p_executed_by_id (PermissionUser, FK''d to election_day_permission_users) / p_executed_by_owner_id_snapshot (Owner, a plain uuid VALUE snapshot with NO foreign key) is non-null on any call - never both, per this migration''s own pre-commit audit-attribution fix (see the executed_by_owner_id_snapshot column comment). p_executed_by_name still carries the acting principal''s own name as the human-readable audit snapshot regardless. Not granted to any role, including service_role.';

revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from public;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from anon;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from service_role;

-- ============================================================================
-- CORE 3 - election_day_rebalance_assignments_core. Business logic copied
-- verbatim from election_day_rebalance_assignments_v2 (20260829020000).
-- ============================================================================
create or replace function public.election_day_rebalance_assignments_core(
  p_workspace_id uuid,
  p_sources jsonb,
  p_destinations jsonb,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
)
returns table (
  operation_id uuid,
  transferred_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_elem jsonb;
  v_quantity integer;
  v_sum_sources integer := 0;
  v_sum_destinations integer := 0;
  v_lock_ids uuid[];
  v_locked_count integer;
  v_source_names text[];
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
  v_transferred_count integer;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) = 0
     or p_destinations is null or jsonb_typeof(p_destinations) <> 'array' or jsonb_array_length(p_destinations) = 0
  then
    raise exception 'INVALID_ASSIGNMENT_SHAPE';
  end if;

  for v_elem in select * from jsonb_array_elements(p_sources)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;
    begin
      v_quantity := (v_elem->>'quantity')::integer;
      perform (v_elem->>'coordinator_id')::uuid;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;
    if v_quantity <= 0 then
      raise exception 'NON_POSITIVE_QUANTITY';
    end if;
    v_sum_sources := v_sum_sources + v_quantity;
  end loop;

  for v_elem in select * from jsonb_array_elements(p_destinations)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;
    begin
      v_quantity := (v_elem->>'quantity')::integer;
      perform (v_elem->>'coordinator_id')::uuid;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;
    if v_quantity <= 0 then
      raise exception 'NON_POSITIVE_QUANTITY';
    end if;
    v_sum_destinations := v_sum_destinations + v_quantity;
  end loop;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_sources) elem
  ) <> jsonb_array_length(p_sources) then
    raise exception 'DUPLICATE_COORDINATOR_IN_SOURCES';
  end if;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_destinations) elem
  ) <> jsonb_array_length(p_destinations) then
    raise exception 'DUPLICATE_COORDINATOR_IN_DESTINATIONS';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sources) s
    join jsonb_array_elements(p_destinations) d
      on s->>'coordinator_id' = d->>'coordinator_id'
  ) then
    raise exception 'SOURCE_DESTINATION_OVERLAP';
  end if;

  if v_sum_sources <> v_sum_destinations then
    raise exception 'REBALANCE_SUM_MISMATCH';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct x.id order by x.id) into v_lock_ids
  from (
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_sources) elem
    union
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_destinations) elem
  ) x;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = p_workspace_id
  order by id
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = p_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  select array_agg(distinct name) into v_source_names
  from (
    select c.display_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
    union
    select c.linked_assignment_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
    where c.linked_assignment_name is not null
  ) names;

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if exists (
    select 1
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
    where (elem->>'quantity')::integer > (
      select count(*)
      from public.election_day_voters v
      where v.id = any(v_locked_voter_ids)
        and v.coordinator = any(array_remove(array[c.display_name, c.linked_assignment_name], null))
    )
  ) then
    raise exception 'REBALANCE_SOURCE_INSUFFICIENT';
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('rebalance', p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, null, null)
  returning id into v_operation_id;

  with source_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, src_ord
    from jsonb_array_elements(p_sources) with ordinality as t(elem, src_ord)
  ),
  source_names as (
    select sm.coordinator_id, sm.quantity, sm.src_ord, c.display_name,
      array_remove(array[c.display_name, c.linked_assignment_name], null) as names
    from source_map sm
    join public.election_day_coordinators c
      on c.id = sm.coordinator_id and c.workspace_id = p_workspace_id
  ),
  eligible_voters as (
    select v.id, v.first_name || ' ' || v.last_name as full_name,
           sn.coordinator_id as source_id, sn.display_name as source_display_name, sn.src_ord,
           row_number() over (partition by sn.coordinator_id order by v.created_at asc, v.id asc) as within_source_rn
    from public.election_day_voters v
    join source_names sn on v.coordinator = any(sn.names)
    where v.id = any(v_locked_voter_ids)
  ),
  selected_source_voters as (
    select ev.*
    from eligible_voters ev
    join source_names sn on sn.coordinator_id = ev.source_id
    where ev.within_source_rn <= sn.quantity
  ),
  ordered_transferred as (
    select *,
      row_number() over (order by src_ord asc, within_source_rn asc) as global_rn
    from selected_source_voters
  ),
  destination_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, dst_ord
    from jsonb_array_elements(p_destinations) with ordinality as t(elem, dst_ord)
  ),
  ranged_destinations as (
    select coordinator_id, quantity,
      coalesce(sum(quantity) over (order by dst_ord rows between unbounded preceding and 1 preceding), 0) as range_start
    from destination_map
  ),
  assignment_map as (
    select ot.id as voter_id, ot.full_name, ot.source_id, ot.source_display_name, rd.coordinator_id as dest_id
    from ordered_transferred ot
    join ranged_destinations rd
      on ot.global_rn > rd.range_start and ot.global_rn <= rd.range_start + rd.quantity
  ),
  updated as (
    update public.election_day_voters v
    set coordinator = dc.display_name
    from assignment_map am
    join public.election_day_coordinators dc
      on dc.id = am.dest_id and dc.workspace_id = p_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.source_id, am.source_display_name, dc.id as to_id, dc.display_name as to_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, u.source_id, u.source_display_name, u.to_id, u.to_name
  from updated u;

  get diagnostics v_transferred_count = row_count;

  return query select v_operation_id, v_transferred_count;
end;
$$;

comment on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3: INTERNAL-ONLY shared business core for rebalance_assignments. Business logic copied verbatim from election_day_rebalance_assignments_v2 (20260829020000), parameterized by p_workspace_id/p_executed_by_id/p_executed_by_owner_id_snapshot/p_executed_by_name. Exactly one of p_executed_by_id/p_executed_by_owner_id_snapshot is non-null, matching the initial-allocation core''s own durable-attribution convention. Not granted to any role, including service_role.';

revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from public;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from anon;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from service_role;

-- ============================================================================
-- CORE 4 - election_day_end_coordinator_activity_core. Business logic
-- copied verbatim from election_day_end_coordinator_activity_v2
-- (20260829020000).
-- ============================================================================
create or replace function public.election_day_end_coordinator_activity_core(
  p_workspace_id uuid,
  p_coordinator_id uuid,
  p_mode text,
  p_target_coordinator_id uuid,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
)
returns table (
  operation_id uuid,
  transferred_count integer,
  ended_coordinator_id uuid,
  ended_coordinator_display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_display_name text;
  v_source_linked_name text;
  v_source_names text[];
  v_target_display_name text;
  v_destinations_count integer;
  v_remaining_count integer;
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
  v_moved_count integer := 0;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_mode not in ('transfer', 'equal_split') then
    raise exception 'INVALID_MODE';
  end if;

  if p_mode = 'transfer' and (p_target_coordinator_id is null or p_target_coordinator_id = p_coordinator_id) then
    raise exception 'INVALID_TARGET';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if p_mode = 'transfer' then
    perform 1 from public.election_day_coordinators
    where id = any(array[p_coordinator_id, p_target_coordinator_id]::uuid[])
      and workspace_id = p_workspace_id
    order by id
    for update;
  else
    perform 1 from public.election_day_coordinators
    where id = p_coordinator_id
      and workspace_id = p_workspace_id
    for update;
  end if;

  select display_name, linked_assignment_name into v_source_display_name, v_source_linked_name
  from public.election_day_coordinators
  where id = p_coordinator_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if (
    select status from public.election_day_coordinators
    where id = p_coordinator_id and workspace_id = p_workspace_id
  ) <> 'active' then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  if p_mode = 'transfer' then
    select display_name into v_target_display_name
    from public.election_day_coordinators
    where id = p_target_coordinator_id
      and workspace_id = p_workspace_id;

    if not found then
      raise exception 'TARGET_NOT_FOUND';
    end if;

    if (
      select status from public.election_day_coordinators
      where id = p_target_coordinator_id and workspace_id = p_workspace_id
    ) <> 'active' then
      raise exception 'TARGET_NOT_ACTIVE';
    end if;
  end if;

  v_source_names := array_remove(array[v_source_display_name, v_source_linked_name], null);

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;
  get diagnostics v_remaining_count = row_count;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if p_mode = 'equal_split' then
    perform 1 from public.election_day_coordinators
    where status = 'active' and id <> p_coordinator_id
      and workspace_id = p_workspace_id
    order by id
    for update;
    get diagnostics v_destinations_count = row_count;

    if v_remaining_count > 0 and v_destinations_count = 0 then
      raise exception 'LAST_ACTIVE_COORDINATOR';
    end if;
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('coordinator_end', p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, p_coordinator_id, v_source_display_name)
  returning id into v_operation_id;

  if v_remaining_count > 0 and p_mode = 'transfer' then
    with moved as (
      update public.election_day_voters v
      set coordinator = v_target_display_name
      where v.id = any(v_locked_voter_ids)
      returning v.id, v.first_name || ' ' || v.last_name as full_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, m.id, m.full_name, p_coordinator_id, v_source_display_name, p_target_coordinator_id, v_target_display_name
    from moved m;

    v_moved_count := v_remaining_count;

  elsif v_remaining_count > 0 and p_mode = 'equal_split' then
    with destinations_ordered as (
      select id, display_name,
        (row_number() over (order by id asc) - 1)::integer as idx
      from public.election_day_coordinators
      where status = 'active' and id <> p_coordinator_id
        and workspace_id = p_workspace_id
    ),
    dest_quantities as (
      select id, display_name, idx,
        (v_remaining_count / v_destinations_count)
          + case when idx < (v_remaining_count % v_destinations_count) then 1 else 0 end as quantity
      from destinations_ordered
    ),
    ranged_destinations as (
      select id, display_name, quantity,
        coalesce(sum(quantity) over (order by idx rows between unbounded preceding and 1 preceding), 0) as range_start
      from dest_quantities
    ),
    ordered_source_voters as (
      select v.id, v.first_name || ' ' || v.last_name as full_name,
        row_number() over (order by v.created_at asc, v.id asc) as rn
      from public.election_day_voters v
      where v.id = any(v_locked_voter_ids)
    ),
    assignment_map as (
      select osv.id as voter_id, osv.full_name, rd.id as dest_id, rd.display_name as dest_name
      from ordered_source_voters osv
      join ranged_destinations rd
        on osv.rn > rd.range_start and osv.rn <= rd.range_start + rd.quantity
    ),
    updated as (
      update public.election_day_voters v
      set coordinator = am.dest_name
      from assignment_map am
      where v.id = am.voter_id
      returning v.id, am.full_name, am.dest_id, am.dest_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, u.id, u.full_name, p_coordinator_id, v_source_display_name, u.dest_id, u.dest_name
    from updated u;

    v_moved_count := v_remaining_count;
  end if;

  update public.election_day_coordinators
  set status = 'ended', ended_at = now()
  where id = p_coordinator_id
    and workspace_id = p_workspace_id;

  return query select v_operation_id, v_moved_count, p_coordinator_id, v_source_display_name;
end;
$$;

comment on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3: INTERNAL-ONLY shared business core for end_coordinator_activity. Business logic copied verbatim from election_day_end_coordinator_activity_v2 (20260829020000), parameterized by p_workspace_id/p_executed_by_id/p_executed_by_owner_id_snapshot/p_executed_by_name. LAST_ACTIVE_COORDINATOR remains workspace-local (the same workspace-scoped "other active coordinators" set feeds both the guard''s count and the equal-split destination ranges). Exactly one of p_executed_by_id/p_executed_by_owner_id_snapshot is non-null. Not granted to any role, including service_role.';

revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from public;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from anon;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from service_role;

-- ============================================================================
-- CORE 5 - election_day_list_coordinators_core. Trivial workspace-scoped
-- read, mirroring listCoordinators()'s own current ordering
-- (created_at asc, id asc) but scoped - the live frontend read itself is
-- NOT changed by this migration (still the globally-unscoped SELECT against
-- the SELECT-only-granted table, untouched).
-- ============================================================================
create or replace function public.election_day_list_coordinators_core(
  p_workspace_id uuid
)
returns setof public.election_day_coordinators
language sql
security definer
set search_path = ''
stable
as $$
  select * from public.election_day_coordinators
  where workspace_id = p_workspace_id
  order by created_at asc, id asc;
$$;

comment on function public.election_day_list_coordinators_core(uuid) is
  'Phase 3C Dual-Principal V3: INTERNAL-ONLY shared read core - workspace-scoped coordinator roster, for a future trusted-cutover read path. Does not require p_workspace_id to be non-null itself (a NULL simply matches zero rows, since workspace_id is never NULL on this table) - both wrappers below only ever pass a live-resolved, non-null workspace_id anyway. Not granted to any role, including service_role.';

revoke all on function public.election_day_list_coordinators_core(uuid) from public;
revoke all on function public.election_day_list_coordinators_core(uuid) from anon;
revoke all on function public.election_day_list_coordinators_core(uuid) from authenticated;
revoke all on function public.election_day_list_coordinators_core(uuid) from service_role;

-- ============================================================================
-- WRAPPERS - PermissionUser (session + one-time-consumed action-bound proof
-- via election_day_verify_and_consume_reauth_proof_v3, then a LIVE
-- electionDay.manageCoordinatorAllocation check on the resolved role).
-- ============================================================================

create or replace function public.election_day_manage_coordinators_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_actions jsonb
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.role_id, v.workspace_id into v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'manage_coordinators'
  ) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return query select * from public.election_day_manage_coordinators_core(v_workspace_id, p_actions);
end;
$$;

comment on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) is
  'Phase 3C Dual-Principal V3: PermissionUser-authorized manage_coordinators. Session + one-time-consumed action-bound proof (election_day_verify_and_consume_reauth_proof_v3, action=''manage_coordinators''), then requires electionDay.manageCoordinatorAllocation on the resolved actor''s CURRENT role, read live every call. Delegates all business logic to election_day_manage_coordinators_core. service_role-only. NOT wired into the live frontend - election_day_manage_coordinators_v2 remains the only reachable path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from public;
revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from anon;
revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from authenticated;
grant execute on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) to service_role;

create or replace function public.election_day_apply_initial_allocation_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_assignments jsonb
)
returns table (
  operation_id uuid,
  allocated_count integer,
  remaining_unassigned_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.actor_id, v.actor_name, v.role_id, v.workspace_id
    into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'apply_initial_allocation'
  ) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select * from public.election_day_apply_initial_allocation_core(
      v_workspace_id, p_assignments, v_actor_id, null, v_actor_name
    );
end;
$$;

comment on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) is
  'Phase 3C Dual-Principal V3: PermissionUser-authorized apply_initial_allocation. Session + one-time-consumed action-bound proof, requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_apply_initial_allocation_core with the resolved actor''s own id/name as the audit executed_by snapshot. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from public;
revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from anon;
revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from authenticated;
grant execute on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) to service_role;

create or replace function public.election_day_rebalance_assignments_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_sources jsonb,
  p_destinations jsonb
)
returns table (
  operation_id uuid,
  transferred_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.actor_id, v.actor_name, v.role_id, v.workspace_id
    into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'rebalance_assignments'
  ) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select * from public.election_day_rebalance_assignments_core(
      v_workspace_id, p_sources, p_destinations, v_actor_id, null, v_actor_name
    );
end;
$$;

comment on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) is
  'Phase 3C Dual-Principal V3: PermissionUser-authorized rebalance_assignments. Session + one-time-consumed action-bound proof, requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_rebalance_assignments_core. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from public;
revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from anon;
revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from authenticated;
grant execute on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) to service_role;

create or replace function public.election_day_end_coordinator_activity_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_coordinator_id uuid,
  p_mode text,
  p_target_coordinator_id uuid
)
returns table (
  operation_id uuid,
  transferred_count integer,
  ended_coordinator_id uuid,
  ended_coordinator_display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.actor_id, v.actor_name, v.role_id, v.workspace_id
    into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'end_coordinator_activity'
  ) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select * from public.election_day_end_coordinator_activity_core(
      v_workspace_id, p_coordinator_id, p_mode, p_target_coordinator_id, v_actor_id, null, v_actor_name
    );
end;
$$;

comment on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) is
  'Phase 3C Dual-Principal V3: PermissionUser-authorized end_coordinator_activity. Session + one-time-consumed action-bound proof, requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_end_coordinator_activity_core. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from public;
revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from anon;
revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from authenticated;
grant execute on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) to service_role;

create or replace function public.election_day_list_coordinators_v3(
  p_session_hash bytea
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  return query select * from public.election_day_list_coordinators_core(v_workspace_id);
end;
$$;

comment on function public.election_day_list_coordinators_v3(bytea) is
  'Phase 3C Dual-Principal V3: PermissionUser-authorized, workspace-scoped coordinator read - no reauth proof required (a read has no step-up requirement, matching election_day_list_permission_users_v3''s own established convention). Session alone (election_day_resolve_session) resolves the workspace; no additional permission check - matches listCoordinators()''s own current "any signed-in context can read" behavior, just workspace-scoped now instead of global. service_role-only. NOT wired into the live frontend - added for a future trusted-cutover read path.';

revoke all on function public.election_day_list_coordinators_v3(bytea) from public;
revoke all on function public.election_day_list_coordinators_v3(bytea) from anon;
revoke all on function public.election_day_list_coordinators_v3(bytea) from authenticated;
grant execute on function public.election_day_list_coordinators_v3(bytea) to service_role;

-- ============================================================================
-- WRAPPERS - Owner (verified auth_user_id + one-time-consumed action-bound
-- proof via election_day_verify_and_consume_owner_proof). NO permission
-- check - being a resolved Owner of the proof''s own workspace IS the
-- authorization, per this workstream''s approved, non-negotiable
-- authorization decision (fixed Owner authority, mirroring election_day_
-- create_role_owner_v3''s own evidence-based precedent, 20260828070000).
-- ============================================================================

create or replace function public.election_day_manage_coordinators_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_actions jsonb
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select v.workspace_id into v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'manage_coordinators'
  ) v;

  return query select * from public.election_day_manage_coordinators_core(v_workspace_id, p_actions);
end;
$$;

comment on function public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb) is
  'Phase 3C Dual-Principal V3: Owner-authorized manage_coordinators. One-time-consumed Owner proof (election_day_verify_and_consume_owner_proof, action=''manage_coordinators''). Authorization is being a resolved Election Owner holding a valid proof for the target workspace - no PermissionUser permission of any kind is checked or relevant. Delegates to election_day_manage_coordinators_core (the SAME shared business core the PermissionUser wrapper uses). service_role-only. NOT wired into the live frontend - no Owner Coordinator/Allocation UI exists yet.';

revoke all on function public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb) from public;
revoke all on function public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb) from anon;
revoke all on function public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb) from authenticated;
grant execute on function public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb) to service_role;

create or replace function public.election_day_apply_initial_allocation_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_assignments jsonb
)
returns table (
  operation_id uuid,
  allocated_count integer,
  remaining_unassigned_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_owner_name text;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'apply_initial_allocation'
  ) v;

  select o.name into v_owner_name
  from public.election_owners o
  where o.id = v_owner_id;

  return query
    select * from public.election_day_apply_initial_allocation_core(
      v_workspace_id, p_assignments, null, v_owner_id, v_owner_name
    );
end;
$$;

comment on function public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb) is
  'Phase 3C Dual-Principal V3: Owner-authorized apply_initial_allocation. One-time-consumed Owner proof, no permission check. Delegates to election_day_apply_initial_allocation_core with executed_by_id = NULL and executed_by_owner_id_snapshot = the acting Owner''s own election_owners.id, captured as a durable snapshot value with no FK of any kind (pre-commit audit-attribution fix, round 2) - executed_by_name still carries the Owner''s own name as the human-readable snapshot. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb) from public;
revoke all on function public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb) from anon;
revoke all on function public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb) from authenticated;
grant execute on function public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb) to service_role;

create or replace function public.election_day_rebalance_assignments_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_sources jsonb,
  p_destinations jsonb
)
returns table (
  operation_id uuid,
  transferred_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_owner_name text;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'rebalance_assignments'
  ) v;

  select o.name into v_owner_name
  from public.election_owners o
  where o.id = v_owner_id;

  return query
    select * from public.election_day_rebalance_assignments_core(
      v_workspace_id, p_sources, p_destinations, null, v_owner_id, v_owner_name
    );
end;
$$;

comment on function public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb) is
  'Phase 3C Dual-Principal V3: Owner-authorized rebalance_assignments. One-time-consumed Owner proof, no permission check. Delegates to election_day_rebalance_assignments_core with executed_by_id = NULL / executed_by_owner_id_snapshot = the acting Owner''s own election_owners.id, captured as a durable snapshot value with no FK of any kind / executed_by_name = the Owner''s own name. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb) from public;
revoke all on function public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb) from anon;
revoke all on function public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb) from authenticated;
grant execute on function public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb) to service_role;

create or replace function public.election_day_end_coordinator_activity_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_coordinator_id uuid,
  p_mode text,
  p_target_coordinator_id uuid
)
returns table (
  operation_id uuid,
  transferred_count integer,
  ended_coordinator_id uuid,
  ended_coordinator_display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_owner_name text;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'end_coordinator_activity'
  ) v;

  select o.name into v_owner_name
  from public.election_owners o
  where o.id = v_owner_id;

  return query
    select * from public.election_day_end_coordinator_activity_core(
      v_workspace_id, p_coordinator_id, p_mode, p_target_coordinator_id, null, v_owner_id, v_owner_name
    );
end;
$$;

comment on function public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid) is
  'Phase 3C Dual-Principal V3: Owner-authorized end_coordinator_activity. One-time-consumed Owner proof, no permission check. Delegates to election_day_end_coordinator_activity_core with executed_by_id = NULL / executed_by_owner_id_snapshot = the acting Owner''s own election_owners.id, captured as a durable snapshot value with no FK of any kind / executed_by_name = the Owner''s own name. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid) from public;
revoke all on function public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid) from anon;
revoke all on function public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid) from authenticated;
grant execute on function public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid) to service_role;

create or replace function public.election_day_list_coordinators_owner_v3(
  p_auth_user_id uuid
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) r;

  return query select * from public.election_day_list_coordinators_core(v_workspace_id);
end;
$$;

comment on function public.election_day_list_coordinators_owner_v3(uuid) is
  'Phase 3C Dual-Principal V3: Owner-authorized, workspace-scoped coordinator read - no reauth proof required, matching election_day_list_roles_owner_v3''s own established convention (a read has no step-up requirement). Resolves workspace via election_day_resolve_owner_context alone. service_role-only. NOT wired into the live frontend - added for a future trusted-cutover read path (no Owner Coordinator/Allocation UI exists yet).';

revoke all on function public.election_day_list_coordinators_owner_v3(uuid) from public;
revoke all on function public.election_day_list_coordinators_owner_v3(uuid) from anon;
revoke all on function public.election_day_list_coordinators_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_list_coordinators_owner_v3(uuid) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   drop function if exists public.election_day_list_coordinators_owner_v3(uuid);
--   drop function if exists public.election_day_end_coordinator_activity_owner_v3(uuid, bytea, uuid, text, uuid);
--   drop function if exists public.election_day_rebalance_assignments_owner_v3(uuid, bytea, jsonb, jsonb);
--   drop function if exists public.election_day_apply_initial_allocation_owner_v3(uuid, bytea, jsonb);
--   drop function if exists public.election_day_manage_coordinators_owner_v3(uuid, bytea, jsonb);
--   drop function if exists public.election_day_list_coordinators_v3(bytea);
--   drop function if exists public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid);
--   drop function if exists public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb);
--   drop function if exists public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb);
--   drop function if exists public.election_day_manage_coordinators_v3(bytea, bytea, jsonb);
--   drop function if exists public.election_day_list_coordinators_core(uuid);
--   drop function if exists public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text);
--   drop function if exists public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text);
--   drop function if exists public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text);
--   drop function if exists public.election_day_manage_coordinators_core(uuid, jsonb);
--   commit;
-- ============================================================================
