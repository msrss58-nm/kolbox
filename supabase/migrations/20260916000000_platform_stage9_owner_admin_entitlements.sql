-- Platform Stage 9 - Election Owner administration + workspace module entitlements.
--
-- Three authorization layers, deliberately kept separate:
--   1. PLATFORM ENTITLEMENT  - which product modules a workspace may use
--                              (platform_modules + election_workspace_modules),
--                              decided by the Platform Owner.
--   2. OWNER ADMINISTRATION  - the Election Owner manages the workspace's users
--                              and roles (the *_owner_v3 functions below).
--   3. PERMISSIONUSER ROLES  - what a worker may do inside an ENABLED module
--                              (election_day_roles.permissions, unchanged).
--
-- What this migration does:
--   A. Module catalog + per-workspace entitlements (normalized; a future module
--      is one catalog row). Existing workspaces are backfilled with
--      election_day ONLY (approved product decision). Voter Management and
--      Budget are catalogued with available=false: recorded and editable, not
--      enforced until those modules exist as workspace-scoped server modules.
--   B. Approvals carry the Platform Owner's explicit module choice
--      (requested_modules) until provisioning copies it into the entitlement
--      table IN THE SAME TRANSACTION that creates the workspace. Each approval
--      also records the approving Platform Owner. An approval with NO recorded
--      choice (pre-Stage-9) FAILS CLOSED at provisioning (APPROVAL_MODULES_
--      MISSING): nothing is created and nothing is inferred. The 6-argument
--      approval function loses its service_role grant, so no module-less
--      approval can be created any more (not even by a still-deployed build).
--   F. Append-only public.platform_entitlement_audit: approval selection,
--      provisioning grant, enable, disable and the migration backfill - each
--      row written in the same statement/transaction as the change it records;
--      UPDATE / DELETE / TRUNCATE refused by triggers.
--   G. Multi-Entity aggregates: an assigned, not-ended workspace that is not
--      entitled to Election Day reports 'unavailable' with NO numbers (checked
--      before any voter row is read). 'ended' and the <10 'suppressed' rules
--      are unchanged.
--   C. Election Day entitlement enforced in the DATABASE for every worker
--      path: election_day_login_v3 refuses (MODULE_NOT_ENABLED, only after the
--      password verified) and election_day_resolve_session - the resolver
--      every worker *_v3 RPC goes through - resolves nothing. The Owner's
--      Election Day data operations are gated by the server handler through
--      election_day_owner_has_module (those RPCs are service_role-only, so no
--      browser can reach them around the handler). Owner administration
--      (users, roles) stays available when Election Day is not entitled.
--   D. User management moves to the Election Owner: list/create/delete/reset
--      *_owner_v3, Owner JWT + one-time Owner proof, workspace re-resolved
--      live. Reset is refused for users whose role carries is_manager
--      (new explicit role flag; backfilled from the existing admin-permission
--      holders, which on Production are exactly the two "מנהל" roles).
--   E. The worker-side user-management RPCs and the first-user bootstrap RPC
--      lose service_role EXECUTE (they had no other grant), so no deployed
--      handler can reach them any more. Nothing is dropped.
--
-- ACL: every new function is SECURITY DEFINER, search_path '', EXECUTE revoked
-- BY NAME from PUBLIC/anon/authenticated (hosted pg_default_acl hazard) and
-- granted to service_role only, or to no role at all for internal helpers.
-- New tables: RLS enabled, zero policies, anon/authenticated revoked.
--
-- MANUAL ROLLBACK (revert the application first - it calls the new RPCs):
--   begin;
--   grant execute on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) to service_role;
--   grant execute on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) to service_role;
--   grant execute on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) to service_role;
--   grant execute on function public.election_day_list_permission_users_v3(bytea) to service_role;
--   grant execute on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) to service_role;
--   -- restore the previous bodies of election_day_resolve_session (20260826010000),
--   -- election_day_login_v3 (20260909010000), election_day_provision_workspace
--   -- (20260915000000), election_day_seed_new_workspace (20260910000000),
--   -- election_day_clone_role_owner_v3 (20260828070000), platform_list_owner_access
--   -- (20260914000000) and election_day_list_roles_owner_v3 (20260829000000);
--   grant execute on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) to service_role;
--   -- restore multi_entity_compute_workspace_aggregate's 20260913000000 body;
--   drop table if exists public.platform_entitlement_audit;
--   drop function if exists public.platform_entitlement_audit_prevent_mutation();
--   alter table public.election_workspace_pending_owner_access drop column if exists approved_by_platform_owner_auth_user_id;
--   drop function if exists public.platform_set_workspace_modules(uuid, uuid, text[]);
--   drop function if exists public.platform_list_workspace_modules(uuid);
--   drop function if exists public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]);
--   drop function if exists public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text);
--   drop function if exists public.election_day_delete_permission_user_owner_v3(uuid, bytea, uuid);
--   drop function if exists public.election_day_create_permission_user_owner_v3(uuid, bytea, text, text, uuid);
--   drop function if exists public.election_day_list_permission_users_owner_v3(uuid);
--   drop function if exists public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text, boolean);
--   drop function if exists public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text, boolean);
--   drop function if exists public.election_day_list_workspace_modules_owner_v3(uuid);
--   drop function if exists public.election_day_owner_has_module(uuid, text);
--   drop function if exists public.election_day_workspace_has_module(uuid, text);
--   drop function if exists public.election_day_normalize_modules(text[]);
--   alter table public.election_day_roles drop column if exists is_manager;
--   alter table public.election_workspace_pending_owner_access drop column if exists requested_modules;
--   drop table if exists public.election_workspace_modules;
--   drop table if exists public.platform_modules;
--   commit;

begin;

-- ===========================================================================
-- A. Module catalog + workspace entitlements.
-- ===========================================================================
create table public.platform_modules (
  key text primary key,
  sort_order integer not null,
  available boolean not null default false,
  created_at timestamptz not null default now(),
  constraint platform_modules_key_format_check check (key ~ '^[a-z][a-z0-9_]{1,62}$')
);

comment on table public.platform_modules is
  'Stage 9: the product-module catalog. available=false means the module is recorded and assignable but not yet a workspace-scoped server module, so its entitlement is not enforced anywhere yet. Adding a module is one INSERT here.';

insert into public.platform_modules (key, sort_order, available) values
  ('voter_management', 1, false),
  ('election_day', 2, true),
  ('budget', 3, false);

alter table public.platform_modules enable row level security;
revoke all on table public.platform_modules from public;
revoke all on table public.platform_modules from anon;
revoke all on table public.platform_modules from authenticated;
-- The Platform approval handler reads the catalog (to refuse an unknown module
-- BEFORE it creates any Auth user); it never writes it.
revoke all on table public.platform_modules from service_role;
grant select on table public.platform_modules to service_role;

create table public.election_workspace_modules (
  workspace_id uuid not null references public.election_workspaces (id) on delete cascade,
  module_key text not null references public.platform_modules (key) on delete restrict,
  enabled_at timestamptz not null default now(),
  primary key (workspace_id, module_key)
);

create index election_workspace_modules_module_key_idx
  on public.election_workspace_modules (module_key);

comment on table public.election_workspace_modules is
  'Stage 9: which product modules a workspace is entitled to (platform licensing). NOT a role permission - a worker still needs a role permission inside an entitled module. Written only by provisioning and platform_set_workspace_modules.';

alter table public.election_workspace_modules enable row level security;
revoke all on table public.election_workspace_modules from public;
revoke all on table public.election_workspace_modules from anon;
revoke all on table public.election_workspace_modules from authenticated;
-- Entitlements are written ONLY by the DEFINER functions below (provisioning
-- and platform_set_workspace_modules, which re-resolve the Platform Owner), so
-- no server code path can grant a module by writing the table directly.
revoke all on table public.election_workspace_modules from service_role;

-- The existing-workspace backfill runs further down, once the audit table
-- exists, so every backfilled grant is audited in the same statement.

-- ===========================================================================
-- B. Approvals carry the requested modules until provisioning.
-- ===========================================================================
alter table public.election_workspace_pending_owner_access
  add column requested_modules text[];

alter table public.election_workspace_pending_owner_access
  add constraint election_workspace_pending_owner_access_requested_modules_check
  check (requested_modules is null or pg_catalog.cardinality(requested_modules) >= 1);

comment on column public.election_workspace_pending_owner_access.requested_modules is
  'Stage 9: the Platform Owner''s explicit module choice at approval time, copied into election_workspace_modules when the Owner provisions. NULL only for approvals created before Stage 9 - provisioning REFUSES those (APPROVAL_MODULES_MISSING); nothing is inferred.';

alter table public.election_workspace_pending_owner_access
  add column approved_by_platform_owner_auth_user_id uuid;

-- A module choice is always attributed; a legacy row has neither.
alter table public.election_workspace_pending_owner_access
  add constraint election_workspace_pending_owner_access_approved_by_shape
  check ((requested_modules is null) = (approved_by_platform_owner_auth_user_id is null));

comment on column public.election_workspace_pending_owner_access.approved_by_platform_owner_auth_user_id is
  'Stage 9: snapshot of the approving Platform Owner''s auth.users id, so the entitlement granted at provisioning is attributed to the Platform Owner who chose it. Deliberately not a foreign key (audit attribution must outlive the principal).';

-- ===========================================================================
-- F. Append-only entitlement audit.
-- ===========================================================================
create table public.platform_entitlement_audit (
  id                                 uuid primary key default gen_random_uuid(),
  action                             text not null
                                       check (action in (
                                         'approval_selected',
                                         'provisioning_granted',
                                         'enabled',
                                         'disabled',
                                         'backfill_granted'
                                       )),
  module_key                         text not null,
  workspace_id_snapshot              uuid,
  workspace_name_snapshot            text,
  pending_access_id_snapshot         uuid,
  previous_enabled                   boolean,
  new_enabled                        boolean not null,
  acting_platform_owner_auth_user_id uuid,
  acting_auth_user_id                uuid,
  performed_at                       timestamptz not null default now(),

  -- An approval precedes its workspace; every other row names one.
  constraint platform_entitlement_audit_workspace_shape
    check ((action = 'approval_selected') = (workspace_id_snapshot is null)),
  constraint platform_entitlement_audit_workspace_name_shape
    check ((workspace_id_snapshot is null) = (workspace_name_snapshot is null)),
  constraint platform_entitlement_audit_pending_shape
    check ((action in ('approval_selected', 'provisioning_granted')) = (pending_access_id_snapshot is not null)),
  -- Only the migration backfill has no Platform Owner behind it.
  constraint platform_entitlement_audit_platform_owner_shape
    check ((action = 'backfill_granted') = (acting_platform_owner_auth_user_id is null)),
  constraint platform_entitlement_audit_actor_shape
    check ((action = 'backfill_granted') = (acting_auth_user_id is null)),
  constraint platform_entitlement_audit_state_shape
    check (
      (action = 'approval_selected' and previous_enabled is null and new_enabled)
      or (action in ('provisioning_granted', 'enabled', 'backfill_granted')
          and previous_enabled = false and new_enabled)
      or (action = 'disabled' and previous_enabled and not new_enabled)
    )
);

comment on table public.platform_entitlement_audit is
  'Stage 9: append-only history of every workspace module-entitlement decision - approval_selected (the Platform Owner''s choice at approval; no workspace yet), provisioning_granted (copied onto the new workspace; attributed to the approving Platform Owner, executed by the Election Owner), enabled / disabled (Platform Owner edits; only real changes), backfill_granted (this migration). Every row is written in the same statement or transaction as the change it records. UPDATE / DELETE / TRUNCATE are refused by triggers. Reference columns are snapshots without foreign keys (must outlive workspaces and principals, and a FK cascade would be refused by the immutability trigger - see multi_entity_audit). RLS on, zero policies, no grant to any role: written only by SECURITY DEFINER functions.';

create index platform_entitlement_audit_workspace_id_snapshot_idx
  on public.platform_entitlement_audit (workspace_id_snapshot);
create index platform_entitlement_audit_performed_at_idx
  on public.platform_entitlement_audit (performed_at desc);

alter table public.platform_entitlement_audit enable row level security;
revoke all on table public.platform_entitlement_audit from public;
revoke all on table public.platform_entitlement_audit from anon;
revoke all on table public.platform_entitlement_audit from authenticated;
revoke all on table public.platform_entitlement_audit from service_role;

create or replace function public.platform_entitlement_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

comment on function public.platform_entitlement_audit_prevent_mutation() is
  'Stage 9: makes platform_entitlement_audit append-only (BEFORE UPDATE/DELETE row trigger + BEFORE TRUNCATE statement trigger; TRUNCATE does not fire row triggers). SECURITY INVOKER, confers nothing; granted to no role.';

create trigger platform_entitlement_audit_immutable
  before update or delete on public.platform_entitlement_audit
  for each row execute function public.platform_entitlement_audit_prevent_mutation();

create trigger platform_entitlement_audit_immutable_truncate
  before truncate on public.platform_entitlement_audit
  for each statement execute function public.platform_entitlement_audit_prevent_mutation();

revoke all on function public.platform_entitlement_audit_prevent_mutation() from public;
revoke all on function public.platform_entitlement_audit_prevent_mutation() from anon;
revoke all on function public.platform_entitlement_audit_prevent_mutation() from authenticated;
revoke all on function public.platform_entitlement_audit_prevent_mutation() from service_role;

-- Backfill (approved product decision, 2026-09-12): every workspace that exists
-- when this migration runs is entitled to Election Day ONLY - on Production
-- exactly "מודיעין" and "ניסוי קבלה Production" (verified read-only).
-- voter_management and budget are never granted automatically. Deterministic:
-- a pure function of the workspaces present; each grant is audited in the SAME
-- statement.
with granted as (
  insert into public.election_workspace_modules (workspace_id, module_key)
  select w.id, 'election_day' from public.election_workspaces w
  on conflict do nothing
  returning workspace_id, module_key
)
insert into public.platform_entitlement_audit
  (action, module_key, workspace_id_snapshot, workspace_name_snapshot, previous_enabled, new_enabled)
select 'backfill_granted', g.module_key, g.workspace_id, w.name, false, true
from granted g
join public.election_workspaces w on w.id = g.workspace_id;

-- ===========================================================================
-- D (schema). Explicit Manager flag on roles.
-- ===========================================================================
alter table public.election_day_roles
  add column is_manager boolean not null default false;

comment on column public.election_day_roles.is_manager is
  'Stage 9: marks a role as a Manager role. The Election Owner cannot reset the password of a user holding a Manager role. Grants no permission by itself.';

-- Backfill: a role is a Manager role iff it currently holds any electionDay.*
-- administrative permission. On Production that is exactly the "מנהל" role of
-- each workspace (verified read-only before writing this migration).
update public.election_day_roles r
set is_manager = true
where exists (
  select 1 from pg_catalog.unnest(r.permissions) p where p like 'electionDay.%'
);

-- ===========================================================================
-- Internal helpers (granted to no role).
-- ===========================================================================
create or replace function public.election_day_normalize_modules(p_modules text[])
returns text[]
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v text[];
begin
  if p_modules is null or pg_catalog.cardinality(p_modules) = 0 then
    raise exception 'INVALID_MODULES';
  end if;
  select pg_catalog.array_agg(distinct m order by m) into v
  from pg_catalog.unnest(p_modules) m;
  if exists (
    select 1 from pg_catalog.unnest(v) m
    where m is null
       or not exists (select 1 from public.platform_modules pm where pm.key = m)
  ) then
    raise exception 'INVALID_MODULES';
  end if;
  return v;
end;
$fn$;

revoke all on function public.election_day_normalize_modules(text[]) from public;
revoke all on function public.election_day_normalize_modules(text[]) from anon;
revoke all on function public.election_day_normalize_modules(text[]) from authenticated;
revoke all on function public.election_day_normalize_modules(text[]) from service_role;

create or replace function public.election_day_workspace_has_module(
  p_workspace_id uuid,
  p_module_key text
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $fn$
  select exists (
    select 1 from public.election_workspace_modules m
    where m.workspace_id = p_workspace_id and m.module_key = p_module_key
  )
$fn$;

revoke all on function public.election_day_workspace_has_module(uuid, text) from public;
revoke all on function public.election_day_workspace_has_module(uuid, text) from anon;
revoke all on function public.election_day_workspace_has_module(uuid, text) from authenticated;
revoke all on function public.election_day_workspace_has_module(uuid, text) from service_role;

-- ===========================================================================
-- C. Election Day enforcement for workers (database level).
-- ===========================================================================

-- Identical to 20260826010000 except the entitlement predicate: a session in a
-- workspace that is not entitled to Election Day resolves to nothing, so every
-- worker *_v3 RPC (all resolve through here) fails UNAUTHORIZED immediately -
-- including sessions created before the entitlement was removed.
create or replace function public.election_day_resolve_session(
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select u.id, u.name, u.role_id, s.workspace_id
    from public.election_day_sessions s
    join public.election_day_permission_users u
      on u.id = s.permission_user_id
     and u.workspace_id = s.workspace_id
    where s.token_hash = p_session_hash
      and s.expires_at > now()
      and public.election_day_workspace_has_module(s.workspace_id, 'election_day');

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$$;

revoke all on function public.election_day_resolve_session(bytea) from public;
revoke all on function public.election_day_resolve_session(bytea) from anon;
revoke all on function public.election_day_resolve_session(bytea) from authenticated;
grant execute on function public.election_day_resolve_session(bytea) to service_role;

-- Identical to 20260909010000 except the entitlement check, placed AFTER the
-- password verification so it never tells an unauthenticated caller anything
-- about a workspace.
create or replace function public.election_day_login_v3(
  p_workspace_code text,
  p_name text,
  p_password text,
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_user_name text;
  v_password_hash text;
  v_role_id uuid;
  v_expires_at timestamptz;
begin
  if p_workspace_code is null or btrim(p_workspace_code) = ''
     or p_name is null or btrim(p_name) = ''
     or p_password is null or p_password = ''
     or p_session_hash is null
  then
    raise exception 'UNAUTHORIZED';
  end if;

  v_code := upper(btrim(p_workspace_code));

  select w.id into v_workspace_id
  from public.election_workspaces w
  where w.login_code = v_code;

  if v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select u.id, u.name, u.password_hash, u.role_id
    into v_user_id, v_user_name, v_password_hash, v_role_id
  from public.election_day_permission_users u
  where u.workspace_id = v_workspace_id
    and u.name = btrim(p_name);

  if v_user_id is null
     or v_password_hash is null
     or extensions.crypt(p_password, v_password_hash) <> v_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Stage 9: platform entitlement. Only reachable with valid credentials.
  if not public.election_day_workspace_has_module(v_workspace_id, 'election_day') then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  delete from public.election_day_sessions s
  where s.permission_user_id = v_user_id and s.expires_at < now();

  v_expires_at := now() + interval '24 hours';

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (v_user_id, v_workspace_id, p_session_hash, v_expires_at);

  return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
end;
$$;

revoke all on function public.election_day_login_v3(text, text, text, bytea) from public;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from anon;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from authenticated;
grant execute on function public.election_day_login_v3(text, text, text, bytea) to service_role;

-- ===========================================================================
-- C (Owner). Entitlement reads for the Election Owner.
-- ===========================================================================
create or replace function public.election_day_owner_has_module(
  p_auth_user_id uuid,
  p_module_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_workspace_id uuid;
begin
  select o.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) o;
  return public.election_day_workspace_has_module(v_workspace_id, p_module_key);
end;
$fn$;

comment on function public.election_day_owner_has_module(uuid, text) is
  'Stage 9: whether the Election Owner''s own workspace (resolved live from a server-verified auth_user_id) is entitled to a module. UNAUTHORIZED for a non-Owner. Called by api/election-day/owner-actions.ts before every Owner Election Day data operation. service_role-only.';

revoke all on function public.election_day_owner_has_module(uuid, text) from public;
revoke all on function public.election_day_owner_has_module(uuid, text) from anon;
revoke all on function public.election_day_owner_has_module(uuid, text) from authenticated;
grant execute on function public.election_day_owner_has_module(uuid, text) to service_role;

create or replace function public.election_day_list_workspace_modules_owner_v3(
  p_auth_user_id uuid
)
returns table (
  module_key text,
  available boolean,
  enabled boolean,
  sort_order integer
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_workspace_id uuid;
begin
  select o.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) o;

  return query
    select pm.key, pm.available,
           public.election_day_workspace_has_module(v_workspace_id, pm.key),
           pm.sort_order
    from public.platform_modules pm
    order by pm.sort_order, pm.key;
end;
$fn$;

comment on function public.election_day_list_workspace_modules_owner_v3(uuid) is
  'Stage 9: the module catalog with this Owner''s workspace entitlement per module. Read-only, display only. service_role-only.';

revoke all on function public.election_day_list_workspace_modules_owner_v3(uuid) from public;
revoke all on function public.election_day_list_workspace_modules_owner_v3(uuid) from anon;
revoke all on function public.election_day_list_workspace_modules_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_list_workspace_modules_owner_v3(uuid) to service_role;

-- ===========================================================================
-- D. Owner user management. Authorization = a live election_owners row for
-- the server-verified auth_user_id (+ a one-time Owner proof for mutations).
-- Never a PermissionUser permission. Same-workspace only; a target outside
-- the Owner's workspace is indistinguishable from a nonexistent one.
-- ===========================================================================
create or replace function public.election_day_list_permission_users_owner_v3(
  p_auth_user_id uuid
)
returns table (id uuid, name text, role_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_workspace_id uuid;
begin
  select o.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) o;

  return query
    select u.id, u.name, u.role_id, u.created_at
    from public.election_day_permission_users u
    where u.workspace_id = v_workspace_id
    order by u.created_at asc;
end;
$fn$;

revoke all on function public.election_day_list_permission_users_owner_v3(uuid) from public;
revoke all on function public.election_day_list_permission_users_owner_v3(uuid) from anon;
revoke all on function public.election_day_list_permission_users_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_list_permission_users_owner_v3(uuid) to service_role;

create or replace function public.election_day_create_permission_user_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_name text,
  p_password text,
  p_role_id uuid
)
returns table (id uuid, name text, role_id uuid, workspace_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'create_permission_user'
  ) v;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'PASSWORD_REQUIRED';
  end if;
  if p_role_id is null or not exists (
    select 1 from public.election_day_roles r
    where r.id = p_role_id and r.workspace_id = v_workspace_id
  ) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values (
    btrim(p_name),
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    p_role_id,
    v_workspace_id
  )
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role_id, u.workspace_id
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$fn$;

revoke all on function public.election_day_create_permission_user_owner_v3(uuid, bytea, text, text, uuid) from public;
revoke all on function public.election_day_create_permission_user_owner_v3(uuid, bytea, text, text, uuid) from anon;
revoke all on function public.election_day_create_permission_user_owner_v3(uuid, bytea, text, text, uuid) from authenticated;
grant execute on function public.election_day_create_permission_user_owner_v3(uuid, bytea, text, text, uuid) to service_role;

create or replace function public.election_day_delete_permission_user_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'delete_permission_user'
  ) v;

  select u.workspace_id into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id
  for update;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- Sessions and reauth proofs cascade; coordinator-operation audit rows keep
  -- their history with executed_by_id set null (existing FKs).
  delete from public.election_day_permission_users where id = p_target_user_id;
end;
$fn$;

revoke all on function public.election_day_delete_permission_user_owner_v3(uuid, bytea, uuid) from public;
revoke all on function public.election_day_delete_permission_user_owner_v3(uuid, bytea, uuid) from anon;
revoke all on function public.election_day_delete_permission_user_owner_v3(uuid, bytea, uuid) from authenticated;
grant execute on function public.election_day_delete_permission_user_owner_v3(uuid, bytea, uuid) to service_role;

create or replace function public.election_day_reset_permission_user_password_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
  v_is_manager boolean;
  v_owner_name text;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'reset_permission_user_password'
  ) v;

  -- Lock the user row and share-lock its role row, so the Manager decision
  -- below cannot race a concurrent role change.
  select u.workspace_id, r.is_manager
    into v_target_workspace_id, v_is_manager
  from public.election_day_permission_users u
  join public.election_day_roles r on r.id = u.role_id
  where u.id = p_target_user_id
  for update of u
  for share of r;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  if v_is_manager then
    raise exception 'CANNOT_RESET_MANAGER';
  end if;

  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  select o.name into v_owner_name from public.election_owners o where o.id = v_owner_id;

  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_owner_name
  where public.election_day_permission_users.id = p_target_user_id;

  -- Same revocation as the worker v3 reset: no outstanding proof or session of
  -- the target outlives the reset.
  delete from public.election_day_reauth_proofs where actor_id = p_target_user_id;
  delete from public.election_day_sessions where permission_user_id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$fn$;

revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from public;
revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from anon;
revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from authenticated;
grant execute on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) to service_role;

-- ===========================================================================
-- D (roles). is_manager in the Owner role surface.
-- ===========================================================================

-- Return shape gains is_manager, so the function is recreated (a RETURNS TABLE
-- change cannot be done with CREATE OR REPLACE). Additive for every caller.
drop function if exists public.election_day_list_roles_owner_v3(uuid);

create function public.election_day_list_roles_owner_v3(
  p_auth_user_id uuid
)
returns table (
  id uuid,
  name text,
  description text,
  permissions text[],
  scope_type text,
  scope_value jsonb,
  is_manager boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_workspace_id uuid;
begin
  select o.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) o;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.is_manager
    from public.election_day_roles r
    where r.workspace_id = v_workspace_id
    order by r.created_at asc;
end;
$$;

revoke all on function public.election_day_list_roles_owner_v3(uuid) from public;
revoke all on function public.election_day_list_roles_owner_v3(uuid) from anon;
revoke all on function public.election_day_list_roles_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_list_roles_owner_v3(uuid) to service_role;

-- New overloads carrying p_is_manager. The previous 6/7-argument overloads stay
-- (a deployed build calls them by named arguments during the rollout window);
-- they create a non-Manager role / leave is_manager unchanged.
create or replace function public.election_day_create_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text,
  p_is_manager boolean
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb, is_manager boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'create_role'
  ) v;

  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values (
    btrim(p_name),
    coalesce(p_description, ''),
    coalesce(p_permissions, '{}'),
    p_scope_type,
    v_workspace_id,
    coalesce(p_is_manager, false)
  )
  returning public.election_day_roles.id into v_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.is_manager
    from public.election_day_roles r
    where r.id = v_id;
end;
$$;

revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text, boolean) from public;
revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text, boolean) from anon;
revoke all on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text, boolean) from authenticated;
grant execute on function public.election_day_create_role_owner_v3(uuid, bytea, text, text, text[], text, boolean) to service_role;

create or replace function public.election_day_update_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text,
  p_is_manager boolean
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb, is_manager boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'update_role'
  ) v;

  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  update public.election_day_roles as r
  set name = btrim(p_name),
      description = coalesce(p_description, ''),
      permissions = coalesce(p_permissions, '{}'),
      scope_type = p_scope_type,
      is_manager = coalesce(p_is_manager, r.is_manager)
  where r.id = p_role_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.is_manager
    from public.election_day_roles r
    where r.id = p_role_id;
end;
$$;

revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text, boolean) from public;
revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text, boolean) from anon;
revoke all on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text, boolean) from authenticated;
grant execute on function public.election_day_update_role_owner_v3(uuid, bytea, uuid, text, text, text[], text, boolean) to service_role;

-- Clone keeps its signature and return shape; the copy now inherits is_manager.
create or replace function public.election_day_clone_role_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_role_id uuid,
  p_new_name text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
  v_new_id uuid;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'clone_role'
  ) v;

  if p_new_name is null or btrim(p_new_name) = '' then
    raise exception 'ROLE_NAME_REQUIRED';
  end if;

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_roles (name, description, permissions, scope_type, scope_value, workspace_id, is_manager)
  select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value, v_workspace_id, r.is_manager
  from public.election_day_roles r
  where r.id = p_role_id
  returning public.election_day_roles.id into v_new_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_new_id;
end;
$$;

revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from public;
revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from anon;
revoke all on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) from authenticated;
grant execute on function public.election_day_clone_role_owner_v3(uuid, bytea, uuid, text) to service_role;

-- New workspaces: identical to 20260910000000's seed except the manager role
-- is marked is_manager = true.
create or replace function public.election_day_seed_new_workspace(
  p_workspace_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
begin
  if p_workspace_id is null then
    raise exception 'MISSING_WORKSPACE_ID';
  end if;

  insert into public.election_day_roles
    (workspace_id, name, description, permissions, scope_type, is_manager)
  values
    (
      p_workspace_id,
      'מנהל',
      'גישה מלאה לכל הפעולות והנתונים, כולל ניהול משתמשים ותפקידים.',
      array[
        'voter.markVoted', 'voter.manageReminder', 'voter.manageRide',
        'voter.editPhone', 'voter.editNotes',
        'electionDay.import', 'electionDay.clearData', 'electionDay.export',
        'electionDay.manageSettings', 'electionDay.manageUsers',
        'electionDay.manageRideCoordinators',
        'electionDay.manageRolesAndPermissions',
        'electionDay.manageNonVotingReasons',
        'electionDay.manageCoordinatorAllocation',
        'app.accessFullNavigation',
        'voter.viewName', 'voter.viewAddress', 'voter.viewPhone',
        'voter.viewMasad', 'voter.viewCoordinator', 'voter.viewNotes',
        'voter.viewReminderStatus', 'voter.viewRideStatus',
        'voter.viewVotedStatus', 'voter.viewReminderHistory'
      ],
      'all',
      true
    ),
    (
      p_workspace_id,
      'טלפן/ית',
      'ניהול תפעולי של אנשי קשר - תזכורות, הסעות, עדכון פרטים - ללא סימון הצבעה וללא פעולות ניהול.',
      array[
        'voter.manageReminder', 'voter.manageRide', 'voter.editPhone',
        'voter.editNotes',
        'voter.viewName', 'voter.viewAddress', 'voter.viewPhone',
        'voter.viewMasad', 'voter.viewCoordinator', 'voter.viewNotes',
        'voter.viewReminderStatus', 'voter.viewRideStatus',
        'voter.viewVotedStatus', 'voter.viewReminderHistory'
      ],
      'assigned_to_me',
      false
    ),
    (
      p_workspace_id,
      'נציג קלפי',
      'סימון וביטול סימון הצבעה בלבד, עם פרטי זיהוי בסיסיים.',
      array[
        'voter.markVoted', 'voter.viewName', 'voter.viewAddress',
        'voter.viewPhone', 'voter.viewVotedStatus'
      ],
      'assigned_to_me',
      false
    );

  insert into public.election_day_not_voting_reasons
    (workspace_id, name, description, sort_order, requires_follow_up)
  values
    (p_workspace_id, 'אמר שלא יגיע', '', 0, false),
    (p_workspace_id, 'מספר טלפון שגוי', '', 1, false),
    (p_workspace_id, 'לא עונה', '', 2, true),
    (p_workspace_id, 'בחו״ל', '', 3, false),
    (p_workspace_id, 'נפטר', '', 4, false),
    (p_workspace_id, 'עבר עיר', '', 5, false);
end;
$fn$;

revoke all on function public.election_day_seed_new_workspace(uuid) from public;
revoke all on function public.election_day_seed_new_workspace(uuid) from anon;
revoke all on function public.election_day_seed_new_workspace(uuid) from authenticated;
revoke all on function public.election_day_seed_new_workspace(uuid) from service_role;

-- ===========================================================================
-- B (platform). Approval with modules, provisioning copies them.
-- ===========================================================================
create or replace function public.platform_create_pending_owner_access(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_expires_in_days integer,
  p_modules text[]
)
returns table (
  pending_id uuid,
  expires_at timestamptz,
  already_existed boolean
)
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_modules text[];
  v_id uuid;
  v_expires timestamptz;
  v_existed boolean;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  v_modules := public.election_day_normalize_modules(p_modules);

  -- Every Stage 3B rule (lock, re-approval, consumed/expired/provisioned) is
  -- the 6-argument function's; this wrapper only records the module choice on
  -- a row it just created.
  select c.pending_id, c.expires_at, c.already_existed
    into v_id, v_expires, v_existed
  from public.platform_create_pending_owner_access(
    p_platform_owner_auth_user_id, p_auth_user_id, p_name, p_email, p_phone,
    p_expires_in_days
  ) c;

  if not v_existed then
    update public.election_workspace_pending_owner_access
    set requested_modules = v_modules,
        approved_by_platform_owner_auth_user_id = p_platform_owner_auth_user_id
    where id = v_id;

    -- Audit the Platform Owner's decision, attributed, in this transaction.
    insert into public.platform_entitlement_audit
      (action, module_key, pending_access_id_snapshot, previous_enabled, new_enabled,
       acting_platform_owner_auth_user_id, acting_auth_user_id)
    select 'approval_selected', m, v_id, null, true,
           p_platform_owner_auth_user_id, p_platform_owner_auth_user_id
    from pg_catalog.unnest(v_modules) m;
  end if;

  return query select v_id, v_expires, v_existed;
end;
$fn$;

comment on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]) is
  'Stage 9: approval with an explicit module choice. Delegates every Stage 3B rule to the 6-argument function in the same transaction and records the normalized, catalog-validated modules (INVALID_MODULES otherwise) on the new row. An idempotent re-approval leaves the existing row untouched. service_role-only.';

revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]) from public;
revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]) from anon;
revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]) from authenticated;
grant execute on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer, text[]) to service_role;

-- Identical to 20260915000000 except: the approval's requested_modules (and its
-- approving Platform Owner) are read under the same row lock; an approval
-- WITHOUT a module choice fails closed (APPROVAL_MODULES_MISSING) before
-- anything is created; otherwise the modules become the new workspace's
-- entitlements, audited, in the same transaction.
create or replace function public.election_day_provision_workspace(
  p_auth_user_id uuid,
  p_workspace_name text,
  p_election_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_pending_id uuid;
  v_pending_name text;
  v_pending_email text;
  v_pending_phone text;
  v_pending_status text;
  v_pending_expires timestamptz;
  v_pending_modules text[];
  v_pending_approved_by uuid;
  v_login_code text;
  v_name text;
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_workspace_name is null or btrim(p_workspace_name) = '' then
    raise exception 'MISSING_WORKSPACE_NAME';
  end if;
  if p_election_end_at is null then
    raise exception 'MISSING_ELECTION_END_AT';
  end if;

  v_name := btrim(p_workspace_name);
  if pg_catalog.length(v_name) > 120 then
    raise exception 'WORKSPACE_NAME_TOO_LONG';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('election_day_provision_workspace_' || p_auth_user_id::text)::bigint
  );

  select o.id, o.workspace_id into v_owner_id, v_workspace_id
  from public.election_owners o
  where o.auth_user_id = p_auth_user_id;

  if v_owner_id is not null then
    return (
      select pg_catalog.jsonb_build_object(
        'workspace_id', w.id,
        'owner_id', v_owner_id,
        'workspace_name', w.name,
        'election_end_at', w.election_end_at,
        'login_code', w.login_code,
        'already_provisioned', true
      )
      from public.election_workspaces w
      where w.id = v_workspace_id
    );
  end if;

  select pa.id, pa.name, pa.email, pa.phone, pa.status, pa.expires_at,
         pa.requested_modules, pa.approved_by_platform_owner_auth_user_id
    into v_pending_id, v_pending_name, v_pending_email, v_pending_phone,
         v_pending_status, v_pending_expires, v_pending_modules, v_pending_approved_by
  from public.election_workspace_pending_owner_access pa
  where pa.auth_user_id = p_auth_user_id
  for update;

  if v_pending_id is null then
    raise exception 'PENDING_ACCESS_NOT_FOUND';
  end if;

  if v_pending_status = 'consumed' then
    raise exception 'PENDING_ACCESS_ALREADY_CONSUMED';
  end if;

  if v_pending_expires <= pg_catalog.now() then
    raise exception 'PENDING_ACCESS_EXPIRED';
  end if;

  -- Stage 9: FAIL CLOSED on an approval without a recorded module choice
  -- (pre-Stage-9). Nothing is created, nothing is inferred; the Platform
  -- Owner has to record an explicit choice first.
  if v_pending_modules is null or pg_catalog.cardinality(v_pending_modules) = 0 then
    raise exception 'APPROVAL_MODULES_MISSING';
  end if;

  v_login_code := public.election_day_generate_workspace_login_code();

  insert into public.election_workspaces (name, election_end_at, login_code)
  values (v_name, p_election_end_at, v_login_code)
  returning public.election_workspaces.id into v_workspace_id;

  insert into public.election_owners (workspace_id, auth_user_id, name, phone, email)
  values (
    v_workspace_id,
    p_auth_user_id,
    v_pending_name,
    v_pending_phone,
    v_pending_email
  )
  returning public.election_owners.id into v_owner_id;

  perform public.election_day_seed_new_workspace(v_workspace_id);

  -- Stage 9: the Platform Owner's module choice becomes the workspace's
  -- entitlement - and its audit - atomically with the workspace itself.
  insert into public.election_workspace_modules (workspace_id, module_key)
  select v_workspace_id, m
  from pg_catalog.unnest(v_pending_modules) m
  on conflict do nothing;

  insert into public.platform_entitlement_audit
    (action, module_key, workspace_id_snapshot, workspace_name_snapshot,
     pending_access_id_snapshot, previous_enabled, new_enabled,
     acting_platform_owner_auth_user_id, acting_auth_user_id)
  select 'provisioning_granted', m, v_workspace_id, v_name, v_pending_id, false, true,
         v_pending_approved_by, p_auth_user_id
  from pg_catalog.unnest(v_pending_modules) m;

  update public.election_workspace_pending_owner_access
  set status = 'consumed',
      consumed_at = pg_catalog.now()
  where id = v_pending_id;

  perform public.election_day_invalidate_owner_recovery(p_auth_user_id);

  return pg_catalog.jsonb_build_object(
    'workspace_id', v_workspace_id,
    'owner_id', v_owner_id,
    'workspace_name', v_name,
    'election_end_at', p_election_end_at,
    'login_code', v_login_code,
    'already_provisioned', false
  );
end;
$fn$;

revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from public;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from anon;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from authenticated;
grant execute on function public.election_day_provision_workspace(uuid, text, timestamptz) to service_role;

-- Identical to 20260914000000 plus 'requested_modules' per approval.
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
        'workspace_name', w.name,
        'requested_modules', pg_catalog.to_jsonb(pa.requested_modules)
      )
      order by pa.created_at desc, pa.id
    )
    from public.election_workspace_pending_owner_access pa
    left join public.election_owners o on o.auth_user_id = pa.auth_user_id
    left join public.election_workspaces w on w.id = o.workspace_id
  ), '[]'::jsonb);
end;
$fn$;

revoke all on function public.platform_list_owner_access(uuid) from public;
revoke all on function public.platform_list_owner_access(uuid) from anon;
revoke all on function public.platform_list_owner_access(uuid) from authenticated;
grant execute on function public.platform_list_owner_access(uuid) to service_role;

-- ===========================================================================
-- Platform Owner: view and edit workspace entitlements.
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
        pg_catalog.jsonb_build_object('key', pm.key, 'available', pm.available)
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
  'Stage 9: module catalog + every workspace with its current module entitlements. Platform-Owner-only (re-resolves the singleton from a server-verified id). Read-only. service_role-only.';

revoke all on function public.platform_list_workspace_modules(uuid) from public;
revoke all on function public.platform_list_workspace_modules(uuid) from anon;
revoke all on function public.platform_list_workspace_modules(uuid) from authenticated;
grant execute on function public.platform_list_workspace_modules(uuid) to service_role;

create or replace function public.platform_set_workspace_modules(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id uuid,
  p_modules text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_modules text[];
  v_name text;
  v_removed text[];
  v_added text[];
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null then
    raise exception 'INVALID_WORKSPACE_ID';
  end if;

  v_modules := public.election_day_normalize_modules(p_modules);

  -- Serialize concurrent edits of the same workspace (and snapshot its name).
  select w.name into v_name from public.election_workspaces w
  where w.id = p_workspace_id
  for update;
  if not found then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  -- Exactly what changes: only real enables/disables are applied and audited.
  select coalesce(pg_catalog.array_agg(m.module_key order by m.module_key), '{}')
    into v_removed
  from public.election_workspace_modules m
  where m.workspace_id = p_workspace_id
    and m.module_key <> all (v_modules);

  select coalesce(pg_catalog.array_agg(x order by x), '{}')
    into v_added
  from pg_catalog.unnest(v_modules) x
  where not exists (
    select 1 from public.election_workspace_modules m
    where m.workspace_id = p_workspace_id and m.module_key = x
  );

  delete from public.election_workspace_modules m
  where m.workspace_id = p_workspace_id
    and m.module_key = any (v_removed);

  insert into public.election_workspace_modules (workspace_id, module_key)
  select p_workspace_id, x from pg_catalog.unnest(v_added) x;

  -- Same transaction: an entitlement change without its audit row is impossible.
  insert into public.platform_entitlement_audit
    (action, module_key, workspace_id_snapshot, workspace_name_snapshot,
     previous_enabled, new_enabled, acting_platform_owner_auth_user_id, acting_auth_user_id)
  select 'disabled', x, p_workspace_id, v_name, true, false,
         p_platform_owner_auth_user_id, p_platform_owner_auth_user_id
  from pg_catalog.unnest(v_removed) x
  union all
  select 'enabled', x, p_workspace_id, v_name, false, true,
         p_platform_owner_auth_user_id, p_platform_owner_auth_user_id
  from pg_catalog.unnest(v_added) x;

  return pg_catalog.jsonb_build_object(
    'workspace_id', p_workspace_id,
    'modules', pg_catalog.to_jsonb(v_modules),
    'enabled', pg_catalog.to_jsonb(v_added),
    'disabled', pg_catalog.to_jsonb(v_removed)
  );
end;
$fn$;

comment on function public.platform_set_workspace_modules(uuid, uuid, text[]) is
  'Stage 9: replaces a workspace''s module entitlements with an explicit, catalog-validated, non-empty set (INVALID_MODULES / WORKSPACE_NOT_FOUND otherwise). Platform-Owner-only. Takes effect on the next worker request (election_day_resolve_session re-checks every call). service_role-only.';

revoke all on function public.platform_set_workspace_modules(uuid, uuid, text[]) from public;
revoke all on function public.platform_set_workspace_modules(uuid, uuid, text[]) from anon;
revoke all on function public.platform_set_workspace_modules(uuid, uuid, text[]) from authenticated;
grant execute on function public.platform_set_workspace_modules(uuid, uuid, text[]) to service_role;

-- ===========================================================================
-- E. Close the worker-side user management and the first-user bootstrap.
-- They had only a service_role grant; removing it leaves them callable by no
-- role at all. Nothing is dropped (rollback above restores the grants).
-- ===========================================================================
revoke all on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) from service_role;
revoke all on function public.election_day_delete_permission_user_v3(bytea, bytea, uuid) from service_role;
revoke all on function public.election_day_reset_permission_user_password_v3(bytea, bytea, uuid, text) from service_role;
revoke all on function public.election_day_list_permission_users_v3(bytea) from service_role;
revoke all on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) from service_role;

-- The 6-argument approval function becomes internal (called only by the
-- 7-argument wrapper, as postgres): no module-less approval can be created by
-- any caller any more - including a still-deployed pre-Stage-9 build during
-- the rollout gap, whose approval then fails closed instead of producing an
-- approval that could never be provisioned.
revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) from service_role;

-- ===========================================================================
-- G. Multi-Entity aggregates respect the Election Day entitlement.
-- Identical to 20260913000000 except the entitlement check, placed AFTER the
-- unchanged 'ended' rule and BEFORE any voter row is read: an assigned,
-- not-ended workspace without election_day reports 'unavailable' with no
-- numbers - no current or historical count can leak. 'suppressed' (< 10) is
-- unchanged. Still granted to NO role (internal to the two readers).
-- ===========================================================================
create or replace function public.multi_entity_compute_workspace_aggregate(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz,
  report_status text,
  contacts_total integer,
  voted integer,
  follow_up_closed integer,
  follow_up_remaining integer,
  ride_needed integer,
  ride_arranged integer,
  ride_completed integer
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  c_min_reportable constant integer := 10;
  v_ws_id uuid;
  v_ws_name text;
  v_ws_end timestamptz;
  v_assigned_at timestamptz;
  v_total integer;
  v_voted integer;
  v_closed integer;
  v_completed integer;
  v_arranged integer;
  v_needed integer;
begin
  perform public.multi_entity_assert_workspace_assigned(p_auth_user_id, p_workspace_id);

  select w.id, w.name, w.election_end_at, a.assigned_at
    into v_ws_id, v_ws_name, v_ws_end, v_assigned_at
  from public.multi_entity_assignments a
  join public.election_workspaces w on w.id = a.workspace_id
  where a.workspace_id = p_workspace_id;

  if not found then
    raise exception 'WORKSPACE_NOT_ASSIGNED';
  end if;

  if not (v_ws_end > pg_catalog.now()) then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'ended'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  -- Stage 9: platform entitlement, before any Election Day data is read.
  if not public.election_day_workspace_has_module(p_workspace_id, 'election_day') then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'unavailable'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  select pg_catalog.count(*)::integer,
         (pg_catalog.count(*) filter (where v.voted))::integer,
         (pg_catalog.count(*) filter (where not v.voted and r.requires_follow_up = false))::integer,
         (pg_catalog.count(*) filter (where v.ride_completed))::integer,
         (pg_catalog.count(*) filter (where v.ride_arranged and not v.ride_completed))::integer,
         (pg_catalog.count(*) filter (where v.ride_requested and not v.ride_arranged and not v.ride_completed))::integer
    into v_total, v_voted, v_closed, v_completed, v_arranged, v_needed
  from public.election_day_voters v
  left join public.election_day_not_voting_reasons r
    on r.id = v.not_voting_reason_id
   and r.workspace_id = v.workspace_id
  where v.workspace_id = p_workspace_id;

  if v_total < c_min_reportable then
    return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'suppressed'::text,
      null::integer, null::integer, null::integer, null::integer,
      null::integer, null::integer, null::integer;
    return;
  end if;

  return query select v_ws_id, v_ws_name, v_ws_end, v_assigned_at, 'reported'::text,
    v_total, v_voted, v_closed, v_total - v_voted - v_closed,
    v_needed, v_arranged, v_completed;
end;
$fn$;

comment on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) is
  'Stage 6 INTERNAL (+ Stage 9 entitlement): aggregate counts for ONE workspace, gated FIRST by multi_entity_assert_workspace_assigned in the same STABLE snapshot. report_status: ''ended'' (election_end_at <= now(), no counts), ''unavailable'' (not entitled to Election Day - no counts, no voter row read), ''suppressed'' (fewer than 10 contacts, no counts - not even the total) or ''reported''. Never returns a row, a person, free text or login_code. Granted to NO role, service_role included.';

revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from public;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from anon;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from authenticated;
revoke all on function public.multi_entity_compute_workspace_aggregate(uuid, uuid) from service_role;

commit;
