-- Budget Stage 7B Gate 4 - the official, audited Platform Owner control of a
-- module's GLOBAL availability (platform_modules.available), kept separate
-- from the per-workspace entitlements (election_workspace_modules).
--
-- Semantics (unchanged, now switchable through a product path):
--   effective access to a switchable module
--     = platform_modules.available  AND  the workspace's entitlement row.
--   Changing availability NEVER adds or removes an entitlement row: a module
--   made unavailable keeps every workspace's entitlement (inert), and making it
--   available again restores exactly those workspaces - no one else.
--
-- Only a module whose runtime actually honours the flag is switchable
-- (platform_modules.availability_switchable). Today that is exactly `budget`
-- (budget_workspace_entitled). `election_day`'s entitlement is enforced
-- regardless of the flag (election_day_workspace_has_module) and
-- `voter_management` is not a built module, so a switch there would change
-- nothing at runtime - it is refused (MODULE_AVAILABILITY_FIXED), never offered.
-- A future module that honours the flag sets availability_switchable in its
-- own migration.
--
-- Audit: every real change writes one row to the append-only
-- platform_module_availability_audit IN THE SAME TRANSACTION (a change without
-- its audit row is impossible). An identical retry changes nothing and writes
-- nothing. The workspace-entitlement audit (platform_entitlement_audit) is not
-- reused: its previous_enabled / new_enabled columns mean a workspace's
-- entitlement, and a catalog-level event has no workspace.
--
-- ACL: the new function is SECURITY DEFINER, search_path '', EXECUTE revoked BY
-- NAME from PUBLIC / anon / authenticated (hosted pg_default_acl hazard) and
-- granted to service_role only - reached only through api/platform/session.ts
-- (verifyPlatformOwnerJwt: getUser -> aal2 -> platform_owners row), and the
-- function re-resolves the Platform Owner itself.
--
-- MANUAL ROLLBACK (revert the application first; dropping the audit table
-- loses its history - keep it unless the change is abandoned):
--   begin;
--   drop function if exists public.platform_set_module_availability(uuid, text, boolean);
--   -- restore public.platform_list_workspace_modules(uuid) from 20260916000000;
--   drop table if exists public.platform_module_availability_audit;
--   alter table public.platform_modules drop column if exists availability_switchable;
--   commit;

begin;

-- ===========================================================================
-- 1. Which modules the availability switch applies to.
-- ===========================================================================
alter table public.platform_modules
  add column availability_switchable boolean not null default false;

comment on column public.platform_modules.availability_switchable is
  'Gate 4: true only for a module whose runtime honours platform_modules.available (effective access = available AND entitlement). Only such a module can be switched by platform_set_module_availability; every other module refuses with MODULE_AVAILABILITY_FIXED.';

update public.platform_modules
set availability_switchable = true
where key = 'budget';

-- ===========================================================================
-- 2. Append-only availability audit.
-- ===========================================================================
create table public.platform_module_availability_audit (
  id                                 uuid primary key default gen_random_uuid(),
  module_key                         text not null,
  previous_available                 boolean not null,
  new_available                      boolean not null,
  acting_platform_owner_auth_user_id uuid not null,
  performed_at                       timestamptz not null default now(),
  -- Only real changes are recorded; an identical retry writes nothing.
  constraint platform_module_availability_audit_change_shape
    check (previous_available <> new_available)
);

comment on table public.platform_module_availability_audit is
  'Gate 4: append-only history of every GLOBAL module availability change (platform_modules.available), written by platform_set_module_availability in the same transaction as the change. Reference columns are snapshots without foreign keys (must outlive principals). UPDATE / DELETE / TRUNCATE are refused by triggers. RLS on, zero policies, no grant to any role.';

create index platform_module_availability_audit_module_idx
  on public.platform_module_availability_audit (module_key, performed_at desc);

alter table public.platform_module_availability_audit enable row level security;
revoke all on table public.platform_module_availability_audit from public;
revoke all on table public.platform_module_availability_audit from anon;
revoke all on table public.platform_module_availability_audit from authenticated;
revoke all on table public.platform_module_availability_audit from service_role;

-- The Stage 9 refusal function is generic (raises AUDIT_IMMUTABLE, SECURITY
-- INVOKER, granted to no role); reused rather than duplicated.
create trigger platform_module_availability_audit_immutable
  before update or delete on public.platform_module_availability_audit
  for each row execute function public.platform_entitlement_audit_prevent_mutation();

create trigger platform_module_availability_audit_immutable_truncate
  before truncate on public.platform_module_availability_audit
  for each statement execute function public.platform_entitlement_audit_prevent_mutation();

-- ===========================================================================
-- 3. The switch itself.
-- ===========================================================================
create or replace function public.platform_set_module_availability(
  p_platform_owner_auth_user_id uuid,
  p_module_key text,
  p_available boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_previous boolean;
  v_switchable boolean;
  v_entitled integer;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_module_key is null or p_available is null then
    raise exception 'INVALID_MODULE_AVAILABILITY';
  end if;

  -- Serializes concurrent switches of the same module: a second, identical
  -- request waits here, then sees the new state and changes nothing.
  select pm.available, pm.availability_switchable
    into v_previous, v_switchable
  from public.platform_modules pm
  where pm.key = p_module_key
  for update;
  if not found then
    raise exception 'MODULE_NOT_FOUND';
  end if;
  if not v_switchable then
    raise exception 'MODULE_AVAILABILITY_FIXED';
  end if;

  -- Informational only: how many workspaces this switch reaches. Entitlement
  -- rows are never touched here.
  select pg_catalog.count(*)::integer into v_entitled
  from public.election_workspace_modules m
  where m.module_key = p_module_key;

  if v_previous = p_available then
    return pg_catalog.jsonb_build_object(
      'module_key', p_module_key,
      'previous_available', v_previous,
      'available', v_previous,
      'changed', false,
      'entitled_workspaces', v_entitled
    );
  end if;

  update public.platform_modules
  set available = p_available
  where key = p_module_key;

  -- Same transaction: a change without its audit row is impossible.
  insert into public.platform_module_availability_audit
    (module_key, previous_available, new_available, acting_platform_owner_auth_user_id)
  values (p_module_key, v_previous, p_available, p_platform_owner_auth_user_id);

  return pg_catalog.jsonb_build_object(
    'module_key', p_module_key,
    'previous_available', v_previous,
    'available', p_available,
    'changed', true,
    'entitled_workspaces', v_entitled
  );
end;
$fn$;

comment on function public.platform_set_module_availability(uuid, text, boolean) is
  'Gate 4: sets a switchable module''s GLOBAL availability (the platform-wide kill switch). Platform-Owner-only (re-resolves the singleton from a server-verified id); MODULE_NOT_FOUND / MODULE_AVAILABILITY_FIXED otherwise. Row-locked; an identical retry returns changed=false and writes nothing; a real change writes one platform_module_availability_audit row in the same transaction. Never adds or removes a workspace entitlement. service_role-only.';

revoke all on function public.platform_set_module_availability(uuid, text, boolean) from public;
revoke all on function public.platform_set_module_availability(uuid, text, boolean) from anon;
revoke all on function public.platform_set_module_availability(uuid, text, boolean) from authenticated;
grant execute on function public.platform_set_module_availability(uuid, text, boolean) to service_role;

-- ===========================================================================
-- 4. The Platform Owner's read also states, per module, whether it is
--    switchable and how many workspaces hold it. Identical to 20260916000000
--    otherwise (additive keys only - older clients ignore them).
-- ===========================================================================
create or replace function public.platform_list_workspace_modules(
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

  return pg_catalog.jsonb_build_object(
    'catalog', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'key', pm.key,
          'available', pm.available,
          'availability_switchable', pm.availability_switchable,
          'entitled_workspaces', (
            select pg_catalog.count(*) from public.election_workspace_modules m
            where m.module_key = pm.key
          )
        )
        order by pm.sort_order, pm.key
      )
      from public.platform_modules pm
    ), '[]'::jsonb),
    'workspaces', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'workspace_id', w.id,
          'name', w.name,
          'election_end_at', w.election_end_at,
          'owner_name', o.name,
          'owner_email', o.email,
          'modules', coalesce((
            select pg_catalog.jsonb_agg(m.module_key order by m.module_key)
            from public.election_workspace_modules m
            where m.workspace_id = w.id
          ), '[]'::jsonb)
        )
        order by w.created_at, w.id
      )
      from public.election_workspaces w
      left join public.election_owners o on o.workspace_id = w.id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.platform_list_workspace_modules(uuid) is
  'Stage 9 (+ Gate 4 catalog keys availability_switchable / entitled_workspaces): module catalog + every workspace with its current module entitlements. Platform-Owner-only (re-resolves the singleton from a server-verified id). Read-only. service_role-only.';

revoke all on function public.platform_list_workspace_modules(uuid) from public;
revoke all on function public.platform_list_workspace_modules(uuid) from anon;
revoke all on function public.platform_list_workspace_modules(uuid) from authenticated;
grant execute on function public.platform_list_workspace_modules(uuid) to service_role;

commit;
