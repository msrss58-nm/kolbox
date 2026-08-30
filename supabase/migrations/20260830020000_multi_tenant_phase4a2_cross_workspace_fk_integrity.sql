-- Multi-Tenant Phase 4A.2: cross-workspace relationship integrity.
--
-- Closes the composite-FK gap flagged during Phase 4 scoping: 6 FK
-- relationships had a bare single-column FK plus an independent
-- workspace_id column on each side, with no DB-level guarantee the two
-- sides agree on workspace - a row in workspace A could, in principle,
-- reference a row in workspace B. Fixes this by ADDING a composite FK
-- `(workspace_id, <id column>)` alongside each existing single-column FK
-- (never dropping the original - matches this project's own established
-- precedent, election_day_reauth_proofs_workspace_actor_fkey /
-- election_day_sessions_workspace_permission_user_fkey, 20260826000000).
-- The composite FK is the one that actually does new work; the original
-- single-column FK becomes logically redundant (implied whenever the
-- composite is satisfied) but is left in place - dropping it is not
-- necessary for this migration's goal and would be needless extra risk.
--
-- ============================================================================
-- PREFLIGHT (read-only, against linked Production, immediately before
-- authoring this migration) - 0 mismatches on every relationship, so this
-- migration needs zero data backfill:
-- ============================================================================
--   permission_users.role_id -> roles:                        0/8 mismatched
--   coordinator_operations.executed_by_id -> permission_users: 0/3 mismatched
--   coordinator_operations.subject_coordinator_id -> coordinators: 0/1 mismatched
--   coordinator_operation_items.to_coordinator_id -> coordinators: 0/30 mismatched
--   coordinator_operation_items.from_coordinator_id -> coordinators: 0/30 mismatched
--   coordinator_operation_items.voter_id -> voters:            0/30 mismatched
--
-- ============================================================================
-- CRITICAL DESIGN NOTE - why 3 of these composite FKs use
-- `ON DELETE SET NULL (<col>)`, not plain `ON DELETE SET NULL`
-- ============================================================================
-- A multi-column FK's `ON DELETE SET NULL` nulls EVERY column in the FK by
-- default - for a composite FK shaped (workspace_id, x), that would null
-- the CHILD ROW'S OWN workspace_id too, which Phase 4A
-- (20260830010000) just made NOT NULL on both coordinator_operations and
-- coordinator_operation_items. All 3 real hard-delete paths this would
-- interact with are live, not hypothetical: coordinators are hard-deleted
-- by election_day_manage_coordinators_v3 ("הסר אחראי"), permission_users
-- by election_day_delete_permission_user_v3, and - highest blast radius -
-- election_day_voters is bulk-deleted-and-reinserted by every single
-- Import/Clear (election_day_import_voters_v3/_clear_voters_v3), which
-- would otherwise attempt to null workspace_id on every
-- coordinator_operation_items row referencing any voter, on every import.
-- PostgreSQL 17 (confirmed live version) supports column-scoped
-- `ON DELETE SET NULL (column)` (PG15+) specifically for this case - used
-- below on subject_coordinator_id/to_coordinator_id/from_coordinator_id/
-- voter_id so ONLY that one identity column is nulled, workspace_id is
-- never touched, and this migration reproduces the exact pre-existing
-- ON DELETE behavior with zero change to what gets nulled.
-- executed_by_id also uses this same column-scoped form for the same
-- reason. role_id keeps plain ON DELETE RESTRICT (unaffected by this
-- issue - RESTRICT blocks the delete outright, touching no column).
--
-- ON UPDATE RESTRICT on every new composite FK matches this project's own
-- existing composite-FK precedent (reauth_proofs/sessions,
-- 20260826000000) - workspace_id/id pairs are never intentionally updated
-- in place.
--
-- No RLS change, no NOT NULL change (all 6 workspace_id columns already
-- NOT NULL since 20260830010000), no application code change, no data
-- backfill (preflight above proves none is needed).
begin;

-- ============================================================================
-- 1. Minimum supporting composite UNIQUE constraints on the 3 referenced
--    tables that don't already have one. election_day_permission_users
--    already carries UNIQUE (workspace_id, id) (election_day_permission_
--    users_workspace_id_id_key, added 20260826000000) - not duplicated.
-- ============================================================================
alter table public.election_day_roles
  add constraint election_day_roles_workspace_id_id_key unique (workspace_id, id);

alter table public.election_day_coordinators
  add constraint election_day_coordinators_workspace_id_id_key unique (workspace_id, id);

alter table public.election_day_voters
  add constraint election_day_voters_workspace_id_id_key unique (workspace_id, id);

-- ============================================================================
-- 2. Composite, workspace-aware FKs.
-- ============================================================================
alter table public.election_day_permission_users
  add constraint election_day_permission_users_workspace_role_fkey
  foreign key (workspace_id, role_id)
  references public.election_day_roles (workspace_id, id)
  on delete restrict
  on update restrict;

alter table public.election_day_coordinator_operations
  add constraint election_day_coordinator_operations_workspace_executed_by_fkey
  foreign key (workspace_id, executed_by_id)
  references public.election_day_permission_users (workspace_id, id)
  on delete set null (executed_by_id)
  on update restrict;

alter table public.election_day_coordinator_operations
  add constraint election_day_coordinator_operations_workspace_subject_fkey
  foreign key (workspace_id, subject_coordinator_id)
  references public.election_day_coordinators (workspace_id, id)
  on delete set null (subject_coordinator_id)
  on update restrict;

alter table public.election_day_coordinator_operation_items
  add constraint election_day_coordinator_operation_items_workspace_to_fkey
  foreign key (workspace_id, to_coordinator_id)
  references public.election_day_coordinators (workspace_id, id)
  on delete set null (to_coordinator_id)
  on update restrict;

alter table public.election_day_coordinator_operation_items
  add constraint election_day_coordinator_operation_items_workspace_from_fkey
  foreign key (workspace_id, from_coordinator_id)
  references public.election_day_coordinators (workspace_id, id)
  on delete set null (from_coordinator_id)
  on update restrict;

alter table public.election_day_coordinator_operation_items
  add constraint election_day_coordinator_operation_items_workspace_voter_fkey
  foreign key (workspace_id, voter_id)
  references public.election_day_voters (workspace_id, id)
  on delete set null (voter_id)
  on update restrict;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this
-- migration needs to be reversed; drops only what this migration added,
-- the original single-column FKs and NOT NULL constraints are untouched):
--
--   begin;
--   alter table public.election_day_coordinator_operation_items drop constraint if exists election_day_coordinator_operation_items_workspace_voter_fkey;
--   alter table public.election_day_coordinator_operation_items drop constraint if exists election_day_coordinator_operation_items_workspace_from_fkey;
--   alter table public.election_day_coordinator_operation_items drop constraint if exists election_day_coordinator_operation_items_workspace_to_fkey;
--   alter table public.election_day_coordinator_operations drop constraint if exists election_day_coordinator_operations_workspace_subject_fkey;
--   alter table public.election_day_coordinator_operations drop constraint if exists election_day_coordinator_operations_workspace_executed_by_fkey;
--   alter table public.election_day_permission_users drop constraint if exists election_day_permission_users_workspace_role_fkey;
--
--   alter table public.election_day_voters drop constraint if exists election_day_voters_workspace_id_id_key;
--   alter table public.election_day_coordinators drop constraint if exists election_day_coordinators_workspace_id_id_key;
--   alter table public.election_day_roles drop constraint if exists election_day_roles_workspace_id_id_key;
--   commit;
-- ============================================================================
