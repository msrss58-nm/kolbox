-- Multi-Tenant Program - Phase 0: Platform Foundation (Expand only).
--
-- ============================================================================
-- SCOPE - strictly additive, zero interaction with any existing table
-- ============================================================================
-- This migration creates the brand-new platform-level tables the approved
-- Multi-Tenant architecture needs (Platform Owner / Election Workspace /
-- Election Owner / Multi-Entity Owner), and nothing else. It does NOT touch
-- any existing election_day_* table, does NOT add a workspace_id column
-- anywhere yet (that is Phase 1), does NOT create any RPC, does NOT change
-- any existing RLS policy or grant, and does NOT create a real workspace or
-- any real Owner/Platform Owner/Multi-Entity Owner row - every table below
-- starts empty. The existing single-tenant Election Day application is
-- completely unaffected by this migration; it never queries any table
-- created here.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction - without this wrapper, a failure partway through could leave
-- a subset of these 7 tables created and the rest missing.
--
-- ============================================================================
-- DESIGN NOTES (read before extending in a later phase)
-- ============================================================================
-- 1. Lifecycle status is DERIVED, never stored. election_workspaces has no
--    status/deleted_at/is_active column - per the approved architecture,
--    "ACTIVE" is defined purely as "election_end_at has not yet been
--    reached" and the post-END deletion-review labels are themselves derived
--    from how much time has passed since election_end_at. Storing a
--    redundant status column here would create a second source of truth that
--    could drift from the timestamp it's supposed to represent.
--
-- 2. No password/credential material anywhere in this migration. Platform
--    Owner, Election Owner, and Multi-Entity Owner all authenticate via
--    Supabase Auth (auth.users) - every one of the 4 identity tables below
--    stores only `auth_user_id uuid references auth.users(id)`, never a
--    password or password hash. This is the first migration in this project
--    to reference auth.users at all (confirmed via full-history grep before
--    writing this file: zero prior references) - a standard, supported
--    Supabase pattern.
--
-- 3. election_workspace_pending_owner_access carries NO password field of
--    any kind, by explicit product requirement. The temporary password for
--    a new Owner's first login exists ONLY inside Supabase Auth (set via the
--    Admin API at the same moment this row's auth_user_id account is
--    created, in a future phase's Server Function) - this table's only job
--    is to track that a not-yet-onboarded Auth account exists and is
--    waiting for its 7-day window to either be consumed (the Owner logs in
--    and confirms their workspace) or expire (a future phase's cleanup job
--    deletes both the Auth account via the Admin API and this row). It does
--    NOT carry a workspace_id - per explicit product instruction, no
--    workspace is created merely by creating pending access; workspace
--    creation happens later, atomically, as part of the first-login
--    confirmation flow (a future phase's RPC/Server Function), at which
--    point this row is deleted (its job is done) rather than updated.
--
--    `status` is a deliberate, explicitly-requested exception to Design Note
--    1's "never store a derived value" rule: every one of its 3 values is
--    technically derivable from expires_at/consumed_at alone (consumed iff
--    consumed_at is not null; expired iff consumed_at is null and expires_at
--    has passed; pending otherwise), so it CAN drift from those columns if a
--    future expiry-cleanup job runs late - a 'pending' row whose expires_at
--    has already passed is real, expected drift until that job catches up,
--    not a bug. Kept anyway because it was explicitly named in the approved
--    field list and gives cheap, indexed, driftless-at-write-time
--    filterability for that future cleanup job's query. Any future RPC/Server
--    Function must treat expires_at/consumed_at as authoritative and update
--    status to match, never the reverse.
--
-- 4. `email`/`name`/`phone` are stored locally (not just in auth.users) on
--    platform_owners / election_owners / multi_entity_owner as ordinary,
--    non-secret display/business metadata - e.g. so "who deleted this
--    workspace" or "who is the representative Owner" can be answered without
--    an Admin API round-trip. Supabase Auth remains the source of truth for
--    the *credential* (password) and for email-as-login-identity; keeping
--    these fields in sync on any future email/name/phone change is a
--    guarded RPC/Server Function's job in a later phase, not something this
--    schema-only migration enforces. Flagged here deliberately so this
--    assumption is visible, not silently baked in.
--
-- 5. multi_entity_owner is modeled as a true singleton using the exact same
--    `id boolean primary key default true` + `check (id)` idiom this
--    project already uses for election_day_settings (see
--    20260803174712_election_day_core_tables.sql) - here the singleton
--    cardinality genuinely matches the product rule ("exactly ONE
--    Multi-Entity Owner exists at a time"), unlike election_day_settings'
--    own use of that idiom, which turned out to need to become per-workspace
--    later (see the Multi-Tenant audit). "Replacing" the Multi-Entity Owner
--    is therefore a plain UPDATE of this one row's auth_user_id/name/phone/
--    email, never a delete+insert - which is exactly what makes
--    multi_entity_assignments (keyed only by workspace_id, with no owner-id
--    column at all) "automatically inherit" to a replacement owner for
--    free, with no data migration needed on replacement.
--
-- 6. Every table is RLS-enabled with ZERO policies, matching this project's
--    own established pattern for every other sensitive table
--    (election_day_permission_users, election_day_roles,
--    election_day_reauth_proofs, etc.) - RLS-enabled-with-zero-policies
--    denies all direct anon/authenticated access regardless of table-level
--    GRANTs. No GRANT statement of any kind appears in this migration -
--    there is no RPC yet that would need one; every future read/write goes
--    through a SECURITY DEFINER RPC or a Vercel Server Function using
--    service_role, built in a later phase.
--
-- 7. Business rules that are NOT schema constraints are deliberately NOT
--    enforced here (correct for a schema-only Phase 0): "Owner cannot delete
--    self", "last remaining Owner can never be deleted", "representative
--    Owner is the oldest remaining" (a pure derived ORDER BY created_at
--    query, needs no extra column), MFA enforcement for Platform Owner
--    (enforced via Supabase Auth's own MFA APIs, not a local boolean flag -
--    deliberately not duplicated here to avoid a second, driftable source of
--    truth). These all belong to the RPC/business-logic phase, not this one.
begin;

-- ============================================================================
-- 1. platform_owners
-- ============================================================================
create table public.platform_owners (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.platform_owners is
  'Platform-level administrators. One row per Supabase Auth account (auth_user_id), never a password/credential of any kind - Supabase Auth (with mandatory MFA, enforced via its own APIs, not a local flag) is the sole authentication mechanism. RLS-enabled, zero policies - every access path is a future SECURITY DEFINER RPC or server-side Server Function.';

alter table public.platform_owners enable row level security;
-- Deliberately no CREATE POLICY here, matching every other sensitive table
-- in this project: RLS-enabled with zero policies denies all direct
-- anon/authenticated access. No RPC exists yet in this Phase-0-only
-- migration to grant EXECUTE on.

-- ============================================================================
-- 2. election_workspaces
-- ============================================================================
create table public.election_workspaces (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  election_end_at timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.election_workspaces is
  'One row per Election Day workspace (the future "Customer Account" unit). No status/is_active/deleted_at column by design - ACTIVE is defined purely as "election_end_at has not yet been reached", and every later Multi-Tenant table hangs off this table via workspace_id ON DELETE CASCADE, which is what makes a future Hard Delete a single DELETE FROM election_workspaces. RLS-enabled, zero policies.';

alter table public.election_workspaces enable row level security;

-- ============================================================================
-- 3. election_workspace_pending_owner_access
-- ============================================================================
create table public.election_workspace_pending_owner_access (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text not null,
  status       text not null default 'pending'
                 check (status in ('pending', 'consumed', 'expired')),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint election_workspace_pending_owner_access_consumed_at_check
    check ((status = 'consumed') = (consumed_at is not null))
);

comment on table public.election_workspace_pending_owner_access is
  'A not-yet-onboarded Owner Auth account, waiting for its 7-day window to either be consumed (first login + workspace-details confirmation, in a future phase) or expire (cleanup deletes both the auth.users row via the Admin API and this row). NO password/password_hash column - the temporary password lives exclusively in Supabase Auth, set at the same moment auth_user_id is created. NO workspace_id column - creating pending access must never create a workspace; that happens later, atomically, in the first-login confirmation flow, at which point this row is deleted rather than updated. RLS-enabled, zero policies.';

alter table public.election_workspace_pending_owner_access enable row level security;

-- ============================================================================
-- 4. election_owners
-- ============================================================================
create table public.election_owners (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.election_workspaces(id) on delete cascade,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index election_owners_workspace_id_idx on public.election_owners (workspace_id);

comment on table public.election_owners is
  'Election Owners - a separate system principal, not a dynamic role, exactly per the approved architecture. Multiple equal Owners may exist per workspace_id; "representative Owner" is a pure derived query (oldest remaining, ORDER BY created_at), no extra column needed. auth_user_id is unique - the same real person/account is never shared across two Election Days, matching the approved architecture directly. "Owner cannot delete self" / "last remaining Owner can never be deleted" are business rules enforced by a future RPC, not a schema constraint. RLS-enabled, zero policies.';

alter table public.election_owners enable row level security;

-- ============================================================================
-- 5. multi_entity_owner - true singleton (at most 1 row, matching the actual
-- product cardinality: "exactly ONE Multi-Entity Owner exists at a time").
-- ============================================================================
create table public.multi_entity_owner (
  id           boolean primary key default true,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint multi_entity_owner_singleton check (id)
);

comment on table public.multi_entity_owner is
  'At most one row, enforced by the boolean primary key (same singleton idiom this project already uses for election_day_settings). "Replacing" the Multi-Entity Owner is a plain UPDATE of this one row (auth_user_id/name/phone/email) in a future phase''s RPC, never a delete+insert - this is what makes multi_entity_assignments automatically carry over to a replacement with zero data migration. RLS-enabled, zero policies.';

alter table public.multi_entity_owner enable row level security;

-- ============================================================================
-- 6. multi_entity_assignments
-- ============================================================================
create table public.multi_entity_assignments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.election_workspaces(id) on delete cascade,
  assigned_at  timestamptz not null default now()
);

comment on table public.multi_entity_assignments is
  'Which workspaces the (single) Multi-Entity Owner can see. Deliberately carries no owner-id column at all - multi_entity_owner is a true singleton, so this row''s mere existence means "assigned to whoever currently holds that singleton", which is exactly what makes a Multi-Entity Owner replacement inherit assignments automatically. "Removing assignment only removes visibility" (a future RPC deletes the row here; election_workspaces itself is untouched). UNIQUE(workspace_id) - a workspace can be assigned at most once. RLS-enabled, zero policies.';

alter table public.multi_entity_assignments enable row level security;

-- ============================================================================
-- 7. platform_deletion_audit
-- ============================================================================
create table public.platform_deletion_audit (
  id                           uuid primary key default gen_random_uuid(),
  workspace_id_snapshot        uuid not null,
  workspace_name_snapshot      text not null,
  deleted_by_platform_owner_id uuid references public.platform_owners(id) on delete set null,
  deleted_at                   timestamptz not null default now(),
  reason                       text
);

create index platform_deletion_audit_workspace_id_snapshot_idx
  on public.platform_deletion_audit (workspace_id_snapshot);

comment on table public.platform_deletion_audit is
  'Minimal, permanent record of every Hard Delete, written by a future phase''s deletion RPC in the same DB transaction that deletes the election_workspaces row. workspace_id_snapshot is deliberately NOT a foreign key - the referenced workspace no longer exists by the time this audit row is queried back, exactly like this project''s existing *_name_snapshot columns on election_day_coordinator_operations. Survives the workspace it describes, indefinitely - never deleted, never touched by any workspace-scoped cascade. RLS-enabled, zero policies.';

alter table public.platform_deletion_audit enable row level security;

-- ============================================================================
-- 8. Shared updated_at trigger reuse (existing generic function, unmodified)
-- ============================================================================
create trigger platform_owners_set_updated_at
  before update on public.platform_owners
  for each row execute function public.election_day_set_updated_at();

create trigger election_workspaces_set_updated_at
  before update on public.election_workspaces
  for each row execute function public.election_day_set_updated_at();

create trigger election_owners_set_updated_at
  before update on public.election_owners
  for each row execute function public.election_day_set_updated_at();

create trigger multi_entity_owner_set_updated_at
  before update on public.multi_entity_owner
  for each row execute function public.election_day_set_updated_at();

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop table if exists public.platform_deletion_audit;
--   drop table if exists public.multi_entity_assignments;
--   drop table if exists public.multi_entity_owner;
--   drop table if exists public.election_owners;
--   drop table if exists public.election_workspace_pending_owner_access;
--   drop table if exists public.election_workspaces;
--   drop table if exists public.platform_owners;
--   commit;
-- ============================================================================
