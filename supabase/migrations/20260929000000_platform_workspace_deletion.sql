-- ===========================================================================
-- Platform Owner: permanent deletion of an election system.
--
-- The console has never had a path that deletes a workspace. Everything the
-- database needs for one already existed except the deletion itself:
--
--   * public.platform_deletion_audit was created by Phase 0 (20260823010000)
--     and its own comment says it is "written by a future phase's deletion RPC
--     in the same DB transaction that deletes the election_workspaces row".
--     This is that phase.
--   * public.election_workspaces_budget_delete_guard (Budget Stage 7A,
--     20260921000000) is a BEFORE DELETE trigger that refuses to let a
--     workspace holding Budget data disappear without a fresh VERIFIED Budget
--     export, and purges the Budget rows itself when there is one. A plain
--     DELETE therefore already carries that guard - so this migration issues a
--     plain DELETE and never touches, disables or works around the trigger.
--   * every one of the 28 foreign keys pointing at election_workspaces is
--     ON DELETE CASCADE, so the workspace's own data goes with it.
--
-- What did NOT exist, and is added here:
--
--   1. platform_deletion_audit was the last audit table in this project still
--      carrying table privileges for anon/authenticated/service_role (a
--      pg_default_acl artefact - see CLAUDE.md's permanent guardrail) and the
--      last one with no immutability trigger. Stage 4A recorded this gap
--      explicitly and left it "separately tracked" as out of its scope
--      (20260910010000). The phase that finally writes to the table closes it.
--
--      Making it immutable REQUIRES dropping its
--      deleted_by_platform_owner_id -> platform_owners(id) ON DELETE SET NULL
--      foreign key first. Stage 4A proved empirically why: a SET NULL cascade
--      issues an internal UPDATE against the audit table, which an
--      immutability trigger refuses - which would make deleting a
--      platform_owners row impossible forever once any audit row referenced
--      it. The column stays, as a plain snapshot, exactly like every
--      reference column on multi_entity_audit.
--
--   2. Three things a cascade cannot reach, because nothing links them to the
--      workspace by a foreign key:
--
--        - election_workspace_pending_owner_access: the approval the workspace
--          was provisioned FROM. It has no workspace_id at all (it is keyed by
--          the Owner's auth_user_id, UNIQUE). Left behind it would read in the
--          console as a system that has not been created yet, and
--          platform_classify_owner_access_email would answer APPROVAL_EXISTS
--          forever - that address could never be approved again.
--        - auth_identities for realm 'election_owner': the row that resolves
--          the Owner's USERNAME at the shared login. Its subject-shape CHECK
--          forces workspace_id to be NULL for every non-worker realm, so no
--          cascade touches it, and the shared-username unique index would hold
--          that username hostage for the life of the account.
--        - auth_handoff_codes for realm 'election_owner': outstanding sign-in
--          codes for the account, which only ever led into this workspace.
--
--   3. The deletion itself, and proof that it was complete.
--
-- NOT in this migration, deliberately: replacing an Owner, deleting an Owner
-- while keeping the workspace, and deleting the Auth ACCOUNT. The Auth account
-- is a shared identity - the same auth.users row can hold another principal -
-- so the database only ever REPORTS it as orphaned, after checking that
-- nothing else holds it, and the existing confirmed-delete path in
-- api/platform/session.ts removes it. A DEFINER function reaching into
-- auth.users would bypass that convention and GoTrue's own bookkeeping.
--
-- ROLLBACK (manual):
--   begin;
--   drop function if exists public.platform_delete_election_workspace(uuid, uuid, text);
--   drop function if exists public.platform_workspace_row_counts(uuid);
--   drop trigger if exists platform_deletion_audit_immutable on public.platform_deletion_audit;
--   drop trigger if exists platform_deletion_audit_immutable_truncate on public.platform_deletion_audit;
--   drop function if exists public.platform_deletion_audit_prevent_mutation();
--   alter table public.platform_deletion_audit
--     drop constraint if exists platform_deletion_audit_row_counts_shape,
--     drop column if exists acting_auth_user_id,
--     drop column if exists owner_name_snapshot,
--     drop column if exists owner_email_snapshot,
--     drop column if exists owner_auth_user_id_snapshot,
--     drop column if exists auth_user_orphaned,
--     drop column if exists row_counts;
--   -- the dropped foreign key is NOT restored: an immutable audit table cannot
--   -- carry one (see above). Re-adding it would re-open the Stage 4A hazard.
--   grant all on table public.platform_deletion_audit to anon, authenticated, service_role;
--   commit;
-- ===========================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. platform_deletion_audit: a real, immutable, unreachable audit table.
-- ---------------------------------------------------------------------------
alter table public.platform_deletion_audit
  drop constraint if exists platform_deletion_audit_deleted_by_platform_owner_id_fkey;

alter table public.platform_deletion_audit
  add column if not exists acting_auth_user_id         uuid,
  add column if not exists owner_name_snapshot         text,
  add column if not exists owner_email_snapshot        text,
  add column if not exists owner_auth_user_id_snapshot uuid,
  add column if not exists auth_user_orphaned          boolean not null default false,
  add column if not exists row_counts                  jsonb   not null default '{}'::jsonb;

-- row_counts is the only free-shaped column on this table, so it is the only
-- place a future caller could put something that does not belong in an audit
-- record. It must be a JSON OBJECT, and it may not carry a key that looks like
-- credential material - the same blocklist platform_owner_account_audit uses on
-- its own details column (20260928000000). "Every value is a number" cannot be
-- expressed here: a CHECK constraint may not contain a subquery, and
-- jsonb_each is set-returning. platform_workspace_row_counts is the only writer
-- and it only ever builds counts.
alter table public.platform_deletion_audit
  drop constraint if exists platform_deletion_audit_row_counts_shape;
alter table public.platform_deletion_audit
  add constraint platform_deletion_audit_row_counts_shape
  check (
    jsonb_typeof(row_counts) = 'object'
    and not (row_counts ?| array['password', 'new_password', 'old_password', 'secret',
                                 'token', 'hash', 'password_hash', 'encrypted_password'])
  );

comment on column public.platform_deletion_audit.deleted_by_platform_owner_id is
  'Snapshot of the acting Platform Owner''s platform_owners.id. Deliberately NOT a foreign key any more: this table is immutable, and an ON DELETE SET NULL cascade issues an internal UPDATE against it, which the immutability trigger refuses - that would make deleting a platform_owners row impossible forever once any deletion had been audited. Stage 4A established this empirically for multi_entity_audit and recorded platform_deletion_audit as the same gap, left for the phase that would finally write here.';
comment on column public.platform_deletion_audit.acting_auth_user_id is
  'The auth.users id the request was authenticated as, snapshotted. Plain snapshot, no foreign key, for the same reason as every other reference column here.';
comment on column public.platform_deletion_audit.owner_email_snapshot is
  'The deleted workspace''s Election Owner address, as election_owners held it. An identifier, never a credential - no password, token, hash or link is recorded on this table, and the row_counts CHECK keeps a credential-shaped key out of the only free-shaped column.';
comment on column public.platform_deletion_audit.auth_user_orphaned is
  'True when, after the deletion, nothing in the system still held that auth.users row - so the server was told to purge the account. False when another principal held it and the account (and its username identity) were deliberately left alone.';
comment on column public.platform_deletion_audit.row_counts is
  'Table name -> number of rows that workspace held immediately before deletion, over every table with a workspace_id column. Evidence of what the cascade removed; the record outlives every one of those rows.';
comment on column public.platform_deletion_audit.reason is
  'Free text, and deliberately never filled from operator or client input - platform_delete_election_workspace writes a fixed marker. Keeping arbitrary text off an immutable table is the simplest way to guarantee it can never carry a secret.';

create or replace function public.platform_deletion_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

-- Same treatment every other *_prevent_mutation function in this project has:
-- postgres-only. It is reachable as a trigger regardless of grants, and nobody
-- has any reason to call it directly.
revoke all on function public.platform_deletion_audit_prevent_mutation() from public;
revoke all on function public.platform_deletion_audit_prevent_mutation() from anon;
revoke all on function public.platform_deletion_audit_prevent_mutation() from authenticated;
revoke all on function public.platform_deletion_audit_prevent_mutation() from service_role;

drop trigger if exists platform_deletion_audit_immutable on public.platform_deletion_audit;
create trigger platform_deletion_audit_immutable
  before update or delete on public.platform_deletion_audit
  for each row execute function public.platform_deletion_audit_prevent_mutation();

drop trigger if exists platform_deletion_audit_immutable_truncate on public.platform_deletion_audit;
create trigger platform_deletion_audit_immutable_truncate
  before truncate on public.platform_deletion_audit
  for each statement execute function public.platform_deletion_audit_prevent_mutation();

-- The pg_default_acl residue. RLS with zero policies already stops anon and
-- authenticated, but service_role carries BYPASSRLS - so without these REVOKEs
-- the deletion record is readable AND writable straight through PostgREST with
-- the server key. Every other audit table in this project is
-- postgres-privileges-only; this one now matches.
revoke all on table public.platform_deletion_audit from public;
revoke all on table public.platform_deletion_audit from anon;
revoke all on table public.platform_deletion_audit from authenticated;
revoke all on table public.platform_deletion_audit from service_role;

comment on table public.platform_deletion_audit is
  'Permanent record of every workspace deletion, written by platform_delete_election_workspace in the SAME transaction that deletes the election_workspaces row - so a deletion either happens and is recorded, or neither. workspace_id_snapshot and every other reference column are deliberately plain snapshots with no foreign key: this table must outlive the workspace, the platform_owners row and the auth.users row it describes. Immutable (UPDATE/DELETE/TRUNCATE all raise AUDIT_IMMUTABLE), RLS-enabled with zero policies, and reachable by no role at all - not even service_role, which holds BYPASSRLS. Carries no credential material of any kind. Companion to budget_workspace_deletions, which records the Budget side of the same event.';

-- ---------------------------------------------------------------------------
-- 2. What a workspace still holds. Derived from the catalog, not a hand-kept
--    list, so a table added by a later migration is covered the day it exists.
-- ---------------------------------------------------------------------------
create or replace function public.platform_workspace_row_counts(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  r     record;
  n     bigint;
  v_out jsonb := '{}'::jsonb;
begin
  for r in
    select c.oid::regclass::text as tbl
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid
     and a.attname = 'workspace_id'
     and a.attnum > 0
     and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace
      and c.relkind = 'r'
      -- The one intentional survivor: budget_workspace_deletions is the Budget
      -- side's own permanent record of this very deletion. It is written BY the
      -- purge and must outlive the workspace, exactly like this audit table.
      and c.relname <> 'budget_workspace_deletions'
    order by 1
  loop
    execute pg_catalog.format(
      'select pg_catalog.count(*) from %s x where x.workspace_id = $1', r.tbl)
      into n using p_workspace_id;
    if n > 0 then
      v_out := v_out || pg_catalog.jsonb_build_object(r.tbl, n);
    end if;
  end loop;
  return v_out;
end;
$fn$;

comment on function public.platform_workspace_row_counts(uuid) is
  'Every row the given workspace still owns, as table name -> count, over EVERY public table carrying a workspace_id column - discovered from the catalog rather than from a hand-maintained list, so a table added by a later migration is counted the day it is created. Zero counts are omitted, so an empty object means the workspace owns nothing anywhere. Used twice by platform_delete_election_workspace: once before the delete, as the audited record of what was removed, and once after, as the proof that nothing survived. Granted to no role - internal to that function.';

-- Granted to NO role, service_role included: it is a DEFINER reader with no
-- authorization check of its own (its caller does that), so exposing it through
-- PostgREST would hand out a row-count oracle over every workspace.
revoke all on function public.platform_workspace_row_counts(uuid) from public;
revoke all on function public.platform_workspace_row_counts(uuid) from anon;
revoke all on function public.platform_workspace_row_counts(uuid) from authenticated;
revoke all on function public.platform_workspace_row_counts(uuid) from service_role;

-- ---------------------------------------------------------------------------
-- 3. The deletion.
-- ---------------------------------------------------------------------------
create or replace function public.platform_delete_election_workspace(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id                uuid,
  p_confirm_name                text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_platform_owner_id uuid;
  v_name              text;
  v_owner_auth        uuid;
  v_owner_name        text;
  v_owner_email       text;
  v_counts            jsonb;
  v_residual          jsonb;
  v_orphan            uuid := null;
  v_held              text := null;
  v_deleted           integer;
begin
  -- Same convention as every other privileged Platform function: the acting
  -- identity is re-resolved from platform_owners here, in this transaction. A
  -- Platform Owner who was replaced between the request's authentication and
  -- this statement is refused.
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
    raise exception 'INVALID_REQUEST';
  end if;

  -- Locked for the life of the transaction: the name that is confirmed, the
  -- rows that are counted and the row that is deleted must all be the same
  -- workspace in the same state.
  select w.name into v_name
  from public.election_workspaces w
  where w.id = p_workspace_id
  for update;

  if v_name is null then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  -- The typed name must be the workspace's own. The console requires this too,
  -- but a confirmation that lives only in the browser is not a confirmation:
  -- this is the boundary that makes an accidental or replayed request
  -- impossible to turn into a deletion. Internal runs of whitespace are
  -- collapsed on both sides - that is typing, not a different name.
  if regexp_replace(btrim(coalesce(p_confirm_name, '')), '\s+', ' ', 'g')
     <> regexp_replace(btrim(v_name), '\s+', ' ', 'g') then
    raise exception 'WORKSPACE_NAME_MISMATCH';
  end if;

  -- At most one Owner per workspace (UNIQUE(workspace_id)), so this is THE
  -- Owner. Locked for the same reason as the workspace.
  select o.auth_user_id, o.name, o.email
    into v_owner_auth, v_owner_name, v_owner_email
  from public.election_owners o
  where o.workspace_id = p_workspace_id
  for update;

  v_counts := public.platform_workspace_row_counts(p_workspace_id);

  -- The three things no cascade reaches. All inside this transaction, so they
  -- roll back with everything else if the delete below is refused.
  if v_owner_auth is not null then
    delete from public.election_workspace_pending_owner_access pa
    where pa.auth_user_id = v_owner_auth;

    delete from public.auth_handoff_codes hc
    where hc.auth_user_id = v_owner_auth and hc.realm = 'election_owner';
  end if;

  -- A PLAIN delete, on purpose. election_workspaces_budget_delete_guard fires
  -- here: a workspace holding Budget data without a fresh verified export
  -- raises BUDGET_EXPORT_REQUIRED / BUDGET_EXPORT_STALE and this whole
  -- transaction - the approval and handoff deletes above included - rolls back,
  -- leaving the workspace exactly as it was. The guard is never bypassed,
  -- disabled or weakened, and the 28 ON DELETE CASCADE foreign keys do the
  -- rest of the work.
  delete from public.election_workspaces w where w.id = p_workspace_id;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then
    raise exception 'WORKSPACE_DELETE_INCOMPLETE';
  end if;

  -- Proof, not assumption: nothing anywhere still claims this workspace.
  v_residual := public.platform_workspace_row_counts(p_workspace_id);
  if v_residual <> '{}'::jsonb then
    raise exception 'WORKSPACE_DELETE_INCOMPLETE'
      using detail = 'rows still reference the workspace after the cascade';
  end if;

  -- The Owner's ACCOUNT is a shared identity: the same auth.users row can hold
  -- another principal. held_by is asked AFTER the cascade, so it answers about
  -- what is left - and only when the answer is "nobody" is the username
  -- released and the account reported for purging. When something else holds
  -- it, both are deliberately left alone.
  if v_owner_auth is not null then
    v_held := public.multi_entity_auth_user_held_by(v_owner_auth);
    if v_held is null then
      -- The project's own release primitive, not a raw delete: auth_identities
      -- holds at most one row per auth_user_id (a partial UNIQUE index), and
      -- for a non-worker realm the shape CHECK forces workspace_id to be NULL,
      -- so this is exactly the Owner's username row.
      perform public.auth_identity_release(v_owner_auth, null);
      v_orphan := v_owner_auth;
    end if;
  end if;

  insert into public.platform_deletion_audit (
    workspace_id_snapshot, workspace_name_snapshot,
    deleted_by_platform_owner_id, acting_auth_user_id,
    owner_name_snapshot, owner_email_snapshot, owner_auth_user_id_snapshot,
    auth_user_orphaned, row_counts, reason
  ) values (
    p_workspace_id, v_name,
    v_platform_owner_id, p_platform_owner_auth_user_id,
    v_owner_name, v_owner_email, v_owner_auth,
    v_orphan is not null, v_counts, 'platform_console'
  );

  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'name', v_name,
    'ownerAuthUserId', v_owner_auth,
    'orphanedAuthUserId', v_orphan,
    'heldBy', v_held,
    'rowCounts', v_counts
  );
end;
$fn$;

comment on function public.platform_delete_election_workspace(uuid, uuid, text) is
  'Deletes one election system permanently, as the Platform Owner, atomically. Re-resolves the acting Platform Owner from platform_owners in this transaction; locks the workspace and its Owner row; requires p_confirm_name to be the workspace''s own name (WORKSPACE_NAME_MISMATCH otherwise) so that a deletion can never be a single accidental or replayed call; removes the three things no foreign key reaches (the approval the workspace was provisioned from, the Owner''s username identity, outstanding election_owner handoff codes); issues a PLAIN DELETE so election_workspaces_budget_delete_guard runs - a workspace holding Budget data without a fresh verified export raises and the whole transaction rolls back with the workspace intact; verifies afterwards that no table with a workspace_id column still holds a row for it (WORKSPACE_DELETE_INCOMPLETE); and writes the immutable platform_deletion_audit row in the same transaction. It NEVER deletes an auth.users row: it returns orphanedAuthUserId only when multi_entity_auth_user_held_by confirms, after the cascade, that no other principal holds that account, and the server''s existing confirmed-delete path removes it. Returns counts and identifiers, never a credential. service_role only.';

revoke all on function public.platform_delete_election_workspace(uuid, uuid, text) from public;
revoke all on function public.platform_delete_election_workspace(uuid, uuid, text) from anon;
revoke all on function public.platform_delete_election_workspace(uuid, uuid, text) from authenticated;
grant execute on function public.platform_delete_election_workspace(uuid, uuid, text) to service_role;

commit;
