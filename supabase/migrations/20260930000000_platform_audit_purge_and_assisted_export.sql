-- ===========================================================================
-- Two approved Platform Owner capabilities.
--
-- 1. PURGING THE ACTIVITY LOG. `יומן פעולות` reads four audit tables, and all
--    four are immutable by trigger and reachable by no role. A real deletion
--    therefore cannot be a grant and cannot be a TRUNCATE: it has to be one
--    privileged function, and the immutability triggers have to learn about
--    exactly that function and nothing else.
--
--    The mechanism is the one this project already uses for the Budget purge
--    (20260921000000): a TRANSACTION-LOCAL setting, set only inside the
--    privileged function and cleared before it returns. On its own the setting
--    grants nothing - no role holds DELETE on any of these tables, so only the
--    table owner reaching them through a SECURITY DEFINER function can delete
--    at all. The setting decides WHICH definer function may, not WHO may.
--
--    Narrow on purpose:
--      * DELETE only. UPDATE and TRUNCATE still raise AUDIT_IMMUTABLE under
--        the token - an audit row can still never be rewritten, and the tables
--        can still never be truncated.
--      * Only the four tables the activity log actually reads.
--        platform_deletion_audit keeps its unconditional trigger: it is not a
--        log source, it is the permanent record of a workspace deletion, and it
--        must never be deletable by anything.
--      * budget_audit_events is untouched. It belongs to a workspace's
--        finances, is covered by the Budget export/deletion contract, and is
--        not in the activity log.
--
--    Erasing an audit trail with no trace would be indefensible, so the purge
--    writes public.platform_audit_purge_log - which is itself immutable, is NOT
--    a log source (so the log really does read empty afterwards), and records
--    who purged, when, and how many rows of each table went.
--
-- 2. THE PLATFORM OWNER CAN PRODUCE A WORKSPACE'S BUDGET DELETION EXPORT.
--    A workspace holding Budget data can only be deleted with a fresh VERIFIED
--    Budget export - enforced by election_workspaces_budget_delete_guard, which
--    this migration does not touch, weaken or go around. Until now only the
--    workspace's own Election Owner could produce that export, so a workspace
--    whose Owner is unavailable could not be deleted at all.
--
--    platform_budget_export is a thin, fixed dispatcher onto the EXISTING
--    export ops - budget_op_export_status / _start / _part /
--    _document_locate / _verify - with no new export logic of any kind. The
--    same manifest, the same per-part checksums, the same serve records, the
--    same verification rules. The console drives it exactly as the Owner's own
--    export client does, writing every part and every document to a folder the
--    operator picks, so a verified export still means the data was served and
--    taken delivery of.
--
--    TWO DELIBERATE DECISIONS, stated rather than buried:
--
--    (a) It does NOT require the Budget module entitlement. The entitlement is
--        licensing; this is a deletion prerequisite. A workspace whose Budget
--        entitlement was removed still HOLDS its Budget rows, so requiring the
--        entitlement here would make such a workspace permanently undeletable -
--        the export could never be produced and the guard would never pass.
--    (b) The Budget actor it builds carries type 'owner', because
--        budget_require_owner demands it and relaxing that would weaken the
--        Budget boundary for every other op. The actor's ID is the Platform
--        Owner's real auth id and its NAME says so in words, so
--        budget_document_access_log and budget_data_exports.created_by_name
--        both record who actually did it rather than implying the Election
--        Owner did.
--
-- ROLLBACK (manual):
--   begin;
--   drop function if exists public.platform_budget_export(uuid, uuid, text, jsonb);
--   drop function if exists public.platform_workspace_deletion_preview(uuid, uuid);
--   drop function if exists public.platform_purge_activity_log(uuid, text);
--   -- restore the three trigger functions to their unconditional form:
--   create or replace function public.platform_owner_account_audit_prevent_mutation()
--     returns trigger language plpgsql set search_path = '' as $r$
--     begin raise exception 'AUDIT_IMMUTABLE'; end $r$;
--   create or replace function public.platform_entitlement_audit_prevent_mutation()
--     returns trigger language plpgsql set search_path = '' as $r$
--     begin raise exception 'AUDIT_IMMUTABLE'; end $r$;
--   create or replace function public.multi_entity_audit_prevent_mutation()
--     returns trigger language plpgsql set search_path = '' as $r$
--     begin raise exception 'AUDIT_IMMUTABLE'; end $r$;
--   drop trigger if exists platform_audit_purge_log_immutable on public.platform_audit_purge_log;
--   drop trigger if exists platform_audit_purge_log_immutable_truncate on public.platform_audit_purge_log;
--   drop function if exists public.platform_audit_purge_log_prevent_mutation();
--   drop table if exists public.platform_audit_purge_log;
--   commit;
-- ===========================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1a. The trace a purge leaves behind.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_audit_purge_log (
  id                                 uuid primary key default gen_random_uuid(),
  acting_platform_owner_auth_user_id uuid not null,
  purged_at                          timestamptz not null default now(),
  row_counts                         jsonb not null default '{}'::jsonb,
  constraint platform_audit_purge_log_row_counts_shape check (
    jsonb_typeof(row_counts) = 'object'
    and not (row_counts ?| array['password', 'new_password', 'old_password', 'secret',
                                 'token', 'hash', 'password_hash', 'encrypted_password'])
  )
);

comment on table public.platform_audit_purge_log is
  'One row per activity-log purge: who did it, when, and how many rows of each audited table went. Written by platform_purge_activity_log in the SAME transaction that deletes them, so an erased audit trail can never be an untraceable one. Deliberately NOT a source of platform_list_activity - the log genuinely reads empty after a purge, and this record still exists. Itself immutable with no escape of any kind: the purge token that lets the four log tables be deleted has no effect here. RLS-enabled with zero policies and no privileges for any role, service_role included. Carries no credential material - the only free-shaped column is row_counts, which holds counts.';
comment on column public.platform_audit_purge_log.acting_platform_owner_auth_user_id is
  'The auth.users id the purge was authenticated as, snapshotted. Plain snapshot, no foreign key: this record must outlive the platform_owners row and the account it names.';

alter table public.platform_audit_purge_log enable row level security;

create or replace function public.platform_audit_purge_log_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

revoke all on function public.platform_audit_purge_log_prevent_mutation() from public;
revoke all on function public.platform_audit_purge_log_prevent_mutation() from anon;
revoke all on function public.platform_audit_purge_log_prevent_mutation() from authenticated;
revoke all on function public.platform_audit_purge_log_prevent_mutation() from service_role;

drop trigger if exists platform_audit_purge_log_immutable on public.platform_audit_purge_log;
create trigger platform_audit_purge_log_immutable
  before update or delete on public.platform_audit_purge_log
  for each row execute function public.platform_audit_purge_log_prevent_mutation();

drop trigger if exists platform_audit_purge_log_immutable_truncate on public.platform_audit_purge_log;
create trigger platform_audit_purge_log_immutable_truncate
  before truncate on public.platform_audit_purge_log
  for each statement execute function public.platform_audit_purge_log_prevent_mutation();

revoke all on table public.platform_audit_purge_log from public;
revoke all on table public.platform_audit_purge_log from anon;
revoke all on table public.platform_audit_purge_log from authenticated;
revoke all on table public.platform_audit_purge_log from service_role;

-- ---------------------------------------------------------------------------
-- 1b. The three immutability triggers behind the activity log learn about the
--     purge - and about nothing else.
--
--     platform_entitlement_audit_prevent_mutation serves BOTH
--     platform_entitlement_audit and platform_module_availability_audit, and
--     both are log sources, so one replacement covers the two.
-- ---------------------------------------------------------------------------
create or replace function public.platform_owner_account_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- DELETE, and only DELETE, and only from inside platform_purge_activity_log.
  -- The setting is transaction-local and confers nothing by itself: no role
  -- holds DELETE on this table, so only the owner reaching it through a
  -- SECURITY DEFINER function can be here at all.
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('kolbox.audit_purge', true) = 'platform_activity_log' then
    return old;
  end if;
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

create or replace function public.platform_entitlement_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('kolbox.audit_purge', true) = 'platform_activity_log' then
    return old;
  end if;
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

create or replace function public.multi_entity_audit_prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('kolbox.audit_purge', true) = 'platform_activity_log' then
    return old;
  end if;
  raise exception 'AUDIT_IMMUTABLE';
end;
$fn$;

comment on function public.platform_entitlement_audit_prevent_mutation() is
  'Immutability trigger for platform_entitlement_audit AND platform_module_availability_audit. Refuses every UPDATE, every TRUNCATE and every DELETE except one: a DELETE issued while the transaction-local kolbox.audit_purge setting names the activity-log purge, which only platform_purge_activity_log sets. The setting authorizes nothing on its own - no role holds DELETE on either table.';

-- ---------------------------------------------------------------------------
-- 1c. The purge itself.
-- ---------------------------------------------------------------------------
create or replace function public.platform_purge_activity_log(
  p_platform_owner_auth_user_id uuid,
  p_confirm                     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_counts jsonb := '{}'::jsonb;
  v_total  bigint := 0;
  r        record;
  n        bigint;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  -- A deliberate word, compared here and not only in the browser, so that an
  -- accidental or replayed request can never erase an audit trail.
  if pg_catalog.btrim(coalesce(p_confirm, '')) <> 'מחיקה' then
    raise exception 'PURGE_NOT_CONFIRMED';
  end if;

  -- Exactly the four tables platform_list_activity reads, and in a fixed list
  -- rather than a catalog sweep: which tables the log shows is a product
  -- decision, and a new audit table must be added here on purpose.
  perform pg_catalog.set_config('kolbox.audit_purge', 'platform_activity_log', true);
  for r in
    select t from pg_catalog.unnest(array[
      'platform_owner_account_audit',
      'platform_entitlement_audit',
      'platform_module_availability_audit',
      'multi_entity_audit'
    ]) as t
  loop
    -- `where true` is NOT decoration: the hosted database loads Supabase's
    -- safeupdate hook for the role PostgREST connects as, and it rejects any
    -- DELETE with no WHERE clause (21000). A bare DELETE works as postgres and
    -- fails through the API - the same trap election_day_atomic_import hit.
    execute pg_catalog.format('delete from public.%I where true', r.t);
    get diagnostics n = row_count;
    v_counts := v_counts || pg_catalog.jsonb_build_object(r.t, n);
    v_total := v_total + n;
  end loop;
  perform pg_catalog.set_config('kolbox.audit_purge', '', true);

  -- Proof, not assumption: the log has nothing left to show.
  if public.platform_list_activity(p_platform_owner_auth_user_id, 500) <> '[]'::jsonb then
    raise exception 'PURGE_INCOMPLETE';
  end if;

  insert into public.platform_audit_purge_log
    (acting_platform_owner_auth_user_id, row_counts)
  values (p_platform_owner_auth_user_id, v_counts);

  return jsonb_build_object('purged', v_total, 'rowCounts', v_counts);
end;
$fn$;

comment on function public.platform_purge_activity_log(uuid, text) is
  'Permanently deletes every record the activity log shows, as the Platform Owner, atomically. Re-resolves the acting Platform Owner from platform_owners in this transaction; requires p_confirm to be the deliberate word the console also requires (PURGE_NOT_CONFIRMED otherwise); deletes from exactly the four tables platform_list_activity reads, in a fixed list so that adding a table to the log is a deliberate decision here too; verifies afterwards that the log really reads empty (PURGE_INCOMPLETE); and records the purge in the immutable platform_audit_purge_log in the same transaction. The transaction-local kolbox.audit_purge token it sets is the ONLY thing those four immutability triggers accept, and only for DELETE - UPDATE and TRUNCATE still raise AUDIT_IMMUTABLE, and platform_deletion_audit, platform_audit_purge_log and budget_audit_events are not affected at all. Handles no credential material of any kind. service_role only.';

revoke all on function public.platform_purge_activity_log(uuid, text) from public;
revoke all on function public.platform_purge_activity_log(uuid, text) from anon;
revoke all on function public.platform_purge_activity_log(uuid, text) from authenticated;
grant execute on function public.platform_purge_activity_log(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2a. What deleting a workspace would actually destroy, before deciding to.
-- ---------------------------------------------------------------------------
create or replace function public.platform_workspace_deletion_preview(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id                uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_name    text;
  v_po_name text;
  v_counts  jsonb;
  v_total   bigint := 0;
  v_budget  jsonb;
  e         record;
begin
  select po.name into v_po_name
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;
  if p_platform_owner_auth_user_id is null or v_po_name is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select w.name into v_name from public.election_workspaces w where w.id = p_workspace_id;
  if v_name is null then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  v_counts := public.platform_workspace_row_counts(p_workspace_id);
  select coalesce(pg_catalog.sum((e2.value)::text::bigint), 0) into v_total
  from pg_catalog.jsonb_each(v_counts) e2;

  -- The Budget side's own answer, from the Budget side's own function - never a
  -- second opinion about whether deletion is allowed.
  v_budget := public.budget_op_export_status(
    p_workspace_id,
    jsonb_build_object('type', 'owner', 'id', p_platform_owner_auth_user_id,
                       'name', v_po_name, 'workspace_id', p_workspace_id),
    '{}'::jsonb);

  return jsonb_build_object(
    'workspaceId', p_workspace_id,
    'name', v_name,
    'rowCounts', v_counts,
    'totalRows', v_total,
    'budget', v_budget);
end;
$fn$;

comment on function public.platform_workspace_deletion_preview(uuid, uuid) is
  'What deleting this workspace would destroy, so the console can say it before the operator decides: the per-table row counts from platform_workspace_row_counts, their total, and the Budget side''s OWN answer from budget_op_export_status (hasBudgetData / deletionAllowed / the latest export) rather than a second opinion formed here. Read-only - it deletes nothing and changes nothing. service_role only.';

revoke all on function public.platform_workspace_deletion_preview(uuid, uuid) from public;
revoke all on function public.platform_workspace_deletion_preview(uuid, uuid) from anon;
revoke all on function public.platform_workspace_deletion_preview(uuid, uuid) from authenticated;
grant execute on function public.platform_workspace_deletion_preview(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2b. The Platform Owner can drive the workspace's Budget deletion export.
-- ---------------------------------------------------------------------------
create or replace function public.platform_budget_export(
  p_platform_owner_auth_user_id uuid,
  p_workspace_id                uuid,
  p_step                        text,
  p_args                        jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_po_name text;
  v_actor   jsonb;
  v_args    jsonb := coalesce(p_args, '{}'::jsonb);
begin
  select po.name into v_po_name
  from public.platform_owners po
  where po.auth_user_id = p_platform_owner_auth_user_id;
  if p_platform_owner_auth_user_id is null or v_po_name is null then
    raise exception 'UNAUTHORIZED';
  end if;

  if not exists (select 1 from public.election_workspaces w where w.id = p_workspace_id) then
    raise exception 'WORKSPACE_NOT_FOUND';
  end if;

  -- type 'owner' because budget_require_owner demands it; the id and the name
  -- are the Platform Owner's, so every Budget record this produces
  -- (budget_data_exports.created_by_name, budget_document_access_log) says who
  -- actually did it. See this migration's header for why the CHECK on
  -- budget_document_access_log.actor_type is deliberately left alone.
  v_actor := jsonb_build_object(
    'type', 'owner',
    'id', p_platform_owner_auth_user_id,
    'name', 'בעל הפלטפורמה: ' || v_po_name,
    'workspace_id', p_workspace_id);

  -- A FIXED dispatch. There is no path from here to any other budget_op_*,
  -- and no step that writes Budget business data.
  case p_step
    when 'status'   then return public.budget_op_export_status(p_workspace_id, v_actor, '{}'::jsonb);
    when 'start'    then return public.budget_op_export_start(p_workspace_id, v_actor, '{}'::jsonb);
    when 'part'     then return public.budget_op_export_part(p_workspace_id, v_actor, v_args);
    when 'document' then return public.budget_op_export_document_locate(p_workspace_id, v_actor, v_args);
    when 'verify'   then return public.budget_op_export_verify(p_workspace_id, v_actor, v_args);
    else raise exception 'INVALID_STEP';
  end case;
end;
$fn$;

comment on function public.platform_budget_export(uuid, uuid, text, jsonb) is
  'Lets the Platform Owner produce a workspace''s Budget DELETION EXPORT - the prerequisite election_workspaces_budget_delete_guard enforces - without being that workspace''s Election Owner. A thin FIXED dispatcher onto the existing export ops (budget_op_export_status / _start / _part / _document_locate / _verify) and nothing else: no new export logic, no new manifest, no new verification rule, no reachable path to any other budget_op_*, and no step that writes Budget business data. The delete guard is untouched and is still the only thing that decides whether a workspace holding Budget data may be deleted. Deliberately does NOT require the Budget module entitlement: the entitlement is licensing, this is a deletion prerequisite, and a workspace whose entitlement was removed still holds its Budget rows - requiring it here would make such a workspace permanently undeletable. The actor it builds carries type ''owner'' because budget_require_owner demands it, with the Platform Owner''s own id and a name that says so, so the Budget records name the real actor. service_role only.';

revoke all on function public.platform_budget_export(uuid, uuid, text, jsonb) from public;
revoke all on function public.platform_budget_export(uuid, uuid, text, jsonb) from anon;
revoke all on function public.platform_budget_export(uuid, uuid, text, jsonb) from authenticated;
grant execute on function public.platform_budget_export(uuid, uuid, text, jsonb) to service_role;

commit;
