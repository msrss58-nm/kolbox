-- Phase 3C Roles Mutations - Owner Trust Foundation (EXPAND, service_role
-- only, zero frontend wiring). Reusable backend foundation for EVERY future
-- Owner-only sensitive action, not just Roles - modeled directly on the
-- already-shipped, already-proven PermissionUser Session + action-bound
-- Reauth v3 architecture (20260826000000/20260826010000/20260828000000),
-- but for a genuinely different principal: an Election Owner authenticates
-- via real Supabase Auth (auth.users), never via the local PermissionUser
-- name/password system, and holds no password_hash of any kind in this
-- schema - Supabase Auth remains the sole credential store, per Phase 0's
-- own election_owners design (20260823010000).
--
-- ============================================================================
-- TRUST CHAIN (per the approved architecture, empirically verified in the
-- prior Owner trust-boundary spike - see CURRENT_STATUS.md):
-- ============================================================================
--   Browser (real Supabase Auth session, Owner's own JWT)
--   -> Vercel endpoint extracts the JWT from Authorization: Bearer
--   -> Vercel calls auth.getUser(jwt) itself - real cryptographic signature
--      verification, not decoded-and-trusted - obtaining a SERVER-VERIFIED
--      auth_user_id (and, for step-up, the verified user's own email)
--   -> Vercel passes ONLY that server-verified auth_user_id into a
--      service_role-only RPC - never a client-supplied ownerId/workspaceId
--   -> Postgres resolves {owner_id, workspace_id} from election_owners LIVE,
--      on every call - never cached, never trusted from the JWT's own claims
--      or from any table other than election_owners itself.
--
-- Why p_auth_user_id (not a session-hash, unlike the PermissionUser
-- architecture): the prior spike proved a service_role-keyed RPC call
-- resolves auth.uid() to NULL (no forwarded user JWT reaches Postgres that
-- way), so no function below relies on auth.uid(). The verified identity
-- instead arrives as an explicit parameter - safe specifically because it is
-- populated ONLY by Vercel's own auth.getUser(jwt) call, a cryptographic
-- verification step no browser can forge or skip, and these RPCs are
-- service_role-only (the anon key can never call them directly - confirmed
-- unreachable below, same guardrail as every other _v3/session RPC in this
-- project).
--
-- ============================================================================
-- SCOPE OF THIS MIGRATION (Workstream A only - see the companion Workstream B
-- migration, 20260828070000, for the actual Owner-only Roles v3 mutation
-- RPCs that consume this foundation):
-- ============================================================================
--   1. election_owner_reauth_proofs - new, dedicated proof table. Distinct
--      from election_day_reauth_proofs (the PermissionUser table) - Owner
--      identity is a completely different principal (election_owners, not
--      election_day_permission_users), and reusing the PermissionUser table
--      would require weakening its actor_id FK (currently election_day_
--      permission_users-only) to accept either principal type, silently
--      blurring two distinct trust models. A small, purpose-built table
--      keeps the two proof lifecycles - and their very different one-time
--      vs. reusable-within-TTL consumption semantics, see below - completely
--      independent.
--   2. election_day_resolve_owner_context(p_auth_user_id) - live {owner_id,
--      workspace_id} resolution, service_role-only.
--   3. election_day_owner_reauth(p_auth_user_id, p_action, p_proof_hash) -
--      mints a short-lived, action-bound Owner proof, service_role-only.
--      Deliberately does NOT verify a password itself (election_owners has
--      no password_hash column to check) - password step-up happens in Node
--      via an isolated Supabase Auth signInWithPassword call BEFORE this RPC
--      is ever invoked (api/election-day/owner-reauth.ts), per the approved
--      design and the spike's own empirical findings ("Fresh signInWithPassword
--      re-verification (step-up) works cleanly, doesn't corrupt other
--      sessions, resolves to the same identity, rejects wrong passwords").
--   4. election_day_verify_and_consume_owner_proof(p_auth_user_id,
--      p_proof_hash, p_action) - internal-only helper (no grant to any role,
--      matching election_day_verify_and_consume_reauth_proof_v3's own
--      internal-helper precedent exactly). ONE-TIME consumption via a single
--      atomic `delete ... returning` statement - the deletion IS the
--      verification, same mechanism and same honestly-stated transactional
--      semantics as the PermissionUser one-time helper: consumption is only
--      PERMANENT if the enclosing mutation RPC's own transaction later
--      commits; a business-rule failure raised afterward in that same call
--      rolls back the whole transaction, including the proof DELETE,
--      restoring it for a legitimate retry until natural TTL expiry. Live
--      re-resolves owner/workspace from election_owners on every call (not
--      just at mint time) - a stale JWT whose Owner membership was removed
--      after the proof was minted fails here even if the proof itself has
--      not yet expired, because v_owner_id resolution itself fails first.
--
-- 5-minute TTL, matching the established project convention for every
-- action-bound proof (election_day_reauth_v3's own 5-minute window,
-- deliberately shorter than the legacy general-purpose 15-minute proof,
-- since this is meant for immediate one-shot consumption, not a
-- session-long credential) - no evidence surfaced during this task to
-- justify a different value for the Owner principal.
--
-- ============================================================================
-- SECURITY GUARDRAILS APPLIED UNIFORMLY (per CLAUDE.md's Permanent
-- Engineering Guardrail, added after the Production privilege-escalation
-- incident): every function below explicitly REVOKEs EXECUTE from PUBLIC,
-- anon, and authenticated by name - a bare `revoke ... from public` alone is
-- NOT sufficient on this project's own hosted Production instance, which
-- carries a confirmed per-role default-privilege grant. Every service_role-
-- callable function additionally GRANTs EXECUTE to service_role only - never
-- anon/authenticated, so the browser's own anon key can never call any of
-- these directly, exactly like every other _v3/session/reauth RPC in this
-- project. election_day_verify_and_consume_owner_proof gets NO grant to any
-- role, including service_role - callable only from inside a future
-- Owner-only mutation RPC's own SECURITY DEFINER body (both owned by
-- postgres, which bypasses ACL checks entirely for a nested call - the same
-- mechanism election_day_verify_and_consume_reauth_proof_v3 already relies
-- on, verified working in that migration's own local test run).
--
-- No RLS policy is added on election_owner_reauth_proofs beyond RLS-enabled-
-- with-zero-policies (this project's own established pattern for every
-- sensitive, RPC-only table) - PLUS an explicit `revoke all ... from public,
-- anon, authenticated`, matching election_day_sessions/election_day_login_
-- attempts' own defense-in-depth precedent from the Phase 3A EXPAND
-- migration.
--
-- No existing table, RLS policy, or v1/v2/legacy function is touched by this
-- migration - strictly additive, parallel to everything that already exists.
-- No frontend code calls anything in this migration - EXPAND only, per this
-- task's explicit local-implementation-only scope.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol batching, not an implicit transaction.
begin;

-- ============================================================================
-- 1. election_owner_reauth_proofs - dedicated, Owner-only proof table.
-- ============================================================================
create table public.election_owner_reauth_proofs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.election_owners(id) on delete cascade,
  workspace_id uuid not null references public.election_workspaces(id) on delete cascade,
  action       text not null,
  proof_hash   bytea not null unique,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

comment on table public.election_owner_reauth_proofs is
  'Phase 3C Owner Trust Foundation: short-lived, action-bound, ONE-TIME-consumed step-up proofs for Election Owner-authorized mutations (Roles v3 create/update/delete/clone, and any future Owner-only action). Distinct from election_day_reauth_proofs (the PermissionUser table, actor_id FK''d to election_day_permission_users) - a genuinely different principal, kept in its own table rather than weakening that FK to accept either identity type. owner_id FK is ON DELETE CASCADE - removing an Owner (or the workspace itself, via the separate workspace_id FK, also CASCADE) immediately and structurally invalidates every outstanding proof, no separate cleanup job required. Only proof_hash (sha256 of a raw proof generated in Node) is ever stored - the raw proof itself never reaches this table, matching election_day_reauth_proofs.proof_hash''s own precedent. RLS-enabled, zero policies, PLUS an explicit table-level REVOKE (defense in depth, matching election_day_sessions'' own precedent) - every access path is a SECURITY DEFINER RPC in this same migration.';

comment on column public.election_owner_reauth_proofs.proof_hash is
  'sha256 digest of the raw opaque proof token, computed by the caller (a Vercel Server Function) BEFORE this table is ever touched - Postgres never receives or handles the raw proof. Unique: a hash collision would otherwise let one proof resolve two rows.';

create index election_owner_reauth_proofs_owner_id_idx
  on public.election_owner_reauth_proofs (owner_id);

comment on index public.election_owner_reauth_proofs_owner_id_idx is
  'Supports the FK''s cascade-delete lookup and a future "list/revoke this Owner''s outstanding proofs" query - Postgres does not automatically index the referencing side of a foreign key.';

alter table public.election_owner_reauth_proofs enable row level security;

-- Deliberately no CREATE POLICY here - RLS enabled with zero policies denies
-- every direct anon/authenticated access by default, matching every other
-- sensitive table in this schema. All access goes through the SECURITY
-- DEFINER RPCs below.

revoke all on table public.election_owner_reauth_proofs from public;
revoke all on table public.election_owner_reauth_proofs from anon;
revoke all on table public.election_owner_reauth_proofs from authenticated;

-- ============================================================================
-- 2. election_day_resolve_owner_context - live {owner_id, workspace_id}
-- resolution from a server-verified auth_user_id. service_role-only. No
-- caching of any kind - every call re-queries election_owners directly, so
-- a removed Owner (or a valid Supabase Auth user who was never registered as
-- an Owner at all) loses/never has mutation authority immediately, on the
-- very next call - there is no separate revocation step to run.
-- ============================================================================
create or replace function public.election_day_resolve_owner_context(
  p_auth_user_id uuid
)
returns table (
  owner_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select o.id, o.workspace_id
    from public.election_owners o
    where o.auth_user_id = p_auth_user_id;

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$$;

comment on function public.election_day_resolve_owner_context(uuid) is
  'Phase 3C Owner Trust Foundation: resolves a trusted {owner_id, workspace_id} from a SERVER-VERIFIED auth_user_id alone (never a client-supplied ownerId/workspaceId - the caller must have already verified this id via auth.getUser(jwt) in Node before calling this function). Live lookup on election_owners on every call - no caching, so a removed Owner (FK cascade already deletes their row) or a Supabase Auth user with no election_owners row at all both raise the same generic UNAUTHORIZED, never a distinguishing message. Multiple equal Owners in one workspace are each independently resolved via their own distinct auth_user_id - no special-casing. service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever.';

revoke all on function public.election_day_resolve_owner_context(uuid) from public;
revoke all on function public.election_day_resolve_owner_context(uuid) from anon;
revoke all on function public.election_day_resolve_owner_context(uuid) from authenticated;
grant execute on function public.election_day_resolve_owner_context(uuid) to service_role;

-- ============================================================================
-- 3. election_day_owner_reauth - mints a short-lived, action-bound Owner
-- proof. service_role-only. Does NOT verify a password itself - election_
-- owners carries no password_hash of any kind; password step-up happens in
-- Node via an isolated Supabase Auth signInWithPassword call BEFORE this RPC
-- is ever invoked (see api/election-day/owner-reauth.ts). p_proof_hash is
-- bytea, computed by the caller in Node from a raw proof it generates
-- itself, BEFORE calling this function - the raw proof never reaches
-- Postgres, mirroring election_day_reauth_v3's own p_proof_hash convention.
-- ============================================================================
create or replace function public.election_day_owner_reauth(
  p_auth_user_id uuid,
  p_action text,
  p_proof_hash bytea
)
returns table (
  owner_id uuid,
  workspace_id uuid,
  action text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_expires_at timestamptz;
begin
  if p_auth_user_id is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select o.id, o.workspace_id into v_owner_id, v_workspace_id
  from public.election_owners o
  where o.auth_user_id = p_auth_user_id;

  if v_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Opportunistic cleanup of this Owner's own already-expired same-action
  -- proofs, matching election_day_reauth_v3's own precedent.
  delete from public.election_owner_reauth_proofs p
  where p.owner_id = v_owner_id and p.action = p_action and p.expires_at < now();

  v_expires_at := now() + interval '5 minutes';

  insert into public.election_owner_reauth_proofs (owner_id, workspace_id, action, proof_hash, expires_at)
  values (v_owner_id, v_workspace_id, p_action, p_proof_hash, v_expires_at);

  return query select v_owner_id, v_workspace_id, p_action, v_expires_at;
end;
$$;

comment on function public.election_day_owner_reauth(uuid, text, bytea) is
  'Phase 3C Owner Trust Foundation: service_role-only, action-bound Owner step-up proof issuance. Resolves {owner_id, workspace_id} LIVE from p_auth_user_id (a SERVER-VERIFIED identity, never client-supplied) - UNAUTHORIZED for any auth_user_id with no matching election_owners row. Does NOT verify a password - election_owners has no password_hash column; the caller (api/election-day/owner-reauth.ts) MUST have already re-verified the Owner''s password via an isolated Supabase Auth signInWithPassword call before ever invoking this function. p_proof_hash is sha256(raw proof) computed by the caller in Node - the raw proof never reaches Postgres. 5-minute expiry, matching election_day_reauth_v3''s own established TTL. service_role-only: no PUBLIC/anon/authenticated EXECUTE.';

revoke all on function public.election_day_owner_reauth(uuid, text, bytea) from public;
revoke all on function public.election_day_owner_reauth(uuid, text, bytea) from anon;
revoke all on function public.election_day_owner_reauth(uuid, text, bytea) from authenticated;
grant execute on function public.election_day_owner_reauth(uuid, text, bytea) to service_role;

-- ============================================================================
-- 4. election_day_verify_and_consume_owner_proof - internal-only helper (no
-- grant to any role, including service_role - matching election_day_verify_
-- and_consume_reauth_proof_v3's own internal-helper precedent). Callable
-- only from inside a future Owner-only mutation RPC's own SECURITY DEFINER
-- body (both owned by postgres, which bypasses the ACL check for a nested
-- call).
--
-- ONE-TIME consumption via a single atomic `delete ... returning` statement
-- - the deletion IS the verification, identical mechanism to election_day_
-- verify_and_consume_reauth_proof_v3 (see that function''s own migration
-- header, 20260828000000, for the full concurrency/rollback argument, which
-- applies here unchanged: Postgres row-level locking on the DELETE makes two
-- concurrent callers racing the SAME proof safe - the first to acquire the
-- row lock deletes it, the second finds zero matching rows and fails
-- UNAUTHORIZED; a business-rule failure raised LATER in the SAME enclosing
-- transaction rolls back the whole call, including this DELETE, restoring
-- the proof for a legitimate retry until its natural TTL expiry).
--
-- Live re-resolution of owner/workspace from election_owners (not just a
-- comparison against values captured at mint time) is what makes "remove
-- Owner membership after authentication -> stale JWT immediately loses
-- mutation authority" and "proof issued before Owner removal cannot be used
-- afterward" both true even within a still-unexpired proof''s 5-minute
-- window - if the Owner row is gone, v_owner_id resolution fails FIRST, so
-- the proof (if it still physically exists - it may already be gone too, via
-- election_owner_reauth_proofs.owner_id''s own ON DELETE CASCADE) is never
-- even reached.
-- ============================================================================
create or replace function public.election_day_verify_and_consume_owner_proof(
  p_auth_user_id uuid,
  p_proof_hash bytea,
  p_action text
)
returns table (
  owner_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_proof_owner_id uuid;
  v_proof_workspace_id uuid;
begin
  if p_auth_user_id is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select o.id, o.workspace_id into v_owner_id, v_workspace_id
  from public.election_owners o
  where o.auth_user_id = p_auth_user_id;

  if v_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Atomic consume: this DELETE...RETURNING IS the verification step.
  delete from public.election_owner_reauth_proofs p
  where p.proof_hash = p_proof_hash
    and p.action = p_action
    and p.expires_at > now()
  returning p.owner_id, p.workspace_id into v_proof_owner_id, v_proof_workspace_id;

  if v_proof_owner_id is null
     or v_proof_owner_id <> v_owner_id
     or v_proof_workspace_id is distinct from v_workspace_id
  then
    raise exception 'UNAUTHORIZED';
  end if;

  return query select v_owner_id, v_workspace_id;
end;
$$;

comment on function public.election_day_verify_and_consume_owner_proof(uuid, bytea, text) is
  'Phase 3C Owner Trust Foundation: internal-only helper - live-resolves {owner_id, workspace_id} from a SERVER-VERIFIED p_auth_user_id, then ATOMICALLY CONSUMES (single delete...returning) a matching, non-expired, same-owner, same-workspace, same-action proof. The deletion IS the verification. See this migration''s header for the full, honestly-stated one-time consumption semantics (permanent only if the enclosing mutation''s own transaction later commits). A proof for a different action, a different owner, an expired proof, or an Owner whose election_owners row no longer exists all raise the same generic UNAUTHORIZED - never a distinguishing message. Not granted to any role, including service_role - callable only from inside a future Owner-only mutation RPC''s own SECURITY DEFINER body.';

revoke all on function public.election_day_verify_and_consume_owner_proof(uuid, bytea, text) from public;
revoke all on function public.election_day_verify_and_consume_owner_proof(uuid, bytea, text) from anon;
revoke all on function public.election_day_verify_and_consume_owner_proof(uuid, bytea, text) from authenticated;
revoke all on function public.election_day_verify_and_consume_owner_proof(uuid, bytea, text) from service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   drop function if exists public.election_day_verify_and_consume_owner_proof(uuid, bytea, text);
--   drop function if exists public.election_day_owner_reauth(uuid, text, bytea);
--   drop function if exists public.election_day_resolve_owner_context(uuid);
--   drop table if exists public.election_owner_reauth_proofs;
--   commit;
-- ============================================================================
