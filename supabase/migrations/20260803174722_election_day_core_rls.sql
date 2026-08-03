-- Election Day core tables: Row Level Security - Strategy A (product
-- decision, approved): the same trust model as today's per-browser
-- MockApi/localStorage setup, now shared instead of isolated. No real
-- Supabase Auth identity backs a PermissionUser (see the
-- election_day_permission_users migration) - "user"-role scoping
-- (a coordinator only seeing their own contacts) stays enforced entirely
-- client-side, exactly as it is today in useElectionDay.ts's
-- scopedContacts. Anyone holding the public anon key can read/write these
-- four tables - this is an explicit, accepted product decision, not an
-- oversight (see task-plan.md's Election Day → Supabase migration section).

alter table public.election_day_voters enable row level security;
alter table public.election_day_ride_status_events enable row level security;
alter table public.election_day_ride_coordinators enable row level security;
alter table public.election_day_settings enable row level security;

create policy election_day_voters_all on public.election_day_voters
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy election_day_ride_status_events_all on public.election_day_ride_status_events
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy election_day_ride_coordinators_all on public.election_day_ride_coordinators
  for all
  to anon, authenticated
  using (true)
  with check (true);

create policy election_day_settings_all on public.election_day_settings
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ============================================================================
-- ROLLBACK (manual):
--
--   drop policy if exists election_day_settings_all on public.election_day_settings;
--   drop policy if exists election_day_ride_coordinators_all on public.election_day_ride_coordinators;
--   drop policy if exists election_day_ride_status_events_all on public.election_day_ride_status_events;
--   drop policy if exists election_day_voters_all on public.election_day_voters;
--   alter table public.election_day_settings disable row level security;
--   alter table public.election_day_ride_coordinators disable row level security;
--   alter table public.election_day_ride_status_events disable row level security;
--   alter table public.election_day_voters disable row level security;
-- ============================================================================
