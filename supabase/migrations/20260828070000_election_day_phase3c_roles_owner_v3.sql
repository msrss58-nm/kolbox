-- Phase 3C Roles Mutations - Owner-only Roles v3 backend (EXPAND, service_
-- role only, zero frontend wiring). Companion to 20260828060000 (the Owner
-- Trust Foundation this migration consumes) - implements the 4 actual
-- Owner-only Role mutation RPCs per the approved, non-negotiable
-- architectural decision: Roles/Permissions management moves to Election
-- Owner authority exclusively, never a PermissionUser-held permission.
--
-- Does NOT touch, modify, or retire election_day_create_role_v2/_update_
-- role_v2/_delete_role_v2/_clone_role_v2 (20260828030000, already workspace-
-- contained) - those remain the frontend's only reachable Role mutation
-- path until a separate, later, explicitly-approved frontend cutover
-- decision. This migration is strictly additive and parallel.
--
-- ============================================================================
-- AUTHORIZATION MODEL - genuinely different from every _v2/_v3 RPC that
-- came before it in this project:
-- ============================================================================
-- Every function below authorizes SOLELY via election_day_verify_and_
-- consume_owner_proof(p_auth_user_id, p_reauth_proof_hash, '<action>') -
-- being a successfully-resolved, proof-holding Election Owner of the target
-- workspace IS the authorization. There is no `electionDay.manageRolesAnd
-- Permissions` (or any other) permission check anywhere in this file - per
-- this task''s own explicit, non-negotiable instruction ("never authorize
-- using electionDay.manageRolesAndPermissions"), and because that
-- permission is a PermissionUser-role attribute, a completely different
-- principal from the Owner identity these functions actually authorize
-- against. A PermissionUser holding that permission - even one holding
-- every permission in the system - cannot call any function in this file,
-- because none of them accept a PermissionUser session/proof of any kind;
-- their only inputs are a server-verified Owner auth_user_id and an
-- Owner-proof hash.
--
-- ============================================================================
-- LAST-HOLDER GUARD DECISION (evidence-based, per this task''s explicit
-- instruction not to blindly copy it) - OMITTED from all 4 functions below.
-- ============================================================================
-- Full repo-wide inventory of electionDay.manageRolesAndPermissions''s live
-- uses, performed before writing this migration (grep across src/ and every
-- migration): the ONLY places that check this permission are (a) election_
-- day_update_role_v2/_delete_role_v2''s own CANNOT_REMOVE_LAST_PERMISSION_
-- HOLDER guards (both untouched, legacy-only, Part of 20260828030000 and
-- its own predecessors), and (b) client-side gating of the Role Management
-- screen itself (useRoleManagement.ts''s guardedAction calls) plus a purely
-- cosmetic nav-visibility/sort use (electionDayNavVisibility.ts,
-- PermissionUsersPanel.tsx). No OTHER capability, screen, or business rule
-- anywhere in this codebase is gated on this permission.
--
-- The legacy guard''s entire purpose, per its own original comment
-- (20260806100000): prevent an edit/delete from leaving ZERO PermissionUsers
-- anywhere holding electionDay.manageRolesAndPermissions, which would lock
-- every PermissionUser out of the Role Management screen with no PermissionUser
-- account able to grant it back (a genuine self-lockout risk, given
-- PermissionUsers were - until this migration''s own architectural
-- reassignment - the sole principal capable of managing roles at all).
--
-- Under the approved Owner-only model, that rationale no longer applies to
-- these NEW functions: Role mutation authority now lives entirely in
-- election_owners, verified via election_day_verify_and_consume_owner_proof
-- - completely independent of any PermissionUser''s role/permission
-- assignment. Reducing electionDay.manageRolesAndPermissions to zero
-- PermissionUser holders via one of THESE functions cannot lock any Owner
-- out of anything, since no Owner action anywhere is gated on that
-- permission, and it cannot lock a PermissionUser out of a capability they
-- are about to lose access to regardless (Role Management is being removed
-- from the PermissionUser-reachable surface entirely, as this whole
-- migration''s own premise). No other still-valid business or security
-- invariant was found that depends on at least one PermissionUser role
-- retaining this permission. OMITTED, with this evidence trail, rather than
-- assumed away.
--
-- Corollary: the pg_advisory_xact_lock('election_day_manage_roles_
-- permission_guard') serialization the legacy update/delete v2 RPCs use
-- exists SPECIFICALLY to make that same last-holder COUNT-then-DECIDE
-- sequence race-safe across concurrent callers (a single-row UPDATE/DELETE
-- is already atomic on its own; the multi-row COUNT(*) across the whole
-- workspace is what needed serializing). With the guard itself removed,
-- update_role_owner_v3 has no analogous read-then-decide sequence left to
-- protect - a plain `update ... where id = ...` is atomic via ordinary row
-- locking - so the advisory lock is correctly omitted here too, not merely
-- forgotten. delete_role_owner_v3 keeps its own ROLE_HAS_ASSIGNED_USERS
-- check (a REAL, still-valid data-integrity invariant, completely
-- independent of the last-holder question - see below) backed, as before,
-- by the unbreakable FK ON DELETE RESTRICT backstop (election_day_
-- permission_users.role_id -> election_day_roles.id, Phase 0) for the rare
-- concurrent-assignment race window; no advisory lock is needed there either
-- for the same reason.
--
-- ROLE_HAS_ASSIGNED_USERS itself IS KEPT on delete_role_owner_v3 - this is a
-- genuine, still-valid data-integrity invariant (deleting a role that
-- PermissionUsers are currently assigned to would orphan their role_id),
-- completely unrelated to the last-holder-of-a-specific-permission question
-- this section addresses. Not affected by the Owner-only authorization
-- change at all.
--
-- ============================================================================
-- BUSINESS SEMANTICS REUSED VERBATIM from the already-workspace-contained
-- _v2 bodies (20260828030000), swapping only the proof/authorization
-- mechanism:
-- ============================================================================
--   - election_day_validate_role_input(p_name, p_permissions, p_scope_type)
--     for create/update (unchanged, same shared helper).
--   - workspace-scoped target lookup, collapsing "doesn't exist" and
--     "exists in a different workspace" into the SAME non-leaking
--     ROLE_NOT_FOUND (update/delete/clone).
--   - workspace_id written on INSERT (create/clone) as the ACTING OWNER''S
--     OWN server-derived value - never a client-supplied value, and for
--     clone specifically never copied from the source role''s own
--     workspace_id either (even though the containment check above already
--     guarantees they match at that point).
--   - ROLE_NAME_REQUIRED (clone only, mirrors v2 exactly).
--
-- Deliberately NOT changed by this migration, matching the corresponding
-- items already tracked, unchanged, in 20260828030000''s own header (out of
-- explicit scope for this task too - see its DO NOT list):
--   1. election_day_roles.name stays a GLOBAL UNIQUE(name), not
--      UNIQUE(workspace_id, name) - a duplicate name on create/clone still
--      raises a raw Postgres unique_violation (23505), not a friendly app-
--      level error code, exactly as it already does for the legacy _v2
--      functions today. Deterministic (always fails the same way for the
--      same colliding name) and non-leaking (fails identically whether the
--      collision is with a role in the actor''s own workspace or a
--      different one) - unchanged behavior, not a new gap introduced here.
--   2. No composite FK from election_day_permission_users(role_id,
--      workspace_id) to election_day_roles(id, workspace_id).
--   3. election_day_list_roles_v3 (the trusted read path, already live) is
--      untouched - this migration only adds mutation RPCs.
--
-- ============================================================================
-- SECURITY GUARDRAILS: every function below explicitly REVOKEs EXECUTE from
-- PUBLIC, anon, and authenticated by name (per CLAUDE.md''s Permanent
-- Engineering Guardrail) and GRANTs to service_role only - the browser''s own
-- anon key can never call any of these directly, exactly like every other
-- _v3/session RPC in this project.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI''s migration runner pipelines
-- a file''s statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- 1. election_day_create_role_owner_v3.
-- ============================================================================
create or replace function public.election_day_create_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'create_role'
  ) v;

  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id)
  values (
    btrim(p_name),
    coalesce(p_description, ''),
    coalesce(p_permissions, '{}'),
    p_scope_type,
    v_workspace_id
  )
  returning public.election_day_roles.id into v_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text) is
  'Phase 3C Roles Mutations: Owner-only, one-time-consumed-proof create (action ''create_role'', via election_day_verify_and_consume_owner_proof - see 20260828060000). Authorization is being a resolved Election Owner holding a valid proof - NOT electionDay.manageRolesAndPermissions (see this migration''s header for the full evidence-based reasoning). Writes the new role''s workspace_id as the ACTING OWNER''S OWN server-derived value. Business validation (election_day_validate_role_input) unchanged from election_day_create_role_v2. service_role-only: no PUBLIC/anon/authenticated EXECUTE. NOT wired into the live frontend - the legacy election_day_create_role_v2 remains the only reachable create path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text) from public;
revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text) from anon;
revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text) from authenticated;
grant execute on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text) to service_role;

-- ============================================================================
-- 2. election_day_update_role_owner_v3. No advisory lock (see this
-- migration''s header "Corollary" - the last-holder guard it existed to
-- protect is intentionally omitted here).
-- ============================================================================
create or replace function public.election_day_update_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'update_role'
  ) v;

  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, mirroring the legacy v2 containment pattern.
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  update public.election_day_roles as r
  set name = btrim(p_name),
      description = coalesce(p_description, ''),
      permissions = coalesce(p_permissions, '{}'),
      scope_type = p_scope_type
  where r.id = p_role_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = p_role_id;
end;
$$;

comment on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text) is
  'Phase 3C Roles Mutations: Owner-only, one-time-consumed-proof update (action ''update_role''). Authorization is being a resolved Election Owner holding a valid proof for the target''s own workspace - no electionDay.manageRolesAndPermissions check, no CANNOT_REMOVE_LAST_PERMISSION_HOLDER guard, no advisory lock (see this migration''s header for the evidence-based reasoning for both omissions). Workspace-scoped target lookup collapses "doesn''t exist" and "different workspace" into the same ROLE_NOT_FOUND. Business validation unchanged from election_day_update_role_v2. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text) from public;
revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text) from anon;
revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text) from authenticated;
grant execute on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text) to service_role;

-- ============================================================================
-- 3. election_day_delete_role_owner_v3. ROLE_HAS_ASSIGNED_USERS is KEPT
-- (real, still-valid data-integrity invariant, unrelated to the last-holder
-- question) - CANNOT_REMOVE_LAST_PERMISSION_HOLDER and the advisory lock are
-- both omitted (see this migration''s header).
-- ============================================================================
create or replace function public.election_day_delete_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
  v_assigned_count integer;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'delete_role'
  ) v;

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  select count(*) into v_assigned_count
  from public.election_day_permission_users
  where role_id = p_role_id
    and workspace_id = v_workspace_id;

  if v_assigned_count > 0 then
    raise exception 'ROLE_HAS_ASSIGNED_USERS';
  end if;

  delete from public.election_day_roles where id = p_role_id;
end;
$$;

comment on function public.election_day_delete_role_owner_v3(uuid, bytea, uuid) is
  'Phase 3C Roles Mutations: Owner-only, one-time-consumed-proof delete (action ''delete_role''). Authorization is being a resolved Election Owner holding a valid proof for the target''s own workspace. Workspace-scoped ROLE_NOT_FOUND, workspace-scoped ROLE_HAS_ASSIGNED_USERS (KEPT - a genuine, still-valid data-integrity invariant, backed by the unbreakable election_day_permission_users.role_id FK ON DELETE RESTRICT backstop). CANNOT_REMOVE_LAST_PERMISSION_HOLDER and its advisory lock are deliberately OMITTED (see this migration''s header for the full evidence trail). service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_delete_role_owner_v3(uuid, bytea, uuid) from public;
revoke all on function public.election_day_delete_role_owner_v3(uuid, bytea, uuid) from anon;
revoke all on function public.election_day_delete_role_owner_v3(uuid, bytea, uuid) from authenticated;
grant execute on function public.election_day_delete_role_owner_v3(uuid, bytea, uuid) to service_role;

-- ============================================================================
-- 4. election_day_clone_role_owner_v3.
-- ============================================================================
create or replace function public.election_day_clone_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_role_id uuid,
  p_new_name text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
  v_new_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'clone_role'
  ) v;

  if p_new_name is null or btrim(p_new_name) = '' then
    raise exception 'ROLE_NAME_REQUIRED';
  end if;

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  -- workspace_id is the ACTING OWNER'S OWN server-derived value, never
  -- copied from the source role's own workspace_id, even though the check
  -- above already guarantees they match at this point - matches v2 clone's
  -- own explicit design decision.
  insert into public.election_day_roles (name, description, permissions, scope_type, scope_value, workspace_id)
  select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value, v_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id
  returning public.election_day_roles.id into v_new_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_new_id;
end;
$$;

comment on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) is
  'Phase 3C Roles Mutations: Owner-only, one-time-consumed-proof clone (action ''clone_role''). Authorization is being a resolved Election Owner holding a valid proof for the source role''s own workspace. ROLE_NAME_REQUIRED, workspace-scoped ROLE_NOT_FOUND. Writes the cloned row''s workspace_id as the ACTING OWNER''S OWN server-derived value, never copied from the source. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from public;
revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from anon;
revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from authenticated;
grant execute on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   drop function if exists public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text);
--   drop function if exists public.election_day_delete_role_owner_v3(uuid, bytea, uuid);
--   drop function if exists public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text);
--   drop function if exists public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text);
--   commit;
-- ============================================================================
