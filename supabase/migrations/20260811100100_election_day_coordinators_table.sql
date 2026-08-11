-- Coordinator Allocation Management - Phase 1 (DB foundation), step 2/5.
-- The "today's coordinators" entity - deliberately NOT a permanent roster
-- (unlike election_day_ride_coordinators, the unrelated driver list): a
-- fresh set of coordinator rows is expected to be entered each election day,
-- ended when their activity is done, never reused across days by identity.
--
-- linked_assignment_name is the explicit-only bridge to voters that already
-- arrived from Excel with a non-null `coordinator` string (see the previous
-- migration) - a manager manually links a coordinator entity to that exact
-- string; there is no automatic/heuristic name matching anywhere, and no FK
-- from election_day_voters.coordinator to this table's id, by design (locked
-- decision - avoids a data-migration/rename hazard on the existing free-text
-- column). Business RPCs that read/write this link (Phase 2/3) are
-- responsible for keeping it consistent; this migration only defines shape.
--
-- Write access is deliberately NOT open client CRUD (unlike the existing
-- Strategy A `USING(true)` convention on the four original election_day_*
-- tables) - only a SELECT policy is added here. INSERT/UPDATE/DELETE are
-- left with zero client policies, so they are denied by default now that RLS
-- is enabled; real writes will go through SECURITY DEFINER RPCs added in a
-- later phase, mirroring the already-shipped election_day_permission_users /
-- election_day_roles pattern (RLS enabled, writes RPC-only).

create table if not exists public.election_day_coordinators (
  id                      uuid primary key default gen_random_uuid(),
  display_name            text not null,
  status                  text not null default 'active' check (status in ('active', 'ended')),
  linked_assignment_name  text,
  created_at              timestamptz not null default now(),
  ended_at                timestamptz
);

comment on table public.election_day_coordinators is
  'Coordinator Allocation Management: "today''s coordinators" for one election day - not a permanent roster (contrast election_day_ride_coordinators, the unrelated driver list). status flips to ''ended'' when a coordinator finishes activity (Phase 2/3 RPC), never deleted. linked_assignment_name is an explicit-only manual link to a pre-existing Excel `election_day_voters.coordinator` string - never auto-matched.';

comment on column public.election_day_coordinators.linked_assignment_name is
  'Explicit-only link to an existing election_day_voters.coordinator string (e.g. a name that arrived pre-assigned from an Excel import). Set only by a manager''s deliberate manual action, never inferred by name-matching. Decoupled from display_name so renaming a coordinator later does not break the link.';

-- At most one ACTIVE coordinator per display name - a display name can be
-- reused once the previous coordinator holding it has ended (status <> 'active'
-- falls outside this partial index), so ending and re-adding the same person
-- next election day is never blocked by a stale row.
create unique index if not exists election_day_coordinators_active_display_name_key
  on public.election_day_coordinators (display_name)
  where status = 'active';

-- At most one coordinator entity linked to any given pre-existing Excel
-- coordinator string, across all statuses (a linked coordinator's identity
-- as "the one representing that Excel string" must stay unique even after
-- it ends).
create unique index if not exists election_day_coordinators_linked_assignment_name_key
  on public.election_day_coordinators (linked_assignment_name)
  where linked_assignment_name is not null;

alter table public.election_day_coordinators enable row level security;

create policy election_day_coordinators_select on public.election_day_coordinators
  for select
  to anon, authenticated
  using (true);

-- ============================================================================
-- ROLLBACK (manual):
--
--   drop policy if exists election_day_coordinators_select on public.election_day_coordinators;
--   alter table public.election_day_coordinators disable row level security;
--   drop index if exists public.election_day_coordinators_linked_assignment_name_key;
--   drop index if exists public.election_day_coordinators_active_display_name_key;
--   drop table if exists public.election_day_coordinators;
-- ============================================================================
