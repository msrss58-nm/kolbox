-- ============================================================================
-- Platform Owner Program - STAGE 3B: WORKSPACE PROVISIONING
--
-- Closes the last structural gap in the multi-tenant programme: until now no
-- deployed code path could create a second workspace at all. The only function
-- that ever inserted into election_workspaces was the one-time historical
-- backfill RPC, dropped in 20260825000000. This migration supplies the normal,
-- product-level onboarding flow that Phase 0 (20260823010000) designed the
-- election_workspace_pending_owner_access table for and deliberately left
-- unimplemented.
--
-- THE FLOW THIS IMPLEMENTS
--
--   Platform Owner approves an Election Owner
--     -> platform_create_pending_owner_access (this migration)
--   Owner receives a one-time recovery link and sets their OWN password
--     -> Supabase Auth only; no password is ever chosen for them
--   Owner signs in and is recognised as "pending, not yet provisioned"
--     -> election_day_resolve_owner_provisioning_state (this migration)
--   Owner confirms a workspace name + election end date
--     -> election_day_provision_workspace (this migration), ONE transaction
--   Owner creates the workspace's very first PermissionUser
--     -> election_day_bootstrap_first_permission_user (this migration)
--
-- WHY THE PENDING ROW IS CONSUMED, NOT DELETED
--
-- Phase 0's own header comment says the pending row "is deleted (its job is
-- done) rather than updated". That prose is SUPERSEDED by a later, explicit
-- product decision: the row is consumed in place (status='consumed',
-- consumed_at=now()) and kept, so an approval remains auditable after the
-- workspace exists. Phase 0's SCHEMA already supports exactly this and always
-- did - 'consumed' is one of the three CHECKed status values, consumed_at
-- exists, and election_workspace_pending_owner_access_consumed_at_check
-- enforces the biconditional (status='consumed') = (consumed_at is not null).
-- Only the comment was stale; no schema change is needed here, and this
-- migration adds no column to that table.
--
-- WHY NO PASSWORD IS SET BY THE PLATFORM OWNER
--
-- Phase 0's header also anticipated "the temporary password ... set via the
-- Admin API". That is likewise superseded: the Platform Owner never sets and
-- never learns an Election Owner's password. The Auth user is created with NO
-- password at all (api/platform/session.ts, op=create_owner_access) and the
-- Owner sets their own through a one-time recovery link. This mirrors the
-- Platform Owner's own bootstrap (scripts/platform-owner-bootstrap.mjs), which
-- already refuses to generate a password on anyone's behalf.
--
-- SEED PARITY - A DELIBERATE, DOCUMENTED WIDENING
--
-- election_day_seed_new_workspace reproduces the original single-tenant seed
-- (3 roles from 20260805181806, 6 non-voting reasons from 20260806160000),
-- with two corrections that are NOT drift:
--
--   1. The role originally seeded as the pre-rename operations name is seeded
--      under the renamed value applied by 20260823000000. Seeding the old name
--      would make a new workspace differ from every existing one.
--   2. The manager role is seeded with the COMPLETE current permission catalog
--      rather than the 22 strings frozen into the 2026-08-05 seed. Three
--      permissions were added to the catalog after that seed was written
--      (electionDay.manageNonVotingReasons,
--      electionDay.manageCoordinatorAllocation, voter.viewReminderHistory) and
--      were retro-fitted to the single existing workspace by targeted UPDATEs.
--      Replaying the frozen array here would hand every NEW workspace a manager
--      who cannot manage non-voting reasons or coordinator allocation -
--      reproducing, by construction, the exact bug class this project has
--      already had to fix twice. The manager role means full access, so it is
--      seeded as full access.
--
-- THE NO-ANSWER REASON IS MANDATORY, NOT DECORATIVE
--
-- election_day_close_call_as_no_answer_v3 resolves one literal reason name per
-- workspace and raises NO_ANSWER_REASON_NOT_CONFIGURED when it is absent, so a
-- workspace seeded without it has a call-outcome flow that fails closed from
-- day one. Stage 3A's rollback note already named this as something "Stage 3B's
-- provisioning seeds deliberately produce".
--
-- CONCURRENCY
--
-- Provisioning takes a per-Owner transaction-scoped advisory lock and then
-- re-checks for an existing owner row INSIDE the lock, so two concurrent
-- first-logins by the same Owner cannot produce two workspaces. Bootstrap takes
-- a per-workspace lock and asserts a genuinely empty roster inside it. Both use
-- the project's established pg_advisory_xact_lock idiom. Belt and braces:
-- election_owners_auth_user_id_key and election_owners_workspace_id_key would
-- still make a double-provision fail with 23505 even if the lock were bypassed.
--
-- ACL
--
-- Per CLAUDE.md's permanent guardrail (this project's hosted Production carries
-- a pg_default_acl entry that auto-grants EXECUTE to anon/authenticated on every
-- newly created function in schema public), every function below revokes from
-- public, anon and authenticated BY NAME before granting. The internal helper
-- additionally revokes from service_role - it is callable only from inside
-- another postgres-owned SECURITY DEFINER function.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Pre-flight gates: refuse to run twice, or against an unexpected schema.
-- ---------------------------------------------------------------------------
do $gate$
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'election_day_provision_workspace'
  ) then
    raise exception 'STAGE3B_GATE_FAILED: public.election_day_provision_workspace already exists - migration may already be applied';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'election_day_generate_workspace_login_code'
  ) then
    raise exception 'STAGE3B_GATE_FAILED: public.election_day_generate_workspace_login_code is missing - 20260909010000 must be applied first';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'election_owners_workspace_id_key'
  ) then
    raise exception 'STAGE3B_GATE_FAILED: election_owners_workspace_id_key is missing - 20260907000000 must be applied first';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'election_workspaces_login_code_key'
  ) then
    raise exception 'STAGE3B_GATE_FAILED: election_workspaces_login_code_key is missing - 20260909010000 must be applied first';
  end if;
end;
$gate$;

-- ===========================================================================
-- 1. INTERNAL HELPER - seed a brand-new workspace's built-in catalogs.
-- ===========================================================================
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

  -- Built-in roles. The manager role carries the complete current permission
  -- catalog (see the header's SEED PARITY note); the other two reproduce their
  -- historical arrays exactly.
  insert into public.election_day_roles
    (workspace_id, name, description, permissions, scope_type)
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
      'all'
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
      'assigned_to_me'
    ),
    (
      p_workspace_id,
      'נציג קלפי',
      'סימון וביטול סימון הצבעה בלבד, עם פרטי זיהוי בסיסיים.',
      array[
        'voter.markVoted', 'voter.viewName', 'voter.viewAddress',
        'voter.viewPhone', 'voter.viewVotedStatus'
      ],
      'assigned_to_me'
    );

  -- Built-in non-voting reasons. requires_follow_up mirrors 20260806180000:
  -- true only for the no-answer reason, false for the other five.
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

comment on function public.election_day_seed_new_workspace(uuid) is
  'Stage 3B internal helper: seeds one brand-new workspace built-in roles and non-voting reasons. Granted to NO role at all, service_role included - callable only from inside another postgres-owned SECURITY DEFINER function (election_day_provision_workspace) or by a superuser during a migration, matching the election_day_generate_workspace_login_code precedent. Seeds the literal no-answer reason, without which election_day_close_call_as_no_answer_v3 raises NO_ANSWER_REASON_NOT_CONFIGURED for that workspace forever.';

revoke all on function public.election_day_seed_new_workspace(uuid) from public;
revoke all on function public.election_day_seed_new_workspace(uuid) from anon;
revoke all on function public.election_day_seed_new_workspace(uuid) from authenticated;
revoke all on function public.election_day_seed_new_workspace(uuid) from service_role;

-- ===========================================================================
-- 2. PLATFORM OWNER - approve an Election Owner (create pending access).
--
-- The Auth user is created by the caller (api/platform/session.ts) via the
-- Admin API BEFORE this function runs, because election_workspace_pending_owner_access
-- .auth_user_id carries a FK to auth.users. If this function raises, the caller
-- compensates by deleting that just-created Auth user - the only id it is ever
-- allowed to delete, and only within the same request that created it.
--
-- Re-approving an auth_user_id that already has a pending row is idempotent
-- ONLY while that row is still genuinely pending and unexpired: it returns the
-- existing row untouched rather than extending its window. Every other state
-- (already consumed, expired, already an Owner) fails closed.
-- ===========================================================================
create or replace function public.platform_create_pending_owner_access(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_expires_in_days integer
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
  v_days integer;
  v_existing_id uuid;
  v_existing_status text;
  v_existing_expires timestamptz;
  v_id uuid;
  v_expires timestamptz;
begin
  -- Defence in depth. api/platform/session.ts has already verified the caller
  -- through the full three-check Platform Owner chain; this re-resolves the
  -- singleton independently so the RPC is not authorized by its caller's word.
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
    raise exception 'INVALID_REQUEST';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'MISSING_OWNER_NAME';
  end if;
  if p_email is null or btrim(p_email) = '' then
    raise exception 'MISSING_OWNER_EMAIL';
  end if;

  v_days := coalesce(p_expires_in_days, 7);
  if v_days < 1 or v_days > 30 then
    raise exception 'INVALID_EXPIRY_WINDOW';
  end if;

  -- Serialize concurrent approvals of the same Auth user.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('platform_create_pending_owner_access_' || p_auth_user_id::text)::bigint
  );

  -- An account that is already a provisioned Owner must never be re-approved.
  if exists (
    select 1 from public.election_owners o where o.auth_user_id = p_auth_user_id
  ) then
    raise exception 'OWNER_ALREADY_PROVISIONED';
  end if;

  select pa.id, pa.status, pa.expires_at
    into v_existing_id, v_existing_status, v_existing_expires
  from public.election_workspace_pending_owner_access pa
  where pa.auth_user_id = p_auth_user_id
  for update;

  if v_existing_id is not null then
    -- expires_at/consumed_at are authoritative; status may legitimately lag
    -- behind them (Phase 0 Design Note 3), so it is never read on its own.
    if v_existing_status = 'consumed' then
      raise exception 'PENDING_ACCESS_ALREADY_CONSUMED';
    end if;

    -- No attempt is made to write status='expired' here. This function is
    -- about to raise, and a raise rolls back its own transaction - the write
    -- would be silently discarded, leaving dead code that looks effective.
    -- Reconciling a stale status against expires_at is the future cleanup
    -- job's responsibility, exactly as Phase 0 Design Note 3 specifies.
    if v_existing_expires <= pg_catalog.now() then
      raise exception 'PENDING_ACCESS_EXPIRED';
    end if;

    -- Still genuinely pending: idempotent no-op, window deliberately NOT
    -- extended - re-clicking approve must not silently lengthen the window.
    return query select v_existing_id, v_existing_expires, true;
    return;
  end if;

  v_expires := pg_catalog.now() + (v_days || ' days')::interval;

  insert into public.election_workspace_pending_owner_access
    (auth_user_id, name, phone, email, status, expires_at)
  values (
    p_auth_user_id,
    btrim(p_name),
    nullif(btrim(coalesce(p_phone, '')), ''),
    btrim(p_email),
    'pending',
    v_expires
  )
  returning public.election_workspace_pending_owner_access.id into v_id;

  return query select v_id, v_expires, false;
end;
$fn$;

comment on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) is
  'Stage 3B: records Platform Owner approval of a new Election Owner as a pending-access row. Re-resolves the singleton platform_owners row from a SERVER-VERIFIED auth_user_id rather than trusting the caller. Creates no workspace and no election_owners row - provisioning happens later, atomically, when the Owner themselves confirms. Carries no password field of any kind: the Owner sets their own credential through a one-time recovery link. Idempotent only for a still-pending, unexpired row, which it returns without extending; consumed, expired and already-provisioned states all fail closed. service_role-only.';

revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) from public;
revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) from anon;
revoke all on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) from authenticated;
grant execute on function public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer) to service_role;

-- ===========================================================================
-- 3. ELECTION OWNER - resolve provisioning state.
--
-- The pre-owner-context path. Every other Owner RPC resolves through
-- election_day_resolve_owner_context, which requires an election_owners row and
-- therefore cannot describe an Owner who has been approved but has not yet
-- provisioned. This one answers the question "what should this authenticated
-- person see next?" without asserting any authority of its own.
--
-- It returns exactly one row, always, with state one of:
--   'provisioned' - an election_owners row exists; workspace fields populated
--   'pending'     - an unexpired pending row exists; workspace fields null
--   'expired'     - a pending row exists but its window has closed
--   'invalid'     - neither; an authenticated Supabase user who is nobody here
--
-- 'invalid' is deliberately NOT an exception: the caller is already
-- authenticated, and distinguishing "not an owner" from "expired" is exactly
-- what the UI needs in order to show the right message. It reveals nothing a
-- caller does not already know about their own account.
-- ===========================================================================
create or replace function public.election_day_resolve_owner_provisioning_state(
  p_auth_user_id uuid
)
returns table (
  state text,
  owner_id uuid,
  workspace_id uuid,
  workspace_name text,
  election_end_at timestamptz,
  login_code text,
  pending_id uuid,
  pending_name text,
  pending_email text,
  pending_expires_at timestamptz,
  has_permission_users boolean
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_pending_id uuid;
  v_pending_name text;
  v_pending_email text;
  v_pending_expires timestamptz;
  v_pending_status text;
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select o.id, o.workspace_id
    into v_owner_id, v_workspace_id
  from public.election_owners o
  where o.auth_user_id = p_auth_user_id;

  if v_owner_id is not null then
    return query
      select
        'provisioned'::text,
        v_owner_id,
        w.id,
        w.name,
        w.election_end_at,
        w.login_code,
        null::uuid,
        null::text,
        null::text,
        null::timestamptz,
        exists (
          select 1 from public.election_day_permission_users u
          where u.workspace_id = w.id
        )
      from public.election_workspaces w
      where w.id = v_workspace_id;
    return;
  end if;

  select pa.id, pa.name, pa.email, pa.expires_at, pa.status
    into v_pending_id, v_pending_name, v_pending_email, v_pending_expires, v_pending_status
  from public.election_workspace_pending_owner_access pa
  where pa.auth_user_id = p_auth_user_id;

  if v_pending_id is null then
    return query
      select 'invalid'::text, null::uuid, null::uuid, null::text,
             null::timestamptz, null::text, null::uuid, null::text,
             null::text, null::timestamptz, false;
    return;
  end if;

  -- expires_at/consumed_at are authoritative over status (Phase 0 Design
  -- Note 3). A consumed pending row with no owner row means the Owner was
  -- removed after provisioning; that is not a re-provisionable state.
  if v_pending_status = 'consumed' or v_pending_expires <= pg_catalog.now() then
    return query
      select 'expired'::text, null::uuid, null::uuid, null::text,
             null::timestamptz, null::text, v_pending_id, v_pending_name,
             v_pending_email, v_pending_expires, false;
    return;
  end if;

  return query
    select 'pending'::text, null::uuid, null::uuid, null::text,
           null::timestamptz, null::text, v_pending_id, v_pending_name,
           v_pending_email, v_pending_expires, false;
end;
$fn$;

comment on function public.election_day_resolve_owner_provisioning_state(uuid) is
  'Stage 3B: the pre-owner-context resolver. Answers what an authenticated Supabase user should see next - provisioned / pending / expired / invalid - WITHOUT requiring an election_owners row, which is precisely what election_day_resolve_owner_context cannot do. Confers no authority: every privileged Owner RPC still resolves its own owner_id and workspace_id independently. STABLE, read-only. service_role-only.';

revoke all on function public.election_day_resolve_owner_provisioning_state(uuid) from public;
revoke all on function public.election_day_resolve_owner_provisioning_state(uuid) from anon;
revoke all on function public.election_day_resolve_owner_provisioning_state(uuid) from authenticated;
grant execute on function public.election_day_resolve_owner_provisioning_state(uuid) to service_role;

-- ===========================================================================
-- 4. ELECTION OWNER - atomic workspace provisioning.
--
-- One transaction. A PL/pgSQL function body is one implicit transaction, so any
-- failure below rolls the whole thing back - there is no partial state in which
-- a workspace exists without its Owner, its seeds, or its consumed pending row.
-- ===========================================================================
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

  -- Per-Owner lock. Two concurrent first-logins by the same Owner serialize
  -- here, and the existing-owner check below then runs INSIDE the lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('election_day_provision_workspace_' || p_auth_user_id::text)::bigint
  );

  -- Idempotent success: an Owner who retries after a completed provisioning
  -- (a lost response, a double submit) gets their existing context back rather
  -- than a second workspace or a confusing error.
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

  select pa.id, pa.name, pa.email, pa.phone, pa.status, pa.expires_at
    into v_pending_id, v_pending_name, v_pending_email, v_pending_phone,
         v_pending_status, v_pending_expires
  from public.election_workspace_pending_owner_access pa
  where pa.auth_user_id = p_auth_user_id
  for update;

  if v_pending_id is null then
    raise exception 'PENDING_ACCESS_NOT_FOUND';
  end if;

  if v_pending_status = 'consumed' then
    raise exception 'PENDING_ACCESS_ALREADY_CONSUMED';
  end if;

  -- As in platform_create_pending_owner_access: no status='expired' write is
  -- attempted before raising, because the raise would roll it back. expires_at
  -- is authoritative; election_day_resolve_owner_provisioning_state already
  -- reports 'expired' from it regardless of what status says.
  if v_pending_expires <= pg_catalog.now() then
    raise exception 'PENDING_ACCESS_EXPIRED';
  end if;

  -- Bounded and fail-closed: the generator raises rather than returning a
  -- colliding or malformed code after 20 attempts.
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

  update public.election_workspace_pending_owner_access
  set status = 'consumed',
      consumed_at = pg_catalog.now()
  where id = v_pending_id;

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

comment on function public.election_day_provision_workspace(uuid, text, timestamptz) is
  'Stage 3B: atomically provisions one workspace for an approved, authenticated Election Owner - workspace row, unique login_code, election_owners row, built-in role and non-voting-reason seeds, and consumption of the pending-access row - in a single transaction. All-or-nothing: no partial provisioning state can exist. Concurrency-safe via a per-Owner pg_advisory_xact_lock plus SELECT ... FOR UPDATE on the pending row, backed by election_owners_auth_user_id_key and election_owners_workspace_id_key. Idempotent: a retry after success returns the existing context rather than creating a second workspace. The workspace name and election_end_at come from the Owner at this moment and are deliberately NOT stored on pending access. service_role-only.';

revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from public;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from anon;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from authenticated;
grant execute on function public.election_day_provision_workspace(uuid, text, timestamptz) to service_role;

-- ===========================================================================
-- 5. ELECTION OWNER - bootstrap the workspace's FIRST PermissionUser.
--
-- election_day_create_permission_user_v3 is unusable for this by construction:
-- it authenticates the actor through a PermissionUser session, which requires a
-- PermissionUser to already exist. This function breaks that circle exactly
-- once per workspace and then permanently refuses.
--
-- It does NOT weaken the normal path. create_permission_user_v3 is untouched,
-- still requires electionDay.manageUsers, and remains the only way to create
-- the second and every later user.
-- ===========================================================================
create or replace function public.election_day_bootstrap_first_permission_user(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_name text,
  p_password text,
  p_role_id uuid
)
returns table (
  id uuid,
  name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_id uuid;
begin
  -- Step-up proof, one-time-consumed, bound to this exact action string and to
  -- an Owner re-resolved live from election_owners.
  select v.owner_id, v.workspace_id
    into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'bootstrap_first_user'
  ) v;

  if v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'NAME_REQUIRED';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'PASSWORD_REQUIRED';
  end if;
  if p_role_id is null then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  -- Per-workspace lock, so two concurrent bootstraps serialize and the
  -- emptiness assertion below is evaluated under it.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('election_day_bootstrap_first_user_' || v_workspace_id::text)::bigint
  );

  -- THE self-extinguishing gate. Checked inside the lock, against this
  -- workspace only.
  if exists (
    select 1 from public.election_day_permission_users u
    where u.workspace_id = v_workspace_id
  ) then
    raise exception 'BOOTSTRAP_ALREADY_COMPLETED';
  end if;

  -- The role must belong to THIS workspace. Same containment rule and same
  -- generic error as create_permission_user_v3 - a cross-workspace role id is
  -- indistinguishable from a nonexistent one.
  if not exists (
    select 1 from public.election_day_roles r
    where r.id = p_role_id and r.workspace_id = v_workspace_id
  ) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_permission_users
    (name, password_hash, role_id, workspace_id)
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

comment on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) is
  'Stage 3B: creates the FIRST PermissionUser of a freshly provisioned workspace, breaking the circular dependency in election_day_create_permission_user_v3 (which authenticates its actor through a PermissionUser session that cannot exist yet). Owner-authenticated and step-up-proofed with the dedicated bootstrap_first_user action. Self-extinguishing: asserts a genuinely empty roster for this workspace under a per-workspace advisory lock, so the second call raises BOOTSTRAP_ALREADY_COMPLETED forever after. Uses the same bcrypt path and the same workspace-scoped role validation as the normal creation RPC, which is left completely unchanged. service_role-only.';

revoke all on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) from public;
revoke all on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) from anon;
revoke all on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) from authenticated;
grant execute on function public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid) to service_role;

commit;

-- ============================================================================
-- MANUAL ROLLBACK (not executed by this migration)
--
--   begin;
--   drop function if exists public.election_day_bootstrap_first_permission_user(uuid, bytea, text, text, uuid);
--   drop function if exists public.election_day_provision_workspace(uuid, text, timestamptz);
--   drop function if exists public.election_day_resolve_owner_provisioning_state(uuid);
--   drop function if exists public.platform_create_pending_owner_access(uuid, uuid, text, text, text, integer);
--   drop function if exists public.election_day_seed_new_workspace(uuid);
--   commit;
--
-- Dropping these functions removes the ability to provision further workspaces
-- but does NOT undo any workspace already provisioned. Any such workspace, its
-- Owner, its seeds and its consumed pending row all remain valid and fully
-- functional - nothing in this migration alters existing data or schema, so a
-- rollback is forward-safe. Deleting an already-provisioned workspace is a
-- separate, deliberate, destructive act and is not part of this rollback.
-- ============================================================================
