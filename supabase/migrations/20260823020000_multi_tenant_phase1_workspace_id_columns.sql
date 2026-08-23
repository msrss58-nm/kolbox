-- Multi-Tenant Phase 1 (Expand step): additive workspace_id columns on
-- every existing Election-Day-scoped table.
--
-- Scope, exactly as approved: add a NULLABLE workspace_id uuid, FK'd to
-- public.election_workspaces(id), to each of the 12 existing
-- election_day_* tables. Nothing else. No backfill, no NOT NULL, no RLS
-- policy change, no RPC change, no frontend/session/auth change, no
-- second real workspace, no existing behavior change of any kind - this
-- migration is pure schema preparation for the eventual Phase 2 backfill.
-- Every application code path today still reads/writes these tables with
-- no awareness of workspace_id at all, so a column that is always NULL
-- until Phase 2 changes nothing observable.
--
-- Design notes:
--
-- 1. ON DELETE CASCADE (not SET NULL, not RESTRICT) on every FK, matching
--    Phase 0's own election_owners/multi_entity_assignments choice - this
--    is the correct END-STATE semantics for the approved Hard Delete
--    model (deleting a workspace must remove all of its scoped data), even
--    though today, with every workspace_id still NULL, no row is actually
--    scoped to any workspace and this cascade can never fire in practice.
--
-- 2. election_day_settings is the one table needing special care (see the
--    approved B3 dependency plan): it is a Postgres singleton table today
--    (`id boolean primary key default true` + a CHECK forcing id = true),
--    so it can only ever hold exactly one row, campaign-wide. Adding a
--    nullable workspace_id column here is still purely additive and safe
--    - it does NOT change the singleton PK/CHECK, does NOT add a second
--    row, and does NOT attempt the real per-workspace conversion (which
--    requires replacing the boolean PK with a proper workspace_id-based
--    key, and is Phase 2's job, not Phase 1's). The existing single
--    settings row simply gains a NULL workspace_id like every other row
--    in every other table this migration touches.
--
-- 3. election_day_coordinator_operation_items gets its own workspace_id
--    (not left to be inferred via a join to its parent
--    election_day_coordinator_operations row) so that a future RLS policy
--    can scope it directly without a join - the same denormalize-for-RLS
--    reasoning already used elsewhere in this schema (e.g. contact_name/
--    coordinator on election_day_ride_status_events).
--
-- 4. election_day_reauth_proofs is actor-bound (per PermissionUser), not
--    an object with its own natural workspace membership - it still gets
--    workspace_id for the same direct-RLS-scoping reason as note 3, since
--    the approved architecture states every Election-Day-scoped record
--    gets workspace_id, not just per-voter data.
--
-- 5. election_day_roles currently holds both built-in and custom roles
--    with no per-workspace distinction (Phase 3 of Dynamic Roles removed
--    the last legacy/built-in marking - "every role is an ordinary row").
--    Whether built-in roles end up workspace_id = NULL (shared/global) or
--    duplicated per workspace is an explicit Phase 2 backfill decision,
--    not decided here - Phase 1 only adds the column.

begin;

alter table public.election_day_voters
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_voters_workspace_id_idx
  on public.election_day_voters (workspace_id);

alter table public.election_day_ride_status_events
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_ride_status_events_workspace_id_idx
  on public.election_day_ride_status_events (workspace_id);

alter table public.election_day_ride_coordinators
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_ride_coordinators_workspace_id_idx
  on public.election_day_ride_coordinators (workspace_id);

alter table public.election_day_settings
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_settings_workspace_id_idx
  on public.election_day_settings (workspace_id);

alter table public.election_day_permission_users
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_permission_users_workspace_id_idx
  on public.election_day_permission_users (workspace_id);

alter table public.election_day_coordinators
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_coordinators_workspace_id_idx
  on public.election_day_coordinators (workspace_id);

alter table public.election_day_coordinator_operations
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_coordinator_operations_workspace_id_idx
  on public.election_day_coordinator_operations (workspace_id);

alter table public.election_day_coordinator_operation_items
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_coordinator_operation_items_workspace_id_idx
  on public.election_day_coordinator_operation_items (workspace_id);

alter table public.election_day_roles
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_roles_workspace_id_idx
  on public.election_day_roles (workspace_id);

alter table public.election_day_not_voting_reasons
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_not_voting_reasons_workspace_id_idx
  on public.election_day_not_voting_reasons (workspace_id);

alter table public.election_day_reminder_events
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_reminder_events_workspace_id_idx
  on public.election_day_reminder_events (workspace_id);

alter table public.election_day_reauth_proofs
  add column if not exists workspace_id uuid null
    references public.election_workspaces(id) on delete cascade;
create index if not exists election_day_reauth_proofs_workspace_id_idx
  on public.election_day_reauth_proofs (workspace_id);

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this migration
-- needs to be reversed; Supabase CLI migrations have no automatic "down"):
--
--   alter table public.election_day_reauth_proofs drop column if exists workspace_id;
--   alter table public.election_day_reminder_events drop column if exists workspace_id;
--   alter table public.election_day_not_voting_reasons drop column if exists workspace_id;
--   alter table public.election_day_roles drop column if exists workspace_id;
--   alter table public.election_day_coordinator_operation_items drop column if exists workspace_id;
--   alter table public.election_day_coordinator_operations drop column if exists workspace_id;
--   alter table public.election_day_coordinators drop column if exists workspace_id;
--   alter table public.election_day_permission_users drop column if exists workspace_id;
--   alter table public.election_day_settings drop column if exists workspace_id;
--   alter table public.election_day_ride_coordinators drop column if exists workspace_id;
--   alter table public.election_day_ride_status_events drop column if exists workspace_id;
--   alter table public.election_day_voters drop column if exists workspace_id;
-- ============================================================================
