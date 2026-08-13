-- Security Phase 1 - re-auth proof infrastructure. Short-lived, opaque,
-- table-backed proof token that replaces repeated raw-password transmission
-- on privileged Election Day admin mutations (see task-plan.md/CLAUDE.md's
-- Password Logging Gate and Security Phase 1 audit). Purely additive - does
-- not touch any existing table, function, or grant. election_day_login is
-- untouched and remains a raw-password entry point alongside this
-- migration's own election_day_reauth (the only two RPCs ever taking a
-- plaintext password after this migration + its companion).
--
-- Approved design: 256-bit random token via pgcrypto's gen_random_bytes,
-- hex-encoded; only its sha256 digest (pgcrypto's digest()) is ever stored
-- server-side; actor-bound via FK; 15-minute TTL; reusable within TTL (a
-- proof only certifies "this actor recently proved knowledge of their
-- password" - never a permission snapshot; every privileged v2 mutation in
-- the companion migration re-checks the resolved actor's CURRENT
-- role/permission independently, so a permission change takes effect
-- immediately regardless of proof validity). No revoked_at column:
-- revocation (logout, password reset) is a physical DELETE of the row - a
-- deleted row is unambiguously invalid, simpler than a soft-revoke flag
-- that every verification would otherwise have to check.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

create table public.election_day_reauth_proofs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references public.election_day_permission_users(id) on delete cascade,
  proof_hash  bytea not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.election_day_reauth_proofs is
  'Security Phase 1: short-lived, opaque re-auth proofs for Election Day privileged admin mutations. Only sha256(raw token) is ever stored (proof_hash) - the raw token is returned to the caller exactly once at issuance (election_day_reauth) and never persisted anywhere, including here. A row''s existence with expires_at > now() IS validity - revocation (logout, password reset) is a physical DELETE, not a soft-revoke flag. actor_id cascades on election_day_permission_users deletion, so a deleted account''s outstanding proofs vanish automatically.';

comment on column public.election_day_reauth_proofs.proof_hash is
  'sha256 digest (pgcrypto extensions.digest(token, ''sha256'')) of the raw 256-bit opaque token. The raw token itself is never written to any column.';

create unique index election_day_reauth_proofs_proof_hash_key
  on public.election_day_reauth_proofs (proof_hash);

create index election_day_reauth_proofs_actor_id_idx
  on public.election_day_reauth_proofs (actor_id);

-- RLS enabled, zero client policies - same precedent as
-- election_day_permission_users/election_day_roles/
-- election_day_coordinator_operations. The only access path is the
-- SECURITY DEFINER RPCs below; no grant is ever given on the table itself.
alter table public.election_day_reauth_proofs enable row level security;

-- ============================================================================
-- 1. election_day_reauth - the one-time step-up re-authentication call.
-- Same p_actor_id/p_actor_password shape and bcrypt-verify pattern as every
-- other actor-authenticated RPC in this project (see
-- election_day_reset_permission_user_password). Issues a fresh proof and
-- returns the raw token exactly once - it is never stored or logged by this
-- function, only its hash is persisted. Opportunistically deletes this
-- actor's own already-expired proof rows before inserting a new one (cheap,
-- always-available cleanup, no pg_cron dependency). Does not itself check
-- any specific permission - every privileged v2 RPC that consumes the proof
-- still runs its own permission check independently (see the companion
-- migration); this RPC only re-establishes identity/recency.
-- ============================================================================
create or replace function public.election_day_reauth(
  p_actor_id uuid,
  p_actor_password text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_password_hash text;
  v_raw_token text;
begin
  select u.password_hash into v_actor_password_hash
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  delete from public.election_day_reauth_proofs
  where actor_id = p_actor_id and expires_at < now();

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.election_day_reauth_proofs (actor_id, proof_hash, expires_at)
  values (p_actor_id, extensions.digest(v_raw_token, 'sha256'), now() + interval '15 minutes');

  return v_raw_token;
end;
$$;

comment on function public.election_day_reauth(uuid, text) is
  'Security Phase 1: step-up re-authentication. bcrypt-verifies p_actor_password against the actor''s own password_hash (UNAUTHORIZED on mismatch or missing actor - identical pattern to every other actor-authenticated RPC in this project), then issues a new opaque 256-bit proof (hex-encoded, returned exactly once), 15-minute TTL, reusable within that window. Only sha256(token) is stored; the raw token is never persisted or logged. Checks no specific permission itself - callers still must pass their own permission check inside whichever privileged v2 RPC they use the proof with. Opportunistically deletes this actor''s own already-expired proof rows before inserting.';

revoke all on function public.election_day_reauth(uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_reauth(uuid, text) to anon, authenticated;

-- ============================================================================
-- 2. election_day_verify_reauth_proof - internal helper only, never granted
-- to anon/authenticated directly (called only from inside other SECURITY
-- DEFINER function bodies in the companion migration, which therefore
-- execute this nested call as the shared owner role - same reasoning and
-- same anon/authenticated-must-be-explicitly-revoked requirement as
-- election_day_is_valid_permission/election_day_validate_role_input's own
-- internal-only grants, see 20260806100000). Derives the actor identity
-- SERVER-SIDE from the proof alone - a caller never supplies a separate,
-- independently-trusted actor_id alongside a proof (approved design:
-- proof-only actor derivation, minimizing client-controlled identity
-- fields - there is structurally no way for a client to pair a valid proof
-- for actor A with a claim about actor B, since no such field exists).
-- ============================================================================
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
  'Security Phase 1: internal helper - hashes p_proof, looks up a matching non-expired election_day_reauth_proofs row, and returns the SERVER-DERIVED actor identity {actor_id, actor_name, role_id}. Raises UNAUTHORIZED for a missing/forged/expired proof, or if the proof''s actor_id no longer resolves to an existing permission user (deleted actor - the FK cascade already removes their proofs on deletion, this re-check is defense in depth against any future change to that guarantee). Never accepts or trusts a client-supplied actor_id - identity comes exclusively from the proof itself. Not granted to anon/authenticated - callable only from inside another SECURITY DEFINER function''s body (which executes as the shared owner role), matching this project''s existing internal-helper pattern.';

revoke all on function public.election_day_verify_reauth_proof(text) from public, anon, authenticated;

-- ============================================================================
-- 3. election_day_revoke_reauth_proof - logout revocation. The proof itself
-- is the credential authorizing deletion of that exact row (never a bare
-- actor_id, per the approved design - a revoke RPC accepting only actor_id
-- would let anyone revoke anyone else's proof with zero authentication).
-- Idempotent no-op if the proof is already missing/expired/garbage, since
-- "logging out with an already-invalid proof" is not an error condition and
-- must never block or fail client-side logout.
-- ============================================================================
create or replace function public.election_day_revoke_reauth_proof(p_proof text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_proof is null or btrim(p_proof) = '' then
    return;
  end if;

  delete from public.election_day_reauth_proofs
  where proof_hash = extensions.digest(p_proof, 'sha256');
end;
$$;

comment on function public.election_day_revoke_reauth_proof(text) is
  'Security Phase 1: logout revocation - deletes exactly the proof row matching p_proof''s hash (the proof itself is the credential authorizing this delete, never a bare actor_id). Idempotent: a missing/already-expired/garbage proof is a silent no-op, never an error, so client-side logout never fails or blocks on this call regardless of network conditions.';

revoke all on function public.election_day_revoke_reauth_proof(text) from public, anon, authenticated;
grant execute on function public.election_day_revoke_reauth_proof(text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_revoke_reauth_proof(text);
--   drop function if exists public.election_day_verify_reauth_proof(text);
--   drop function if exists public.election_day_reauth(uuid, text);
--   drop table if exists public.election_day_reauth_proofs;
--   commit;
-- ============================================================================
