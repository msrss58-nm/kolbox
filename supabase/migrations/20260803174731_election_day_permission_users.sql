-- Election Day local user/manager roster ("ניהול הרשאות משתמשים"). This is
-- NOT Supabase Auth (product decision, approved) - it mirrors today's local
-- PermissionUser directory, now shared across devices via this table
-- instead of per-browser localStorage.
--
-- Security-critical change vs. today: passwords are NEVER stored, selected,
-- or transmitted in plaintext after creation. Only a pgcrypto bcrypt hash is
-- persisted, in password_hash. There is deliberately no anon/authenticated
-- policy on this table at all (see below) - the only way to read, create,
-- list, or delete rows is through the four SECURITY DEFINER RPC functions
-- created in the companion "election_day_permission_rpc" migration, which
-- run as the table owner and bypass RLS internally. A direct
-- `select * from election_day_permission_users` with the anon key returns
-- zero rows, always.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.election_day_permission_users (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  password_hash  text not null,
  role           text not null check (role in ('user', 'manager')),
  created_at     timestamptz not null default now()
);

comment on table public.election_day_permission_users is
  'Election Day local user/manager roster (not Supabase Auth). password_hash is a pgcrypto bcrypt hash - plaintext passwords are never stored. No anon/authenticated policy exists on this table by design; all access goes through the election_day_login / election_day_create_permission_user / election_day_list_permission_users / election_day_delete_permission_user RPC functions (see the companion migration).';

comment on column public.election_day_permission_users.password_hash is
  'pgcrypto bcrypt hash (crypt(password, gen_salt(''bf''))) - never a plaintext password. Only ever written by the election_day_create_permission_user RPC and only ever compared (never selected out) by the election_day_login RPC.';

alter table public.election_day_permission_users enable row level security;

-- Deliberately no CREATE POLICY here: with RLS enabled and zero policies,
-- every direct access from anon/authenticated (SELECT, INSERT, UPDATE,
-- DELETE alike) is denied by default. This is the intended, final state
-- for this table - not a placeholder waiting for a policy to be added later.

-- ============================================================================
-- ROLLBACK (manual):
--
--   drop table if exists public.election_day_permission_users;
--   -- (leaves the pgcrypto extension installed - shared by other migrations/
--   -- functions, so it is not dropped here even on rollback of this table)
-- ============================================================================
