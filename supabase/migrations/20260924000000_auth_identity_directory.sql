-- ===========================================================================
-- KOLBOX unified identity - the username directory behind THREE dedicated
-- login surfaces.
--
-- ARCHITECTURE. There is no universal login that guesses who you are. There
-- are three dedicated login routes - Platform Owner, Election Owner, and
-- Manager/User - and THE ROUTE DETERMINES THE REALM. One shared mechanism
-- sits underneath all three: this directory, plus each realm's existing
-- credential store. No realm selector, no workspace selector, no system code
-- and no e-mail is ever entered on any of the three screens.
--
-- WHY THE UNIQUENESS SCOPE IS PER-REALM, NOT GLOBAL.
-- Because the route already fixes the realm, a username only has to be
-- unambiguous WITHIN its own realm. Two different people may therefore hold
-- the same username in two different realms without any ambiguity: the
-- Platform Owner screen can only ever resolve a platform_owner row, and the
-- Users screen can only ever resolve a worker row. Scoping uniqueness to the
-- realm is the MINIMUM that makes each dedicated surface unambiguous:
--
--   platform_owner  - platform_owners is a hard singleton
--                     (platform_owners_singleton_idx on ((true))), so at most
--                     one row can ever exist and uniqueness is trivially met.
--   election_owner  - must be unique among Election Owners, so the Owner
--                     screen resolves exactly one account.
--   worker          - must be unique across ALL workers in ALL workspaces,
--                     because the Users screen carries no system code and no
--                     workspace selector: the username is the ONLY input, so
--                     it alone must determine the workspace. This is the one
--                     realm that genuinely needs a cross-workspace namespace,
--                     and it gets exactly that and no more.
--
-- Stage 3A's unique (workspace_id, name) on election_day_permission_users is
-- deliberately left ALONE. `name` stays the workspace-scoped DISPLAY name;
-- the cross-workspace value is the separate `username` held here. Two
-- workspaces may still both display a worker called the same thing.
--
-- WHY auth_user_id IS THE OWNER SUBJECT. An approved Election Owner signs in
-- BEFORE their workspace exists, and provisioning DELETES the pending row
-- (election_workspace_pending_owner_access) rather than updating it. Keying
-- on auth_user_id - identical before and after provisioning - is what lets
-- one username survive onboarding with no data migration at all.
--
-- THIS TABLE HOLDS NO CREDENTIAL. Passwords stay exactly where they are:
-- bcrypt in election_day_permission_users for workers, Supabase Auth for
-- every Owner. This directory only answers "which principal, in this realm,
-- owns this username", so the server can make EXACTLY ONE credential-bearing
-- call to the right verifier. It is a directory, never a second identity
-- system, and stores no password, hash, token or secret.
--
-- NO BACKFILL. Ships EMPTY. Every current Production principal except the one
-- real Platform Owner is slated for removal, so seeding rows for them would
-- create records only to destroy them. A username is an independent
-- application identity and is NEVER derived from an e-mail local part. Until
-- a username is assigned, the existing direct per-origin login routes remain
-- the working path.
-- ===========================================================================

-- ROLLBACK (manual, in this exact order):
--   begin;
--   drop function if exists public.election_day_verify_credentials_by_actor_v1(uuid,text);
--   drop function if exists public.auth_identity_release(uuid,uuid);
--   drop function if exists public.auth_identity_assign(text,text,uuid,uuid,uuid);
--   drop function if exists public.auth_identity_for_subject(uuid);
--   drop function if exists public.auth_identity_resolve(text,text);
--   drop table if exists public.auth_identities;
--   commit;
-- Safe while no principal has been given a username: nothing else references
-- this table. Once usernames are in use, dropping it removes every principal's
-- ability to sign in through a dedicated login route - the direct per-origin
-- routes are the fallback.

begin;

create table public.auth_identities (
  id           uuid primary key default gen_random_uuid(),
  username     text not null,
  realm        text not null check (realm in
                 ('worker','election_owner','platform_owner','multi_entity_owner')),
  auth_user_id uuid references auth.users(id) on delete cascade,
  actor_id     uuid references public.election_day_permission_users(id) on delete cascade,
  workspace_id uuid,
  disabled_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- Leading/trailing whitespace is TRIMMED by the writer (see
  -- auth_identity_assign) rather than rejected, which is the specified
  -- behaviour; what this CHECK enforces is the canonical stored form. One or
  -- more runs of non-space, non-'@' characters separated by exactly ONE plain
  -- space: internal single spaces are allowed on purpose, because a username
  -- here is expected to look like a personal name. Double spaces, tabs,
  -- newlines and any surviving edge whitespace are rejected.
  constraint auth_identities_username_format
    check (username ~ '^[^\s@]+( [^\s@]+)*$'),
  constraint auth_identities_username_length
    check (char_length(username) between 3 and 64),

  -- Identical in shape to auth_handoff_codes' subject rule, deliberately:
  -- the two tables describe the same principal split and must not drift.
  constraint auth_identities_subject_shape check (
    (realm =  'worker' and actor_id is not null and workspace_id is not null
                       and auth_user_id is null)
 or (realm <> 'worker' and auth_user_id is not null and actor_id is null
                       and workspace_id is null)),

  -- Tenant-isolation hardening: a worker row's workspace_id cannot drift away
  -- from the actor's real workspace, because the pair must exist in
  -- election_day_permission_users. MATCH SIMPLE means owner rows, whose two
  -- columns are both NULL, are unaffected.
  constraint auth_identities_worker_fk
    foreign key (workspace_id, actor_id)
    references public.election_day_permission_users (workspace_id, id)
    on delete cascade
);

comment on table public.auth_identities is
  'Username directory shared by the three dedicated KOLBOX login surfaces. Maps (realm, username) to exactly one principal. Uniqueness is PER REALM, because the login route already fixes the realm - the minimum scope that makes each surface unambiguous. Holds NO credential: passwords remain in election_day_permission_users (bcrypt) and Supabase Auth. Read only by the server through auth_identity_resolve; never exposed as its own endpoint, because a pre-authentication lookup reachable by a client would be an account-enumeration oracle.';

comment on column public.auth_identities.username is
  'The login username, stored in canonical form (trimmed, NFC-normalized). Unique within its realm, case-insensitively where case is meaningful. Internal single spaces are allowed; the ''@'' character is forbidden by CHECK, which is what structurally prevents a recovery e-mail from ever being usable as a login credential.';

comment on column public.auth_identities.workspace_id is
  'Worker rows only. Present so the composite FK to (workspace_id, id) can make workspace drift impossible. It is NOT the authorization source: the server always re-derives a worker workspace from the actor row at verification time.';

comment on column public.auth_identities.disabled_at is
  'When set, auth_identity_resolve returns nothing, so the principal cannot sign in. The row is kept so the username stays reserved and is not silently re-issued to someone else.';

-- PER-REALM uniqueness. NFC first so two canonically-equivalent but
-- differently-composed strings cannot both exist; lower() folds case where
-- case is meaningful and is a harmless no-op for Hebrew, which is caseless.
-- normalize() is IMMUTABLE (verified on this project's PostgreSQL 17 before
-- being relied on in an index).
create unique index auth_identities_realm_username_key
  on public.auth_identities (realm, lower(normalize(username, NFC)));

-- One directory row per subject, in either direction.
create unique index auth_identities_actor_key
  on public.auth_identities (actor_id) where actor_id is not null;
create unique index auth_identities_auth_user_key
  on public.auth_identities (auth_user_id) where auth_user_id is not null;

-- RLS on, ZERO policies AND no table privileges - both, deliberately. RLS
-- alone would already deny anon/authenticated, but this project's hosted
-- instance carries a pg_default_acl that auto-grants table privileges on
-- every new public table, so the grants are revoked by name as well. The
-- same belt-and-braces standard as election_day_sessions,
-- election_owner_reauth_proofs and the Budget tables. The only access path
-- is the SECURITY DEFINER functions below.
alter table public.auth_identities enable row level security;

revoke all on table public.auth_identities from public;
revoke all on table public.auth_identities from anon;
revoke all on table public.auth_identities from authenticated;

-- ===========================================================================
-- 1. auth_identity_resolve - the one lookup, scoped to the calling surface.
--    p_realm comes from the LOGIN ROUTE, never from user input, which is what
--    makes a wrong-realm attempt resolve to nothing instead of leaking that
--    the username exists somewhere else.
--    Takes no password and verifies nothing.
-- ===========================================================================
create or replace function public.auth_identity_resolve(
  p_realm    text,
  p_username text
)
returns table (
  realm        text,
  auth_user_id uuid,
  actor_id     uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_key text;
begin
  if p_realm is null or p_username is null or btrim(p_username) = '' then
    return;
  end if;

  v_key := lower(normalize(btrim(p_username), NFC));

  return query
    select i.realm, i.auth_user_id, i.actor_id, i.workspace_id
    from public.auth_identities i
    where i.realm = p_realm
      and lower(normalize(i.username, NFC)) = v_key
      and i.disabled_at is null;
end;
$fn$;

comment on function public.auth_identity_resolve(text,text) is
  'Resolves a username to exactly one principal WITHIN the realm the login route declares. Applies the same trim + NFC + case-fold normalization as the uniqueness index. Returns zero rows for an unknown username, a disabled one, or one belonging to a different realm - the caller MUST answer identically in all of those cases and in the wrong-password case, so this is never an enumeration oracle. Verifies no credential. service_role only.';

revoke all on function public.auth_identity_resolve(text,text) from public;
revoke all on function public.auth_identity_resolve(text,text) from anon;
revoke all on function public.auth_identity_resolve(text,text) from authenticated;
grant execute on function public.auth_identity_resolve(text,text) to service_role;

-- ===========================================================================
-- 1b. auth_identity_for_subject - the username a principal already holds.
--     Read by the Platform console to show whether a username is claimed yet.
--     Takes a SERVER-VERIFIED auth_user_id, never anything client-supplied.
-- ===========================================================================
create or replace function public.auth_identity_for_subject(p_auth_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_username text;
begin
  if p_auth_user_id is null then
    return null;
  end if;

  select i.username into v_username
  from public.auth_identities i
  where i.auth_user_id = p_auth_user_id;

  return v_username;
end;
$fn$;

comment on function public.auth_identity_for_subject(uuid) is
  'Returns the login username a principal already holds, or null when none is claimed. Exists so no caller has to read auth_identities directly - the table grants nothing to any role and its only access path is a SECURITY DEFINER function. service_role only.';

revoke all on function public.auth_identity_for_subject(uuid) from public;
revoke all on function public.auth_identity_for_subject(uuid) from anon;
revoke all on function public.auth_identity_for_subject(uuid) from authenticated;
grant execute on function public.auth_identity_for_subject(uuid) to service_role;

-- ===========================================================================
-- 2. auth_identity_assign - the single write path.
-- ===========================================================================
create or replace function public.auth_identity_assign(
  p_realm        text,
  p_username     text,
  p_auth_user_id uuid,
  p_actor_id     uuid,
  p_workspace_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_username text;
  v_id uuid;
begin
  if p_username is null or p_realm is null then
    raise exception 'INVALID_USERNAME';
  end if;

  -- Trim + NFC on write, so the stored value is canonical and matches the
  -- uniqueness index exactly. Trimming is the specified behaviour: a pasted
  -- value with stray edge whitespace is accepted and cleaned, never stored
  -- with padding that renders differently than it sorts.
  v_username := normalize(btrim(p_username), NFC);

  -- Everything the CHECK constraints enforce is re-stated here so the caller
  -- gets a clean, named error instead of a raw constraint violation.
  if v_username !~ '^[^\s@]+( [^\s@]+)*$'
     or char_length(v_username) < 3
     or char_length(v_username) > 64 then
    raise exception 'INVALID_USERNAME';
  end if;

  -- One username per subject. Without this, a second assign for the same
  -- principal surfaced as a raw unique-violation on the subject index rather
  -- than as a meaningful error.
  if (p_auth_user_id is not null
        and exists (select 1 from public.auth_identities i
                    where i.auth_user_id = p_auth_user_id))
     or (p_actor_id is not null
        and exists (select 1 from public.auth_identities i
                    where i.actor_id = p_actor_id))
  then
    raise exception 'SUBJECT_ALREADY_ASSIGNED';
  end if;

  -- Collision is checked WITHIN THE REALM only - the same scope the unique
  -- index enforces.
  if exists (
    select 1 from public.auth_identities i
    where i.realm = p_realm
      and lower(normalize(i.username, NFC)) = lower(v_username)
  ) then
    raise exception 'USERNAME_TAKEN';
  end if;

  insert into public.auth_identities
    (username, realm, auth_user_id, actor_id, workspace_id)
  values
    (v_username, p_realm, p_auth_user_id, p_actor_id, p_workspace_id)
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.auth_identity_assign(text,text,uuid,uuid,uuid) is
  'Assigns a username to one principal. Trims and NFC-normalizes on write so the stored value is canonical, and raises a named error - INVALID_USERNAME, SUBJECT_ALREADY_ASSIGNED or USERNAME_TAKEN - rather than letting a collision surface later as an ambiguous login or a raw constraint violation. Collision is evaluated within the target realm only. The subject-shape CHECK rejects any realm/subject combination that does not match, and the composite worker FK rejects a workspace that is not the actor''s own. service_role only.';

revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from public;
revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from anon;
revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from authenticated;
grant execute on function public.auth_identity_assign(text,text,uuid,uuid,uuid) to service_role;

-- ===========================================================================
-- 3. auth_identity_release - retire a directory row by subject.
--    Worker rows also disappear on their own via ON DELETE CASCADE; this
--    exists for an explicit rename/retire without deleting the person.
-- ===========================================================================
create or replace function public.auth_identity_release(
  p_auth_user_id uuid,
  p_actor_id     uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  if p_auth_user_id is null and p_actor_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  delete from public.auth_identities i
  where (p_auth_user_id is not null and i.auth_user_id = p_auth_user_id)
     or (p_actor_id     is not null and i.actor_id     = p_actor_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.auth_identity_release(uuid,uuid) is
  'Removes the directory row(s) for one subject, freeing the username within its realm. Requires at least one subject identifier - a call with both null is refused rather than silently deleting nothing. service_role only.';

revoke all on function public.auth_identity_release(uuid,uuid) from public;
revoke all on function public.auth_identity_release(uuid,uuid) from anon;
revoke all on function public.auth_identity_release(uuid,uuid) from authenticated;
grant execute on function public.auth_identity_release(uuid,uuid) to service_role;

-- ===========================================================================
-- 4. election_day_verify_credentials_by_actor_v1
--    The Manager/User credential check WITHOUT a system code, for the
--    dedicated Users login. The same decisions as
--    election_day_verify_credentials_v1 - one generic UNAUTHORIZED, and
--    MODULE_NOT_ENABLED raised only AFTER the password verified, so it tells
--    nothing to someone without valid credentials - minus the login_code
--    lookup, because the directory already named the actor.
--
--    THE WORKSPACE IS DERIVED HERE, from the actor's own row, never from the
--    directory and never from anything the client sent. That is what keeps
--    tenant isolation intact once the system code is gone from the UI.
--    Creates no session.
-- ===========================================================================
create or replace function public.election_day_verify_credentials_by_actor_v1(
  p_actor_id uuid,
  p_password text
)
returns table (
  actor_name     text,
  role_id        uuid,
  workspace_id   uuid,
  workspace_name text
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user_name text;
  v_role_id uuid;
  v_workspace_id uuid;
  v_workspace_name text;
begin
  if p_actor_id is null or p_password is null or p_password = '' then
    raise exception 'UNAUTHORIZED';
  end if;

  select u.name, u.role_id, u.workspace_id
    into v_user_name, v_role_id, v_workspace_id
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_user_name is null
     or not public.election_day_verify_permission_user_password(p_actor_id, p_password)
  then
    raise exception 'UNAUTHORIZED';
  end if;

  if not (
    public.election_day_workspace_has_module(v_workspace_id, 'election_day')
    or public.budget_workspace_entitled(v_workspace_id)
  ) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  select w.name into v_workspace_name
  from public.election_workspaces w
  where w.id = v_workspace_id;

  return query select v_user_name, v_role_id, v_workspace_id, v_workspace_name;
end;
$fn$;

comment on function public.election_day_verify_credentials_by_actor_v1(uuid,text) is
  'Dedicated Users-login server path: verifies a worker password for an actor the username directory already resolved, and creates NO session. The workspace is derived from the actor row itself, never from client input or from the directory, which is what preserves tenant isolation without a system code. Same generic UNAUTHORIZED and same post-password MODULE_NOT_ENABLED ordering as election_day_verify_credentials_v1. service_role only.';

revoke all on function public.election_day_verify_credentials_by_actor_v1(uuid,text) from public;
revoke all on function public.election_day_verify_credentials_by_actor_v1(uuid,text) from anon;
revoke all on function public.election_day_verify_credentials_by_actor_v1(uuid,text) from authenticated;
grant execute on function public.election_day_verify_credentials_by_actor_v1(uuid,text) to service_role;

commit;
