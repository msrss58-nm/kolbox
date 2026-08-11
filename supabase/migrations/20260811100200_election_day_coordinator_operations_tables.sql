-- Coordinator Allocation Management - Phase 1 (DB foundation), step 3/5.
-- Operational history for allocation moves - two tables, not one, so a
-- business action with zero voters moved (e.g. a coordinator ending activity
-- while already at 0 remaining voters) still leaves exactly one durable
-- record naming who/what/when, instead of vanishing entirely from history
-- and from the re-import guard below.
--
-- election_day_coordinator_operations = one row per business action
-- (initial_allocation / rebalance / coordinator_end). subject_coordinator_id
-- (+ its name snapshot) names the coordinator a coordinator_end operation
-- acted on, even when it produced zero items; left null/unused for
-- initial_allocation and rebalance, which have no single "subject".
--
-- election_day_coordinator_operation_items = one row per voter actually
-- moved by an operation - from/to coordinator plus a voter name snapshot.
--
-- Both tables use ON DELETE SET NULL (never CASCADE) on every FK to a
-- mutable entity (permission user, coordinator, voter) - deleting any of
-- those must never delete history; every FK is paired with a `_snapshot`
-- text column that is filled in once at write time by the business RPCs
-- (Phase 2/3) and never re-derived, so a row stays meaningful after the
-- referenced entity is gone. Only operation_id -> operations is CASCADE,
-- since an item has no meaning detached from its own parent operation.
--
-- RLS: enabled with ZERO client policies on both tables (locked decision -
-- no SELECT policy either, since there is no History UI yet in V1 and this
-- migration deliberately does not add read access "in case it's needed
-- later"). All direct client access (anon and authenticated, every
-- operation) is denied by default the moment RLS is enabled with no
-- matching policy; only a SECURITY DEFINER RPC (running as the table
-- owner, which bypasses RLS) will ever read or write these tables, added in
-- a later phase - mirroring the existing election_day_permission_users
-- write-access posture, but going one step further by denying SELECT too.
--
-- No RPCs are added in this migration - schema/RLS only, per Phase 1 scope.
-- The eventual re-import guard (a later phase) is expected to check
-- `exists (select 1 from election_day_coordinator_operations)` from inside a
-- SECURITY DEFINER function - schema here is written to support that
-- without any future change to this table.

create table if not exists public.election_day_coordinator_operations (
  id                                  uuid primary key default gen_random_uuid(),
  operation_type                      text not null
    check (operation_type in ('initial_allocation', 'rebalance', 'coordinator_end')),
  executed_at                         timestamptz not null default now(),
  executed_by_id                      uuid references public.election_day_permission_users(id) on delete set null,
  executed_by_name_snapshot           text not null,
  subject_coordinator_id              uuid references public.election_day_coordinators(id) on delete set null,
  subject_coordinator_name_snapshot   text
);

comment on table public.election_day_coordinator_operations is
  'Coordinator Allocation Management: one row per business action (initial_allocation / rebalance / coordinator_end). executed_by_* is a frozen snapshot of the acting PermissionUser''s identity, taken at write time - survives that user later being deleted (ON DELETE SET NULL on executed_by_id). subject_coordinator_* names the coordinator a coordinator_end operation acted on (mandatory in practice for that type, even when it moved 0 voters) - left unused for initial_allocation/rebalance, which act on many coordinators at once via operation_items instead. Schema only in Phase 1 - no RPC writes to this table yet.';

comment on column public.election_day_coordinator_operations.executed_by_name_snapshot is
  'Frozen snapshot of the acting PermissionUser''s name at the time of the operation - never re-derived from executed_by_id, so history reads correctly even after that user is deleted.';

comment on column public.election_day_coordinator_operations.subject_coordinator_name_snapshot is
  'Frozen snapshot of the subject coordinator''s display_name at operation time. Filled for coordinator_end (the coordinator that ended, even with 0 items moved); left null for initial_allocation/rebalance.';

alter table public.election_day_coordinator_operations enable row level security;

create table if not exists public.election_day_coordinator_operation_items (
  id                               uuid primary key default gen_random_uuid(),
  operation_id                    uuid not null references public.election_day_coordinator_operations(id) on delete cascade,
  voter_id                        uuid references public.election_day_voters(id) on delete set null,
  voter_name_snapshot              text not null,
  from_coordinator_id              uuid references public.election_day_coordinators(id) on delete set null,
  from_coordinator_name_snapshot   text,
  to_coordinator_id                uuid references public.election_day_coordinators(id) on delete set null,
  to_coordinator_name_snapshot     text not null
);

comment on table public.election_day_coordinator_operation_items is
  'Coordinator Allocation Management: one row per voter actually moved by an operations row (cascades on operation delete - an item has no meaning detached from its parent operation). from_coordinator_id/name_snapshot is null for a voter that had no prior coordinator (initial_allocation of a previously-unassigned voter); to_coordinator_* is always filled - every move has a destination. voter_id uses ON DELETE SET NULL, never CASCADE, so a later voter deletion or re-import never deletes history - voter_name_snapshot keeps the row meaningful regardless. Schema only in Phase 1 - no RPC writes to this table yet.';

create index if not exists election_day_coordinator_operation_items_operation_id_idx
  on public.election_day_coordinator_operation_items (operation_id);
create index if not exists election_day_coordinator_operation_items_voter_id_idx
  on public.election_day_coordinator_operation_items (voter_id);
create index if not exists election_day_coordinator_operation_items_from_coordinator_id_idx
  on public.election_day_coordinator_operation_items (from_coordinator_id);
create index if not exists election_day_coordinator_operation_items_to_coordinator_id_idx
  on public.election_day_coordinator_operation_items (to_coordinator_id);

alter table public.election_day_coordinator_operation_items enable row level security;

-- ============================================================================
-- ROLLBACK (manual):
--
--   alter table public.election_day_coordinator_operation_items disable row level security;
--   drop index if exists public.election_day_coordinator_operation_items_to_coordinator_id_idx;
--   drop index if exists public.election_day_coordinator_operation_items_from_coordinator_id_idx;
--   drop index if exists public.election_day_coordinator_operation_items_voter_id_idx;
--   drop index if exists public.election_day_coordinator_operation_items_operation_id_idx;
--   drop table if exists public.election_day_coordinator_operation_items;
--   alter table public.election_day_coordinator_operations disable row level security;
--   drop table if exists public.election_day_coordinator_operations;
-- ============================================================================
