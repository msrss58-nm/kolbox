-- Dynamic Roles & Permissions - Phase 0: foundational schema only. Zero
-- behavior change - the app keeps reading/writing exactly as it does today
-- (election_day_permission_users.role, the hardcoded 3-way permission
-- engine). This migration only lays the data foundation a future Phase 1
-- (permission-engine read-path cutover) and Phase 2 (role management UI)
-- will build on. Wrapped in explicit begin;/commit; for the same reason as
-- election_day_voting_role: the Supabase CLI's migration runner pipelines a
-- file's statements via pgconn.Batch (wire-protocol pipelining), not an
-- implicit transaction - without this wrapper, a failure partway through
-- (e.g. after role_id is added but before the backfill/NOT NULL steps
-- complete) could leave the table in an inconsistent intermediate state.
begin;

-- ============================================================================
-- 1. election_day_roles - the new role catalog. Every role (including the
-- three seeded below) is a fully ordinary, editable/renameable/deletable row
-- - there are no "special" roles anywhere in this schema. `legacy_role_key`
-- is the one exception to that statement, and it is NOT a business concept:
-- it is a temporary migration-bookkeeping anchor, invisible to any UI, never
-- touched by role editing, and removed entirely in the future Phase 3
-- cleanup alongside the legacy `role` column it exists to bridge to. It
-- never participates in any permission/scope decision.
-- ============================================================================
create table public.election_day_roles (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  description    text not null default '',
  permissions    text[] not null default '{}',
  -- "Work domain" (תחום עבודה) in business language - deliberately modeled
  -- as type + reserved parameter, not a flat boolean, so a future dimension
  -- (e.g. geographic) is an additive new scope_type value plus its filter
  -- logic, not a breaking schema change. scope_value is unused today -
  -- reserved for whatever parameters a future scope_type needs (e.g. a list
  -- of polling stations). Validating array elements of `permissions` against
  -- the live TS permission catalog is intentionally deferred to the future
  -- Phase 2 create/update-role RPCs, which are the first real insertion path
  -- for arbitrary role data - this migration only ever inserts the 3
  -- trusted, hardcoded seed rows below.
  scope_type     text not null default 'assigned_to_me'
                   check (scope_type in ('all', 'assigned_to_me')),
  scope_value    jsonb,
  legacy_role_key text
                   check (legacy_role_key in ('user', 'manager', 'voting')),
  created_at     timestamptz not null default now()
);

comment on table public.election_day_roles is
  'Dynamic Roles & Permissions catalog. Every row is an ordinary, fully editable role - see column comment on legacy_role_key for the one narrow, non-business exception.';
comment on column public.election_day_roles.legacy_role_key is
  'Temporary migration-bookkeeping anchor only ("user"/"manager"/"voting"), NULL for every role created after Phase 0. Never shown in any UI, never touched by role create/rename/edit, plays no part in any permission or scope decision. Removed entirely in the future Phase 3 cleanup.';

-- At most one role may claim to be the legacy anchor for a given key -
-- required for the future Phase-0-updated election_day_create_permission_user
-- RPC's lookup to be unambiguous by construction, not just by convention.
-- Dynamic roles (legacy_role_key is null) are unrestricted in number.
create unique index election_day_roles_legacy_role_key_key
  on public.election_day_roles (legacy_role_key)
  where legacy_role_key is not null;

alter table public.election_day_roles enable row level security;

-- Deliberately no CREATE POLICY here, matching election_day_permission_users'
-- established pattern exactly: RLS-enabled with zero policies denies all
-- direct anon/authenticated access; every future read/write goes through
-- SECURITY DEFINER RPCs (none of which exist yet in this Phase-0-only
-- migration - this table has no consumer at all until Phase 1/2).

-- ============================================================================
-- 2. election_day_permission_users.role becomes nullable - a genuinely new
-- dynamic role (created in a future Phase 2) has no legacy text equivalent
-- to store here. The existing CHECK constraint is untouched and, per
-- ordinary Postgres CHECK-on-nullable-column semantics, already permits NULL
-- automatically (NULL in (...) evaluates to NULL, not FALSE) - no need to
-- redefine it.
-- ============================================================================
alter table public.election_day_permission_users
  alter column role drop not null;

-- ============================================================================
-- 3. Seed the three roles that exist today, with the exact same names shown
-- in production right now (roleOptions in election-day.constants.ts) and the
-- exact same permission sets as PERMISSIONS_BY_ROLE in permissionsMap.ts -
-- zero behavior change for any existing account. "מנהל" additionally
-- includes electionDay.manageRolesAndPermissions (added to the TS catalog in
-- this same change set) since a manager role is meant to represent full
-- access - inert today, since nothing yet checks this permission anywhere.
-- ============================================================================
insert into public.election_day_roles (name, description, permissions, scope_type, legacy_role_key)
values
  (
    'מנהל',
    'גישה מלאה לכל הפעולות והנתונים, כולל ניהול משתמשים ותפקידים.',
    array[
      'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
      'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
      'electionDay.manageUsers', 'electionDay.manageRideCoordinators',
      'app.accessFullNavigation',
      'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
      'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
      'electionDay.manageRolesAndPermissions'
    ],
    'all',
    'manager'
  ),
  (
    'משתמש',
    'ניהול תפעולי של אנשי קשר - תזכורות, הסעות, עדכון פרטים - ללא סימון הצבעה וללא פעולות ניהול.',
    array[
      'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
      'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
      'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
    ],
    'assigned_to_me',
    'user'
  ),
  (
    'נציג קלפי',
    'סימון וביטול סימון הצבעה בלבד, עם פרטי זיהוי בסיסיים.',
    array[
      'voter.markVoted', 'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewVotedStatus'
    ],
    'assigned_to_me',
    'voting'
  );

-- ============================================================================
-- 4. role_id: added nullable, backfilled from the three seeded rows via
-- legacy_role_key (never by name, never by a hardcoded id constant), verified
-- complete, then tightened to NOT NULL - all within this one atomic
-- migration. ON DELETE RESTRICT is the hard, DB-level backstop for "a role
-- with assigned users cannot be deleted" (a future Phase 2 RPC will also
-- give a friendly Hebrew error with the affected count - this constraint is
-- what makes that guarantee actually unbreakable, not just polite).
-- ============================================================================
alter table public.election_day_permission_users
  add column role_id uuid references public.election_day_roles(id) on delete restrict;

update public.election_day_permission_users pu
set role_id = r.id
from public.election_day_roles r
where r.legacy_role_key = pu.role;

do $$
declare
  v_missing_count integer;
begin
  select count(*) into v_missing_count
  from public.election_day_permission_users
  where role_id is null;

  if v_missing_count > 0 then
    raise exception
      'election_day_dynamic_roles_phase0: % row(s) in election_day_permission_users have no matching role_id after backfill - aborting before NOT NULL would fail anyway',
      v_missing_count;
  end if;
end $$;

alter table public.election_day_permission_users
  alter column role_id set not null;

-- ============================================================================
-- 5. election_day_create_permission_user - the only insertion path into
-- election_day_permission_users (RLS-enabled, zero policies, exactly like
-- election_day_roles above) - now resolves and writes role_id alongside the
-- legacy role text on every creation, so no row can ever exist with
-- role_id = null from this point forward. Fails loudly (never inserts a
-- partial row) if no matching legacy_role_key row exists - a defensive
-- guard for the narrow edge case of a future Phase 2 deleting a legacy seed
-- role while this old, backward-compatible RPC is still in use. The
-- frontend call shape (p_name/p_password/p_role) is completely unchanged.
-- ============================================================================
create or replace function public.election_day_create_permission_user(
  p_name text,
  p_password text,
  p_role text
)
returns table (id uuid, name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_role_id uuid;
begin
  if p_role not in ('user', 'manager', 'voting') then
    raise exception 'invalid role: %', p_role;
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;

  select r.id into v_role_id
  from public.election_day_roles r
  where r.legacy_role_key = p_role;

  if v_role_id is null then
    raise exception
      'no election_day_roles row found for legacy_role_key: % - cannot create user without a valid role_id',
      p_role;
  end if;

  insert into public.election_day_permission_users (name, password_hash, role, role_id)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role, v_role_id)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user(text, text, text) is
  'Creates a new PermissionUser. Phase 0 update: also resolves and writes role_id via legacy_role_key (not by name, not by a hardcoded id), failing loudly rather than inserting a role_id-less row. Signature and frontend call shape unchanged.';

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   create or replace function public.election_day_create_permission_user(
--     p_name text, p_password text, p_role text
--   ) returns table (id uuid, name text, role text)
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare v_id uuid;
--   begin
--     if p_role not in ('user', 'manager', 'voting') then
--       raise exception 'invalid role: %', p_role;
--     end if;
--     if p_name is null or btrim(p_name) = '' then
--       raise exception 'name is required';
--     end if;
--     if p_password is null or btrim(p_password) = '' then
--       raise exception 'password is required';
--     end if;
--     insert into public.election_day_permission_users (name, password_hash, role)
--     values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role)
--     returning public.election_day_permission_users.id into v_id;
--     return query
--       select u.id, u.name, u.role
--       from public.election_day_permission_users u
--       where u.id = v_id;
--   end;
--   $$;
--
--   alter table public.election_day_permission_users
--     drop column if exists role_id;
--   alter table public.election_day_permission_users
--     alter column role set not null;
--   -- (leaves any NULL `role` rows in violation if any dynamic-role user was
--   -- ever created before rollback - not possible yet in Phase 0 alone, since
--   -- no Phase 2 RPC exists yet to create a role_id-only user)
--
--   drop table if exists public.election_day_roles;
--   commit;
-- ============================================================================
