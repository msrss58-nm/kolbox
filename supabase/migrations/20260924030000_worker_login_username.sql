-- ===========================================================================
-- KOLBOX unified identity - the Manager/User login username.
--
-- THE RULE. A worker's DEFAULT login username is simply their name as the
-- Owner typed it (first name + last name). That name is only workspace-scoped
-- unique, but the Users login screen carries no system code and no workspace
-- selector, so the login username must be unique across EVERY workspace. The
-- two therefore cannot be the same value:
--
--   election_day_permission_users.name   DISPLAY name, workspace-scoped,
--                                        may duplicate freely across
--                                        workspaces (Stage 3A, untouched).
--   auth_identities.username             LOGIN name, unique within the
--                                        'worker' realm, i.e. globally.
--
-- COLLISIONS ARE A PRODUCT FLOW, NOT AN ERROR. When the default is already
-- taken, the Owner must not be handed a generic failure. The handler asks
-- auth_identity_suggest_username for the next free value and offers it:
--   'אלי כהן' -> 'אלי כהן 2' -> 'אלי כהן 3' ...
-- The Owner may accept it or type any other valid username.
--
-- ATOMICITY. Creating the worker and claiming the username happen in ONE
-- transaction (v4 wraps v3), so a taken username can never leave behind a
-- worker who exists but cannot log in.
-- ===========================================================================

-- ROLLBACK (manual):
--   begin;
--   drop function if exists public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text);
--   drop function if exists public.auth_identity_suggest_username(text,text);
--   commit;
-- MUST be preceded by reverting api/election-day/owner-actions.ts, whose
-- create_permission_user op calls v4. v3 is untouched by this migration and
-- remains the fallback creation path.

begin;

-- ===========================================================================
-- 1. auth_identity_suggest_username - the next free name in a realm.
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

  if not exists (
    select 1 from public.auth_identities i
    where i.realm = p_realm
      and lower(normalize(i.username, NFC)) = lower(v_base)
  ) then
    return v_base;
  end if;

  -- Bounded: 'base 2' .. 'base 999'. A suffix is appended with a single
  -- space, which the username format explicitly allows.
  while v_n < 1000 loop
    v_candidate := v_base || ' ' || v_n::text;
    -- The suffix must not push the value past the length limit; if it does,
    -- there is nothing sensible to suggest and the Owner must choose.
    if char_length(v_candidate) <= 64
       and not exists (
         select 1 from public.auth_identities i
         where i.realm = p_realm
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
  'Returns the next free login username in a realm: the base itself when it is free, otherwise "base 2", "base 3", ... Applies the same trim + NFC normalization as auth_identity_assign, so the suggestion is exactly what would be stored. Bounded at 999 and at the 64-character limit, raising NO_USERNAME_AVAILABLE rather than looping. service_role only.';

revoke all on function public.auth_identity_suggest_username(text,text) from public;
revoke all on function public.auth_identity_suggest_username(text,text) from anon;
revoke all on function public.auth_identity_suggest_username(text,text) from authenticated;
grant execute on function public.auth_identity_suggest_username(text,text) to service_role;

-- ===========================================================================
-- 2. election_day_create_permission_user_owner_v4
--    v3 plus the login username, in one transaction.
--
--    v3 is called rather than copied, so the Owner proof consumption, the
--    workspace re-resolution, the role check and the password hashing all
--    stay in exactly one place. If the username is taken, auth_identity_assign
--    raises and the whole transaction - including v3's insert - rolls back.
-- ===========================================================================
create or replace function public.election_day_create_permission_user_owner_v4(
  p_auth_user_id      uuid,
  p_reauth_proof_hash bytea,
  p_name              text,
  p_password          text,
  p_role_id           uuid,
  p_username          text
)
returns table (id uuid, name text, role_id uuid, workspace_id uuid, username text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
  v_name text;
  v_role uuid;
  v_ws uuid;
  v_username text;
begin
  select c.id, c.name, c.role_id, c.workspace_id
    into v_id, v_name, v_role, v_ws
  from public.election_day_create_permission_user_owner_v3(
         p_auth_user_id, p_reauth_proof_hash, p_name, p_password, p_role_id) c;

  if v_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Default the login username to the name the Owner typed. An explicit
  -- username always wins, so the Owner can accept a suggestion or choose
  -- something else entirely.
  v_username := coalesce(nullif(btrim(coalesce(p_username, '')), ''), v_name);

  perform public.auth_identity_assign('worker', v_username, null, v_id, v_ws);

  return query
    select v_id, v_name, v_role, v_ws, normalize(btrim(v_username), NFC);
end;
$fn$;

comment on function public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text) is
  'Creates a Manager/User AND claims their globally-unique login username in ONE transaction, so a username collision can never leave a worker who exists but cannot sign in. Delegates every existing check to election_day_create_permission_user_owner_v3 rather than duplicating it. The username defaults to the name the Owner typed; USERNAME_TAKEN is a normal product outcome the handler answers with a suggestion, not a generic failure. service_role only.';

revoke all on function public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text) from public;
revoke all on function public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text) from anon;
revoke all on function public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text) from authenticated;
grant execute on function public.election_day_create_permission_user_owner_v4(uuid,bytea,text,text,uuid,text) to service_role;

commit;
