-- Election Day core tables: ride-coordination contacts, ride-status audit
-- log, the fixed ride-coordinator/driver roster, and the single global
-- countdown-deadline setting. Mirrors src/types/index.ts's ElectionDayVoter /
-- RideStatusEvent / RideCoordinator exactly - moving storage only, no shape
-- changes, per the approved "no regression" constraint.

create table if not exists public.election_day_voters (
  id                 uuid primary key default gen_random_uuid(),
  masad              text not null default '',
  first_name         text not null,
  last_name          text not null,
  street             text not null default '',
  house_number       integer not null default 0,
  city               text not null default '',
  phone              text not null,
  coordinator        text not null,
  notes              text not null default '',
  ride_requested     boolean not null default false,
  ride_requested_at  timestamptz,
  ride_arranged      boolean not null default false,
  ride_arranged_at   timestamptz,
  ride_completed     boolean not null default false,
  ride_completed_at  timestamptz,
  reminder_at        timestamptz,
  voted              boolean not null default false,
  voted_at           timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.election_day_voters is
  'Election-day ride-coordination contact list, imported from a dedicated Excel/CSV/JSON file per campaign day. Independent of the main voter registry (still MockApi/localStorage).';

create index if not exists election_day_voters_coordinator_idx
  on public.election_day_voters (coordinator);
create index if not exists election_day_voters_city_idx
  on public.election_day_voters (city);
create index if not exists election_day_voters_voted_idx
  on public.election_day_voters (voted);
create index if not exists election_day_voters_ride_status_idx
  on public.election_day_voters (ride_arranged, ride_completed);

-- Shared updated_at trigger function - reused by every election_day_* table
-- below that needs one, so it's only defined once.
create or replace function public.election_day_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists election_day_voters_set_updated_at on public.election_day_voters;
create trigger election_day_voters_set_updated_at
  before update on public.election_day_voters
  for each row
  execute function public.election_day_set_updated_at();

-- Ride-status audit log ------------------------------------------------
-- Records every rideArranged flip. Denormalizes contact_name/coordinator
-- (as the current RideStatusEvent type does) so entries stay meaningful
-- even after the contact is deleted or the ride-list is re-imported.
create table if not exists public.election_day_ride_status_events (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid references public.election_day_voters(id) on delete cascade,
  contact_name   text not null,
  coordinator    text not null,
  from_arranged  boolean not null,
  to_arranged    boolean not null,
  created_at     timestamptz not null default now()
);

comment on table public.election_day_ride_status_events is
  'Audit log of ride-arranged status changes on election_day_voters. Denormalizes contact name/coordinator so history survives contact deletion or a fresh ride-list re-import.';

create index if not exists election_day_ride_status_events_created_at_idx
  on public.election_day_ride_status_events (created_at desc);
create index if not exists election_day_ride_status_events_contact_id_idx
  on public.election_day_ride_status_events (contact_id);

-- Fixed, pre-registered ride-coordinator (driver) roster -----------------
-- Distinct from the free-text "coordinator" column above - this is the
-- roster managed from "ניהול אחראי הסעות" that a ride request can be
-- routed to.
create table if not exists public.election_day_ride_coordinators (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null,
  created_at  timestamptz not null default now()
);

comment on table public.election_day_ride_coordinators is
  'Fixed, pre-registered ride-coordinator/driver roster managed from "ניהול אחראי הסעות" - distinct from the free-text coordinator column on election_day_voters.';

-- Single global setting: the election-day countdown deadline -------------
-- The "id boolean primary key default true" + check constraint is the
-- standard Postgres singleton-table trick: the check forces id to always
-- be true, and the primary key forces at most one row, so this table can
-- never hold more than exactly one row.
create table if not exists public.election_day_settings (
  id          boolean primary key default true,
  deadline    timestamptz,
  updated_at  timestamptz not null default now(),
  constraint election_day_settings_singleton check (id)
);

comment on table public.election_day_settings is
  'Singleton settings row for Election Day (currently just the countdown deadline). id is always true - enforced by the check constraint - so this table can only ever hold one row.';

drop trigger if exists election_day_settings_set_updated_at on public.election_day_settings;
create trigger election_day_settings_set_updated_at
  before update on public.election_day_settings
  for each row
  execute function public.election_day_set_updated_at();

insert into public.election_day_settings (id, deadline)
values (true, null)
on conflict (id) do nothing;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this migration
-- needs to be reversed; Supabase CLI migrations have no automatic "down"):
--
--   drop trigger if exists election_day_settings_set_updated_at on public.election_day_settings;
--   drop trigger if exists election_day_voters_set_updated_at on public.election_day_voters;
--   drop function if exists public.election_day_set_updated_at();
--   drop table if exists public.election_day_settings;
--   drop table if exists public.election_day_ride_coordinators;
--   drop table if exists public.election_day_ride_status_events;
--   drop table if exists public.election_day_voters;
-- ============================================================================
