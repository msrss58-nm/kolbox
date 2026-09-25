-- Activity-log purge + the Platform-driven Budget deletion export
-- (migration 20260930000000) - DATABASE suite.
--
-- Covers: who may purge, the deliberate word, that the four audit tables stay
-- immutable to everything except that one function, that the purge really
-- removes everything the log shows and leaves an immutable trace the log does
-- NOT read, that the records designed to outlive a workspace are untouched, and
-- that the Platform Owner can drive a workspace's Budget export through the
-- existing ops without the delete guard being involved at all.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/platform/db-audit-purge.sql
--
-- ONE transaction, ROLLED BACK at the end: re-runnable, leaves no rows.
-- Synthetic identities only. Non-zero exit on any failed assertion.

\set ON_ERROR_STOP on
\pset pager off
begin;

create temp table _r (n serial primary key, id text not null, ok boolean not null, detail text);

create function pg_temp.chk(p_id text, p_ok boolean, p_detail text) returns void
language sql as $$ insert into _r (id, ok, detail) values (p_id, coalesce(p_ok, false), p_detail) $$;

create function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

create function pg_temp.try_as(p_role text, p_sql text) returns text
language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  reset role;
  return 'OK';
exception when others then
  begin reset role; exception when others then null; end;
  return sqlstate || ':' || sqlerrm;
end $$;

/** How many records the activity log would show right now. */
create function pg_temp.log_rows(p_po uuid) returns integer
language sql as $$ select jsonb_array_length(public.platform_list_activity(p_po, 500)) $$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, created_at, updated_at) values
  ('96000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','po@purge.invalid',    '{}', now(), now()),
  ('96000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner@purge.invalid', '{}', now(), now()),
  ('96000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','other@purge.invalid', '{}', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('96000000-0000-4000-8000-000000000001', 'Purge Platform Owner', 'po@purge.invalid');

do $$
declare
  po      uuid := '96000000-0000-4000-8000-000000000001';
  owner_a uuid := '96000000-0000-4000-8000-000000000002';
  nobody  uuid := '96000000-0000-4000-8000-000000000003';
  ws      uuid;
  pend    uuid;
  r       text;
  res     jsonb;
  before_log integer;
  del_before bigint;
  bud_before bigint;
  trace_before bigint;
begin
  -- A real workspace with Budget data, so both halves of this migration have
  -- something real to act on.
  select c.pending_id into pend from public.platform_create_pending_owner_access(
    po, owner_a, 'Purge Owner', 'owner@purge.invalid', null, 7, array['election_day', 'budget']) c;
  select (public.election_day_provision_workspace(owner_a, 'PURGE WS', now() + interval '10 days') ->> 'workspace_id')::uuid into ws;
  perform pg_catalog.set_config('kolbox.budget_actor',
    pg_catalog.format('{"type":"owner","id":"%s","name":"Purge Owner","workspace_id":"%s"}', owner_a, ws), true);
  insert into public.budget_settings (workspace_id) values (ws);
  insert into public.budget_categories (workspace_id, name) values (ws, 'PURGE Category');
  perform pg_catalog.set_config('kolbox.budget_actor', '', true);

  -- Something in every one of the four log sources. All four MUST be
  -- non-empty: a row-level BEFORE DELETE trigger never fires on an empty
  -- table, so an "is still immutable" assertion against one would pass
  -- vacuously. Provisioning fills the entitlement audit; the other three are
  -- filled here.
  insert into public.platform_module_availability_audit (module_key, previous_available, new_available, acting_platform_owner_auth_user_id)
  values ('budget', false, true, po);
  insert into public.multi_entity_audit
    (action, workspace_id_snapshot, workspace_name_snapshot, acting_auth_user_id)
  values ('assigned', ws, 'PURGE WS', po);
  insert into public.platform_owner_account_audit
    (acting_platform_owner_auth_user_id, action, target_workspace_id_snapshot, target_owner_auth_user_id_snapshot, target_owner_email_snapshot, details)
  values (po, 'profile_updated', ws, owner_a, 'owner@purge.invalid', '{"changed":["name"]}'::jsonb);

  -- A row-level BEFORE DELETE trigger never fires on an EMPTY table, so a
  -- "this is protected" assertion against an empty one passes vacuously. Give
  -- platform_deletion_audit something to protect. INSERT is allowed here - only
  -- UPDATE, DELETE and TRUNCATE are refused.
  insert into public.platform_deletion_audit
    (workspace_id_snapshot, workspace_name_snapshot, acting_auth_user_id, reason)
  values ('96000000-0000-4000-8000-0000000000aa', 'PURGE OLD WS', po, 'fixture');

  before_log := pg_temp.log_rows(po);
  del_before := (select count(*) from public.platform_deletion_audit);
  bud_before := (select count(*) from public.budget_audit_events where workspace_id = ws);
  -- The purge trace is immutable BY DESIGN, so nothing can clear it: what is
  -- asserted below is the INCREASE this run causes, never an absolute count.
  trace_before := (select count(*) from public.platform_audit_purge_log);

  perform pg_temp.chk('FIX1 all four log sources have rows, and the log shows them',
    before_log > 3
    and (select count(*) from public.platform_owner_account_audit) > 0
    and (select count(*) from public.platform_entitlement_audit) > 0
    and (select count(*) from public.platform_module_availability_audit) > 0
    and (select count(*) from public.multi_entity_audit) > 0,
    format('log=%s acct=%s ent=%s avail=%s me=%s', before_log,
      (select count(*) from public.platform_owner_account_audit),
      (select count(*) from public.platform_entitlement_audit),
      (select count(*) from public.platform_module_availability_audit),
      (select count(*) from public.multi_entity_audit)));

  -- ---- WHO MAY PURGE ------------------------------------------------------
  r := pg_temp.try_sql(format('select public.platform_purge_activity_log(%L, %L)', nobody, 'מחיקה'));
  perform pg_temp.chk('AUZ1 a caller who is not the Platform Owner -> UNAUTHORIZED, nothing deleted',
    r like '%UNAUTHORIZED%' and pg_temp.log_rows(po) = before_log, r);
  r := pg_temp.try_sql(format('select public.platform_purge_activity_log(null, %L)', 'מחיקה'));
  perform pg_temp.chk('AUZ2 a null acting identity -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  r := pg_temp.try_sql(format('select public.platform_purge_activity_log(%L, %L)', owner_a, 'מחיקה'));
  perform pg_temp.chk('AUZ3 the workspace''s Election Owner cannot purge the platform log -> UNAUTHORIZED',
    r like '%UNAUTHORIZED%', r);

  -- ---- THE DELIBERATE WORD ------------------------------------------------
  for r in select x from unnest(array['', 'delete', 'מחיקת', 'מחיקה!']) x loop
    perform pg_temp.chk(format('CFM a confirmation of %L is refused (PURGE_NOT_CONFIRMED)', r),
      pg_temp.try_sql(format('select public.platform_purge_activity_log(%L, %L)', po, r)) like '%PURGE_NOT_CONFIRMED%',
      r);
  end loop;
  perform pg_temp.chk('CFM-null a null confirmation is refused',
    pg_temp.try_sql(format('select public.platform_purge_activity_log(%L, null)', po)) like '%PURGE_NOT_CONFIRMED%', 'null');
  perform pg_temp.chk('CFM-none every refusal so far left the log exactly as it was',
    pg_temp.log_rows(po) = before_log, format('log=%s', pg_temp.log_rows(po)));

  -- ---- THE TABLES ARE STILL IMMUTABLE TO EVERYTHING ELSE ------------------
  -- FIX1 above guarantees each of these holds rows, so each trigger really
  -- fires rather than the statement finding nothing to delete.
  for r in select x from unnest(array['platform_owner_account_audit', 'platform_entitlement_audit',
                                     'platform_module_availability_audit', 'multi_entity_audit']) x loop
    perform pg_temp.chk(format('IMM1 a DELETE on %s raises AUDIT_IMMUTABLE', r),
      pg_temp.try_sql(format('delete from public.%I where true', r)) like '%AUDIT_IMMUTABLE%',
      r);
  end loop;
  perform pg_temp.chk('IMM2 UPDATE is refused even WITH the purge token set - the escape is DELETE-only',
    pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                        update public.platform_module_availability_audit set module_key = 'x'$q$) like '%AUDIT_IMMUTABLE%',
    'update');
  perform pg_temp.chk('IMM3 TRUNCATE is refused even WITH the purge token set',
    pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                        truncate public.platform_module_availability_audit$q$) like '%AUDIT_IMMUTABLE%',
    'truncate');
  perform pg_temp.chk('IMM4 a WRONG token value does not open the DELETE either',
    pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'something_else', true);
                        delete from public.platform_entitlement_audit$q$) like '%AUDIT_IMMUTABLE%',
    'wrong token');
  perform pg_catalog.set_config('kolbox.audit_purge', '', true);
  perform pg_temp.chk('IMM5 the token on its own confers NOTHING - no role holds DELETE on these tables',
    pg_temp.try_as('service_role', $q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                                      delete from public.platform_entitlement_audit$q$) like '42501%'
    and pg_temp.try_as('anon', 'delete from public.platform_entitlement_audit') like '42501%',
    'privileges');
  perform pg_temp.chk('IMM6 platform_deletion_audit is NOT reachable by the purge token - it is not a log source',
    (select count(*) from public.platform_deletion_audit) > 0
    and pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                          delete from public.platform_deletion_audit where true$q$) like '%AUDIT_IMMUTABLE%',
    format('rows=%s', (select count(*) from public.platform_deletion_audit)));
  perform pg_temp.chk('IMM7 nor is the Budget audit - it refuses with its OWN append-only error',
    (select count(*) from public.budget_audit_events where workspace_id = ws) > 0
    and pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                          delete from public.budget_audit_events where true$q$) like '%BUDGET_APPEND_ONLY%',
    format('rows=%s', (select count(*) from public.budget_audit_events where workspace_id = ws)));
  perform pg_catalog.set_config('kolbox.audit_purge', '', true);
  perform pg_temp.chk('IMM8 and the log still has every row it started with',
    pg_temp.log_rows(po) = before_log, format('log=%s', pg_temp.log_rows(po)));

  -- ---- THE PURGE ----------------------------------------------------------
  select public.platform_purge_activity_log(po, 'מחיקה') into res;
  perform pg_temp.chk('PRG1 the purge reports what it removed, per table',
    (res ->> 'purged')::int = before_log
    and (res -> 'rowCounts') ? 'platform_owner_account_audit'
    and (res -> 'rowCounts') ? 'platform_entitlement_audit'
    and (res -> 'rowCounts') ? 'platform_module_availability_audit'
    and (res -> 'rowCounts') ? 'multi_entity_audit', res::text);
  perform pg_temp.chk('PRG2 every one of the four tables is EMPTY - a real deletion, not a filter',
    (select count(*) from public.platform_owner_account_audit) = 0
    and (select count(*) from public.platform_entitlement_audit) = 0
    and (select count(*) from public.platform_module_availability_audit) = 0
    and (select count(*) from public.multi_entity_audit) = 0, 'empty');
  perform pg_temp.chk('PRG3 the activity log reads empty',
    public.platform_list_activity(po, 500) = '[]'::jsonb, public.platform_list_activity(po, 500)::text);
  perform pg_temp.chk('PRG4 the purge itself is on the record - who, when, and how many of each',
    (select count(*) from public.platform_audit_purge_log) = trace_before + 1
    and (select acting_platform_owner_auth_user_id = po
              and row_counts ? 'multi_entity_audit'
              and not (row_counts ?| array['password','token','secret','hash'])
         from public.platform_audit_purge_log
         order by purged_at desc limit 1),
    format('traces %s -> %s', trace_before, (select count(*) from public.platform_audit_purge_log)));
  perform pg_temp.chk('PRG5 that record is NOT a log source, which is why the log really is empty',
    public.platform_list_activity(po, 500) = '[]'::jsonb
    and (select count(*) from public.platform_audit_purge_log) = trace_before + 1, 'not a source');
  perform pg_temp.chk('PRG6 and it cannot be changed or removed - not even by the purge token',
    pg_temp.try_sql('update public.platform_audit_purge_log set row_counts = ''{}''::jsonb') like '%AUDIT_IMMUTABLE%'
    and pg_temp.try_sql($q$select set_config('kolbox.audit_purge', 'platform_activity_log', true);
                           delete from public.platform_audit_purge_log$q$) like '%AUDIT_IMMUTABLE%'
    and pg_temp.try_sql('truncate public.platform_audit_purge_log') like '%AUDIT_IMMUTABLE%', 'immutable');
  perform pg_catalog.set_config('kolbox.audit_purge', '', true);
  perform pg_temp.chk('PRG7 the purge token is NOT left set behind - a later DELETE is refused again',
    pg_temp.try_sql('delete from public.platform_audit_purge_log') like '%AUDIT_IMMUTABLE%', 'token cleared');
  perform pg_temp.chk('PRG8 what was designed to outlive a workspace is untouched',
    (select count(*) from public.platform_deletion_audit) = del_before
    and (select count(*) from public.budget_audit_events where workspace_id = ws) = bud_before,
    format('deletion=%s budget=%s', del_before, bud_before));
  perform pg_temp.chk('PRG9 the workspace and its data are untouched - a log purge is not a data purge',
    exists (select 1 from public.election_workspaces where id = ws)
    and exists (select 1 from public.budget_categories where workspace_id = ws)
    and exists (select 1 from public.election_owners where workspace_id = ws), 'data intact');
  select public.platform_purge_activity_log(po, 'מחיקה') into res;
  perform pg_temp.chk('PRG10 purging an already empty log is a confirmed no-op, and records a second trace',
    (res ->> 'purged')::int = 0
    and (select count(*) from public.platform_audit_purge_log) = trace_before + 2, res::text);

  -- ---- THE DELETION PREVIEW ----------------------------------------------
  r := pg_temp.try_sql(format('select public.platform_workspace_deletion_preview(%L, %L)', nobody, ws));
  perform pg_temp.chk('PRV1 the preview is Platform-Owner-only -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  r := pg_temp.try_sql(format('select public.platform_workspace_deletion_preview(%L, %L)', po, '96000000-0000-4000-8000-0000000000ff'));
  perform pg_temp.chk('PRV2 a workspace that does not exist -> WORKSPACE_NOT_FOUND', r like '%WORKSPACE_NOT_FOUND%', r);
  select public.platform_workspace_deletion_preview(po, ws) into res;
  perform pg_temp.chk('PRV3 it names the workspace, counts its real rows, and reports the Budget verdict',
    res ->> 'name' = 'PURGE WS'
    and (res ->> 'totalRows')::bigint > 0
    and (res -> 'rowCounts') ? 'public.election_owners'
    and (res -> 'budget' ->> 'hasBudgetData')::boolean
    and not (res -> 'budget' ->> 'deletionAllowed')::boolean, res::text);
  perform pg_temp.chk('PRV4 the preview changed nothing',
    exists (select 1 from public.election_workspaces where id = ws)
    and (select count(*) from public.budget_data_exports where workspace_id = ws) = 0, 'read-only');

  -- ---- THE PLATFORM-DRIVEN BUDGET EXPORT ---------------------------------
  r := pg_temp.try_sql(format('select public.platform_budget_export(%L, %L, %L, %L::jsonb)', nobody, ws, 'status', '{}'));
  perform pg_temp.chk('EXP1 it is Platform-Owner-only -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  r := pg_temp.try_sql(format('select public.platform_budget_export(%L, %L, %L, %L::jsonb)', po, '96000000-0000-4000-8000-0000000000ff', 'status', '{}'));
  perform pg_temp.chk('EXP2 an unknown workspace -> WORKSPACE_NOT_FOUND', r like '%WORKSPACE_NOT_FOUND%', r);
  for r in select x from unnest(array['purge', 'delete', 'export_start', 'op', '']) x loop
    perform pg_temp.chk(format('EXP3 step %L is refused (INVALID_STEP) - the dispatch is a fixed list', r),
      pg_temp.try_sql(format('select public.platform_budget_export(%L, %L, %L, %L::jsonb)', po, ws, r, '{}')) like '%INVALID_STEP%',
      r);
  end loop;
  select public.platform_budget_export(po, ws, 'status', '{}'::jsonb) into res;
  perform pg_temp.chk('EXP4 status comes from the BUDGET side''s own function, unchanged',
    (res ->> 'hasBudgetData')::boolean and not (res ->> 'deletionAllowed')::boolean, res::text);
  -- The entitlement is deliberately not required: a workspace whose Budget
  -- entitlement was removed still holds its rows and must stay deletable.
  delete from public.election_workspace_modules where workspace_id = ws and module_key = 'budget';
  select public.platform_budget_export(po, ws, 'status', '{}'::jsonb) into res;
  perform pg_temp.chk('EXP5 it still works with the Budget entitlement REMOVED - otherwise such a workspace could never be deleted',
    (res ->> 'hasBudgetData')::boolean, res::text);
  select public.platform_budget_export(po, ws, 'start', '{}'::jsonb) into res;
  perform pg_temp.chk('EXP6 start produces a real manifest, attributed to the PLATFORM Owner by name',
    res ->> 'format' = 'kolbox-budget-export-v1'
    and (res -> 'totals' ->> 'parts')::int > 0
    and (select created_by_name like 'בעל הפלטפורמה:%' from public.budget_data_exports where workspace_id = ws),
    (select created_by_name from public.budget_data_exports where workspace_id = ws));
  perform pg_temp.chk('EXP7 starting an export does NOT make the workspace deletable on its own',
    not (public.platform_budget_export(po, ws, 'status', '{}'::jsonb) ->> 'deletionAllowed')::boolean,
    'still blocked');
  -- An export that was never served/verified must leave the guard refusing.
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, ws, 'PURGE WS'));
  perform pg_temp.chk('EXP8 with an unverified export the delete guard still refuses, and the workspace is intact',
    r like '%BUDGET_EXPORT_REQUIRED%' and exists (select 1 from public.election_workspaces where id = ws), r);

  -- ---- GRANTS -------------------------------------------------------------
  perform pg_temp.chk('ACL1 the purge is executable only by the privileged server role',
    not pg_catalog.has_function_privilege('anon', 'public.platform_purge_activity_log(uuid,text)', 'execute')
    and not pg_catalog.has_function_privilege('authenticated', 'public.platform_purge_activity_log(uuid,text)', 'execute')
    and pg_catalog.has_function_privilege('service_role', 'public.platform_purge_activity_log(uuid,text)', 'execute'), 'purge');
  perform pg_temp.chk('ACL2 so are the preview and the export dispatcher',
    not pg_catalog.has_function_privilege('anon', 'public.platform_workspace_deletion_preview(uuid,uuid)', 'execute')
    and pg_catalog.has_function_privilege('service_role', 'public.platform_workspace_deletion_preview(uuid,uuid)', 'execute')
    and not pg_catalog.has_function_privilege('anon', 'public.platform_budget_export(uuid,uuid,text,jsonb)', 'execute')
    and pg_catalog.has_function_privilege('service_role', 'public.platform_budget_export(uuid,uuid,text,jsonb)', 'execute'), 'grants');
  perform pg_temp.chk('ACL3 the purge trace is readable and writable by NO role',
    pg_temp.try_as('anon', 'select 1 from public.platform_audit_purge_log') like '42501%'
    and pg_temp.try_as('authenticated', 'select 1 from public.platform_audit_purge_log') like '42501%'
    and pg_temp.try_as('service_role', 'select 1 from public.platform_audit_purge_log') like '42501%'
    and pg_temp.try_as('service_role', format('insert into public.platform_audit_purge_log (acting_platform_owner_auth_user_id) values (%L)', po)) like '42501%',
    'unreachable');
  perform pg_temp.chk('ACL4 all three new functions are SECURITY DEFINER with an empty search_path',
    (select bool_and(prosecdef and proconfig @> array['search_path=""'])
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname = 'public'
        and p.proname in ('platform_purge_activity_log', 'platform_workspace_deletion_preview', 'platform_budget_export')), 'definer');
  perform pg_temp.chk('ACL5 the Budget delete guard is still exactly where it was',
    exists (select 1 from pg_catalog.pg_trigger t
             where t.tgrelid = 'public.election_workspaces'::regclass
               and t.tgname = 'election_workspaces_budget_delete_guard'
               and not t.tgisinternal), 'guard present');
end $$;

select id, ok, detail from _r order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'AUDIT PURGE DB SUITE: % FAILED', f;
  end if;
end $$;

rollback;
