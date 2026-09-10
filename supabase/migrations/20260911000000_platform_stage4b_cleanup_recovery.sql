-- Platform Stage 4B (backend enablement): durable Auth-cleanup recovery.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- Stage 4A left two cleanup facts reachable only through a single HTTP
-- response, which means neither survives a reload:
--
--   1. REPLACEMENT orphans. Replacing the Multi-Entity Owner deliberately does
--      NOT delete the previous Auth account (D-1); the id comes back once, in
--      the provision response, as previousAuthUserId. Durable evidence already
--      exists - the 'replaced' audit row - but nothing derives pending state
--      from it, so the console cannot re-find the account after a reload.
--
--   2. PROVISIONING orphans. api/platform/session.ts creates the Auth account
--      BEFORE calling platform_provision_multi_entity_owner. When that RPC
--      fails it raises, so its transaction - seat write AND audit row - rolls
--      back completely, and the compensating delete may not be confirmable.
--      The account then exists with NO committed Postgres row naming it, and
--      platform_check_auth_user_purgeable correctly refuses it
--      (NOT_A_REPLACED_PRINCIPAL, since no 'replaced' row binds it).
--
-- Case 2 is closed by write-ahead recording: the handler records the mint in
-- its OWN transaction, between createUser and the provisioning RPC, so the
-- record survives that rollback. PostgREST runs one transaction per RPC call,
-- so "a separate transaction" necessarily means "a separate RPC" - the same
-- structural constraint that forced election_day_register_login_attempt to be
-- a standalone call rather than a step inside the login RPC.
--
-- ============================================================================
-- SCOPE - additive and reversible. No existing row is rewritten.
-- ============================================================================
--   new actions ............. 3  provisioning_auth_minted
--                                provisioning_orphan_deleted
--                                provisioning_orphan_delete_failed
--   new columns ............. 2  orphan_auth_user_id, attempted_email
--                                (both nullable, no default -> metadata-only)
--   constraints ............. 1 REPLACED (multi_entity_audit_action_check,
--                                widened 6 -> 9 actions; the name is resolved
--                                from pg_catalog by the gate below, never
--                                assumed) + 2 ADDED (shape constraints)
--   indexes ................. 1  multi_entity_audit_orphan_cleanup_success_key
--   tables .................. 0  deliberately none - see below
--   triggers ................ 0  deliberately none - see below
--   functions ............... +4 new, 2 replaced (7 -> 11 total)
--
-- No new table and no new trigger BY DESIGN. Reusing multi_entity_audit
-- inherits, already Production-verified, all of: the row-level UPDATE/DELETE
-- immutability trigger, the statement-level TRUNCATE immutability trigger,
-- RLS-enabled-with-zero-policies, and the table-level REVOKEs. A dedicated
-- table would have had to reproduce every one of those correctly. The four
-- pre-existing shape constraints were verified against all three new actions
-- before this migration was written: each new action carries NULL in
-- workspace_id_snapshot, workspace_name_snapshot, seat_auth_user_id and
-- previous_auth_user_id, so every one of those constraints evaluates
-- false = false and holds unchanged. Only the action list itself changes.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- This project's hosted Production carries a project-level pg_default_acl
-- entry that auto-grants EXECUTE to anon and authenticated on every newly
-- created function in schema public, and `revoke ... from public` alone does
-- NOT undo an individually-named-role default privilege. Every function below
-- - new AND replaced - therefore revokes EXECUTE from PUBLIC, anon and
-- authenticated BY EXACT SIGNATURE and only then grants EXECUTE to
-- service_role. CREATE OR REPLACE preserves an existing ACL rather than
-- re-applying defaults, but the block is re-asserted unconditionally anyway:
-- it is idempotent and costs nothing, and this instance has surprised us on
-- exactly this axis before. After applying to Production, verify
-- pg_proc.proacl there directly rather than trusting a local result.
--
-- ============================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ============================================================================
-- It grants the Multi-Entity Owner no runtime access of any kind. No new
-- anon/authenticated path is created, no authentication or AAL2 work for that
-- principal is performed, and no entity-scoped read is enabled. Stage 5 is
-- untouched.

-- ===========================================================================
-- 0. GATE - fail loudly rather than half-applying.
-- ===========================================================================
do $gate$
declare
  v_action_check text;
begin
  if to_regclass('public.multi_entity_audit') is null then
    raise exception 'STAGE4B_GATE_FAILED: public.multi_entity_audit is missing - 20260910010000 must be applied first';
  end if;

  if to_regprocedure('public.platform_get_multi_entity_state(uuid)') is null then
    raise exception 'STAGE4B_GATE_FAILED: platform_get_multi_entity_state(uuid) is missing';
  end if;

  if to_regprocedure('public.platform_check_auth_user_purgeable(uuid,uuid)') is null then
    raise exception 'STAGE4B_GATE_FAILED: platform_check_auth_user_purgeable(uuid,uuid) is missing';
  end if;

  -- The Stage 4A action CHECK is declared INLINE and therefore carries a
  -- system-generated name. It is resolved from pg_catalog here - identified by
  -- its definition, not by a guessed name - so that a differently-named
  -- constraint fails this gate instead of being silently left in place beside
  -- a second, wider one.
  select con.conname into v_action_check
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class c on c.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'multi_entity_audit'
    and con.contype = 'c'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%provisioned%'
    and pg_catalog.pg_get_constraintdef(con.oid) like '%unassigned%'
    and pg_catalog.pg_get_constraintdef(con.oid) not like '%IS NOT NULL%';

  if v_action_check is null then
    raise exception 'STAGE4B_GATE_FAILED: could not resolve the multi_entity_audit action CHECK constraint';
  end if;

  if v_action_check <> 'multi_entity_audit_action_check' then
    raise exception 'STAGE4B_GATE_FAILED: unexpected action CHECK name %', v_action_check;
  end if;
end;
$gate$;

-- ===========================================================================
-- 1. AUDIT MODEL - 3 new lifecycle actions, 2 new snapshot columns.
-- ===========================================================================
alter table public.multi_entity_audit
  add column if not exists orphan_auth_user_id uuid,
  add column if not exists attempted_email text;

comment on column public.multi_entity_audit.orphan_auth_user_id is
  'Stage 4B: the Supabase Auth id minted during a Multi-Entity provisioning attempt, and the subject of that account''s cleanup lifecycle. Deliberately a SEPARATE column from seat_auth_user_id and previous_auth_user_id: an id here is neither a seat holder nor a displaced seat holder - it is a candidate that may never have become either. Keeping it separate is what lets orphan eligibility ask "was this id ever a seat?" as a plain absence test against seat_auth_user_id. No foreign key, exactly like every other reference column on this table - the record must outlive the auth.users row it names, which is the entire point of recording it.';

comment on column public.multi_entity_audit.attempted_email is
  'Stage 4B: snapshot of the email the Platform Owner supplied for a provisioning attempt, carried ONLY on provisioning_auth_minted rows. Present so a destructive cleanup is confirmed against a recognisable identity rather than a bare UUID. Not a credential and never a link: no activation URL, token_hash, password, recovery secret or access token is stored on this table by any code path.';

-- Widen the action domain. The constraint name was resolved from pg_catalog by
-- the gate above; drop-then-add is the only way to widen a CHECK, and on this
-- table it is cheap - multi_entity_audit holds 0 rows in Production, so the
-- re-added constraint validates instantly and no existing row can violate it.
alter table public.multi_entity_audit
  drop constraint multi_entity_audit_action_check;

alter table public.multi_entity_audit
  add constraint multi_entity_audit_action_check
  check (action in (
    'provisioned',
    'replaced',
    'assigned',
    'unassigned',
    'previous_auth_deleted',
    'previous_auth_delete_failed',
    'provisioning_auth_minted',
    'provisioning_orphan_deleted',
    'provisioning_orphan_delete_failed'
  ));

-- Shape constraints for the new columns, matching the four the table already
-- carries: each column is bound to exactly the actions that may carry it, in
-- both directions, so a malformed row is rejected by the database rather than
-- by convention.
alter table public.multi_entity_audit
  add constraint multi_entity_audit_orphan_shape
  check ((action in (
            'provisioning_auth_minted',
            'provisioning_orphan_deleted',
            'provisioning_orphan_delete_failed'
          )) = (orphan_auth_user_id is not null));

-- One-directional on purpose: attempted_email is OPTIONAL even on a mint row
-- (a caller may legitimately omit it), but it must never appear on any other
-- action.
alter table public.multi_entity_audit
  add constraint multi_entity_audit_attempted_email_shape
  check (attempted_email is null or action = 'provisioning_auth_minted');

-- Exactly-once terminal success per orphaned id, mirroring
-- multi_entity_audit_cleanup_success_key's guarantee for the replacement path.
-- This is what lets the recorder convert a concurrent 23505 into an idempotent
-- "already completed" answer instead of writing a second, contradictory row.
-- provisioning_orphan_delete_failed rows are deliberately NOT unique - each
-- failed attempt is a genuinely distinct event worth keeping.
create unique index if not exists multi_entity_audit_orphan_cleanup_success_key
  on public.multi_entity_audit (orphan_auth_user_id)
  where action = 'provisioning_orphan_deleted';

-- ===========================================================================
-- 2. INTERNAL HELPER - the ONE definition of "this Auth id is currently held".
-- ===========================================================================
-- Extracted verbatim from platform_check_auth_user_purgeable's check (c) so
-- the replacement path and the provisioning-orphan path can never drift into
-- two different ideas of what is safe to delete. The elsif ORDER is preserved
-- exactly, because the returned label is order-sensitive and is surfaced to
-- the operator as held_by.
--
-- All four linkages are FKs to auth.users(id) with ON DELETE CASCADE (Phase 0),
-- so deleting a held account would silently destroy the referencing row.
-- election_workspace_pending_owner_access is matched for ANY status - a
-- pending/unexpired row is live in-flight onboarding, and consumed/expired rows
-- are onboarding history the cascade would erase. That is the Stage 4A
-- behaviour and it is preserved EXACTLY; it is deliberately NOT narrowed to the
-- "actionable pending" predicate used by provisioning eligibility, which
-- answers a different question.
--
-- SECURITY DEFINER because both callers are, and because it reads tables no
-- caller role may read directly. Granted to NO role at all - it is reached only
-- from inside other SECURITY DEFINER functions, whose owner retains EXECUTE.
create or replace function public.multi_entity_auth_user_held_by(
  p_auth_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  if p_auth_user_id is null then
    return null;
  end if;

  if exists (
    select 1 from public.platform_owners po where po.auth_user_id = p_auth_user_id
  ) then
    return 'platform';
  elsif exists (
    select 1 from public.election_owners o where o.auth_user_id = p_auth_user_id
  ) then
    return 'election';
  elsif exists (
    select 1 from public.multi_entity_owner m where m.auth_user_id = p_auth_user_id
  ) then
    return 'multi_entity';
  elsif exists (
    select 1 from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = p_auth_user_id
  ) then
    return 'pending_owner';
  end if;

  return null;
end;
$fn$;

comment on function public.multi_entity_auth_user_held_by(uuid) is
  'Stage 4B internal helper: returns which live linkage currently holds a Supabase Auth id (platform / election / multi_entity / pending_owner), or NULL when none does. The single definition of "held" shared by the replacement-cleanup and provisioning-orphan-cleanup guards, extracted verbatim from the Stage 4A guard so the two paths cannot drift. Order-sensitive: the label is surfaced as held_by. Matches election_workspace_pending_owner_access for ANY status, exactly as Stage 4A did. Granted to NO role - reached only from inside other SECURITY DEFINER functions.';

revoke all on function public.multi_entity_auth_user_held_by(uuid) from public;
revoke all on function public.multi_entity_auth_user_held_by(uuid) from anon;
revoke all on function public.multi_entity_auth_user_held_by(uuid) from authenticated;
revoke all on function public.multi_entity_auth_user_held_by(uuid) from service_role;

-- ===========================================================================
-- 3. Stage 4A guard, re-expressed through the helper. BEHAVIOUR UNCHANGED.
-- ===========================================================================
-- Body-only change: checks (a) and (b) are byte-identical to Stage 4A, and
-- check (c)'s inline elsif chain is replaced by a call to the helper that
-- carries that same chain verbatim. Same signature, same return shape, same
-- reason strings, same held_by labels, same ordering of the three checks.
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

  -- (a) Already recorded as purged - a RECORD fact, deliberately distinct from
  -- the caller's own WORLD fact of whether the account is absent.
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

  -- (b) Bind this destructive operation to a real replacement event.
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

  -- (c) Live linkages, via the shared helper.
  v_held_by := public.multi_entity_auth_user_held_by(p_auth_user_id);

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
  'Stage 4A: read-only guard answering "is it safe to delete this Supabase Auth account?". Refuses unless the id is recorded as the previous_auth_user_id of a real replacement event AND holds none of the four auth.users linkages (platform_owners, election_owners, multi_entity_owner, election_workspace_pending_owner_access - the last for ANY status, since all four cascade). Returns already_completed=true when a previous_auth_deleted row already exists - a RECORD fact, deliberately distinct from the caller''s own WORLD fact of whether the account is absent. Stage 4B re-expressed check (c) through multi_entity_auth_user_held_by so the replacement and provisioning-orphan paths share one definition of "held"; behaviour, return shape and reason strings are unchanged. service_role-only.';

revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from public;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from anon;
revoke all on function public.platform_check_auth_user_purgeable(uuid, uuid) from authenticated;
grant execute on function public.platform_check_auth_user_purgeable(uuid, uuid) to service_role;

-- ===========================================================================
-- 4. WRITE-AHEAD mint recording.
-- ===========================================================================
-- Called between createUser and platform_provision_multi_entity_owner, in its
-- own transaction, so the record survives that RPC's rollback. Deliberately a
-- pure writer with a caller re-resolution, matching
-- platform_record_multi_entity_auth_cleanup rather than
-- platform_record_recovery_audit: the caller always holds a server-verified id,
-- so re-resolving it costs nothing and keeps the function safe on its own.
--
-- Not idempotent by index, and deliberately so: Supabase Auth mints a fresh
-- uuid per createUser call, so a duplicate id cannot arise from the intended
-- flow, and eligibility is an EXISTS test that a hypothetical duplicate would
-- not disturb. Adding a unique index here would buy nothing and would turn a
-- harmless replay into a hard error.
create or replace function public.platform_record_provisioning_auth_mint(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_email text;
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

  if p_auth_user_id is null then
    raise exception 'MISSING_AUTH_USER_ID';
  end if;

  v_email := nullif(btrim(coalesce(p_email, '')), '');

  if v_email is not null and pg_catalog.length(v_email) > 254 then
    raise exception 'OWNER_EMAIL_TOO_LONG';
  end if;

  insert into public.multi_entity_audit
    (action, orphan_auth_user_id, attempted_email,
     acting_platform_owner_id, acting_auth_user_id)
  values
    ('provisioning_auth_minted', p_auth_user_id, v_email,
     v_platform_owner_id, p_platform_owner_auth_user_id)
  returning public.multi_entity_audit.id into v_id;

  return pg_catalog.jsonb_build_object('audit_id', v_id);
end;
$fn$;

comment on function public.platform_record_provisioning_auth_mint(uuid, uuid, text) is
  'Stage 4B: write-ahead record that a Supabase Auth account was minted for a Multi-Entity provisioning attempt. MUST be called in its own transaction, after createUser and BEFORE platform_provision_multi_entity_owner - that RPC raises on failure and rolls its whole transaction back, so a record written inside it would vanish exactly when it is needed. Stores the Auth uuid and the attempted email only; never a link, token, password or any credential. service_role-only.';

revoke all on function public.platform_record_provisioning_auth_mint(uuid, uuid, text) from public;
revoke all on function public.platform_record_provisioning_auth_mint(uuid, uuid, text) from anon;
revoke all on function public.platform_record_provisioning_auth_mint(uuid, uuid, text) from authenticated;
grant execute on function public.platform_record_provisioning_auth_mint(uuid, uuid, text) to service_role;

-- ===========================================================================
-- 5. Provisioning-orphan purge guard.
-- ===========================================================================
-- The sibling of platform_check_auth_user_purgeable. It cannot BE that
-- function: that guard's check (b) requires a 'replaced' row, which an orphan
-- by definition does not have. The two share check (c) through the helper.
create or replace function public.platform_check_provisioning_orphan_purgeable(
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

  -- (a) Terminal success already recorded. RECORD fact, not a WORLD fact.
  if exists (
    select 1 from public.multi_entity_audit a
    where a.action = 'provisioning_orphan_deleted'
      and a.orphan_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', true,
      'reason', 'ALREADY_COMPLETED',
      'held_by', null
    );
  end if;

  -- (b) Bind the deletion to an account THIS provisioning flow minted. Without
  -- it the guard would permit deleting any unheld Auth account, including one
  -- named by a typo.
  if not exists (
    select 1 from public.multi_entity_audit a
    where a.action = 'provisioning_auth_minted'
      and a.orphan_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'NOT_A_PROVISIONING_ORPHAN',
      'held_by', null
    );
  end if;

  -- (c) The account must never have become the seat. This is what separates a
  -- failed attempt from a successful one, and it is derived purely from
  -- immutable evidence: 'provisioned' and 'replaced' are the only actions that
  -- carry seat_auth_user_id, and both are written by the provisioning RPC in
  -- the very transaction that establishes the seat. A successful provision
  -- therefore excludes its own mint row from eligibility forever, without
  -- anything ever mutating or deleting that mint row.
  --
  -- Note this is strictly stronger than the live-linkage test below: an id that
  -- became the seat and was LATER replaced out of it is still refused here, and
  -- correctly so - that account is a REPLACEMENT orphan and must be purged
  -- through platform_check_auth_user_purgeable, which records the matching
  -- previous_auth_deleted audit row. Neither id can ever appear on both paths.
  if exists (
    select 1 from public.multi_entity_audit a
    where a.action in ('provisioned', 'replaced')
      and a.seat_auth_user_id = p_auth_user_id
  ) then
    return pg_catalog.jsonb_build_object(
      'purgeable', false,
      'already_completed', false,
      'reason', 'NOT_A_PROVISIONING_ORPHAN',
      'held_by', null
    );
  end if;

  -- (d) Live linkages, via the shared helper.
  v_held_by := public.multi_entity_auth_user_held_by(p_auth_user_id);

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

comment on function public.platform_check_provisioning_orphan_purgeable(uuid, uuid) is
  'Stage 4B: read-only guard answering "is it safe to delete this Auth account, which a failed Multi-Entity provisioning attempt left behind?". Requires a provisioning_auth_minted row for the id, no terminal provisioning_orphan_deleted row, NO provisioned/replaced row naming it as seat_auth_user_id (so an account that ever became the seat is refused - a displaced seat holder is a REPLACEMENT orphan and belongs to platform_check_auth_user_purgeable), and none of the four live auth.users linkages via multi_entity_auth_user_held_by. Mirrors the Stage 4A guard''s return shape exactly. service_role-only.';

revoke all on function public.platform_check_provisioning_orphan_purgeable(uuid, uuid) from public;
revoke all on function public.platform_check_provisioning_orphan_purgeable(uuid, uuid) from anon;
revoke all on function public.platform_check_provisioning_orphan_purgeable(uuid, uuid) from authenticated;
grant execute on function public.platform_check_provisioning_orphan_purgeable(uuid, uuid) to service_role;

-- ===========================================================================
-- 6. Provisioning-orphan cleanup recorder.
-- ===========================================================================
-- Structurally identical to platform_record_multi_entity_auth_cleanup, on the
-- orphan actions and the orphan unique index. A success is TERMINAL: once one
-- exists, neither a duplicate success nor a contradictory later failure is
-- written, so a retry after a lost response converges instead of appending a
-- record that says the opposite of the one already there.
create or replace function public.platform_record_provisioning_orphan_cleanup(
  p_platform_owner_auth_user_id uuid,
  p_auth_user_id uuid,
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

  if p_auth_user_id is null then
    raise exception 'INVALID_AUTH_CLEANUP_TARGET';
  end if;

  select a.id into v_existing
  from public.multi_entity_audit a
  where a.action = 'provisioning_orphan_deleted'
    and a.orphan_auth_user_id = p_auth_user_id;

  if v_existing is not null then
    return pg_catalog.jsonb_build_object(
      'audit_id', v_existing,
      'recorded', false,
      'already_completed', true
    );
  end if;

  begin
    insert into public.multi_entity_audit
      (action, orphan_auth_user_id, acting_platform_owner_id, acting_auth_user_id)
    values (
      case when p_deleted is true
           then 'provisioning_orphan_deleted'
           else 'provisioning_orphan_delete_failed'
      end,
      p_auth_user_id,
      v_platform_owner_id,
      p_platform_owner_auth_user_id
    )
    returning public.multi_entity_audit.id into v_id;
  exception when unique_violation then
    -- Genuinely concurrent success recorders: the partial unique index let
    -- exactly one through. Report the winner rather than failing.
    select a.id into v_id
    from public.multi_entity_audit a
    where a.action = 'provisioning_orphan_deleted'
      and a.orphan_auth_user_id = p_auth_user_id;

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

comment on function public.platform_record_provisioning_orphan_cleanup(uuid, uuid, boolean) is
  'Stage 4B: records the terminal outcome of purging an Auth account left behind by a failed Multi-Entity provisioning attempt, as one immutable append-only row. Idempotent and non-contradictory: once a provisioning_orphan_deleted row exists, neither a duplicate success nor a later failure is written, and a concurrent duplicate is absorbed via multi_entity_audit_orphan_cleanup_success_key rather than raising. Repeated provisioning_orphan_delete_failed rows are permitted before a success - each is a genuinely distinct attempt. Mirrors platform_record_multi_entity_auth_cleanup exactly. service_role-only.';

revoke all on function public.platform_record_provisioning_orphan_cleanup(uuid, uuid, boolean) from public;
revoke all on function public.platform_record_provisioning_orphan_cleanup(uuid, uuid, boolean) from anon;
revoke all on function public.platform_record_provisioning_orphan_cleanup(uuid, uuid, boolean) from authenticated;
grant execute on function public.platform_record_provisioning_orphan_cleanup(uuid, uuid, boolean) to service_role;

-- ===========================================================================
-- 7. READ CONTRACT - seat + workspaces UNCHANGED, two cleanup arrays added.
-- ===========================================================================
-- Same signature, return type, volatility, security mode and search_path as
-- Stage 4A. The seat and workspaces expressions are byte-identical to Stage
-- 4A's; only the two new keys are added to the returned object.
--
-- Both new keys are ALWAYS arrays - coalesce to '[]', never null - so a client
-- never has to distinguish "none" from "missing".
--
-- Ordering in both is a TOTAL order: timestamp ascending (oldest outstanding
-- first) with the uuid as tiebreak. The timestamp alone is not unique, so
-- without the tiebreak two entries could legally swap between two reads of
-- identical data, which is exactly what "stable across reloads" forbids.
--
-- "Currently purgeable" is expressed as `held_by is null` rather than by
-- calling the guards per row. That is the same predicate, not an approximation:
-- for a candidate already filtered to "has the binding evidence" and "has no
-- terminal success", the guards' only remaining test IS the linkage check.
-- Proven by the Stage 4B suite, which asserts the two agree row-for-row.
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
  v_pending_cleanup jsonb;
  v_pending_orphans jsonb;
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

  -- REPLACEMENT orphans: an account displaced from the seat that was never
  -- purged. Grouped by previous_auth_user_id, not per 'replaced' row: the
  -- terminal-success index is unique on the id, so one success settles every
  -- replacement naming that id, and an id displaced more than once must still
  -- produce exactly one entry.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'previous_auth_user_id', p.auth_user_id,
               'replaced_at', p.replaced_at,
               'failure_count', p.failure_count,
               'last_cleanup_attempt_at', p.last_attempt_at
             )
             order by p.replaced_at, p.auth_user_id
           ),
           '[]'::jsonb
         )
    into v_pending_cleanup
  from (
    select r.previous_auth_user_id as auth_user_id,
           pg_catalog.max(r.performed_at) as replaced_at,
           (select pg_catalog.count(*) from public.multi_entity_audit f
             where f.action = 'previous_auth_delete_failed'
               and f.previous_auth_user_id = r.previous_auth_user_id) as failure_count,
           (select pg_catalog.max(f.performed_at) from public.multi_entity_audit f
             where f.action = 'previous_auth_delete_failed'
               and f.previous_auth_user_id = r.previous_auth_user_id) as last_attempt_at
    from public.multi_entity_audit r
    where r.action = 'replaced'
      and not exists (
        select 1 from public.multi_entity_audit s
        where s.action = 'previous_auth_deleted'
          and s.previous_auth_user_id = r.previous_auth_user_id
      )
      and public.multi_entity_auth_user_held_by(r.previous_auth_user_id) is null
    group by r.previous_auth_user_id
  ) p;

  -- PROVISIONING orphans: an account minted for an attempt that never became
  -- the seat. The mint row stays forever - eligibility is derived from
  -- immutable facts, never by amending or deleting history.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'auth_user_id', o.auth_user_id,
               'minted_at', o.minted_at,
               'attempted_email', o.attempted_email,
               'failure_count', o.failure_count,
               'last_cleanup_attempt_at', o.last_attempt_at
             )
             order by o.minted_at, o.auth_user_id
           ),
           '[]'::jsonb
         )
    into v_pending_orphans
  from (
    select m.orphan_auth_user_id as auth_user_id,
           pg_catalog.max(m.performed_at) as minted_at,
           (pg_catalog.array_agg(m.attempted_email
              order by m.performed_at desc, m.id desc))[1] as attempted_email,
           (select pg_catalog.count(*) from public.multi_entity_audit f
             where f.action = 'provisioning_orphan_delete_failed'
               and f.orphan_auth_user_id = m.orphan_auth_user_id) as failure_count,
           (select pg_catalog.max(f.performed_at) from public.multi_entity_audit f
             where f.action = 'provisioning_orphan_delete_failed'
               and f.orphan_auth_user_id = m.orphan_auth_user_id) as last_attempt_at
    from public.multi_entity_audit m
    where m.action = 'provisioning_auth_minted'
      and not exists (
        select 1 from public.multi_entity_audit s
        where s.action = 'provisioning_orphan_deleted'
          and s.orphan_auth_user_id = m.orphan_auth_user_id
      )
      and not exists (
        select 1 from public.multi_entity_audit t
        where t.action in ('provisioned', 'replaced')
          and t.seat_auth_user_id = m.orphan_auth_user_id
      )
      and public.multi_entity_auth_user_held_by(m.orphan_auth_user_id) is null
    group by m.orphan_auth_user_id
  ) o;

  return pg_catalog.jsonb_build_object(
    'seat', v_seat,
    'workspaces', v_workspaces,
    'pending_auth_cleanup', v_pending_cleanup,
    'pending_provisioning_orphans', v_pending_orphans
  );
end;
$fn$;

comment on function public.platform_get_multi_entity_state(uuid) is
  'Stage 4A/4B: one round trip powering the whole Multi-Entity management surface - the current seat (null when unprovisioned), every workspace with is_assigned and derived is_active, and (Stage 4B) the two DURABLE cleanup queues: pending_auth_cleanup (accounts displaced from the seat by a replacement and never purged) and pending_provisioning_orphans (accounts minted for a provisioning attempt that never became the seat). Both are always arrays, both are derived entirely from immutable audit rows so they survive reload and session loss, and both use a TOTAL ordering (timestamp then uuid) so repeated reads are byte-identical. An id can never appear in both. Re-resolves the singleton platform_owners row from a SERVER-VERIFIED auth_user_id rather than trusting the caller. Read-only. service_role-only.';

revoke all on function public.platform_get_multi_entity_state(uuid) from public;
revoke all on function public.platform_get_multi_entity_state(uuid) from anon;
revoke all on function public.platform_get_multi_entity_state(uuid) from authenticated;
grant execute on function public.platform_get_multi_entity_state(uuid) to service_role;

-- ===========================================================================
-- 8. TABLE PRIVILEGES - re-assert, unchanged from Stage 4A.
-- ===========================================================================
-- The new columns inherit the table's ACL, and RLS-with-zero-policies still
-- denies every direct anon/authenticated read and write. service_role is
-- deliberately given NO direct table privilege: every access path is a
-- SECURITY DEFINER RPC above.
revoke all on table public.multi_entity_audit from public;
revoke all on table public.multi_entity_audit from anon;
revoke all on table public.multi_entity_audit from authenticated;
revoke all on table public.multi_entity_audit from service_role;
