-- Platform Owner / Multi-Tenant program - Stage 3A: repair three tenant
-- uniqueness rules that are still GLOBAL but must be WORKSPACE-SCOPED.
--
-- ============================================================================
-- SCOPE - three tables, three constraint swaps, nothing else
-- ============================================================================
-- Touches public.election_day_permission_users, public.election_day_roles and
-- public.election_day_not_voting_reasons only, and on each one only the
-- uniqueness rule on `name`. No column is added, dropped or retyped; no RPC,
-- trigger, view, RLS policy, grant, revoke or foreign key is created,
-- modified or dropped; no row of business data is inserted, updated or
-- deleted. No workspace is created (that is Stage 3B, deliberately not part
-- of this migration).
--
-- ============================================================================
-- THE DEFECT THIS FIXES
-- ============================================================================
-- All three tables carry `workspace_id uuid NOT NULL` (set by Phase 4A,
-- 20260830010000) and are scoped per workspace by every live _v3 RPC, yet
-- each still declares `name text not null unique` from its ORIGINAL
-- single-tenant CREATE TABLE:
--
--   election_day_permission_users  20260803174731, line 20
--   election_day_roles             20260805181806, line 26
--   election_day_not_voting_reasons 20260806160000, line 18
--
-- Under a global UNIQUE(name), a SECOND workspace can never hold a role
-- named 'מנהל', a user named after anyone already registered in the first
-- workspace, or - decisively - a non-voting reason named 'לא עונה'.
--
-- That last one is not a cosmetic limitation, it is a guaranteed functional
-- failure: election_day_close_call_as_no_answer_v3 and its _owner_v3 sibling
-- (20260831000000, lines 983 and 1001) resolve the no-answer reason by
-- LITERAL NAME, scoped to the caller's own workspace:
--
--   select id from public.election_day_not_voting_reasons
--   where workspace_id = v_workspace_id and name = 'לא עונה';
--   if v_reason_id is null then raise exception 'NO_ANSWER_REASON_NOT_CONFIGURED';
--
-- Workspace #2 cannot create that row (the name is taken globally by
-- workspace #1), so its entire call-outcome flow fails closed from day one.
-- Those two RPCs are already written for workspace-scoped names - they are
-- correct-by-construction only AFTER this migration; today they merely
-- happen to work because exactly one workspace exists.
--
-- This is an oversight, not a design decision. The identical repair was
-- already carried out for public.election_day_coordinators in Phase 4A
-- (20260830010000, lines 236-244), which replaced its two global unique
-- indexes with workspace-scoped ones. These three tables were simply missed
-- in that pass.
--
-- ============================================================================
-- WHY CONSTRAINTS AND NOT UNIQUE INDEXES
-- ============================================================================
-- Follows the preference stated in the Stage 1 migration (20260907000000):
-- a UNIQUE CONSTRAINT is used wherever no partial predicate is required, so
-- the rule is visible in pg_constraint / \d and a violation raises SQLSTATE
-- 23505 naming the CONSTRAINT, which server code can map to a specific
-- business error. `create unique index` is reserved in this project for
-- rules that genuinely need a WHERE predicate (the Phase 4A coordinator
-- indexes) or a constant expression (platform_owners_singleton_idx).
--
-- No predicate is needed here: workspace_id is NOT NULL on all three tables
-- (asserted by gate 1 below), so `unique (workspace_id, name)` is a TOTAL
-- rule with no NULL-skipping semantics to reason about.
--
-- ============================================================================
-- ORDERING: ADD THE REPLACEMENT BEFORE DROPPING THE SUPERSEDED RULE
-- ============================================================================
-- Each pair below adds the workspace-scoped constraint FIRST and drops the
-- global one SECOND, so there is no instant - not even inside this
-- transaction - at which `name` is unprotected. Adding the composite while
-- the global rule still stands can never fail on pre-existing data: the
-- global rule is strictly stronger, so any table it already satisfies also
-- satisfies the composite. Same create-replacement-then-drop-superseded
-- pattern as Stage 1 (20260907000000) and Phase 4A (20260830010000).
--
-- ============================================================================
-- CONSTRAINT NAMES WERE READ, NOT GUESSED
-- ============================================================================
-- The three global constraint names below were read directly from
-- pg_constraint on a disposable local database with all 80 prior migrations
-- replayed, not inferred from PostgreSQL's `<table>_<column>_key` naming
-- convention. Gate 3 re-asserts each one by exact name at apply time, so if
-- the target database somehow carries a different name this migration fails
-- loudly and changes nothing, rather than silently skipping a drop.
--
-- ============================================================================
-- INDEX IMPACT (evaluated, not assumed)
-- ============================================================================
-- Dropping each global UNIQUE also drops its backing btree on (name);
-- adding each composite creates a btree on (workspace_id, name). Effects:
--
--   * election_day_not_voting_reasons - IMPROVED. The no-answer lookup above
--     filters on (workspace_id, name) in exactly that column order.
--   * election_day_roles - NEUTRAL. Every live lookup is by id (primary key)
--     or by workspace_id (election_day_roles_workspace_id_idx, untouched).
--   * election_day_permission_users - the one regression, and it is
--     deliberate: election_day_login_v2 looks a user up by bare
--     `where u.name = btrim(p_name)`, which the new leading-workspace_id
--     index cannot serve, so that lookup becomes a sequential scan. Accepted:
--     this table holds single-digit-to-low-double-digit rows per workspace
--     (Production currently holds 4 accounts in total), so the scan is
--     negligible, and adding a standalone non-unique index on (name) purely
--     to preserve an access path for a query that MUST itself change before
--     a second workspace exists (see the note below) would be speculative.
--
-- ============================================================================
-- KNOWN FOLLOW-UP THIS MIGRATION DELIBERATELY DOES NOT MAKE (read this)
-- ============================================================================
-- public.election_day_login_v2 authenticates with:
--
--   select u.id, u.name, u.password_hash, u.role_id, u.workspace_id
--     into  v_user_id, ...
--   from public.election_day_permission_users u
--   where u.name = btrim(p_name);
--
-- PL/pgSQL's `SELECT ... INTO` (without STRICT) does NOT raise on multiple
-- matching rows - it silently keeps an arbitrary one. So once two workspaces
-- each hold a user with the same name, that login resolves non-
-- deterministically: it may test the password against the wrong workspace's
-- row, and may either deny a correct password or authenticate into the wrong
-- workspace depending on physical row order and plan choice.
--
-- That defect CANNOT trigger today and is not triggered by this migration:
-- Production holds exactly ONE workspace, and no code path in the system can
-- create a second one (the only function that ever could,
-- election_day_backfill_historical_workspace, was dropped in 20260825000000).
-- With one workspace, `unique (workspace_id, name)` and `unique (name)` are
-- equivalent in effect, so this migration is a zero-behaviour-change swap on
-- the current database.
--
-- It is left out of THIS migration on purpose: changing an authentication
-- RPC is a materially different risk class from swapping a constraint and
-- needs its own focused change with its own auth-specific verification
-- (rate-limit interaction, session issuance, bcrypt comparison semantics,
-- and a decision on how a same-name/same-password collision across two
-- workspaces must resolve - it must fail closed, not pick a winner).
--
-- >>> STAGE 3B MUST FIX election_day_login_v2 BEFORE IT PROVISIONS A SECOND
-- >>> WORKSPACE. Treat this as a hard prerequisite, not a nice-to-have.
-- The legacy public.election_day_login carries the identical pattern; it is
-- already retired (anon/authenticated EXECUTE revoked in Phase 4A,
-- 20260830010000) and must not be revived.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction - without this wrapper a failure partway through could leave a
-- subset of these swaps applied and the rest missing.
begin;

-- ============================================================================
-- PRE-MIGRATION GATES - all three must hold, or nothing is changed.
--
-- These run inside the same transaction as the swaps, so a RAISE here aborts
-- the whole migration with the table definitions untouched. They are cheap
-- and they encode the exact assumptions this migration is built on, so a
-- database that does not match them fails loudly instead of silently
-- producing a different outcome than the one verified locally.
-- ============================================================================
do $$
declare
  v_tbl  text;
  v_nullable_tables text[] := '{}';
  v_dup_count bigint;
  v_missing text[] := '{}';
  v_expected_global text[] := array[
    'election_day_permission_users_name_key',
    'election_day_roles_name_key',
    'election_day_not_voting_reasons_name_key'
  ];
  v_name text;
begin
  -- GATE 1: workspace_id must be NOT NULL on all three tables. If it were
  -- nullable, `unique (workspace_id, name)` would stop constraining rows
  -- whose workspace_id is NULL (NULLs are never equal to each other), which
  -- would silently WEAKEN the rule instead of re-scoping it.
  foreach v_tbl in array array[
    'election_day_permission_users',
    'election_day_roles',
    'election_day_not_voting_reasons'
  ]
  loop
    if exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = v_tbl
        and c.column_name = 'workspace_id'
        and c.is_nullable = 'YES'
    ) then
      v_nullable_tables := v_nullable_tables || v_tbl;
    end if;

    if not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = v_tbl
        and c.column_name = 'workspace_id'
    ) then
      raise exception
        'STAGE3A_GATE1_FAILED: public.% has no workspace_id column', v_tbl;
    end if;
  end loop;

  if array_length(v_nullable_tables, 1) is not null then
    raise exception
      'STAGE3A_GATE1_FAILED: workspace_id is NULLABLE on: %. Re-scoping uniqueness would weaken the rule for NULL-workspace rows.',
      array_to_string(v_nullable_tables, ', ');
  end if;

  -- GATE 2: no existing duplicate within (workspace_id, name) on any of the
  -- three tables. ADD CONSTRAINT would fail on its own if this were
  -- violated, but it would do so with a generic 23505 that does not say
  -- which table or which value - this reports the table explicitly.
  select count(*) into v_dup_count from (
    select 1 from public.election_day_permission_users
    group by workspace_id, name having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise exception
      'STAGE3A_GATE2_FAILED: % duplicate (workspace_id, name) group(s) in public.election_day_permission_users', v_dup_count;
  end if;

  select count(*) into v_dup_count from (
    select 1 from public.election_day_roles
    group by workspace_id, name having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise exception
      'STAGE3A_GATE2_FAILED: % duplicate (workspace_id, name) group(s) in public.election_day_roles', v_dup_count;
  end if;

  select count(*) into v_dup_count from (
    select 1 from public.election_day_not_voting_reasons
    group by workspace_id, name having count(*) > 1
  ) d;
  if v_dup_count > 0 then
    raise exception
      'STAGE3A_GATE2_FAILED: % duplicate (workspace_id, name) group(s) in public.election_day_not_voting_reasons', v_dup_count;
  end if;

  -- GATE 3: each global constraint this migration intends to drop must
  -- actually exist, under the exact name read from pg_constraint. Guards
  -- against a silent no-op drop on a database whose constraint names differ.
  foreach v_name in array v_expected_global
  loop
    if not exists (
      select 1
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      where ns.nspname = 'public'
        and con.conname = v_name
        and con.contype = 'u'
    ) then
      v_missing := v_missing || v_name;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception
      'STAGE3A_GATE3_FAILED: expected global UNIQUE constraint(s) not found: %. Migration may already be applied, or names differ on this database.',
      array_to_string(v_missing, ', ');
  end if;
end;
$$;

-- ============================================================================
-- 1. election_day_permission_users - login-account names, per workspace.
-- ============================================================================
alter table public.election_day_permission_users
  add constraint election_day_permission_users_workspace_id_name_key
    unique (workspace_id, name);

alter table public.election_day_permission_users
  drop constraint election_day_permission_users_name_key;

comment on constraint election_day_permission_users_workspace_id_name_key
  on public.election_day_permission_users is
  'Stage 3A: PermissionUser login names are unique WITHIN a workspace, not across the platform. Supersedes the single-tenant election_day_permission_users_name_key (UNIQUE(name)) from 20260803174731, dropped by this same migration. workspace_id is NOT NULL (Phase 4A, 20260830010000), so this is a total rule with no NULL-skipping semantics. NOTE: election_day_login_v2 still resolves a user by bare name with no workspace filter - that must be fixed before a second workspace exists; see this migration''s header.';

-- ============================================================================
-- 2. election_day_roles - role names, per workspace.
-- ============================================================================
alter table public.election_day_roles
  add constraint election_day_roles_workspace_id_name_key
    unique (workspace_id, name);

alter table public.election_day_roles
  drop constraint election_day_roles_name_key;

comment on constraint election_day_roles_workspace_id_name_key
  on public.election_day_roles is
  'Stage 3A: role names are unique WITHIN a workspace, not across the platform - so every workspace can carry its own ''מנהל''/''טלפן/ית''/''נציג קלפי''. Supersedes the single-tenant election_day_roles_name_key (UNIQUE(name)) from 20260805181806, dropped by this same migration. Roles are workspace-scoped operational data with no global/shared-role model (see election_day_create_permission_user_v3''s own comment), so global name uniqueness never matched the architecture.';

-- ============================================================================
-- 3. election_day_not_voting_reasons - reason names, per workspace.
-- This is the constraint whose global form actively broke the second
-- workspace's call-outcome flow; see this migration's header.
-- ============================================================================
alter table public.election_day_not_voting_reasons
  add constraint election_day_not_voting_reasons_workspace_id_name_key
    unique (workspace_id, name);

alter table public.election_day_not_voting_reasons
  drop constraint election_day_not_voting_reasons_name_key;

comment on constraint election_day_not_voting_reasons_workspace_id_name_key
  on public.election_day_not_voting_reasons is
  'Stage 3A: non-voting reason names are unique WITHIN a workspace, not across the platform. Supersedes the single-tenant election_day_not_voting_reasons_name_key (UNIQUE(name)) from 20260806160000, dropped by this same migration. REQUIRED FOR CORRECTNESS, not just tidiness: election_day_close_call_as_no_answer_v3 / _owner_v3 (20260831000000) resolve the no-answer reason as (workspace_id = caller''s workspace AND name = ''לא עונה'') and raise NO_ANSWER_REASON_NOT_CONFIGURED when absent - under the old global rule only the first workspace could ever own that name. The backing index on (workspace_id, name) also serves that exact lookup in that exact column order.';

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"). Restores the three original global UNIQUE constraints under their
-- original names and drops the workspace-scoped replacements:
--
--   begin;
--   alter table public.election_day_not_voting_reasons
--     add constraint election_day_not_voting_reasons_name_key unique (name);
--   alter table public.election_day_not_voting_reasons
--     drop constraint if exists election_day_not_voting_reasons_workspace_id_name_key;
--   alter table public.election_day_roles
--     add constraint election_day_roles_name_key unique (name);
--   alter table public.election_day_roles
--     drop constraint if exists election_day_roles_workspace_id_name_key;
--   alter table public.election_day_permission_users
--     add constraint election_day_permission_users_name_key unique (name);
--   alter table public.election_day_permission_users
--     drop constraint if exists election_day_permission_users_workspace_id_name_key;
--   commit;
--
-- >>> KNOWN LIMITATION OF THIS ROLLBACK - READ BEFORE RELYING ON IT <<<
--
-- Rollback to global uniqueness is possible ONLY while no two workspaces
-- share a name in the affected table. The moment a second workspace holds a
-- role, PermissionUser or non-voting reason whose name already exists in
-- another workspace - which is precisely what this migration exists to
-- allow, and which Stage 3B's provisioning seeds deliberately produce (every
-- new workspace gets its own 'מנהל' role and its own 'לא עונה' reason) - the
-- corresponding `add constraint ... unique (name)` above will FAIL with
-- SQLSTATE 23505 and the rollback cannot complete for that table.
--
-- This is not a defect in the rollback script; it is inherent. Re-imposing a
-- strictly stronger constraint on data that has legitimately diverged under
-- the weaker one is only possible by first deleting or renaming the
-- conflicting rows, which is a destructive business-data decision and is
-- therefore deliberately NOT scripted here.
--
-- Practical guidance: this rollback is safe to rely on ONLY in the window
-- between applying this migration and provisioning a second workspace. After
-- that point, treat Stage 3A as effectively forward-only.
-- ============================================================================
