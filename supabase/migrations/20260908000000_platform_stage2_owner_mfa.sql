-- Platform Owner program - Stage 2: Platform Owner singleton enforcement,
-- trusted Platform Owner context resolution, and a durable, secret-free
-- MFA-recovery audit trail.
--
-- ============================================================================
-- SCOPE - strictly additive
-- ============================================================================
-- Adds exactly four things and alters nothing that already exists:
--   1. a UNIQUE expression index on public.platform_owners enforcing "at most
--      one Platform Owner row";
--   2. public.platform_resolve_owner_context(uuid) - service_role-only trusted
--      context resolution from a SERVER-VERIFIED auth_user_id;
--   3. public.platform_owner_recovery_audit - a new RLS-enabled, zero-policy
--      table recording MFA-recovery operations;
--   4. public.platform_record_recovery_audit(...) - service_role-only writer
--      for that table.
-- No existing table, column, constraint, index, policy, grant, trigger or
-- function is modified or dropped by this migration.
--
-- ============================================================================
-- WHY AN EXPRESSION INDEX AND NOT A UNIQUE CONSTRAINT / BOOLEAN-PK SINGLETON
-- ============================================================================
-- The rule "there is at most ONE Platform Owner" has no column to be unique
-- ON - it is a whole-table cardinality rule. PostgreSQL has two idioms for it:
--
--   (a) the boolean-primary-key singleton (`id boolean primary key default
--       true` + `check (id)`), which this project already uses for
--       public.multi_entity_owner and public.election_day_settings; and
--   (b) a UNIQUE index on a constant expression, `((true))`, which can hold at
--       most one row because every row indexes to the same key.
--
-- (a) is RULED OUT here. platform_owners.id is a uuid that is already the
-- target of an inbound foreign key -
-- platform_deletion_audit.deleted_by_platform_owner_id references
-- platform_owners(id) on delete set null (Phase 0, 20260823010000) - so the
-- primary key's type and values cannot be changed without rewriting that FK
-- and any audit history it points at. Unlike multi_entity_owner, this table
-- was never modelled as a singleton and cannot retroactively become one that
-- way.
--
-- So (b) it is. This MUST be `create unique index` rather than
-- `alter table ... add constraint ... unique (...)`: PostgreSQL's UNIQUE
-- table constraint accepts a column list only - there is no expression-based
-- UNIQUE constraint syntax. That is a language limitation, not a stylistic
-- choice, and it is the reason this file deviates from the constraint-first
-- preference stated in the Stage 1 migration (20260907000000). A violation
-- therefore raises SQLSTATE 23505 naming the INDEX
-- (platform_owners_singleton_idx), which is what server code should map to a
-- business error.
--
-- ============================================================================
-- COMPATIBILITY (verified read-only before authoring, not assumed)
-- ============================================================================
-- Production public.platform_owners holds EXACTLY 0 rows, RLS enabled, 0
-- policies, indexes platform_owners_pkey + platform_owners_auth_user_id_key
-- only, and no platform_* function exists yet. The unique index therefore
-- builds cleanly. That check is point-in-time and MUST be re-run immediately
-- before applying this migration - CREATE UNIQUE INDEX fails loudly (and
-- correctly) if a second Platform Owner row has appeared in the meantime.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- This project's hosted Production carries a project-level pg_default_acl
-- entry that auto-grants EXECUTE to anon and authenticated on EVERY newly
-- created function in schema public. `revoke ... from public` alone does NOT
-- undo an individually-named-role default privilege. Every function below
-- therefore revokes EXECUTE from PUBLIC, anon and authenticated BY EXACT
-- SIGNATURE and only then grants EXECUTE to service_role. After applying this
-- migration to Production, verify pg_proc.proacl there directly rather than
-- trusting any local/disposable replica result.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction.
begin;

-- ============================================================================
-- 1. Platform Owner singleton enforcement
-- ============================================================================
create unique index platform_owners_singleton_idx
  on public.platform_owners ((true));

comment on index public.platform_owners_singleton_idx is
  'Enforces the closed product rule "at most ONE Platform Owner exists at a time" in the database itself rather than in application code. Every row indexes to the same constant key (true), so a second INSERT raises SQLSTATE 23505 naming this index. Expressed as a UNIQUE INDEX and not a UNIQUE CONSTRAINT because PostgreSQL has no expression-based UNIQUE constraint syntax - a UNIQUE table constraint accepts a column list only. The boolean-primary-key singleton idiom used by public.multi_entity_owner is ruled out here: platform_owners.id is a uuid already referenced by platform_deletion_audit.deleted_by_platform_owner_id (ON DELETE SET NULL), so its type and values cannot be changed. Replacing the Platform Owner is an UPDATE of this one row, never a second INSERT.';

-- ============================================================================
-- 2. platform_resolve_owner_context - trusted Platform Owner resolution from a
-- server-verified auth_user_id. service_role-only. No caching of any kind -
-- every call re-queries platform_owners directly, so a removed/replaced
-- Platform Owner (or a valid Supabase Auth user who was never a Platform
-- Owner at all) loses/never has authority immediately, on the very next call.
-- Structural sibling of public.election_day_resolve_owner_context
-- (20260828060000).
-- ============================================================================
create or replace function public.platform_resolve_owner_context(
  p_auth_user_id uuid
)
returns table (
  platform_owner_id uuid
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
    select p.id
    from public.platform_owners p
    where p.auth_user_id = p_auth_user_id;

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$$;

comment on function public.platform_resolve_owner_context(uuid) is
  'Platform Owner Stage 2: resolves a trusted platform_owner_id from a SERVER-VERIFIED auth_user_id alone (never a client-supplied ownerId - the caller must have already verified this id via auth.getUser(jwt) in Node before calling this function). Live lookup on public.platform_owners on every call - no caching, so a replaced/removed Platform Owner and a Supabase Auth user with no platform_owners row at all both raise the same generic UNAUTHORIZED, never a distinguishing message; a NULL argument raises the identical UNAUTHORIZED. service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever.';

revoke all on function public.platform_resolve_owner_context(uuid) from public;
revoke all on function public.platform_resolve_owner_context(uuid) from anon;
revoke all on function public.platform_resolve_owner_context(uuid) from authenticated;
grant execute on function public.platform_resolve_owner_context(uuid) to service_role;

-- ============================================================================
-- 3. platform_owner_recovery_audit - durable record of Platform Owner MFA
-- recovery operations. Deliberately minimal and SECRET-FREE.
-- ============================================================================
create table public.platform_owner_recovery_audit (
  id                uuid primary key default gen_random_uuid(),
  platform_owner_id uuid references public.platform_owners(id) on delete set null,
  auth_user_id      uuid not null,
  factor_ids        text[] not null default '{}',
  reason            text,
  performed_by      text not null,
  performed_at      timestamptz not null default now()
);

comment on table public.platform_owner_recovery_audit is
  'Durable audit trail of Platform Owner MFA-recovery operations. MUST NEVER contain a TOTP secret, a TOTP/recovery code, a service-role key, a password or a password hash, a JWT, or any PII beyond what is recorded here. factor_ids holds Supabase Auth FACTOR IDs only - opaque identifiers of the factors that were removed/reset, never the factor secrets themselves. performed_by is a free-text operator label (e.g. an OS username or an operations ticket reference), never a credential. platform_owner_id is ON DELETE SET NULL so the audit row survives the Platform Owner it describes; auth_user_id is deliberately NOT a foreign key, for the same reason - it is a snapshot that must outlive the auth.users row. RLS-enabled, zero policies: all access goes through SECURITY DEFINER RPCs or server-side service_role code.';

comment on column public.platform_owner_recovery_audit.factor_ids is
  'Supabase Auth MFA factor IDs affected by the recovery. Opaque identifiers ONLY - never a TOTP secret, never a recovery code.';

comment on column public.platform_owner_recovery_audit.performed_by is
  'Free-text operator label identifying who performed the recovery (e.g. an OS username or ticket reference). Never a credential of any kind.';

comment on column public.platform_owner_recovery_audit.auth_user_id is
  'Snapshot of the recovered Platform Owner''s Supabase Auth user id. Deliberately NOT a foreign key so the audit row survives deletion of the auth.users row it describes.';

alter table public.platform_owner_recovery_audit enable row level security;
-- Deliberately no CREATE POLICY here, matching every other sensitive table in
-- this project: RLS-enabled with zero policies denies all direct
-- anon/authenticated access.

-- Defence in depth on top of RLS. This project's hosted instance carries an
-- ambient pg_default_acl that auto-grants table privileges to anon and
-- authenticated on newly created tables (the same hazard class as the
-- function one handled above). RLS with zero policies already denies those
-- roles - verified empirically - but a single future CREATE POLICY, or any
-- accidental `alter table ... disable row level security`, would silently
-- turn those ambient grants into real read/write access on an AUDIT table.
-- Revoking them by name removes that latent second failure mode entirely and
-- matches the stricter precedent already set by election_owner_reauth_proofs
-- in migration 20260828060000.
revoke all on table public.platform_owner_recovery_audit from public;
revoke all on table public.platform_owner_recovery_audit from anon;
revoke all on table public.platform_owner_recovery_audit from authenticated;

-- ============================================================================
-- 4. platform_record_recovery_audit - the sole writer for the table above.
-- service_role-only.
-- ============================================================================
create or replace function public.platform_record_recovery_audit(
  p_platform_owner_id uuid,
  p_auth_user_id uuid,
  p_factor_ids text[],
  p_reason text,
  p_performed_by text
)
returns uuid
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  v_id uuid;
begin
  insert into public.platform_owner_recovery_audit (
    platform_owner_id,
    auth_user_id,
    factor_ids,
    reason,
    performed_by
  )
  values (
    p_platform_owner_id,
    p_auth_user_id,
    coalesce(p_factor_ids, '{}'::text[]),
    p_reason,
    p_performed_by
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.platform_record_recovery_audit(uuid, uuid, text[], text, text) is
  'Platform Owner Stage 2: writes exactly one public.platform_owner_recovery_audit row and returns its id. Callers MUST pass Supabase Auth factor IDs in p_factor_ids - never a TOTP secret or recovery code - and a plain operator label in p_performed_by, never a credential; see that table''s own comment for the full prohibition. A NULL p_factor_ids is normalised to an empty array so the column''s NOT NULL never surfaces as a caller-visible error. service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever.';

revoke all on function public.platform_record_recovery_audit(uuid, uuid, text[], text, text) from public;
revoke all on function public.platform_record_recovery_audit(uuid, uuid, text[], text, text) from anon;
revoke all on function public.platform_record_recovery_audit(uuid, uuid, text[], text, text) from authenticated;
grant execute on function public.platform_record_recovery_audit(uuid, uuid, text[], text, text) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down". Reverses this migration exactly and touches nothing else - Phase 0's
-- platform_owners definition, its RLS state and its trigger are all left as
-- they were, because this migration never changed them):
--
--   begin;
--   drop function if exists public.platform_record_recovery_audit(uuid, uuid, text[], text, text);
--   drop table if exists public.platform_owner_recovery_audit;
--   drop function if exists public.platform_resolve_owner_context(uuid);
--   drop index if exists public.platform_owners_singleton_idx;
--   commit;
-- ============================================================================
