-- Platform Stage 4A: Multi-Entity provisioning + assignments (backend only).
--
-- ============================================================================
-- SCOPE - strictly additive (EXPAND). No existing object is altered or dropped.
-- ============================================================================
-- Phase 0 (20260823010000) created public.multi_entity_owner (a true singleton
-- via `id boolean primary key default true` + check (id)) and
-- public.multi_entity_assignments (workspace_id UNIQUE, ON DELETE CASCADE), then
-- left them completely dormant: no RPC, no API, no UI, and - verified by
-- exhaustive grep across every migration since - not one executable statement
-- touching either table in the 34 migrations that followed. The seat could not
-- be created by any deployed mechanism, and nothing could enumerate workspaces
-- to assign.
--
-- This migration supplies the missing backend: one append-only audit table, one
-- trigger function behind two immutability triggers (row-level for UPDATE/DELETE,
-- statement-level for TRUNCATE), and six Platform-Owner-only business RPCs.
--
-- It deliberately does NOT grant the Multi-Entity Owner any runtime access.
-- Authentication, AAL2 enforcement and entity-scoped authorization for that
-- principal are a separate, later stage. Nothing here makes a Multi-Entity
-- Owner's own JWT able to reach anything: their identity is created, their
-- assignments are recorded, and every read/write path remains service_role-only
-- behind a verified Platform Owner.
--
-- ============================================================================
-- OBJECT INVENTORY (exact - Production verification asserts these counts)
-- ============================================================================
--   tables .................. 1  public.multi_entity_audit
--   indexes ................. 4  multi_entity_audit_pkey  (PK-backed, implicit)
--                                multi_entity_audit_cleanup_success_key
--                                multi_entity_audit_workspace_id_snapshot_idx
--                                multi_entity_audit_performed_at_idx
--   triggers (non-internal).. 2  multi_entity_audit_immutable          (row, UPDATE/DELETE)
--                                multi_entity_audit_immutable_truncate (statement, TRUNCATE)
--   constraints ............. 6  1 PK + 5 CHECK  (NO foreign key - see below)
--   FUNCTIONS ............... 7  6 business RPCs + 1 trigger function
--
-- Seven, not six: the trigger function public.multi_entity_audit_prevent_mutation
-- is a real pg_proc row and is counted, ACL-hardened and verified like any other.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- This project's hosted Production carries a project-level pg_default_acl entry
-- that auto-grants EXECUTE to anon and authenticated on EVERY newly created
-- function in schema public. `revoke ... from public` alone does NOT undo an
-- individually-named-role default privilege. Every function below therefore
-- revokes EXECUTE from PUBLIC, anon and authenticated BY EXACT SIGNATURE and
-- only then grants EXECUTE to service_role. After applying this migration to
-- Production, verify pg_proc.proacl there directly rather than trusting any
-- local/disposable replica result.
--
-- The trigger function is revoked from service_role as well and granted to NO
-- role at all, matching the election_day_seed_new_workspace /
-- election_day_generate_workspace_login_code internal-helper precedent.
-- PostgreSQL checks EXECUTE on a trigger function when the TRIGGER is created,
-- not when it fires, so a fully-revoked trigger function still fires normally.
-- That behaviour is asserted empirically by the Stage 4A local test suite
-- rather than assumed here.
--
-- NOTE ON A DELIBERATE DIVERGENCE: the project's older shared trigger function
-- public.election_day_set_updated_at() (20260803174712) carries no ACL block at
-- all. That migration predates this guardrail. The guardrail is applied
-- uniformly to new work here; the older function is deliberately NOT retrofitted
-- (out of scope for Stage 4A).
--
-- ============================================================================
-- TABLE ACL HARDENING
-- ============================================================================
-- multi_entity_owner and multi_entity_assignments were created RLS-enabled with
-- zero policies and no table-level revokes. RLS-with-zero-policies already
-- denies anon/authenticated, but a single future CREATE POLICY - or an
-- accidental `alter table ... disable row level security` - would silently turn
-- the ambient default-privilege grants into real access. Stage 2 established the
-- stricter precedent for exactly this class (platform_owner_recovery_audit,
-- 20260908000000). Stage 4A is the first code ever to write these two tables, so
-- it closes that latent second failure mode while it is here, and applies the
-- same treatment to the new audit table.
--
-- public.platform_deletion_audit shares the same gap and is deliberately NOT
-- touched - it is outside Stage 4A's scope and remains separately tracked.
--
-- ============================================================================
-- CONCURRENCY
-- ============================================================================
-- Seat provisioning takes a fixed transaction-scoped advisory lock (the
-- singleton has no per-entity id to scope by) and re-reads the seat FOR UPDATE
-- inside it. Assignment takes a per-workspace lock and re-checks inside it.
-- Belt and braces: multi_entity_owner's boolean primary key and
-- multi_entity_assignments_workspace_id_key would still make a duplicate fail
-- with 23505 even if a lock were bypassed.

begin;

-- ---------------------------------------------------------------------------
-- Pre-flight gates: refuse to run twice, or against an unexpected schema.
--
-- Gate 1 matches on proname ALONE, never on the argument list: `create or
-- replace function` with a different signature silently creates a SECOND
-- overload instead of replacing, leaving two callable functions with divergent
-- ACLs. Name-collision detection must therefore be signature-blind.
-- ---------------------------------------------------------------------------
do $gate$
declare
  v_name text;
begin
  foreach v_name in array array[
    'platform_get_multi_entity_state',
    'platform_provision_multi_entity_owner',
    'platform_assign_workspace',
    'platform_unassign_workspace',
    'platform_check_auth_user_purgeable',
    'platform_record_multi_entity_auth_cleanup',
    'multi_entity_audit_prevent_mutation'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_name
    ) then
      raise exception 'STAGE4_GATE_FAILED: public.% already exists (any signature) - migration may already be applied', v_name;
    end if;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'multi_entity_audit'
      and c.relkind = 'r'
  ) then
    raise exception 'STAGE4_GATE_FAILED: public.multi_entity_audit already exists - migration may already be applied';
  end if;

  foreach v_name in array array[
    'multi_entity_audit_cleanup_success_key',
    'multi_entity_audit_workspace_id_snapshot_idx',
    'multi_entity_audit_performed_at_idx'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = v_name
        and c.relkind = 'i'
    ) then
      raise exception 'STAGE4_GATE_FAILED: index public.% already exists', v_name;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'multi_entity_owner'
  ) then
    raise exception 'STAGE4_GATE_FAILED: public.multi_entity_owner is missing - 20260823010000 must be applied first';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'multi_entity_assignments'
  ) then
    raise exception 'STAGE4_GATE_FAILED: public.multi_entity_assignments is missing - 20260823010000 must be applied first';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint where conname = 'multi_entity_owner_singleton'
  ) then
    raise exception 'STAGE4_GATE_FAILED: multi_entity_owner_singleton is missing - 20260823010000 must be applied first';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint where conname = 'multi_entity_assignments_workspace_id_key'
  ) then
    raise exception 'STAGE4_GATE_FAILED: multi_entity_assignments_workspace_id_key is missing - 20260823010000 must be applied first';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'platform_owners_singleton_idx'
      and c.relkind = 'i'
  ) then
    raise exception 'STAGE4_GATE_FAILED: platform_owners_singleton_idx is missing - 20260908000000 must be applied first';
  end if;
end;
$gate$;

-- ===========================================================================
-- 1. AUDIT TABLE - append-only, immutability enforced by trigger.
-- ===========================================================================
create table public.multi_entity_audit (
  id                       uuid primary key default gen_random_uuid(),
  action                   text not null
                             check (action in (
                               'provisioned',
                               'replaced',
                               'assigned',
                               'unassigned',
                               'previous_auth_deleted',
                               'previous_auth_delete_failed'
                             )),
  workspace_id_snapshot    uuid,
  workspace_name_snapshot  text,
  seat_auth_user_id        uuid,
  previous_auth_user_id    uuid,
  acting_platform_owner_id uuid,
  acting_auth_user_id      uuid not null,
  performed_at             timestamptz not null default now(),

  -- Shape constraints bind each column to the actions that may carry it.
  -- Verified against all six legal actions; every one satisfies all four.
  constraint multi_entity_audit_workspace_id_shape
    check ((action in ('assigned', 'unassigned')) = (workspace_id_snapshot is not null)),
  constraint multi_entity_audit_workspace_name_shape
    check ((action in ('assigned', 'unassigned')) = (workspace_name_snapshot is not null)),
  constraint multi_entity_audit_seat_shape
    check ((action in ('provisioned', 'replaced')) = (seat_auth_user_id is not null)),
  constraint multi_entity_audit_previous_auth_shape
    check ((action in ('replaced', 'previous_auth_deleted', 'previous_auth_delete_failed'))
             = (previous_auth_user_id is not null))
);

comment on table public.multi_entity_audit is
  'Stage 4A: append-only history of every Multi-Entity seat and assignment event. Six actions: provisioned / replaced / assigned / unassigned / previous_auth_deleted / previous_auth_delete_failed. Immutability is enforced by the multi_entity_audit_immutable trigger, not by convention - UPDATE and DELETE both raise AUDIT_IMMUTABLE. EVERY reference column on this table is deliberately a plain snapshot with NO foreign key - including acting_platform_owner_id: this table must outlive the workspace, the platform_owners row and the auth.users rows it describes, exactly like platform_deletion_audit.workspace_id_snapshot and platform_owner_recovery_audit.auth_user_id. A foreign key here would also be actively harmful: an ON DELETE SET NULL cascade issues an internal UPDATE against this table, which the immutability trigger refuses - that would make deleting a platform_owners row impossible forever once any audit row referenced it (found empirically during Stage 4A verification, not by inspection). Carries no credential material of any kind. RLS-enabled, zero policies, plus explicit table-level REVOKEs.';

comment on column public.multi_entity_audit.seat_auth_user_id is
  'Deliberately NULL on assignment rows. Assignments are seat-scoped, not person-scoped (multi_entity_assignments has no owner-id column at all), and who held the seat at any instant is reconstructable by replaying provisioned/replaced rows. Denormalising it here would create a second, driftable source of truth.';

comment on column public.multi_entity_audit.acting_platform_owner_id is
  'Snapshot of the acting Platform Owner''s platform_owners.id. Deliberately NOT a foreign key. Two reasons: the audit must outlive the principal it records, and - decisively - a FK with ON DELETE SET NULL would make Postgres issue an internal UPDATE on this table when that platform_owners row is deleted, which the immutability trigger refuses, permanently blocking Platform Owner deletion. Nullable because the acting id is a snapshot, not a guarantee.';

comment on column public.multi_entity_audit.acting_auth_user_id is
  'Snapshot of the acting Platform Owner''s auth.users id. NOT a foreign key - it must survive the deletion of that Auth account, matching platform_owner_recovery_audit.auth_user_id''s own precedent.';

-- At most ONE terminal success row per previous_auth_user_id, ever. This is
-- what makes the Auth-cleanup recorder idempotent under retry and under
-- genuinely concurrent callers: a duplicate cannot be inserted, so the
-- recorder converts 23505 into the idempotent "already completed" response
-- instead of writing a second, contradictory record.
--
-- previous_auth_delete_failed rows are deliberately NOT unique - each failed
-- attempt is a genuinely distinct event worth keeping.
create unique index multi_entity_audit_cleanup_success_key
  on public.multi_entity_audit (previous_auth_user_id)
  where action = 'previous_auth_deleted';

create index multi_entity_audit_workspace_id_snapshot_idx
  on public.multi_entity_audit (workspace_id_snapshot);

create index multi_entity_audit_performed_at_idx
  on public.multi_entity_audit (performed_at desc);

alter table public.multi_entity_audit enable row level security;
-- Deliberately no CREATE POLICY: RLS-enabled with zero policies denies all
-- direct anon/authenticated access. Every access path is a SECURITY DEFINER
-- RPC in this migration.

-- ===========================================================================
-- 2. IMMUTABILITY - trigger function + trigger.
-- ===========================================================================
create or replace function public.multi_entity_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

comment on function public.multi_entity_audit_prevent_mutation() is
  'Stage 4A: makes public.multi_entity_audit append-only at the database level. Fires BEFORE UPDATE OR DELETE and always raises AUDIT_IMMUTABLE. SECURITY INVOKER by design - it confers no privilege, it only refuses. Granted to NO role at all, service_role included: PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER time, not at fire time, so a fully-revoked trigger function still fires. A direct call outside trigger context fails regardless ("trigger functions can only be called as triggers").';

create trigger multi_entity_audit_immutable
  before update or delete on public.multi_entity_audit
  for each row execute function public.multi_entity_audit_prevent_mutation();

-- A row-level trigger is NOT sufficient on its own: TRUNCATE does not fire row
-- triggers, so `truncate public.multi_entity_audit` would erase the entire
-- trail in one statement and silently satisfy a row-trigger-only design. This
-- was found empirically during Stage 4A verification (service_role holds
-- TRUNCATE on the table by default, and the truncate succeeded against a
-- row-trigger-only build). A STATEMENT-level BEFORE TRUNCATE trigger closes it.
create trigger multi_entity_audit_immutable_truncate
  before truncate on public.multi_entity_audit
  for each statement execute function public.multi_entity_audit_prevent_mutation();

revoke all on function public.multi_entity_audit_prevent_mutation() from public;
revoke all on function public.multi_entity_audit_prevent_mutation() from anon;
revoke all on function public.multi_entity_audit_prevent_mutation() from authenticated;
revoke all on function public.multi_entity_audit_prevent_mutation() from service_role;

-- ===========================================================================
-- 3. TABLE-LEVEL ACL HARDENING (see header).
-- ===========================================================================
revoke all on table public.multi_entity_owner from public;
revoke all on table public.multi_entity_owner from anon;
revoke all on table public.multi_entity_owner from authenticated;

revoke all on table public.multi_entity_assignments from public;
revoke all on table public.multi_entity_assignments from anon;
revoke all on table public.multi_entity_assignments from authenticated;

revoke all on table public.multi_entity_audit from public;
revoke all on table public.multi_entity_audit from anon;
revoke all on table public.multi_entity_audit from authenticated;
-- service_role is revoked HERE and only here, unlike the two tables above.
-- Every access path to this table is a SECURITY DEFINER function owned by
-- postgres, so removing service_role's direct grants costs nothing and removes
-- the ability of a service-key caller to DELETE or TRUNCATE the audit trail
-- directly. Defense in depth alongside the two immutability triggers.
revoke all on table public.multi_entity_audit from service_role;

-- ===========================================================================
-- 4. READ - current Multi-Entity state + every workspace's assignment status.
-- ===========================================================================
create or replace function public.platform_get_multi_entity_state(
  p_platform_owner_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_seat jsonb;
  v_workspaces jsonb;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  select pg_catalog.jsonb_build_object(
           'auth_user_id', m.auth_user_id,
           'name', m.name,
           'email', m.email,
           'phone', m.phone,
           'created_at', m.created_at,
           'updated_at', m.updated_at
         )
    into v_seat
  from public.multi_entity_owner m;

  -- is_active is DERIVED from election_end_at, never stored (Phase 0 Design
  -- Note 1). login_code is included because election_workspaces.name carries no
  -- uniqueness constraint of any kind - two workspaces may legitimately share a
  -- name, and login_code is the only guaranteed-unique human-readable
  -- discriminator. It is a tenant SELECTOR, not a secret.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'workspace_id', w.id,
               'name', w.name,
               'login_code', w.login_code,
               'election_end_at', w.election_end_at,
               'is_active', (w.election_end_at > pg_catalog.now()),
               'is_assigned', (a.id is not null),
               'assigned_at', a.assigned_at
             )
             order by w.created_at
           ),
           '[]'::jsonb
         )
    into v_workspaces
  from public.election_workspaces w
  left join public.multi_entity_assignments a on a.workspace_id = w.id;

  return pg_catalog.jsonb_build_object(
    'seat', v_seat,
    'workspaces', v_workspaces
  );
end;
$fn$;

comment on function public.platform_get_multi_entity_state(uuid) is
  'Stage 4A: one round trip powering the whole Multi-Entity management surface - the current seat (null when unprovisioned) plus every workspace with is_assigned and derived is_active. Re-resolves the singleton platform_owners row from a SERVER-VERIFIED auth_user_id rather than trusting the caller. Read-only. service_role-only.';

revoke all on function public.platform_get_multi_entity_state(uuid) from public;
revoke all on function public.platform_get_multi_entity_state(uuid) from anon;
revoke all on function public.platform_get_multi_entity_state(uuid) from authenticated;
grant execute on function public.platform_get_multi_entity_state(uuid) to service_role;

-- ===========================================================================
-- 5. PROVISION / REPLACE the Multi-Entity Owner seat.
-- ===========================================================================
create or replace function public.platform_provision_multi_entity_owner(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_name  text;
  v_email text;
  v_phone text;
  v_existing_auth uuid;
  v_already  boolean := false;
  v_replaced boolean := false;
  v_previous uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Defence in depth. api/platform/session.ts has already verified the caller
  -- through the full three-check Platform Owner chain; this re-resolves the
  -- singleton independently so the RPC is not authorized by its caller's word.
  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_auth_user_id is null then
    raise exception 'MISSING_AUTH_USER_ID';
  end if;

  v_name  := btrim(coalesce(p_name, ''));
  v_email := lower(btrim(coalesce(p_email, '')));
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_name = '' then
    raise exception 'MISSING_OWNER_NAME';
  end if;
  if v_email = '' then
    raise exception 'MISSING_OWNER_EMAIL';
  end if;
  if pg_catalog.length(v_name) > 200 then
    raise exception 'OWNER_NAME_TOO_LONG';
  end if;
  if pg_catalog.length(v_email) > 254 then
    raise exception 'OWNER_EMAIL_TOO_LONG';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_seat')::bigint
  );

  -- ---- Principal separation, cross-principal only -------------------------
  -- public.multi_entity_owner is DELIBERATELY not checked here: it is this
  -- function's own target table, so its row can never be a "conflict". The
  -- same-identity vs different-identity distinction is made by the branch
  -- below, which is what keeps an idempotent re-provision of the SAME id legal
  -- while still rejecting genuine cross-principal reuse.
  if exists (
    select 1 from public.platform_owners po where po.auth_user_id = p_auth_user_id
  ) then
    raise exception 'IDENTITY_ALREADY_PRINCIPAL';
  end if;

  if exists (
    select 1 from public.election_owners o where o.auth_user_id = p_auth_user_id
  ) then
    raise exception 'IDENTITY_ALREADY_PRINCIPAL';
  end if;

  -- ---- Actionable pending Election Owner access ---------------------------
  -- An in-flight path to becoming an Election Owner disqualifies an identity
  -- just as much as already being one. This predicate mirrors
  -- election_day_provision_workspace's own actionability test EXACTLY: that
  -- function converts a pending row into an election_owners row iff the row
  -- exists AND status <> 'consumed' AND expires_at > now(). Note it tests
  -- 'consumed' by exact equality, never status = 'pending' - expires_at is
  -- authoritative and status may legitimately lag behind it (Phase 0 Design
  -- Note 3), so a row stamped 'expired' whose expires_at is still in the future
  -- IS actionable and must block.
  --
  -- Terminal rows deliberately do NOT block:
  --   * status='consumed' implies an election_owners row already exists, which
  --     the check above already caught.
  --   * expires_at <= now() is a verified dead end -
  --     platform_create_pending_owner_access raises PENDING_ACCESS_EXPIRED on an
  --     existing expired row and neither replaces it nor extends its window, so
  --     that identity can never be re-approved through the console.
  if exists (
    select 1 from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = p_auth_user_id
      and pa.status <> 'consumed'
      and pa.expires_at > pg_catalog.now()
  ) then
    raise exception 'IDENTITY_PENDING_ELECTION_OWNER';
  end if;

  select m.auth_user_id into v_existing_auth
  from public.multi_entity_owner m
  for update;

  if v_existing_auth is null then
    insert into public.multi_entity_owner (id, auth_user_id, name, phone, email)
    values (true, p_auth_user_id, v_name, v_phone, v_email);

    insert into public.multi_entity_audit
      (action, seat_auth_user_id, acting_platform_owner_id, acting_auth_user_id)
    values
      ('provisioned', p_auth_user_id, v_platform_owner_id, p_platform_owner_auth_user_id);

  elsif v_existing_auth = p_auth_user_id then
    -- Idempotent re-provision of the same identity: refresh display metadata
    -- only. No audit row - the seat holder did not change, so there is no event.
    v_already := true;

    update public.multi_entity_owner
       set name = v_name, phone = v_phone, email = v_email
     where id = true;

  else
    -- Replacement is an UPDATE IN PLACE, never delete+insert (Phase 0 Design
    -- Note 5). multi_entity_assignments carries no owner-id column, so every
    -- assignment inherits to the new holder with zero data migration.
    v_already  := true;
    v_replaced := true;
    v_previous := v_existing_auth;

    update public.multi_entity_owner
       set auth_user_id = p_auth_user_id,
           name = v_name,
           phone = v_phone,
           email = v_email
     where id = true;

    insert into public.multi_entity_audit
      (action, seat_auth_user_id, previous_auth_user_id,
       acting_platform_owner_id, acting_auth_user_id)
    values
      ('replaced', p_auth_user_id, v_previous,
       v_platform_owner_id, p_platform_owner_auth_user_id);
  end if;

  -- previous_auth_user_id is returned so the caller can, as a SEPARATE and
  -- separately-approved operation, purge the replaced Auth account. This
  -- function never deletes an Auth account and never touches auth.* at all.
  return pg_catalog.jsonb_build_object(
    'already_existed', v_already,
    'replaced', v_replaced,
    'previous_auth_user_id', v_previous,
    'seat_auth_user_id', p_auth_user_id
  );
end;
$fn$;

comment on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) is
  'Stage 4A: creates or replaces the singleton Multi-Entity Owner seat. Replacement is an UPDATE in place, never delete+insert, so multi_entity_assignments inherit automatically. Rejects an identity that already holds the Platform Owner or Election Owner seat (IDENTITY_ALREADY_PRINCIPAL) or that has an ACTIONABLE pending Election Owner access (IDENTITY_PENDING_ELECTION_OWNER); re-provisioning the identity already holding this seat is an idempotent metadata refresh. Never touches auth.* - it returns previous_auth_user_id so a separate, separately-approved operation can purge the replaced account. service_role-only.';

revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from public;
revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from anon;
revoke all on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) from authenticated;
grant execute on function public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text) to service_role;

-- ===========================================================================
-- 6. ASSIGN a workspace to the Multi-Entity seat.
-- ===========================================================================
create or replace function public.platform_assign_workspace(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_workspace_name text;
  v_assignment_id uuid;
  v_audit_id uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null then
    raise exception 'INVALID_WORKSPACE_ID';
  end if;

  -- Fail closed rather than pre-staging visibility against an empty seat.
  if not exists (select 1 from public.multi_entity_owner) then
    raise exception 'MULTI_ENTITY_OWNER_NOT_PROVISIONED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_assign_' || p_workspace_id::text)::bigint
  );

  select w.name into v_workspace_name
  from public.election_workspaces w
  where w.id = p_workspace_id;

  if v_workspace_name is null then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  -- Deliberately NOT filtered by is_active: ACTIVE is clock-derived, and a
  -- workspace assigned while active must remain assigned after it ends. The
  -- ACTIVE filter belongs to the future aggregate-read path, not to assignment.
  select a.id into v_assignment_id
  from public.multi_entity_assignments a
  where a.workspace_id = p_workspace_id;

  if v_assignment_id is not null then
    -- Idempotent no-op writes NO audit row: auditing a no-op would be noise and
    -- would let a caller inflate the trail by repeating a request.
    return pg_catalog.jsonb_build_object(
      'assignment_id', v_assignment_id,
      'already_assigned', true,
      'audit_id', null
    );
  end if;

  insert into public.multi_entity_assignments (workspace_id)
  values (p_workspace_id)
  returning public.multi_entity_assignments.id into v_assignment_id;

  insert into public.multi_entity_audit
    (action, workspace_id_snapshot, workspace_name_snapshot,
     acting_platform_owner_id, acting_auth_user_id)
  values
    ('assigned', p_workspace_id, v_workspace_name,
     v_platform_owner_id, p_platform_owner_auth_user_id)
  returning public.multi_entity_audit.id into v_audit_id;

  return pg_catalog.jsonb_build_object(
    'assignment_id', v_assignment_id,
    'already_assigned', false,
    'audit_id', v_audit_id
  );
end;
$fn$;

comment on function public.platform_assign_workspace(uuid, uuid) is
  'Stage 4A: grants the Multi-Entity seat visibility of one workspace by inserting the multi_entity_assignments row. Requires a provisioned seat (MULTI_ENTITY_OWNER_NOT_PROVISIONED). Idempotent - a second assign returns already_assigned with no second row and no audit row. Never filtered by workspace ACTIVE-ness: that is clock-derived and belongs to the read path. Writes one immutable audit row per genuine assignment. service_role-only.';

revoke all on function public.platform_assign_workspace(uuid, uuid) from public;
revoke all on function public.platform_assign_workspace(uuid, uuid) from anon;
revoke all on function public.platform_assign_workspace(uuid, uuid) from authenticated;
grant execute on function public.platform_assign_workspace(uuid, uuid) to service_role;

-- ===========================================================================
-- 7. UNASSIGN a workspace.
-- ===========================================================================
create or replace function public.platform_unassign_workspace(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_workspace_name text;
  v_assignment_id uuid;
  v_audit_id uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_workspace_id is null then
    raise exception 'INVALID_WORKSPACE_ID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_multi_entity_assign_' || p_workspace_id::text)::bigint
  );

  select a.id into v_assignment_id
  from public.multi_entity_assignments a
  where a.workspace_id = p_workspace_id;

  if v_assignment_id is null then
    -- Absent is not an error. Removing visibility that is already absent is a
    -- successful no-op, and writes no audit row.
    return pg_catalog.jsonb_build_object(
      'removed', false,
      'audit_id', null
    );
  end if;

  -- Snapshot the name BEFORE the delete so the audit row stays readable even
  -- after the workspace itself is eventually hard-deleted.
  select w.name into v_workspace_name
  from public.election_workspaces w
  where w.id = p_workspace_id;

  delete from public.multi_entity_assignments
  where workspace_id = p_workspace_id;

  insert into public.multi_entity_audit
    (action, workspace_id_snapshot, workspace_name_snapshot,
     acting_platform_owner_id, acting_auth_user_id)
  values
    ('unassigned', p_workspace_id, coalesce(v_workspace_name, '(deleted workspace)'),
     v_platform_owner_id, p_platform_owner_auth_user_id)
  returning public.multi_entity_audit.id into v_audit_id;

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'audit_id', v_audit_id
  );
end;
$fn$;

comment on function public.platform_unassign_workspace(uuid, uuid) is
  'Stage 4A: removes the Multi-Entity seat''s visibility of one workspace. Removing an assignment removes visibility ONLY - election_workspaces itself is never touched. Idempotent: unassigning something already unassigned returns removed=false with no audit row, never an error. Writes one immutable audit row per genuine removal. service_role-only.';

revoke all on function public.platform_unassign_workspace(uuid, uuid) from public;
revoke all on function public.platform_unassign_workspace(uuid, uuid) from anon;
revoke all on function public.platform_unassign_workspace(uuid, uuid) from authenticated;
grant execute on function public.platform_unassign_workspace(uuid, uuid) to service_role;

-- ===========================================================================
-- 8. GUARD - may this Auth account be purged?
-- ===========================================================================
create or replace function public.platform_check_auth_user_purgeable(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_held_by text;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_auth_user_id is null then
    raise exception 'INVALID_AUTH_CLEANUP_TARGET';
  end if;

  -- (a) Already recorded as purged. This is a RECORD fact and is deliberately
  -- distinct from "the Auth user is absent", which is a WORLD fact the caller
  -- establishes by probing Supabase Auth. Only this one means the audit trail
  -- is complete.
  if exists (
    select 1 from public.multi_entity_audit a
    where a.action = 'previous_auth_deleted'
      and a.previous_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', true,
      'reason', 'ALREADY_COMPLETED',
      'held_by', null
    );
  end if;

  -- (b) Bind this destructive operation to a real replacement event. Without
  -- this the guard would permit deleting ANY unheld Auth account, including one
  -- named by a typo.
  if not exists (
    select 1 from public.multi_entity_audit a
    where a.action = 'replaced'
      and a.previous_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'NOT_A_REPLACED_PRINCIPAL',
      'held_by', null
    );
  end if;

  -- (c) Every linkage whose existence makes deletion unsafe. All four are FKs
  -- to auth.users(id) with ON DELETE CASCADE (Phase 0), so deleting the account
  -- would silently destroy the referencing row:
  --   platform_owners     - the Platform Owner singleton (also covers an
  --                         operator trying to delete their own account)
  --   election_owners     - a live workspace Owner; transitively cascades
  --                         election_owner_reauth_proofs.owner_id as well
  --   multi_entity_owner  - the current seat, including the case where this id
  --                         was re-provisioned back into it after replacement
  --   pending_owner_access- ANY row, ANY status: a pending/unexpired row is a
  --                         live in-flight onboarding, and consumed/expired rows
  --                         are onboarding history the cascade would erase.
  --
  -- NOT a blocker: platform_owner_recovery_audit.auth_user_id is documented as a
  -- snapshot with no FK, designed to outlive the auth.users row. Its presence is
  -- history, not a live linkage.
  if exists (
    select 1 from public.platform_owners po where po.auth_user_id = p_auth_user_id
  ) then
    v_held_by := 'platform';
  elsif exists (
    select 1 from public.election_owners o where o.auth_user_id = p_auth_user_id
  ) then
    v_held_by := 'election';
  elsif exists (
    select 1 from public.multi_entity_owner m where m.auth_user_id = p_auth_user_id
  ) then
    v_held_by := 'multi_entity';
  elsif exists (
    select 1 from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = p_auth_user_id
  ) then
    v_held_by := 'pending_owner';
  end if;

  if v_held_by is not null then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'AUTH_USER_STILL_HELD',
      'held_by', v_held_by
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'purgeable', true,
    'already_completed', false,
    'reason', null,
    'held_by', null
  );
end;
$fn$;

comment on function public.platform_check_auth_user_purgeable(uuid, uuid) is
  'Stage 4A: read-only guard answering "is it safe to delete this Supabase Auth account?". Refuses unless the id is recorded as the previous_auth_user_id of a real replacement event AND holds none of the four auth.users linkages (platform_owners, election_owners, multi_entity_owner, election_workspace_pending_owner_access - the last for ANY status, since all four cascade). Returns already_completed=true when a previous_auth_deleted row already exists - a RECORD fact, deliberately distinct from the caller''s own WORLD fact of whether the account is absent. service_role-only.';

revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from public;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from anon;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from authenticated;
grant execute on function public.platform_check_auth_user_purgeable(uuid, uuid) to service_role;

-- ===========================================================================
-- 9. RECORD the outcome of an Auth-account purge.
-- ===========================================================================
create or replace function public.platform_record_multi_entity_auth_cleanup(
  p_platform_owner_auth_user_id uuid,
  p_previous_auth_user_id uuid,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_existing uuid;
  v_id uuid;
begin
  if p_platform_owner_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select po.id into v_platform_owner_id
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;

  if v_platform_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_previous_auth_user_id is null then
    raise exception 'INVALID_AUTH_CLEANUP_TARGET';
  end if;

  -- A success is TERMINAL. Once it exists, neither a duplicate success nor a
  -- contradictory later failure is written - a retry after a lost response must
  -- converge, not append a record saying the opposite of the one already there.
  select a.id into v_existing
  from public.multi_entity_audit a
  where a.action = 'previous_auth_deleted'
    and a.previous_auth_user_id = p_previous_auth_user_id;

  if v_existing is not null then
    return pg_catalog.jsonb_build_object(
      'audit_id', v_existing,
      'recorded', false,
      'already_completed', true
    );
  end if;

  begin
    insert into public.multi_entity_audit
      (action, previous_auth_user_id, acting_platform_owner_id, acting_auth_user_id)
    values (
      case when p_deleted is true
           then 'previous_auth_deleted'
           else 'previous_auth_delete_failed'
      end,
      p_previous_auth_user_id,
      v_platform_owner_id,
      p_platform_owner_auth_user_id
    )
    returning public.multi_entity_audit.id into v_id;
  exception when unique_violation then
    -- Genuinely concurrent success recorders: the partial unique index let
    -- exactly one through. Report the winner's row rather than failing.
    select a.id into v_id
    from public.multi_entity_audit a
    where a.action = 'previous_auth_deleted'
      and a.previous_auth_user_id = p_previous_auth_user_id;

    return pg_catalog.jsonb_build_object(
      'audit_id', v_id,
      'recorded', false,
      'already_completed', true
    );
  end;

  return pg_catalog.jsonb_build_object(
    'audit_id', v_id,
    'recorded', true,
    'already_completed', (p_deleted is true)
  );
end;
$fn$;

comment on function public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean) is
  'Stage 4A: records the terminal outcome of purging a replaced Multi-Entity Owner''s Auth account, as one immutable append-only row. Idempotent and non-contradictory: once a previous_auth_deleted row exists, neither a duplicate success nor a later failure is written, and a concurrent duplicate is absorbed via the partial unique index rather than raising. Repeated previous_auth_delete_failed rows are permitted before a success - each is a genuinely distinct attempt. Keeps its own platform_owners re-resolution, deliberately diverging from platform_record_recovery_audit''s pure-writer precedent, because the caller always holds a verified id. service_role-only.';

revoke all on function public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean) from public;
revoke all on function public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean) from anon;
revoke all on function public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean) from authenticated;
grant execute on function public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.platform_record_multi_entity_auth_cleanup(uuid, uuid, boolean);
--   drop function if exists public.platform_check_auth_user_purgeable(uuid, uuid);
--   drop function if exists public.platform_unassign_workspace(uuid, uuid);
--   drop function if exists public.platform_assign_workspace(uuid, uuid);
--   drop function if exists public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text);
--   drop function if exists public.platform_get_multi_entity_state(uuid);
--   drop trigger if exists multi_entity_audit_immutable_truncate on public.multi_entity_audit;
--   drop trigger if exists multi_entity_audit_immutable on public.multi_entity_audit;
--   drop function if exists public.multi_entity_audit_prevent_mutation();
--   drop table if exists public.multi_entity_audit;
--   commit;
--
-- The table-level REVOKEs on multi_entity_owner / multi_entity_assignments are
-- deliberately NOT listed: reverting them would restore a documented latent
-- security gap, not undo this migration's feature.
-- ============================================================================
