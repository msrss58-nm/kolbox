-- Phase 3C Users - Containment + Trusted V3 Expand (delete + reset-password +
-- workspace-scoped roster). See CURRENT_STATUS.md's Phase 3C Users record for
-- the full finding this migration responds to.
--
-- ROOT ISSUE (found in a read-only planning pass, confirmed by direct code
-- inspection - not a live exploit): election_day_list_permission_users()
-- (still current, anon/authenticated-reachable, unchanged since
-- 20260806150000) returns every PermissionUser row with NO workspace_id
-- filter at all. election_day_delete_permission_user_v2 / election_day_
-- reset_permission_user_password_v2 (also still current, anon/authenticated-
-- reachable) accept p_target_user_id with NO check that it belongs to the
-- resolved actor's own workspace. Together: any actor holding a legitimate
-- electionDay.manageUsers proof for their OWN workspace can enumerate every
-- OTHER workspace's user ids via the list RPC, then delete or password-reset
-- any of them via the _v2 RPCs - a live cross-tenant destructive/account-
-- takeover path, not a hypothetical.
--
-- PART A - CONTAINMENT. CREATE OR REPLACE, in place, of the two EXISTING
-- _v2 RPCs - same name, same signature, same grants (untouched), same legacy
-- proof mechanism (election_day_verify_reauth_proof, action IS NULL) - every
-- legitimate same-workspace legacy caller (the only live frontend path
-- today) keeps working with zero code/contract change. Adds exactly:
--   1. actor workspace derived server-side - a second lookup on election_
--      day_permission_users keyed by the proof-resolved actor_id (the legacy
--      verifier itself has no workspace column to return, so this cannot be
--      folded into that shared helper without touching the other 9 legacy
--      actions that also call it - out of scope here).
--   2. target existence + workspace-membership collapsed into ONE check,
--      raising the SAME 'USER_NOT_FOUND' for "id doesn't exist" and "id
--      exists in a different workspace" - never distinguishable. This is a
--      genuine behavior change for delete specifically (v2 previously
--      allowed an unconditional delete-by-id with no existence check at all,
--      silently affecting 0 rows for a bad id) - the new check is strictly
--      tighter, never rejects a legitimate same-workspace call.
--   3. (delete only) CANNOT_DELETE_SELF - p_target_user_id = the resolved
--      actor_id is rejected before any delete statement runs.
-- NOT the final product authorization model - electionDay.manageUsers
-- remains the only permission gate, exactly as today. A workspace-aware
-- Owner-only tier (if ever approved) is explicitly out of scope here.
--
-- Deliberately NOT changed by Part A: the other 9 legacy reauth-gated
-- actions (import, role management x4, coordinator allocation x4) - none of
-- those RPCs are touched. election_day_verify_reauth_proof itself is
-- untouched (still the Phase 3C-fixed, action-IS-NULL-only version).
-- election_day_list_permission_users() (the legacy roster RPC) is NOT
-- retired or workspace-scoped by this migration - Part B adds a parallel
-- trusted roster RPC instead; retiring the legacy one is a separate, later,
-- explicitly-approved step, once the frontend is actually cut over.
--
-- PART B - TRUSTED V3 EXPAND (net-new, additive, service_role-only -
-- mirrors election_day_create_permission_user_v3's already-shipped
-- architecture exactly): election_day_list_permission_users_v3
-- (session-derived, workspace-scoped roster read - no proof required, a read
-- has no step-up requirement, matching this project's existing "reads don't
-- require reauth" convention), election_day_delete_permission_user_v3, and
-- election_day_reset_permission_user_password_v3. None of these three is
-- reachable by anon/authenticated - only a Vercel Server Function holding
-- the service_role key may call them, exactly like every other _v3/session
-- RPC. Nothing in this Part is wired into the live frontend - EXPAND only.
--
-- PART C - ONE-TIME PROOF CONSUMPTION for delete_v3/reset_v3 specifically.
-- New internal helper election_day_verify_and_consume_reauth_proof_v3 -
-- deliberately separate from the existing election_day_verify_reauth_proof_v3
-- (left completely untouched, so election_day_create_permission_user_v3's
-- replay semantics - reusable within its 5-minute TTL - are unaffected, per
-- this migration's explicit scope: "do not change replay semantics for
-- other v3 actions"). The new helper's verification IS an atomic
-- `delete ... where proof_hash = $1 and action = $2 and expires_at > now()
-- returning ...` - the row's deletion is itself the proof that "this exact
-- proof has now been used." Postgres's own row-level locking on that DELETE
-- is what makes two concurrent callers racing the SAME proof safe: the first
-- to acquire the row lock deletes it; the second's DELETE blocks until the
-- first transaction ends, then (re-evaluating its WHERE clause against the
-- now-committed state) finds zero matching rows and fails UNAUTHORIZED - no
-- separate advisory lock or extra column needed, since a physical row delete
-- is already an exclusive, serializing operation on that one row.
--
-- Exact, honestly-stated consumption semantics (verified against the actual
-- transaction structure, not assumed - and empirically verified for the
-- concurrent case, see CURRENT_STATUS.md):
--   - delete_v3 and reset_v3 each run as ONE implicit transaction per call (a
--     single PL/pgSQL function body, no internal savepoints). The proof
--     DELETE happens first, inside that same transaction.
--   - If the function later raises (CANNOT_DELETE_SELF, USER_NOT_FOUND,
--     INVALID_PASSWORD, or any other business-rule failure) AFTER the proof
--     was already deleted, Postgres rolls back the ENTIRE transaction -
--     including that DELETE. The proof row is restored exactly as if the
--     call had never happened, and remains valid (retryable, e.g. against a
--     different, valid target) until its natural 5-minute expiry.
--   - Therefore: the proof is consumed IF AND ONLY IF the enclosing RPC call
--     completes successfully (returns normally, the mutation actually
--     happens) - a business-validation failure never burns the caller's
--     step-up proof. This is a deliberate, smallest-safe-design consequence
--     of one function body being one transaction, not a separate
--     "soft-consume" mechanism - and it satisfies the actual requirement
--     ("a successfully-used proof must not execute a second mutation"),
--     since a proof that never produced a successful mutation was never
--     "successfully used" to begin with.
--   - Concurrent replay of a proof that WOULD succeed: only one of the two
--     racing callers can ever see the row before it is gone - the other
--     necessarily fails UNAUTHORIZED, never a second successful mutation.
--
-- No change to the existing 5-minute TTL, to election_day_reauth_v3's own
-- minting logic, or to any other v3 action's replay semantics.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- PART A.1 - election_day_delete_permission_user_v2 (containment).
-- ============================================================================
create or replace function public.election_day_delete_permission_user_v2(
  p_reauth_proof text,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
begin
  select v.actor_id, v.role_id into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if p_target_user_id = v_actor_id then
    raise exception 'CANNOT_DELETE_SELF';
  end if;

  select u.workspace_id into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, per the containment requirement.
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  delete from public.election_day_permission_users where id = p_target_user_id;
end;
$$;

comment on function public.election_day_delete_permission_user_v2(text, uuid) is
  'Security Phase 1 + Phase 3C containment: proof-based, permission-checked, WORKSPACE-SCOPED delete. Requires electionDay.manageUsers on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side (second lookup, the legacy proof verifier has no workspace column), rejects a target outside that workspace with the SAME USER_NOT_FOUND used for a genuinely nonexistent id (never distinguishable - closes a confirmed cross-workspace delete path), and rejects p_target_user_id = the resolved actor_id as CANNOT_DELETE_SELF before any delete runs (closes client-side-only self-delete protection at the RPC boundary). Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any legitimate same-workspace target.';

-- ============================================================================
-- PART A.2 - election_day_reset_permission_user_password_v2 (containment).
-- ============================================================================
create or replace function public.election_day_reset_permission_user_password_v2(
  p_reauth_proof text,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_name text;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
begin
  select v.actor_id, v.role_id, v.actor_name
    into v_actor_id, v_actor_role_id, v_actor_name
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  select u.workspace_id into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, per the containment requirement.
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_actor_name
  where public.election_day_permission_users.id = p_target_user_id;

  delete from public.election_day_reauth_proofs where actor_id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$$;

comment on function public.election_day_reset_permission_user_password_v2(text, uuid, text) is
  'Security Phase 1 + Phase 3C containment: proof-based, WORKSPACE-SCOPED password reset. Requires electionDay.manageUsers on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side and rejects a target outside that workspace with the SAME USER_NOT_FOUND already used for a nonexistent id (never distinguishable - closes a confirmed cross-workspace reset path). Business logic (INVALID_PASSWORD check, reset_by from the server-resolved actor, deleting all of the TARGET''s outstanding reauth proofs) unchanged from the pre-containment version. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any legitimate same-workspace target.';

-- ============================================================================
-- PART B.1 - election_day_list_permission_users_v3 - service_role-only,
-- session-derived, workspace-scoped roster read. No reauth proof required -
-- a read carries no step-up requirement (this project's existing "reads
-- don't require reauth" convention - see election_day_list_permission_users
-- itself, which has never required one either).
-- ============================================================================
create or replace function public.election_day_list_permission_users_v3(
  p_session_hash bytea
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.workspace_id = v_workspace_id
    order by u.created_at asc;
end;
$$;

comment on function public.election_day_list_permission_users_v3(bytea) is
  'Phase 3C trusted-v3 expand: session-derived, WORKSPACE-SCOPED replacement for election_day_list_permission_users (which returns every workspace''s roster with no filter at all). Requires only a currently-valid session (via election_day_resolve_session - UNAUTHORIZED propagates from there for an invalid/expired session); no reauth proof, matching this project''s existing "reads don''t require step-up" convention. Returns only {id, name, role_id} for rows in the session''s own resolved workspace_id - never password_hash, never another workspace''s rows. service_role-only: no PUBLIC/anon/authenticated EXECUTE. The legacy election_day_list_permission_users() is NOT retired or touched by this migration and remains the frontend''s only roster-read path until a separate, later, explicit cutover decision.';

revoke all on function public.election_day_list_permission_users_v3(bytea) from public;
revoke all on function public.election_day_list_permission_users_v3(bytea) from anon;
revoke all on function public.election_day_list_permission_users_v3(bytea) from authenticated;
grant execute on function public.election_day_list_permission_users_v3(bytea) to service_role;

-- ============================================================================
-- PART C - election_day_verify_and_consume_reauth_proof_v3 - internal-only
-- helper (no grant to any role, including service_role - matching election_
-- day_verify_reauth_proof_v3's own internal-helper precedent). See this
-- migration's header for the full, honestly-stated consumption semantics.
-- Deliberately a SEPARATE function from election_day_verify_reauth_proof_v3
-- - that function is untouched, so election_day_create_permission_user_v3's
-- existing reusable-within-TTL replay semantics are unaffected.
-- ============================================================================
create or replace function public.election_day_verify_and_consume_reauth_proof_v3(
  p_session_hash bytea,
  p_proof_hash bytea,
  p_action text
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_actor_id uuid;
  v_session_actor_name text;
  v_session_role_id uuid;
  v_session_workspace_id uuid;
  v_proof_actor_id uuid;
  v_proof_workspace_id uuid;
begin
  if p_session_hash is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select r.actor_id, r.actor_name, r.role_id, r.workspace_id
    into v_session_actor_id, v_session_actor_name, v_session_role_id, v_session_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  -- Atomic consume: this DELETE...RETURNING IS the verification step. At
  -- most one concurrent caller can ever observe a non-null v_proof_actor_id
  -- for the same (proof_hash, action) pair - see this migration's header for
  -- the full concurrency argument.
  delete from public.election_day_reauth_proofs p
  where p.proof_hash = p_proof_hash
    and p.action = p_action
    and p.expires_at > now()
  returning p.actor_id, p.workspace_id into v_proof_actor_id, v_proof_workspace_id;

  if v_proof_actor_id is null
     or v_proof_actor_id <> v_session_actor_id
     or v_proof_workspace_id is distinct from v_session_workspace_id
  then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select v_session_actor_id, v_session_actor_name, v_session_role_id, v_session_workspace_id;
end;
$$;

comment on function public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text) is
  'Phase 3C: internal-only helper for ONE-TIME-CONSUMED v3 actions (delete_permission_user, reset_permission_user_password). Verifies the session AND atomically CONSUMES (deletes) a matching action-bound proof in a single DELETE...RETURNING statement - the deletion IS the verification. See this migration''s header comment for the exact, honestly-stated consumption semantics: consumption is only permanent if the ENCLOSING call''s transaction commits (i.e. the mutation actually succeeds) - a later business-rule failure in the same call rolls the whole transaction back, restoring the proof. Deliberately separate from election_day_verify_reauth_proof_v3 (untouched by this migration) so create_permission_user_v3''s existing reusable-within-TTL replay semantics are unaffected. Not granted to any role, including service_role - callable only from inside a v3 mutation RPC''s own SECURITY DEFINER body.';

-- Per CLAUDE.md's Permanent Engineering Guardrail (added after a real
-- Production privilege-escalation incident): a bare absence of GRANT
-- statements is NOT sufficient on this project's hosted Production instance,
-- which is confirmed to carry a project-level pg_default_acl entry that
-- auto-grants EXECUTE to anon/authenticated (and, empirically re-confirmed
-- against this migration's own local disposable verification run, also to
-- service_role) on every newly-created function in schema public. Every
-- role must be REVOKEd BY NAME, explicitly - matching election_day_verify_
-- reauth_proof_v3's own precedent exactly (which relies on this same
-- explicit-by-name pattern, not a bare "from public").
revoke all on function public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text) from public;
revoke all on function public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text) from anon;
revoke all on function public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text) from authenticated;
revoke all on function public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text) from service_role;

-- ============================================================================
-- PART B.2 - election_day_delete_permission_user_v3 - service_role-only,
-- session + one-time-consumed-proof, workspace-scoped delete.
-- ============================================================================
create or replace function public.election_day_delete_permission_user_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
begin
  select v.actor_id, v.role_id, v.workspace_id
    into v_actor_id, v_actor_role_id, v_actor_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'delete_permission_user'
  ) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  if p_target_user_id = v_actor_id then
    raise exception 'CANNOT_DELETE_SELF';
  end if;

  select u.workspace_id into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Deleting the target row cascades their election_day_sessions (ON DELETE
  -- CASCADE, election_day_sessions.permission_user_id FK) and their
  -- election_day_reauth_proofs (ON DELETE CASCADE, actor_id FK) - both
  -- revoked structurally, no separate explicit DELETE needed for either.
  delete from public.election_day_permission_users where id = p_target_user_id;
end;
$$;

comment on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) is
  'Phase 3C trusted-v3 expand: session + one-time-consumed-action-bound-proof delete (action ''delete_permission_user'', via election_day_verify_and_consume_reauth_proof_v3 - see that function and this migration''s header for exact consumption semantics). Actor/workspace derived entirely server-side - never a client-supplied value. Requires electionDay.manageUsers on the resolved actor''s CURRENT role, read live. Rejects self-delete (CANNOT_DELETE_SELF) and any target outside the actor''s own workspace (USER_NOT_FOUND, indistinguishable from a nonexistent id). Deleting the target row cascades their sessions and reauth proofs via existing FK ON DELETE CASCADE - both revoked structurally. service_role-only: no PUBLIC/anon/authenticated EXECUTE. NOT wired into the live frontend by this migration - the legacy election_day_delete_permission_user_v2 (Part A, containment-hardened) remains the only reachable delete path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) from public;
revoke all on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) from anon;
revoke all on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) from authenticated;
grant execute on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) to service_role;

-- ============================================================================
-- PART B.3 - election_day_reset_permission_user_password_v3 - service_role-
-- only, session + one-time-consumed-proof, workspace-scoped password reset.
-- Additionally revokes ALL of the target's active sessions (new vs. the v2
-- behavior, which only invalidated outstanding reauth proofs) - an already-
-- authenticated compromised session must not remain valid after a reset.
-- ============================================================================
create or replace function public.election_day_reset_permission_user_password_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_name text;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
begin
  select v.actor_id, v.actor_name, v.role_id, v.workspace_id
    into v_actor_id, v_actor_name, v_actor_role_id, v_actor_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'reset_permission_user_password'
  ) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_actor_name
  where public.election_day_permission_users.id = p_target_user_id;

  -- Invalidate every outstanding reauth proof for the target (legacy AND
  -- any v3-actioned row - the table is shared, this DELETE has no `action`
  -- filter, matching the v2 reset's own existing scope exactly).
  delete from public.election_day_reauth_proofs where actor_id = p_target_user_id;

  -- New in v3: revoke ALL of the target's currently-active sessions, not
  -- just their reauth proofs - an already-authenticated session must not
  -- outlive its own account's password reset.
  delete from public.election_day_sessions where permission_user_id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$$;

comment on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) is
  'Phase 3C trusted-v3 expand: session + one-time-consumed-action-bound-proof password reset (action ''reset_permission_user_password'', via election_day_verify_and_consume_reauth_proof_v3). Actor/workspace derived entirely server-side. Requires electionDay.manageUsers on the resolved actor''s CURRENT role, read live. Rejects any target outside the actor''s own workspace (USER_NOT_FOUND, indistinguishable from a nonexistent id). On success: updates password_hash/reset_at/reset_by, deletes ALL of the target''s outstanding reauth_proofs (same scope as v2), and - NEW vs v2 - deletes ALL of the target''s election_day_sessions rows, so an already-authenticated compromised session cannot remain valid after the reset. service_role-only: no PUBLIC/anon/authenticated EXECUTE. NOT wired into the live frontend by this migration - the legacy election_day_reset_permission_user_password_v2 (Part A, containment-hardened) remains the only reachable reset path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) from public;
revoke all on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) from anon;
revoke all on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) from authenticated;
grant execute on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   drop function if exists public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text);
--   drop function if exists public.election_day_delete_permission_user_v3(bytea, bytea, uuid);
--   drop function if exists public.election_day_verify_and_consume_reauth_proof_v3(bytea, bytea, text);
--   drop function if exists public.election_day_list_permission_users_v3(bytea);
--
--   -- Part A containment revert (restores the PRE-Phase-3C-Users behavior -
--   -- no workspace check, no self-delete guard - only do this if a
--   -- legitimate need to revert is identified):
--   create or replace function public.election_day_delete_permission_user_v2(
--     p_reauth_proof text, p_target_user_id uuid
--   )
--   returns void language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid; v_has_permission boolean;
--   begin
--     select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;
--     select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     delete from public.election_day_permission_users where id = p_target_user_id;
--   end;
--   $$;
--   commit;
-- ============================================================================
