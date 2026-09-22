-- ===========================================================================
-- KOLBOX unified identity - ONE shared login screen, so ONE username space.
--
-- WHY THIS EXISTS. 20260924000000 scoped username uniqueness PER REALM, and
-- said so explicitly: "Because the route already fixes the realm, a username
-- only has to be unambiguous WITHIN its own realm." That reasoning was sound
-- while there were four dedicated login routes. There are now TWO login
-- screens - the Platform Owner's, and ONE shared screen for every other
-- principal - and the shared screen states no realm at all. The premise is
-- gone, so the constraint has to move with it.
--
-- THE CONCRETE HAZARD THIS CLOSES. Nothing stopped an Election Owner being
-- given a username a worker in some workspace already held. Each could sign
-- in on their own dedicated screen, so it was harmless. On one shared screen
-- that same pair is AMBIGUOUS: the server cannot know which principal was
-- meant. The broker refuses ambiguity rather than guessing a realm by
-- precedence or trying each realm's password in turn - both of which would be
-- worse - which means such a pair silently locks BOTH principals out, with no
-- error at the moment the collision was actually created. Refusing the
-- collision at CREATION time is the only place it can be reported to someone
-- who can act on it.
--
-- SCOPE: THE SHARED REALMS ONLY.
--   worker, election_owner, multi_entity_owner  -> ONE global namespace.
--   platform_owner                              -> keeps its own.
-- The Platform Owner signs in on a different screen against a different
-- endpoint, so their username never competes with a tenant's and cannot
-- create an ambiguous lookup. Widening the constraint to cover them would
-- reserve names across a boundary that does not exist, for no safety gain.
--
-- WHAT IS DELIBERATELY UNCHANGED.
--   - Normalization. Uniqueness is still compared as
--     lower(normalize(username, NFC)) - the identical expression the existing
--     per-realm index uses - so canonical equivalence, case folding and the
--     trim-on-write behaviour are all exactly as before. No stored value
--     changes and no row is rewritten.
--   - The suggestion MECHANISM. auth_identity_suggest_username still returns
--     the base when free and the next free numbered variant otherwise, with
--     the same 999 bound and the same 64-character limit. Two things do
--     change, both deliberately: the set of rows it searches widens to the
--     whole shared namespace - required, because a suggestion that ignored
--     the other shared realms could offer a name the new index then rejects -
--     and the suffix is appended with NO separator ('אלי כהן2', not
--     'אלי כהן 2'), which is the approved product format.
--   - The per-realm index. Kept, not dropped: it still carries
--     platform_owner, and dropping a live uniqueness guarantee to replace it
--     with a wider one is a strictly riskier way to arrive at the same place.
--   - Every ACL. These are replacements of existing service_role-only
--     functions; the revokes are re-stated below per this project's standing
--     rule rather than trusted to survive.
--
-- PRODUCTION SAFETY. public.auth_identities currently holds exactly one row
-- (the Platform Owner), which this index does not even cover, so the new
-- constraint cannot fail on existing data. The guard below still runs first
-- and reports a real collision by name rather than letting the index build
-- fail with a raw duplicate-key error.
-- ===========================================================================

-- ROLLBACK (manual, in this exact order):
--   begin;
--   drop index if exists public.auth_identities_shared_username_key;
--   -- then re-apply the auth_identity_assign and
--   -- auth_identity_suggest_username bodies from 20260924000000 and
--   -- 20260924030000 respectively; both are plain CREATE OR REPLACE.
--   commit;
-- MUST be preceded by reverting api/platform/_authBroker.ts to a build that
-- does not offer the shared `login` op, because the shared screen is not
-- sound without this constraint.

begin;

-- ===========================================================================
-- 0. Guard: refuse to proceed if the data already contradicts the invariant.
-- ===========================================================================
do $guard$
declare
  v_dupe text;
begin
  select lower(normalize(i.username, NFC))
    into v_dupe
  from public.auth_identities i
  where i.realm in ('worker','election_owner','multi_entity_owner')
    and i.disabled_at is null
  group by lower(normalize(i.username, NFC))
  having count(*) > 1
  limit 1;

  if v_dupe is not null then
    -- Named, actionable, and deliberately NOT auto-resolved: deciding which
    -- principal keeps the name is a product decision, never a migration's.
    raise exception
      'SHARED_USERNAME_COLLISION: more than one shared-realm principal holds the username %. Rename one of them before applying this migration.', v_dupe;
  end if;
end;
$guard$;

-- ===========================================================================
-- 1. The invariant itself.
-- ===========================================================================
-- Same expression as auth_identities_realm_username_key, minus the realm, and
-- restricted to the realms the shared screen can resolve. A partial index is
-- what lets platform_owner keep a separate namespace without a second table.
create unique index auth_identities_shared_username_key
  on public.auth_identities (lower(normalize(username, NFC)))
  where realm in ('worker','election_owner','multi_entity_owner');

comment on index public.auth_identities_shared_username_key is
  'ONE username space for every principal that signs in on the shared KOLBOX login screen (worker, election_owner, multi_entity_owner). Required because that screen states no realm: two principals sharing a username there would be an ambiguous lookup, which the broker refuses, locking both out. platform_owner is excluded on purpose - it has its own screen and endpoint, so its username cannot create an ambiguous lookup.';

comment on table public.auth_identities is
  'Username directory shared by the KOLBOX login surfaces. Maps a username to exactly one principal. Uniqueness is GLOBAL across the shared-login realms (worker, election_owner, multi_entity_owner), because the shared screen states no realm and an ambiguous lookup would lock both principals out; platform_owner keeps its own namespace, having its own screen. Holds NO credential: passwords remain in election_day_permission_users (bcrypt) and Supabase Auth. Read only by the server through auth_identity_resolve; never exposed as its own endpoint, because a pre-authentication lookup reachable by a client would be an account-enumeration oracle.';

comment on column public.auth_identities.username is
  'The login username, stored in canonical form (trimmed, NFC-normalized). Unique across all shared-login realms, case-insensitively where case is meaningful; platform_owner is a separate namespace. Internal single spaces are allowed; the ''@'' character is forbidden by CHECK, which is what structurally prevents a recovery e-mail from ever being usable as a login credential.';

-- ===========================================================================
-- 2. auth_identity_assign - collision is now evaluated across the namespace
--    the target realm actually belongs to.
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
  v_shared constant text[] := array['worker','election_owner','multi_entity_owner'];
  v_scope  text[];
  v_username text;
  v_id uuid;
begin
  if p_username is null or p_realm is null then
    raise exception 'INVALID_USERNAME';
  end if;

  -- Trim + NFC on write, so the stored value is canonical and matches the
  -- uniqueness indexes exactly. Trimming is the specified behaviour: a pasted
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

  -- THE NAMESPACE, not the realm. A shared-login principal competes with
  -- every other shared-login principal, because they all type into the same
  -- box on the same screen. The Platform Owner competes only with itself.
  if p_realm = any(v_shared) then
    v_scope := v_shared;
  else
    v_scope := array[p_realm];
  end if;

  -- Checked here as well as by the indexes so the caller gets USERNAME_TAKEN
  -- - the signal the suggestion flow keys off - rather than a raw 23505.
  if exists (
    select 1 from public.auth_identities i
    where i.realm = any(v_scope)
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
  'Assigns a username to one principal. Trims and NFC-normalizes on write so the stored value is canonical, and raises a named error - INVALID_USERNAME, SUBJECT_ALREADY_ASSIGNED or USERNAME_TAKEN - rather than letting a collision surface later as an ambiguous login or a raw constraint violation. Collision is evaluated across the NAMESPACE the target realm belongs to: all shared-login realms together, or platform_owner alone. The subject-shape CHECK rejects any realm/subject combination that does not match, and the composite worker FK rejects a workspace that is not the actor''s own. service_role only.';

revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from public;
revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from anon;
revoke all on function public.auth_identity_assign(text,text,uuid,uuid,uuid) from authenticated;
grant execute on function public.auth_identity_assign(text,text,uuid,uuid,uuid) to service_role;

-- ===========================================================================
-- 3. auth_identity_suggest_username - searches the same namespace, so a
--    suggestion is never a name the new index would then reject.
-- ===========================================================================
create or replace function public.auth_identity_suggest_username(
  p_realm text,
  p_base  text
)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_shared constant text[] := array['worker','election_owner','multi_entity_owner'];
  v_scope  text[];
  v_base text;
  v_candidate text;
  v_n integer := 2;
begin
  if p_realm is null or p_base is null then
    raise exception 'INVALID_USERNAME';
  end if;

  -- Same normalization as auth_identity_assign, so the value offered to the
  -- Owner is exactly the value that will be stored if they accept it.
  v_base := normalize(btrim(p_base), NFC);
  if v_base = '' then
    raise exception 'INVALID_USERNAME';
  end if;

  if p_realm = any(v_shared) then
    v_scope := v_shared;
  else
    v_scope := array[p_realm];
  end if;

  if not exists (
    select 1 from public.auth_identities i
    where i.realm = any(v_scope)
      and lower(normalize(i.username, NFC)) = lower(v_base)
  ) then
    return v_base;
  end if;

  -- Bounded: 'base2' .. 'base999'. THE SUFFIX IS APPENDED DIRECTLY, WITH NO
  -- SEPARATOR - 'אלי כהן' -> 'אלי כהן2' -> 'אלי כהן3'. This is the approved
  -- product format and it deliberately differs from 20260924030000, which
  -- inserted a single space; that migration is applied to Production and is
  -- left untouched, so this replacement is the only definition that matters.
  -- A base already ending in a digit simply extends it ('user2' -> 'user22'),
  -- which is unusual to read but still correct: every candidate is checked
  -- for existence before it is offered, so a suggestion is never a name that
  -- auth_identity_assign would then refuse.
  while v_n < 1000 loop
    v_candidate := v_base || v_n::text;
    -- The suffix must not push the value past the length limit; if it does,
    -- there is nothing sensible to suggest and the Owner must choose.
    if char_length(v_candidate) <= 64
       and not exists (
         select 1 from public.auth_identities i
         where i.realm = any(v_scope)
           and lower(normalize(i.username, NFC)) = lower(v_candidate)
       )
    then
      return v_candidate;
    end if;
    v_n := v_n + 1;
  end loop;

  raise exception 'NO_USERNAME_AVAILABLE';
end;
$fn$;

comment on function public.auth_identity_suggest_username(text,text) is
  'Returns the next free login username in the namespace the realm belongs to: the base itself when it is free, otherwise "base2", "base3", ... (the suffix is appended directly, with no separator) For a shared-login realm the namespace is all shared-login realms together, so a suggestion can never be a name auth_identity_assign would then refuse. Applies the same trim + NFC normalization as auth_identity_assign, so the suggestion is exactly what would be stored. Bounded at 999 and at the 64-character limit, raising NO_USERNAME_AVAILABLE rather than looping. service_role only.';

revoke all on function public.auth_identity_suggest_username(text,text) from public;
revoke all on function public.auth_identity_suggest_username(text,text) from anon;
revoke all on function public.auth_identity_suggest_username(text,text) from authenticated;
grant execute on function public.auth_identity_suggest_username(text,text) to service_role;

commit;
