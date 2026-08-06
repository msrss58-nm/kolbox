-- Dynamic Non-Voting Reasons - Phase 0: the reason catalog table itself.
-- Mirrors election_day_roles exactly (see election_day_dynamic_roles_phase0):
-- RLS-enabled with zero policies (deny-all direct anon/authenticated access -
-- every read/write goes through SECURITY DEFINER RPCs in a later migration),
-- every row a fully ordinary, editable/renameable/deletable(if unused)
-- record - there is no hardcoded reason anywhere in this schema or the
-- frontend. The 6 rows seeded below are an example starting list only, not a
-- fixed/locked set - a campaign manager can rename, disable, or delete any of
-- them (once unused) from day one via "ניהול סיבות אי-הצבעה".
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements, it does not implicitly wrap them in a transaction.
begin;

create table public.election_day_not_voting_reasons (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text not null default '',
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.election_day_not_voting_reasons is
  'Dynamic catalog of "why a voter has not voted" reasons (סיבות אי-הצבעה) - fully CRUD-managed from "ניהול סיבות אי-הצבעה", mirroring election_day_roles exactly. Never hardcoded in the frontend; election_day_voters only ever stores a reason ID, never free text.';

create index election_day_not_voting_reasons_active_sort_idx
  on public.election_day_not_voting_reasons (is_active, sort_order);

alter table public.election_day_not_voting_reasons enable row level security;
-- Deliberately zero CREATE POLICY statements here, matching
-- election_day_roles' established pattern exactly - RLS-enabled with zero
-- policies denies all direct anon/authenticated access; every future
-- read/write goes through the SECURITY DEFINER RPCs added in a later
-- migration in this same rollout.

-- Reuses the shared trigger function already defined in
-- election_day_core_tables.sql - not redefined here.
create trigger election_day_not_voting_reasons_set_updated_at
  before update on public.election_day_not_voting_reasons
  for each row
  execute function public.election_day_set_updated_at();

-- Seed the 6 reasons the product owner listed as a starting example - plain,
-- ordinary rows like every other, immediately editable/renameable/
-- disableable/deletable (once unused) from the management screen. Not a
-- locked/hardcoded set - this is DB seed data, not a frontend constant.
insert into public.election_day_not_voting_reasons (name, description, sort_order)
values
  ('אמר שלא יגיע', '', 0),
  ('מספר טלפון שגוי', '', 1),
  ('לא עונה', '', 2),
  ('בחו"ל', '', 3),
  ('נפטר', '', 4),
  ('עבר עיר', '', 5);

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this migration
-- needs to be reversed; Supabase CLI migrations have no automatic "down"):
--
--   begin;
--   drop trigger if exists election_day_not_voting_reasons_set_updated_at
--     on public.election_day_not_voting_reasons;
--   drop table if exists public.election_day_not_voting_reasons;
--   commit;
-- ============================================================================
