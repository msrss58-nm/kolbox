-- Platform Stage 8B - Election Owner approval recovery.
--
-- Stage 3B let the Platform Owner approve a new Election Owner, but offered no
-- way back once the one-time link was lost, failed to generate, or expired:
-- create_owner_access creates a NEW Auth user before anything else, so a
-- re-approval of the same address always failed on GoTrue's unique email, and
-- platform_create_pending_owner_access's idempotent branch (keyed on
-- auth_user_id) was unreachable. This migration adds the three read/write
-- primitives the console needs, and nothing else:
--
--   1. platform_list_owner_access           - every approval, with its state
--   2. platform_reissue_pending_owner_access - re-issue access for ONE approval
--   3. platform_classify_owner_access_email  - decide, BEFORE any Auth user is
--                                              created, what an address is
--
-- Business rules (the whole contract):
--   active   (not consumed, expires_at > now)  -> a new link may be issued; the
--                                                window is NOT extended.
--   expired  (not consumed, expires_at <= now) -> may be renewed: a new window of
--                                                p_expires_in_days, then a link.
--   consumed (the Owner provisioned)           -> never re-issued. One Owner per
--                                                workspace is untouched.
--   An approval whose Auth account has since become a Platform Owner, an
--   Election Owner or the Multi-Entity Owner is refused.
--
-- NO table, column, constraint, index, trigger, policy or existing-function
-- change. +3 functions, all postgres-owned SECURITY DEFINER with an empty
-- search_path, each re-resolving the singleton platform_owners row from a
-- server-verified id, EXECUTE revoked from PUBLIC/anon/authenticated BY NAME
-- (the hosted pg_default_acl hazard) and granted to service_role only.
--
-- The "adoptable" classification relies on a marker the API now sets in
-- app_metadata when it creates an approval's Auth user
-- (kolbox_mint = 'election_owner_approval'). app_metadata is writable only
-- through the service-role Admin API, never by the account holder, so an
-- unheld account carrying it can only be one this flow created and then failed
-- to attach - a campaign user or any other account never carries it and is
-- never adopted.
--
-- MANUAL ROLLBACK (revert the application first - the API calls these):
--   drop function if exists public.platform_classify_owner_access_email(uuid, text);
--   drop function if exists public.platform_reissue_pending_owner_access(uuid, uuid, integer);
--   drop function if exists public.platform_list_owner_access(uuid);

-- ===========================================================================
-- 1. List every approval.
-- ===========================================================================
create or replace function public.platform_list_owner_access(
  p_platform_owner_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  -- State follows Phase 0 Design Note 3: consumed_at/expires_at are
  -- authoritative, status may lag, so status is never read on its own for
  -- expiry. workspace_name is present only once the Owner has provisioned.
  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'pending_id', pa.id,
        'name', pa.name,
        'email', pa.email,
        'phone', pa.phone,
        'created_at', pa.created_at,
        'expires_at', pa.expires_at,
        'consumed_at', pa.consumed_at,
        'state', case
          when pa.consumed_at is not null then 'consumed'
          when pa.expires_at <= pg_catalog.now() then 'expired'
          else 'active'
        end,
        'workspace_name', w.name
      )
      order by pa.created_at desc, pa.id
    )
    from public.election_workspace_pending_owner_access pa
    left join public.election_owners o on o.auth_user_id = pa.auth_user_id
    left join public.election_workspaces w on w.id = o.workspace_id
  ), '[]'::jsonb);
end;
$fn$;

comment on function public.platform_list_owner_access(uuid) is
  'Stage 8B: every Election Owner approval (pending-access row) with its derived state (active / expired / consumed) and, once provisioned, its workspace name. Platform-Owner-only (re-resolves the singleton from a server-verified id). Read-only. service_role-only.';

revoke all on function public.platform_list_owner_access(uuid) from public;
revoke all on function public.platform_list_owner_access(uuid) from anon;
revoke all on function public.platform_list_owner_access(uuid) from authenticated;
grant execute on function public.platform_list_owner_access(uuid) to service_role;

-- ===========================================================================
-- 2. Re-issue access for one approval.
-- ===========================================================================
create or replace function public.platform_reissue_pending_owner_access(
  p_platform_owner_auth_user_id uuid,
  p_pending_id uuid,
  p_expires_in_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_days integer;
  v_auth uuid;
  v_consumed timestamptz;
  v_expires timestamptz;
  v_held text;
  v_renewed boolean := false;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_pending_id is null then
    raise exception 'INVALID_PENDING_ID';
  end if;

  v_days := coalesce(p_expires_in_days, 7);
  if v_days < 1 or v_days > 30 then
    raise exception 'INVALID_EXPIRY_WINDOW';
  end if;

  -- Row lock: serializes with election_day_provision_workspace, which takes
  -- the same row FOR UPDATE before consuming it. Whichever commits first wins;
  -- the other sees the committed state.
  select pa.auth_user_id, pa.consumed_at, pa.expires_at
    into v_auth, v_consumed, v_expires
  from public.election_workspace_pending_owner_access pa
  where pa.id = p_pending_id
  for update;

  if v_auth is null then
    raise exception 'PENDING_ACCESS_NOT_FOUND';
  end if;

  if v_consumed is not null then
    raise exception 'PENDING_ACCESS_ALREADY_CONSUMED';
  end if;

  -- 'pending_owner' is this very row and is expected. Any other holder means
  -- the account now belongs to a principal and must not receive a link.
  v_held := public.multi_entity_auth_user_held_by(v_auth);
  if v_held = 'election' then
    raise exception 'OWNER_ALREADY_PROVISIONED';
  elsif v_held in ('platform', 'multi_entity') then
    raise exception 'IDENTITY_ALREADY_PRINCIPAL';
  end if;

  if v_expires <= pg_catalog.now() then
    v_expires := pg_catalog.now() + (v_days || ' days')::interval;
    update public.election_workspace_pending_owner_access
    set status = 'pending',
        expires_at = v_expires
    where id = p_pending_id;
    v_renewed := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'pending_id', p_pending_id,
    'auth_user_id', v_auth,
    'expires_at', v_expires,
    'renewed', v_renewed
  );
end;
$fn$;

comment on function public.platform_reissue_pending_owner_access(uuid, uuid, integer) is
  'Stage 8B: prepares a re-issue of one Election Owner approval. Active -> unchanged window; expired -> renewed for p_expires_in_days (1-30); consumed -> PENDING_ACCESS_ALREADY_CONSUMED; account now held by another principal -> OWNER_ALREADY_PROVISIONED / IDENTITY_ALREADY_PRINCIPAL. Creates no Auth user and no workspace; the caller mints the link. Row-locked against concurrent provisioning. Platform-Owner-only. service_role-only.';

revoke all on function public.platform_reissue_pending_owner_access(uuid, uuid, integer) from public;
revoke all on function public.platform_reissue_pending_owner_access(uuid, uuid, integer) from anon;
revoke all on function public.platform_reissue_pending_owner_access(uuid, uuid, integer) from authenticated;
grant execute on function public.platform_reissue_pending_owner_access(uuid, uuid, integer) to service_role;

-- ===========================================================================
-- 3. Classify an address BEFORE any Auth user is created.
-- ===========================================================================
create or replace function public.platform_classify_owner_access_email(
  p_platform_owner_auth_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_email text;
  v_pending uuid;
  v_ids uuid[];
  v_auth uuid;
  v_held text;
  v_marker text;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  if v_email = '' then
    raise exception 'MISSING_OWNER_EMAIL';
  end if;

  -- An approval already exists for this address: the console re-issues it
  -- from the approvals list instead of creating anything.
  select pa.id into v_pending
  from public.election_workspace_pending_owner_access pa
  where pg_catalog.lower(pa.email) = v_email
  order by pa.created_at desc, pa.id
  limit 1;
  if v_pending is not null then
    return pg_catalog.jsonb_build_object(
      'classification', 'approval_exists', 'pending_id', v_pending);
  end if;

  select pg_catalog.array_agg(u.id) into v_ids
  from auth.users u
  where pg_catalog.lower(u.email) = v_email;

  if v_ids is null then
    return pg_catalog.jsonb_build_object('classification', 'new');
  end if;
  if pg_catalog.cardinality(v_ids) > 1 then
    return pg_catalog.jsonb_build_object('classification', 'registered');
  end if;

  v_auth := v_ids[1];
  v_held := public.multi_entity_auth_user_held_by(v_auth);
  if v_held = 'pending_owner' then
    -- The account's approval row carries a different address than the account
    -- itself (the row is found by auth_user_id, not by email).
    select pa.id into v_pending
    from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = v_auth;
    return pg_catalog.jsonb_build_object(
      'classification', 'approval_exists', 'pending_id', v_pending);
  end if;
  if v_held is not null then
    return pg_catalog.jsonb_build_object('classification', 'registered');
  end if;

  select u.raw_app_meta_data ->> 'kolbox_mint' into v_marker
  from auth.users u
  where u.id = v_auth;

  if v_marker = 'election_owner_approval' then
    -- An account this flow created whose approval was never recorded (the
    -- pending insert failed and the compensating delete could not be
    -- confirmed). Re-using it resumes that attempt; no duplicate is created.
    return pg_catalog.jsonb_build_object(
      'classification', 'adoptable', 'auth_user_id', v_auth);
  end if;

  return pg_catalog.jsonb_build_object('classification', 'registered');
end;
$fn$;

comment on function public.platform_classify_owner_access_email(uuid, text) is
  'Stage 8B: classifies an address before create_owner_access creates any Auth user - approval_exists (+pending_id) / new / adoptable (+auth_user_id: an unheld account carrying the service-role-only app_metadata marker kolbox_mint=election_owner_approval, i.e. a previous failed attempt of this same flow) / registered (any other existing account, never adopted). Read-only. Platform-Owner-only. service_role-only.';

revoke all on function public.platform_classify_owner_access_email(uuid, text) from public;
revoke all on function public.platform_classify_owner_access_email(uuid, text) from anon;
revoke all on function public.platform_classify_owner_access_email(uuid, text) from authenticated;
grant execute on function public.platform_classify_owner_access_email(uuid, text) to service_role;
