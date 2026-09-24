-- Platform console - editing an ELECTION OWNER'S OWN ACCOUNT, and recording it.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- Until now nothing in this database updated public.election_owners. The row
-- was written once, by election_day_provision_workspace, and never touched
-- again - so a misspelled name, a changed phone number or a new e-mail address
-- had no path at all, and the console could only show them.
--
-- Two things arrive together here, deliberately:
--
--   1. platform_update_election_owner - the ONLY way that row's name, e-mail
--      and phone can change. It names exactly those three columns in its
--      UPDATE, so workspace_id, auth_user_id and therefore ownership itself
--      are not merely "not changed" but unreachable from it.
--
--   2. platform_owner_account_audit - because the console can now also change
--      an Owner's login username and set a new password on their account, and
--      a privileged action on someone else's credentials that leaves no trace
--      is the kind of thing that is only ever noticed too late.
--
-- ============================================================================
-- WHAT IS NOT IN THE AUDIT, STRUCTURALLY
-- ============================================================================
-- No password, and not by convention: `password_set` rows are CHECK-constrained
-- to an empty details object, so there is nowhere for a password to go even if
-- a future caller tried to pass one. A second CHECK refuses any details key
-- named after a secret, for the other two actions. Usernames ARE recorded -
-- they are public identifiers, they are what a login resolves, and "which name
-- did this account answer to last week" is precisely the question this table
-- exists to answer.
--
-- ============================================================================
-- AUTHORIZATION
-- ============================================================================
-- No new permission model: both functions re-resolve the Platform Owner from
-- public.platform_owners by the SERVER-VERIFIED auth user id the caller passes,
-- exactly as platform_list_workspace_modules and platform_set_workspace_modules
-- already do, and raise the same generic UNAUTHORIZED otherwise. Both are
-- REVOKEd from PUBLIC, anon and authenticated BY NAME and granted only to
-- service_role - see CLAUDE.md's permanent guardrail: this project's hosted
-- Production carries a pg_default_acl that would otherwise auto-grant EXECUTE
-- on a new public function to anon/authenticated.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   begin;
--   drop function if exists public.platform_list_activity(uuid, integer);
--   drop function if exists public.platform_record_owner_account_event(uuid, uuid, text, jsonb);
--   drop function if exists public.platform_update_election_owner(uuid, uuid, text, text, text);
--   drop table if exists public.platform_owner_account_audit;
--   drop function if exists public.platform_owner_account_audit_prevent_mutation();
--   commit;

begin;

-- ===========================================================================
-- A. The audit trail.
-- ===========================================================================
create table public.platform_owner_account_audit (
  id                                 uuid primary key default gen_random_uuid(),
  action                             text not null
                                       check (action in (
                                         'profile_updated',
                                         'username_changed',
                                         'password_set',
                                         -- The Platform Owner changing their
                                         -- OWN password. No Election Owner is
                                         -- involved, so it names no target.
                                         'self_password_set'
                                       )),
  acting_platform_owner_auth_user_id uuid not null,
  target_workspace_id_snapshot       uuid,
  target_owner_auth_user_id_snapshot uuid,
  target_owner_email_snapshot        text,
  details                            jsonb not null default '{}'::jsonb,
  performed_at                       timestamptz not null default now(),

  -- Every action against an ELECTION Owner names its target; the one action
  -- the Platform Owner performs on themselves names none. Stated as a
  -- constraint so a row can never be half-attributed.
  constraint platform_owner_account_audit_target_shape
    check (
      (action = 'self_password_set') = (
        target_workspace_id_snapshot is null
        and target_owner_auth_user_id_snapshot is null
        and target_owner_email_snapshot is null
      )
    ),
  -- Setting a password records THAT it happened and nothing else. Making this
  -- a constraint rather than a habit means no future caller can widen it.
  constraint platform_owner_account_audit_password_details_empty
    check ((action in ('password_set', 'self_password_set')) = (details = '{}'::jsonb)),
  -- And nothing that reads like secret material anywhere else either.
  constraint platform_owner_account_audit_no_secret_keys
    check (not (details ?| array[
      'password', 'new_password', 'old_password', 'secret', 'token',
      'hash', 'password_hash', 'encrypted_password'
    ]))
);

comment on table public.platform_owner_account_audit is
  'Append-only history of what a Platform Owner did to an ELECTION OWNER''s account: profile_updated (name/e-mail/phone, written in the same statement as the change), username_changed and password_set (the change itself happens in the identity directory and in the auth provider, so the row is written immediately after it succeeds). Never holds password material: password_set rows are CHECK-constrained to empty details, and a second CHECK refuses secret-looking keys on the others. Reference columns are snapshots without foreign keys - they must outlive workspaces and principals, and a FK cascade would be refused by the immutability trigger (same reasoning as multi_entity_audit). UPDATE / DELETE / TRUNCATE are refused by triggers. RLS on, zero policies, no grant to any role: written only by SECURITY DEFINER functions.';

comment on column public.platform_owner_account_audit.details is
  'Non-secret context for the action: {"changed": ["name","phone"]} for profile_updated, {"from": "...", "to": "..."} for username_changed, and always {} for password_set. Usernames are public identifiers and are recorded on purpose; passwords are not, and cannot be.';

create index platform_owner_account_audit_workspace_idx
  on public.platform_owner_account_audit (target_workspace_id_snapshot);
create index platform_owner_account_audit_performed_at_idx
  on public.platform_owner_account_audit (performed_at desc);

alter table public.platform_owner_account_audit enable row level security;
revoke all on table public.platform_owner_account_audit from public;
revoke all on table public.platform_owner_account_audit from anon;
revoke all on table public.platform_owner_account_audit from authenticated;
revoke all on table public.platform_owner_account_audit from service_role;

create or replace function public.platform_owner_account_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

comment on function public.platform_owner_account_audit_prevent_mutation() is
  'Makes platform_owner_account_audit append-only (BEFORE UPDATE/DELETE row trigger + BEFORE TRUNCATE statement trigger; TRUNCATE does not fire row triggers). SECURITY INVOKER, confers nothing; granted to no role.';

create trigger platform_owner_account_audit_immutable
  before update or delete on public.platform_owner_account_audit
  for each row execute function public.platform_owner_account_audit_prevent_mutation();

create trigger platform_owner_account_audit_immutable_truncate
  before truncate on public.platform_owner_account_audit
  for each statement execute function public.platform_owner_account_audit_prevent_mutation();

revoke all on function public.platform_owner_account_audit_prevent_mutation() from public;
revoke all on function public.platform_owner_account_audit_prevent_mutation() from anon;
revoke all on function public.platform_owner_account_audit_prevent_mutation() from authenticated;
revoke all on function public.platform_owner_account_audit_prevent_mutation() from service_role;

-- ===========================================================================
-- B. Editing the Owner's profile - name, e-mail and phone. Nothing else.
-- ===========================================================================
create or replace function public.platform_update_election_owner(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id                uuid,
  p_name                        text,
  p_email                       text,
  p_phone                       text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_owner_id    uuid;
  v_auth_user   uuid;
  v_old_name    text;
  v_old_email   text;
  v_old_phone   text;
  v_name        text;
  v_email       text;
  v_phone       text;
  v_changed     text[] := array[]::text[];
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null then
    raise exception 'INVALID_REQUEST';
  end if;

  -- Locked for the life of the transaction: the read that decides what
  -- changed and the write that applies it must see the same row.
  select o.id, o.auth_user_id, o.name, o.email, o.phone
    into v_owner_id, v_auth_user, v_old_name, v_old_email, v_old_phone
  from public.election_owners o
  where o.workspace_id = p_workspace_id
  for update;

  if v_owner_id is null then
    raise exception 'OWNER_NOT_FOUND';
  end if;

  v_name  := btrim(coalesce(p_name, ''));
  v_email := pg_catalog.lower(btrim(coalesce(p_email, '')));
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_name = '' or pg_catalog.length(v_name) > 120 then
    raise exception 'INVALID_NAME';
  end if;

  -- Deliberately a shape check, not an attempt to decide what a valid address
  -- is: the column is NOT NULL and the console validates too. This only keeps
  -- something that is not an address at all out of the record.
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or pg_catalog.length(v_email) > 254 then
    raise exception 'INVALID_EMAIL';
  end if;

  -- The canonical Israeli form this project stores everywhere. Stated here as
  -- well as in api/platform/session.ts's normalizedIsraeliPhone and the
  -- coordinator migration's SQL block - three statements of one rule, each
  -- cross-referenced, so the database is authoritative for what it holds.
  if v_phone is not null and v_phone !~ '^0[0-9]{8,9}$' then
    raise exception 'INVALID_PHONE';
  end if;

  -- The casts are required, not decorative: `text[] || 'name'` makes Postgres
  -- read the literal as an ARRAY literal and fail on the missing braces.
  if v_name  is distinct from v_old_name  then v_changed := v_changed || 'name'::text;  end if;
  if v_email is distinct from v_old_email then v_changed := v_changed || 'email'::text; end if;
  if v_phone is distinct from v_old_phone then v_changed := v_changed || 'phone'::text; end if;

  -- Nothing actually changed: no write, and no audit row. An audit of
  -- "someone pressed save" is noise that makes the real entries harder to see.
  if pg_catalog.cardinality(v_changed) = 0 then
    return pg_catalog.jsonb_build_object(
      'name', v_old_name, 'email', v_old_email, 'phone', v_old_phone,
      'changed', pg_catalog.to_jsonb(v_changed)
    );
  end if;

  -- THREE COLUMNS. workspace_id and auth_user_id are not in this statement, so
  -- this function cannot move an Owner between systems or between accounts
  -- however it is called.
  update public.election_owners o
  set name = v_name,
      email = v_email,
      phone = v_phone,
      updated_at = pg_catalog.now()
  where o.id = v_owner_id;

  insert into public.platform_owner_account_audit (
    action,
    acting_platform_owner_auth_user_id,
    target_workspace_id_snapshot,
    target_owner_auth_user_id_snapshot,
    target_owner_email_snapshot,
    details
  ) values (
    'profile_updated',
    p_platform_owner_auth_user_id,
    p_workspace_id,
    v_auth_user,
    v_email,
    pg_catalog.jsonb_build_object('changed', pg_catalog.to_jsonb(v_changed))
  );

  return pg_catalog.jsonb_build_object(
    'name', v_name, 'email', v_email, 'phone', v_phone,
    'changed', pg_catalog.to_jsonb(v_changed)
  );
end;
$fn$;

comment on function public.platform_update_election_owner(uuid, uuid, text, text, text) is
  'The ONLY path that updates an Election Owner''s name, e-mail or phone. Platform-Owner-only (re-resolves the singleton from a server-verified auth user id). Locks the Owner row, normalizes and validates, writes ONLY those three columns - workspace_id and auth_user_id are absent from the UPDATE, so ownership cannot move - and records one platform_owner_account_audit row in the SAME transaction, but only when something really changed. service_role only.';

revoke all on function public.platform_update_election_owner(uuid, uuid, text, text, text) from public;
revoke all on function public.platform_update_election_owner(uuid, uuid, text, text, text) from anon;
revoke all on function public.platform_update_election_owner(uuid, uuid, text, text, text) from authenticated;
grant execute on function public.platform_update_election_owner(uuid, uuid, text, text, text) to service_role;

-- ===========================================================================
-- C. Recording the two changes that do NOT happen in this database.
-- ===========================================================================
-- A username lives in auth_identities and is moved by auth_identity_release +
-- auth_identity_assign; a password lives in the auth provider and is set
-- through its Admin API. Neither can be written in the same transaction as its
-- audit row, so the server calls this immediately after the change succeeds.
-- 'profile_updated' is deliberately NOT accepted here: that action has exactly
-- one writer, the function above, and keeping it that way is what makes a
-- profile_updated row proof that the column actually changed.
create or replace function public.platform_record_owner_account_event(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id                uuid,
  p_action                      text,
  p_details                     jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_auth_user uuid;
  v_email     text;
  v_id        uuid;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_action is null
     or p_action not in ('username_changed', 'password_set', 'self_password_set') then
    raise exception 'INVALID_REQUEST';
  end if;

  -- The Platform Owner acting on their own account names no Election Owner.
  if p_action <> 'self_password_set' then
    select o.auth_user_id, o.email into v_auth_user, v_email
    from public.election_owners o
    where o.workspace_id = p_workspace_id;

    if v_auth_user is null then
      raise exception 'OWNER_NOT_FOUND';
    end if;
  end if;

  insert into public.platform_owner_account_audit (
    action,
    acting_platform_owner_auth_user_id,
    target_workspace_id_snapshot,
    target_owner_auth_user_id_snapshot,
    target_owner_email_snapshot,
    details
  ) values (
    p_action,
    p_platform_owner_auth_user_id,
    case when p_action = 'self_password_set' then null else p_workspace_id end,
    v_auth_user,
    v_email,
    case when p_action in ('password_set', 'self_password_set')
         then '{}'::jsonb
         else coalesce(p_details, '{}'::jsonb)
    end
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.platform_record_owner_account_event(uuid, uuid, text, jsonb) is
  'Records a username_changed, password_set or self_password_set event, for the two changes that happen outside this database (the identity directory and the auth provider). Platform-Owner-only, same boundary as every other platform_* function. A password_set row''s details are forced to {} here as well as by the table''s CHECK - the caller cannot supply them even by accident. Refuses profile_updated: that action has exactly one writer. service_role only.';

revoke all on function public.platform_record_owner_account_event(uuid, uuid, text, jsonb) from public;
revoke all on function public.platform_record_owner_account_event(uuid, uuid, text, jsonb) from anon;
revoke all on function public.platform_record_owner_account_event(uuid, uuid, text, jsonb) from authenticated;
grant execute on function public.platform_record_owner_account_event(uuid, uuid, text, jsonb) to service_role;


-- ===========================================================================
-- D. Reading the activity log.
-- ===========================================================================
-- The console's "יומן פעולות" showed a placeholder because every audit table
-- in this project is RLS-on / zero-policy / no-grant, readable only through a
-- SECURITY DEFINER function - and none existed. This is that function.
--
-- It READS, and it reads only what was actually recorded. Nothing is derived,
-- inferred or back-filled: an action that was never audited simply does not
-- appear, which is the honest answer and the reason the placeholder said so
-- rather than inventing a history.
--
-- Four sources, normalized to one shape. They are the Platform Owner's own
-- decisions - who was given what, which modules moved, what was done to an
-- Owner's account - which is what this screen is for. Budget's own audit is
-- deliberately NOT here: it belongs to a workspace's finances, has its own
-- privacy review, and is not a platform-administration event.
create or replace function public.platform_list_activity(
  p_platform_owner_auth_user_id uuid,
  p_limit                       integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_limit integer;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  return coalesce((
    select pg_catalog.jsonb_agg(
             pg_catalog.to_jsonb(e) order by e.at desc, e.source, e.id
           )
    from (
      select * from (
      -- What a Platform Owner did to an Election Owner's account.
      select a.id::text                            as id,
             'owner_account'                       as source,
             a.action                              as action,
             a.performed_at                        as at,
             a.target_owner_email_snapshot         as subject,
             w.name                                as workspace,
             a.details                             as details
      from public.platform_owner_account_audit a
      left join public.election_workspaces w
        on w.id = a.target_workspace_id_snapshot

      union all

      -- Every module-entitlement decision.
      select e.id::text,
             'entitlement',
             e.action,
             e.performed_at,
             e.module_key,
             e.workspace_name_snapshot,
             pg_catalog.jsonb_build_object(
               'previous_enabled', e.previous_enabled,
               'new_enabled', e.new_enabled
             )
      from public.platform_entitlement_audit e

      union all

      -- The global availability switch.
      select m.id::text,
             'module_availability',
             case when m.new_available then 'enabled' else 'disabled' end,
             m.performed_at,
             m.module_key,
             null,
             pg_catalog.jsonb_build_object(
               'previous_available', m.previous_available,
               'new_available', m.new_available
             )
      from public.platform_module_availability_audit m

      union all

      -- The Multi-Entity Owner lifecycle.
      select me.id::text,
             'multi_entity',
             me.action,
             me.performed_at,
             me.attempted_email,
             me.workspace_name_snapshot,
             '{}'::jsonb
      from public.multi_entity_audit me
      ) u
      where u.at is not null
      order by u.at desc
      limit v_limit
    ) e
  ), '[]'::jsonb);
end;
$fn$;

comment on function public.platform_list_activity(uuid, integer) is
  'Read-only platform activity: the Owner-account audit, the module-entitlement audit, the global module-availability audit and the Multi-Entity Owner audit, normalized to {id, source, action, at, subject, workspace, details} and ordered newest first. Reports ONLY what those tables actually hold - nothing is derived or back-filled, and an unaudited action does not appear. Platform-Owner-only (re-resolves the singleton from a server-verified auth user id); reads no credential material, and the account audit cannot hold any. service_role only.';

revoke all on function public.platform_list_activity(uuid, integer) from public;
revoke all on function public.platform_list_activity(uuid, integer) from anon;
revoke all on function public.platform_list_activity(uuid, integer) from authenticated;
grant execute on function public.platform_list_activity(uuid, integer) to service_role;

commit;
