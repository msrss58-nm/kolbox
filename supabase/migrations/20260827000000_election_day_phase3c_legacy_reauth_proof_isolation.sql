-- Phase 3C - legacy/v3 reauth proof isolation (SECURITY FIX, narrow scope).
--
-- Incident: a read-only security check (this repo's own Phase 3C planning
-- pass, not a live exploit) found that a v3 action-bound reauth proof
-- (issued by election_day_reauth_v3 for the 'create_permission_user'
-- action, the only action currently allowlisted server-side in
-- api/election-day/reauth.ts) is also accepted by the LEGACY
-- election_day_verify_reauth_proof helper, because both proof generations
-- share the same election_day_reauth_proofs table and the legacy verifier's
-- predicate never references the `action` column at all - it only checks
-- `proof_hash = ... and expires_at > now()`. Confirmed by direct SQL
-- inspection, not comment-inference: election_day_reauth_v3's own INSERT
-- writes proof_hash = sha256(rawProof) computed in Node
-- (api/election-day/reauth.ts), and Postgres's pgcrypto
-- extensions.digest(p_proof, 'sha256') (the legacy verifier's own hashing
-- step) produces the byte-identical digest for the same raw proof string -
-- so a v3-issued raw proof, if passed as p_proof into the legacy verifier,
-- hash-matches its own already-stored row and is accepted.
--
-- The reverse direction was already safe and remains unchanged by this
-- migration: a legacy-issued proof (action IS NULL, by construction - see
-- below) is already correctly rejected by election_day_verify_reauth_proof_v3,
-- whose predicate requires `p.action = p_action` (a non-null string) -
-- `NULL = 'create_permission_user'` evaluates to NULL, not TRUE, under SQL
-- three-valued logic, so that row is already excluded with no change needed
-- on the v3 side.
--
-- Severity/blast radius (full detail in CURRENT_STATUS.md's Phase 3C
-- security-check record): MEDIUM today, not BLOCKER/HIGH - every legacy
-- `_v2` RPC that calls the legacy verifier still independently re-checks
-- the resolved actor's live permission before any mutation, so this bug
-- does not let a v3 proof authorize a DIFFERENT actor or a permission that
-- actor doesn't already hold; and the still-fully-open, unauthenticated-at-
-- the-RPC-boundary legacy election_day_reauth already hands out a strictly
-- MORE powerful proof (15-minute TTL, valid against all 11 legacy actions
-- the actor's own permissions allow, zero action restriction) for the same
-- one password check, so this bug grants no NEW capability today. It is a
-- real, confirmed design flaw that would matter as soon as the v3 action
-- allowlist grows past one entry, or once the legacy path is eventually
-- retired and v3 proofs become the only credential type - fixed now, ahead
-- of that need, while it is cheap and isolated.
--
-- Fix: legacy issuance (election_day_reauth) never writes the `action`
-- column - its own INSERT names only (actor_id, proof_hash, expires_at) -
-- and `action` was added with no non-null default (`add column action text
-- null`, 20260826000000), so every legitimate legacy-issued row has
-- `action IS NULL` unconditionally, by construction. This was independently
-- confirmed against real Production data immediately before authoring this
-- migration (read-only, no mutation): 2/2 real rows in
-- election_day_reauth_proofs both have action IS NULL; 0 rows with a
-- non-null action exist (expected - no frontend code calls the v3 reauth
-- endpoint yet). Adding `and p.action is null` to the legacy verifier's own
-- WHERE clause therefore changes behavior for ZERO currently-valid or
-- historically-observed legacy proofs, and excludes only v3-issued
-- (non-null-action) rows - exactly the intended isolation, with no schema
-- change, no new table, no data migration, and no change to v3's own
-- verifier (which already enforces the correct action match on its side).
--
-- Explicitly NOT done by this migration, per its own approved scope:
-- proof storage is not redesigned, v3 proof semantics are unchanged
-- (still reusable within its 5-minute TTL, still non-consuming - see
-- election_day_reauth_v3's own header comment for why that is a deliberate,
-- separate design decision, not something this migration touches), no TTL
-- changes, no permission/business-logic changes, no ACL/GRANT/REVOKE
-- statement (CREATE OR REPLACE FUNCTION does not alter an existing
-- function's privileges - verified explicitly, before and after local
-- apply, in this change's own verification record rather than assumed).
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

create or replace function public.election_day_verify_reauth_proof(p_proof text)
returns table (actor_id uuid, actor_name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proof_hash bytea;
  v_actor_id uuid;
begin
  if p_proof is null or btrim(p_proof) = '' then
    raise exception 'UNAUTHORIZED';
  end if;

  v_proof_hash := extensions.digest(p_proof, 'sha256');

  select p.actor_id into v_actor_id
  from public.election_day_reauth_proofs p
  where p.proof_hash = v_proof_hash
    and p.action is null
    and p.expires_at > now();

  if v_actor_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = v_actor_id;

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$$;

comment on function public.election_day_verify_reauth_proof(text) is
  'Security Phase 1 (Phase 3C isolation update): internal helper - hashes p_proof, looks up a matching non-expired election_day_reauth_proofs row, and returns the SERVER-DERIVED actor identity {actor_id, actor_name, role_id}. As of Phase 3C''s legacy/v3 proof isolation fix, ONLY matches rows with action IS NULL (every legitimate legacy-issued proof, since election_day_reauth never writes that column) - this excludes any v3-issued, action-bound proof (from election_day_reauth_v3), which always carries a non-null action, from being accepted by this legacy path. Raises UNAUTHORIZED for a missing/forged/expired/v3-issued proof, or if the proof''s actor_id no longer resolves to an existing permission user (deleted actor - the FK cascade already removes their proofs on deletion, this re-check is defense in depth against any future change to that guarantee). Never accepts or trusts a client-supplied actor_id - identity comes exclusively from the proof itself. ACL unchanged by this update (CREATE OR REPLACE FUNCTION does not alter privileges) - still not granted to anon/authenticated, callable only from inside another SECURITY DEFINER function''s body, matching this project''s existing internal-helper pattern.';

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down". Reversing this re-opens the v3-proof-accepted-by-legacy-verifier
-- gap this migration exists to close - only do this if a legitimate need
-- to revert is identified):
--
--   begin;
--   create or replace function public.election_day_verify_reauth_proof(p_proof text)
--   returns table (actor_id uuid, actor_name text, role_id uuid)
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     v_proof_hash bytea;
--     v_actor_id uuid;
--   begin
--     if p_proof is null or btrim(p_proof) = '' then
--       raise exception 'UNAUTHORIZED';
--     end if;
--     v_proof_hash := extensions.digest(p_proof, 'sha256');
--     select p.actor_id into v_actor_id
--     from public.election_day_reauth_proofs p
--     where p.proof_hash = v_proof_hash
--       and p.expires_at > now();
--     if v_actor_id is null then
--       raise exception 'UNAUTHORIZED';
--     end if;
--     return query
--       select u.id, u.name, u.role_id
--       from public.election_day_permission_users u
--       where u.id = v_actor_id;
--     if not found then
--       raise exception 'UNAUTHORIZED';
--     end if;
--   end;
--   $$;
--   commit;
-- ============================================================================
