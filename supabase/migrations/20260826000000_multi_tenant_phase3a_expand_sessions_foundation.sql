-- Multi-Tenant Phase 3A - EXPAND step: durable schema foundation for
-- trusted PermissionUser sessions. WRITTEN ONLY - not applied anywhere as
-- of this migration file's authoring; a separate, explicit approval is
-- required before `supabase db push` (local or `--linked`) runs it.
--
-- Scope, exactly as approved:
--   1. UNIQUE (workspace_id, id) on election_day_permission_users - the
--      composite-FK target every session/reauth-proof row will point at.
--      Deliberately does NOT set workspace_id NOT NULL - the still-live
--      legacy election_day_create_permission_user / _v2 INSERT paths omit
--      workspace_id (verified against their current function bodies below),
--      so rows keep landing with workspace_id = NULL until a later,
--      separate ENFORCE-phase migration cuts those paths over. This is
--      always safe to add regardless: (workspace_id, id) is unique for
--      every possible value of workspace_id, including NULL, because `id`
--      alone is already unique (it is the table's PK) - the composite
--      constraint can never reject a row that PK uniqueness didn't already
--      guarantee was distinct.
--   2. election_day_sessions - a brand new, empty table. No RPC in this
--      repository reads or writes it yet; this migration only lays down
--      its shape.
--   3. election_day_login_attempts - schema-only foundation for the
--      approved Postgres-backed login rate-limit design. The counting/
--      throttling algorithm itself (and the RPC that would use it) is a
--      separate, later piece of work, not part of this migration.
--   4. election_day_reauth_proofs gets one genuinely new column (`action`)
--      plus a new composite FK. Its `workspace_id` column already exists
--      (added by 20260823020000_multi_tenant_phase1_workspace_id_columns,
--      nullable, single-column FK to election_workspaces(id)) - this
--      migration does not re-add it, only adds the new composite FK
--      constraint alongside the pre-existing single-column one. Postgres
--      allows a column to participate in more than one FK constraint
--      simultaneously; both are enforced independently.
--
-- Explicitly OUT of scope for this migration (later, separate work):
-- permission_users.workspace_id SET NOT NULL, election_day_settings
-- redesign, any session/login/reauth RPC (resolve_session, login_v2,
-- reauth_v3, etc.), any Vercel Server Function, RLS changes on any
-- existing table, retirement of any existing RPC, and any Phase 3b
-- constraint beyond the one UNIQUE this migration adds.
--
-- Legacy-compatibility proof (see the accompanying report for the full
-- per-callsite walk-through against each function's current, live body):
--   - election_day_create_permission_user(text,text,uuid) and
--     election_day_create_permission_user_v2(text,text,text,uuid) both
--     `insert into election_day_permission_users (name, password_hash,
--     role_id) values (...)` - three columns, never workspace_id. Adding
--     UNIQUE (workspace_id, id) does not require these INSERTs to supply
--     any additional column; unlisted columns keep taking their existing
--     defaults/NULL exactly as today.
--   - election_day_delete_permission_user(uuid) and
--     _v2(text,uuid) both `delete from election_day_permission_users
--     where id = ...` - unchanged validity; the new composite FKs from
--     election_day_sessions/election_day_reauth_proofs only add cascade
--     behavior for rows in those (currently nonexistent-data) tables that
--     reference the deleted user, which is zero rows for every existing
--     account today.
--   - election_day_login(text,text) only SELECTs password_hash - untouched
--     by any change in this migration.
--   - election_day_reauth(uuid,text) `insert into election_day_reauth_proofs
--     (actor_id, proof_hash, expires_at) values (...)` - three columns,
--     never workspace_id or the new `action` column. Both stay nullable,
--     so this INSERT is unaffected; the new composite FK on
--     (workspace_id, actor_id) is a MATCH SIMPLE foreign key (Postgres
--     default), meaning any row with a NULL in either FK column is exempt
--     from the check entirely - every existing reauth_proofs row (and every
--     row this unmodified RPC will keep inserting) has workspace_id = NULL
--     today, so the new constraint cannot reject it.
--   - election_day_verify_reauth_proof(text) / election_day_
--     revoke_reauth_proof(text) only SELECT/DELETE by proof_hash - untouched.
--
-- ACL: election_day_sessions and election_day_login_attempts start from
-- this project's own established, already-verified baseline for
-- "RPC-only, zero client access" tables (election_day_permission_users/
-- election_day_roles/election_day_reauth_proofs/election_day_
-- coordinator_operations, etc.): RLS enabled, zero policies created. With
-- RLS enabled and no policy, Postgres denies every row to every role that
-- lacks BYPASSRLS - anon and authenticated both lack it - regardless of
-- any table-level GRANT (a repo-wide grep for `revoke ... on table` /
-- `grant ... on table` across every PRE-EXISTING migration in this project
-- returns zero matches - none of those precedent tables carry an explicit
-- table-level REVOKE, RLS alone has always been sufficient for them).
--
-- This migration goes one step further for these two NEW tables, at
-- explicit request: each also carries an explicit `REVOKE ALL ... FROM
-- PUBLIC, anon, authenticated` immediately after RLS is enabled - table
-- privileges (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER),
-- not RLS policies. This is defense-in-depth, not a fix for a demonstrated
-- gap: RLS-with-zero-policies already blocks every row for anon/
-- authenticated by itself. It directly mirrors this project's own
-- Permanent Engineering Guardrail (CLAUDE.md, added after the historical
-- Backfill-RPC privilege-escalation incident) of never relying on a bare
-- `REVOKE ... FROM PUBLIC` alone and always naming `anon`/`authenticated`
-- explicitly - that guardrail was written for FUNCTION EXECUTE privileges
-- specifically (a Production-only pg_default_acl surprise granted EXECUTE
-- to those roles on every new function regardless of a bare PUBLIC
-- revoke), but the same "name every role explicitly, do not assume a
-- default-privilege posture" discipline applies equally well to TABLE
-- privileges on these two new, especially sensitive tables. No sequence
-- privileges are revoked because none are relevant here: neither table
-- uses a serial/bigserial/IDENTITY column (both `id` columns are
-- `uuid default gen_random_uuid()`, and `attempt_count`'s default is a
-- plain integer literal), so no Postgres sequence object is created or
-- owned by either table.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner
-- pipelines a file's statements via wire-protocol batching, not an
-- implicit transaction.
begin;

-- ============================================================================
-- 1. election_day_permission_users - composite-FK target.
-- ============================================================================
alter table public.election_day_permission_users
  add constraint election_day_permission_users_workspace_id_id_key
    unique (workspace_id, id);

comment on constraint election_day_permission_users_workspace_id_id_key
  on public.election_day_permission_users is
  'Phase 3A EXPAND: composite-FK target for election_day_sessions/election_day_reauth_proofs. Deliberately not paired with workspace_id NOT NULL yet - see this migration''s header comment. Always satisfiable regardless of workspace_id''s value (including NULL) because id alone is already unique via the primary key.';

-- ============================================================================
-- 2. election_day_sessions - durable server-side session record for the
-- approved trusted-workspace-context architecture. Only a sha256 hash of
-- the opaque session token is ever stored (token_hash) - the raw token is
-- never persisted here, mirroring election_day_reauth_proofs.proof_hash's
-- own precedent. No revoked_at column: revocation is a physical DELETE of
-- the row, same reasoning as reauth_proofs (a deleted row is unambiguously
-- invalid - simpler than a soft-revoke flag every verification would
-- otherwise have to check). No sliding-expiry field: expires_at is a fixed
-- absolute deadline set once at issuance, not extended on use.
-- ============================================================================
create table public.election_day_sessions (
  id                  uuid primary key default gen_random_uuid(),
  permission_user_id  uuid not null,
  workspace_id        uuid not null,
  token_hash          bytea not null unique,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  constraint election_day_sessions_workspace_permission_user_fkey
    foreign key (workspace_id, permission_user_id)
    references public.election_day_permission_users (workspace_id, id)
    on delete cascade
    on update restrict
);

comment on table public.election_day_sessions is
  'Phase 3A: durable server-side PermissionUser session. Only sha256(raw token) is ever stored (token_hash) - the raw token itself is never written to any column, matching election_day_reauth_proofs.proof_hash''s precedent. A row''s existence with expires_at > now() IS validity - revocation (logout, password reset, account deletion via the FK cascade) is a physical DELETE, never a soft-revoke flag. workspace_id is NOT NULL on this table itself even though it is still nullable on election_day_permission_users during EXPAND - a session can only ever be created once the composite FK below has a non-null (workspace_id, id) pair on the referenced user to point at. No RPC in this repository reads or writes this table yet; that is separate, later work.';

comment on column public.election_day_sessions.token_hash is
  'sha256 digest of the raw opaque session token, computed by the caller (a Vercel Server Function, per the approved design) BEFORE this table is ever touched - Postgres never receives or handles the raw token for this credential. Unique: a hash collision would otherwise let one token resolve two sessions.';

create index election_day_sessions_permission_user_id_idx
  on public.election_day_sessions (permission_user_id);

comment on index public.election_day_sessions_permission_user_id_idx is
  'Supports the FK''s cascade-delete lookup and a future "list/revoke this user''s sessions" query. Postgres does not automatically index the referencing side of a foreign key, only the referenced side - without this, every election_day_permission_users delete would force a sequential scan here.';

alter table public.election_day_sessions enable row level security;

-- Deliberately no CREATE POLICY here - same precedent and same reasoning
-- as election_day_permission_users/election_day_reauth_proofs: RLS
-- enabled with zero policies denies every direct anon/authenticated
-- access by default. All access will go through SECURITY DEFINER RPCs
-- added in a later, separate migration - none exist yet.

revoke all on table public.election_day_sessions from public;
revoke all on table public.election_day_sessions from anon;
revoke all on table public.election_day_sessions from authenticated;

-- ============================================================================
-- 3. election_day_login_attempts - schema-only foundation for the approved
-- Postgres-backed fixed-window login rate limit. The counting/throttling
-- algorithm and the RPC that would use it are explicitly NOT part of this
-- migration - see this file's header comment.
-- ============================================================================
create table public.election_day_login_attempts (
  id             uuid primary key default gen_random_uuid(),
  bucket_key     text not null,
  window_start   timestamptz not null,
  attempt_count  integer not null default 1,
  constraint election_day_login_attempts_bucket_window_key
    unique (bucket_key, window_start)
);

comment on table public.election_day_login_attempts is
  'Phase 3A: schema-only foundation for a Postgres-backed fixed-window login rate limit (bucket_key examples per the approved design: "name:<name>", "ip:<ip>"). No RPC reads or writes this table yet - the counting/throttling algorithm is separate, later work.';

create index election_day_login_attempts_window_start_idx
  on public.election_day_login_attempts (window_start);

comment on index public.election_day_login_attempts_window_start_idx is
  'Supports an expiry/cleanup sweep query (e.g. delete rows older than the current rate-limit window) once the rate-limit RPC exists.';

alter table public.election_day_login_attempts enable row level security;

-- Deliberately no CREATE POLICY here - same precedent as every other
-- RPC-only table in this schema (see the header comment's ACL note).

revoke all on table public.election_day_login_attempts from public;
revoke all on table public.election_day_login_attempts from anon;
revoke all on table public.election_day_login_attempts from authenticated;

-- ============================================================================
-- 4. election_day_reauth_proofs EXPAND - one new nullable column (`action`)
-- plus a new composite FK alongside the pre-existing single-column
-- workspace_id -> election_workspaces(id) FK (added by
-- 20260823020000_multi_tenant_phase1_workspace_id_columns). Both
-- workspace_id and action stay nullable, so the existing, unmodified
-- election_day_reauth/election_day_verify_reauth_proof/election_day_
-- revoke_reauth_proof functions remain fully compatible - see this file's
-- header comment for the exact INSERT-column proof.
-- ============================================================================
alter table public.election_day_reauth_proofs
  add column action text null;

comment on column public.election_day_reauth_proofs.action is
  'Phase 3A: reserved for a future action-bound reauth design (a proof scoped to one specific privileged operation, not reusable across all of them). Nullable and unused by every current reauth function - not read or written by anything in this migration.';

alter table public.election_day_reauth_proofs
  add constraint election_day_reauth_proofs_workspace_actor_fkey
    foreign key (workspace_id, actor_id)
    references public.election_day_permission_users (workspace_id, id)
    on delete cascade
    on update restrict;

comment on constraint election_day_reauth_proofs_workspace_actor_fkey
  on public.election_day_reauth_proofs is
  'Phase 3A: composite FK alongside the pre-existing single-column workspace_id -> election_workspaces(id) FK (unchanged, still present). MATCH SIMPLE (Postgres default): a row with a NULL in either workspace_id or actor_id is exempt from this check - every row election_day_reauth inserts today has workspace_id = NULL, so this constraint cannot reject any existing or newly-inserted proof while that function is unmodified.';

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   alter table public.election_day_reauth_proofs drop constraint if exists election_day_reauth_proofs_workspace_actor_fkey;
--   alter table public.election_day_reauth_proofs drop column if exists action;
--   drop table if exists public.election_day_login_attempts;
--   drop table if exists public.election_day_sessions;
--   alter table public.election_day_permission_users drop constraint if exists election_day_permission_users_workspace_id_id_key;
--   commit;
-- ============================================================================
