-- Phase 3C Coordinator/Allocation - Reauth Compatibility Patch.
--
-- Root cause (see this repo's own planning records / CURRENT_STATUS.md for
-- the full design report): the already-applied, already-Production-deployed
-- 20260829030000 migration bound all 4 PermissionUser Coordinator/Allocation
-- _v3 wrappers to election_day_verify_and_consume_reauth_proof_v3 - a
-- genuinely ONE-TIME-CONSUMED verifier (a DELETE...RETURNING - the row is
-- gone the instant it's successfully consumed), each also bound to its own
-- distinct, per-operation action string. The existing, still-live
-- Coordinator/Allocation frontend UX (one password entry unlocks a single
-- short reauth window during which any number of the 4 mutations may run
-- without a further prompt) is structurally incompatible with a one-time,
-- per-operation-bound proof: a straight cutover to the already-deployed v3
-- RPCs as-is would force a fresh password prompt before every single
-- mutation, a real UX regression the product decision explicitly rejects -
-- and so does silently caching/replaying the raw password client-side,
-- which the product decision also explicitly rejects (duplicated,
-- weaker-than-server client-side trust logic).
--
-- Approved fix: reuse ALREADY-EXISTING, ALREADY-APPROVED, ALREADY-DEPLOYED
-- infrastructure - election_day_verify_reauth_proof_v3 (Phase 3A,
-- 20260826010000) - the same reusable-within-TTL, non-destructive verifier
-- election_day_create_permission_user_v3 already uses today. This migration
-- changes ONLY which verify helper each of the 4 PermissionUser wrappers
-- calls, and unifies their action-binding onto ONE new feature-scoped action
-- identifier, 'coordinator_allocation' (confirmed unused anywhere in this
-- codebase prior to this migration) - so a single reauth proof, once minted
-- for that one action, verifies successfully against all 4 Coordinator/
-- Allocation mutations for its existing 5-minute TTL, exactly matching the
-- approved UX, while remaining structurally unable to authorize any other
-- feature/domain (delete_permission_user/reset_permission_user_password/
-- create_permission_user each keep their own distinct action string, and
-- election_day_verify_reauth_proof_v3 requires an exact p_action match).
--
-- Explicitly NOT touched by this migration, verified by the "exact function
-- body delta" below and confirmed unaffected by construction:
--   - Every OTHER line of these 4 wrapper bodies: signatures, return types,
--     the live `electionDay.manageCoordinatorAllocation` permission check
--     (still reads public.election_day_roles fresh AFTER the verify call,
--     unconditionally on every single mutation, exactly as before), the
--     session/workspace resolution these verifiers derive internally,
--     the call to the shared business-logic core, and every core's own
--     shared advisory lock (pg_advisory_xact_lock('election_day_voter_
--     allocation_mutation')) - none of that logic lives in the wrapper
--     bodies changed here.
--   - election_day_verify_and_consume_reauth_proof_v3 itself - unchanged,
--     still required by (and still exclusively used by)
--     election_day_delete_permission_user_v3 / election_day_reset_
--     permission_user_password_v3.
--   - election_day_verify_reauth_proof_v3, election_day_reauth_v3,
--     election_day_resolve_session, election_day_reauth_proofs (table/
--     columns/constraints) - zero changes; election_day_reauth_v3 already
--     accepts an arbitrary p_action text with no DB-side allowlist, so no
--     change is needed there to support the new action string.
--   - The 4 Owner-principal _owner_v3 wrappers (a structurally separate
--     trust chain, election_day_verify_and_consume_owner_proof, its own
--     table) - not part of this migration at all.
--   - election_day_manage_coordinators_core / _apply_initial_allocation_core
--     / _rebalance_assignments_core / _end_coordinator_activity_core /
--     _list_coordinators_core - not redefined by this migration; delegated
--     to exactly as before.
--   - All 4 legacy _v2 Coordinator/Allocation RPCs, election_day_import_
--     voters_v2, every other function in this schema - untouched.
--
-- ACL: each CREATE OR REPLACE below is immediately followed by the exact
-- same REVOKE ALL (public/anon/authenticated) + GRANT EXECUTE (service_role)
-- statements the original 20260829030000 migration already established for
-- these same 4 functions - re-issued here per this project's own
-- established convention of re-declaring ACL explicitly after every
-- CREATE OR REPLACE, matching CLAUDE.md's Permanent Engineering Guardrail
-- (name every role explicitly; a bare "from public" is not sufficient on
-- this project's Production instance). No ACL posture actually changes -
-- these statements are idempotent re-assertions of the already-correct,
-- already-verified-in-Production grants.
--
-- Purely additive at the schema level: no table, column, constraint, or
-- index is created, dropped, or altered by this migration - CREATE OR
-- REPLACE FUNCTION + REVOKE/GRANT only. No DML of any kind. Rollback is a
-- straight CREATE OR REPLACE back to the 4 bodies exactly as they exist in
-- 20260829030000 today (reproduced verbatim in this file's own rollback
-- block below) - no data migration in either direction.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- election_day_manage_coordinators_v3 - only the verify-helper call and its
-- action-string literal change (election_day_verify_and_consume_reauth_
-- proof_v3(..., 'manage_coordinators') -> election_day_verify_reauth_
-- proof_v3(..., 'coordinator_allocation')). Every other line is byte-
-- identical to the currently-deployed 20260829030000 body.
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
  from public.election_day_verify_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'coordinator_allocation'
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
  'Phase 3C Dual-Principal V3 (Reauth Compatibility Patch): PermissionUser-authorized manage_coordinators. Session + REUSABLE-WITHIN-TTL feature-scoped proof (election_day_verify_reauth_proof_v3, action=''coordinator_allocation'', 5-minute TTL - same proof also verifies apply_initial_allocation/rebalance_assignments/end_coordinator_activity), then requires electionDay.manageCoordinatorAllocation on the resolved actor''s CURRENT role, read live every call regardless of proof reuse. Delegates all business logic to election_day_manage_coordinators_core, unchanged. service_role-only. NOT wired into the live frontend - election_day_manage_coordinators_v2 remains the only reachable path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from public;
revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from anon;
revoke all on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) from authenticated;
grant execute on function public.election_day_manage_coordinators_v3(bytea, bytea, jsonb) to service_role;

-- ============================================================================
-- election_day_apply_initial_allocation_v3 - same change, same shape.
-- ============================================================================
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
  from public.election_day_verify_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'coordinator_allocation'
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
  'Phase 3C Dual-Principal V3 (Reauth Compatibility Patch): PermissionUser-authorized apply_initial_allocation. Session + REUSABLE-WITHIN-TTL feature-scoped proof (election_day_verify_reauth_proof_v3, action=''coordinator_allocation''), requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_apply_initial_allocation_core with the resolved actor''s own id/name as the audit executed_by snapshot, unchanged. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from public;
revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from anon;
revoke all on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) from authenticated;
grant execute on function public.election_day_apply_initial_allocation_v3(bytea, bytea, jsonb) to service_role;

-- ============================================================================
-- election_day_rebalance_assignments_v3 - same change, same shape.
-- ============================================================================
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
  from public.election_day_verify_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'coordinator_allocation'
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
  'Phase 3C Dual-Principal V3 (Reauth Compatibility Patch): PermissionUser-authorized rebalance_assignments. Session + REUSABLE-WITHIN-TTL feature-scoped proof (election_day_verify_reauth_proof_v3, action=''coordinator_allocation''), requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_rebalance_assignments_core, unchanged. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from public;
revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from anon;
revoke all on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) from authenticated;
grant execute on function public.election_day_rebalance_assignments_v3(bytea, bytea, jsonb, jsonb) to service_role;

-- ============================================================================
-- election_day_end_coordinator_activity_v3 - same change, same shape.
-- ============================================================================
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
  from public.election_day_verify_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'coordinator_allocation'
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
  'Phase 3C Dual-Principal V3 (Reauth Compatibility Patch): PermissionUser-authorized end_coordinator_activity. Session + REUSABLE-WITHIN-TTL feature-scoped proof (election_day_verify_reauth_proof_v3, action=''coordinator_allocation''), requires electionDay.manageCoordinatorAllocation live. Delegates to election_day_end_coordinator_activity_core, unchanged. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from public;
revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from anon;
revoke all on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) from authenticated;
grant execute on function public.election_day_end_coordinator_activity_v3(bytea, bytea, uuid, text, uuid) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"). Restores the 4 wrappers to their exact 20260829030000 bodies
-- (one-time-consumed, per-operation action strings):
--
--   begin;
--
--   create or replace function public.election_day_manage_coordinators_v3(
--     p_session_hash bytea, p_reauth_proof_hash bytea, p_actions jsonb
--   )
--   returns setof public.election_day_coordinators
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid;
--     v_workspace_id uuid;
--     v_has_permission boolean;
--   begin
--     select v.role_id, v.workspace_id into v_actor_role_id, v_workspace_id
--     from public.election_day_verify_and_consume_reauth_proof_v3(
--       p_session_hash, p_reauth_proof_hash, 'manage_coordinators'
--     ) v;
--     select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     return query select * from public.election_day_manage_coordinators_core(v_workspace_id, p_actions);
--   end;
--   $$;
--
--   create or replace function public.election_day_apply_initial_allocation_v3(
--     p_session_hash bytea, p_reauth_proof_hash bytea, p_assignments jsonb
--   )
--   returns table (operation_id uuid, allocated_count integer, remaining_unassigned_count integer)
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_id uuid; v_actor_name text; v_actor_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
--   begin
--     select v.actor_id, v.actor_name, v.role_id, v.workspace_id
--       into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
--     from public.election_day_verify_and_consume_reauth_proof_v3(
--       p_session_hash, p_reauth_proof_hash, 'apply_initial_allocation'
--     ) v;
--     select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     return query select * from public.election_day_apply_initial_allocation_core(
--       v_workspace_id, p_assignments, v_actor_id, null, v_actor_name
--     );
--   end;
--   $$;
--
--   create or replace function public.election_day_rebalance_assignments_v3(
--     p_session_hash bytea, p_reauth_proof_hash bytea, p_sources jsonb, p_destinations jsonb
--   )
--   returns table (operation_id uuid, transferred_count integer)
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_id uuid; v_actor_name text; v_actor_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
--   begin
--     select v.actor_id, v.actor_name, v.role_id, v.workspace_id
--       into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
--     from public.election_day_verify_and_consume_reauth_proof_v3(
--       p_session_hash, p_reauth_proof_hash, 'rebalance_assignments'
--     ) v;
--     select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     return query select * from public.election_day_rebalance_assignments_core(
--       v_workspace_id, p_sources, p_destinations, v_actor_id, null, v_actor_name
--     );
--   end;
--   $$;
--
--   create or replace function public.election_day_end_coordinator_activity_v3(
--     p_session_hash bytea, p_reauth_proof_hash bytea, p_coordinator_id uuid,
--     p_mode text, p_target_coordinator_id uuid
--   )
--   returns table (
--     operation_id uuid, transferred_count integer,
--     ended_coordinator_id uuid, ended_coordinator_display_name text
--   )
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_id uuid; v_actor_name text; v_actor_role_id uuid; v_workspace_id uuid; v_has_permission boolean;
--   begin
--     select v.actor_id, v.actor_name, v.role_id, v.workspace_id
--       into v_actor_id, v_actor_name, v_actor_role_id, v_workspace_id
--     from public.election_day_verify_and_consume_reauth_proof_v3(
--       p_session_hash, p_reauth_proof_hash, 'end_coordinator_activity'
--     ) v;
--     select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     return query select * from public.election_day_end_coordinator_activity_core(
--       v_workspace_id, p_coordinator_id, p_mode, p_target_coordinator_id, v_actor_id, null, v_actor_name
--     );
--   end;
--   $$;
--
--   commit;
-- ============================================================================
