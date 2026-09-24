-- Permanent workspace deletion - DATABASE suite (migration 20260929000000).
--
-- Covers: authorization, the typed-name confirmation, the Budget export guard
-- (refusal AND the intact workspace afterwards), completeness of the cascade
-- across every table carrying a workspace_id, isolation from a second
-- workspace, the three things no foreign key reaches, the shared-Auth-identity
-- rule in both directions, and the immutable audit row.
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/platform/db-workspace-deletion.sql
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
  return sqlstate || ':' || sqlerrm;
end $$;

/** Every row anywhere that still names this workspace, counted the same way the
 *  function under test counts - but written out here independently so the test
 *  does not simply trust the implementation it is checking. */
create function pg_temp.owned(p_ws uuid) returns bigint
language plpgsql as $$
declare r record; n bigint; total bigint := 0;
begin
  for r in
    select c.oid::regclass::text as tbl
    from pg_catalog.pg_class c
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id'
                                  and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname <> 'budget_workspace_deletions'
  loop
    execute format('select count(*) from %s x where x.workspace_id = $1', r.tbl) into n using p_ws;
    total := total + n;
  end loop;
  return total;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures (inside the rolled-back transaction)
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, created_at, updated_at) values
  ('93000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','po@del.invalid',      '{}', now(), now()),
  ('93000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-a@del.invalid', '{}', now(), now()),
  ('93000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-b@del.invalid', '{}', now(), now()),
  ('93000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','owner-c@del.invalid', '{}', now(), now()),
  ('93000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','me@del.invalid',      '{}', now(), now()),
  ('93000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','nobody@del.invalid',  '{}', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('93000000-0000-4000-8000-000000000001', 'Deletion Platform Owner', 'po@del.invalid');

do $$
declare
  po       uuid := '93000000-0000-4000-8000-000000000001';
  oa       uuid := '93000000-0000-4000-8000-000000000002';
  ob       uuid := '93000000-0000-4000-8000-000000000003';
  oc       uuid := '93000000-0000-4000-8000-000000000004';
  me_auth  uuid := '93000000-0000-4000-8000-000000000005';
  nobody   uuid := '93000000-0000-4000-8000-000000000006';
  wa       uuid;
  wb       uuid;
  wc       uuid;
  pend_a   uuid;
  pend_b   uuid;
  me_owner uuid;
  a_role   uuid;
  a_user   uuid;
  r        text;
  res      jsonb;
  n        bigint;
  before_b bigint;
begin
  -- ---- two independent, fully provisioned workspaces ----------------------
  select c.pending_id into pend_a from public.platform_create_pending_owner_access(
    po, oa, 'Owner A', 'owner-a@del.invalid', '0501111111', 7, array['election_day']) c;
  select c.pending_id into pend_b from public.platform_create_pending_owner_access(
    po, ob, 'Owner B', 'owner-b@del.invalid', '0502222222', 7, array['election_day']) c;
  select (public.election_day_provision_workspace(oa, 'DEL WS A', now() + interval '10 days') ->> 'workspace_id')::uuid into wa;
  select (public.election_day_provision_workspace(ob, 'DEL WS B', now() + interval '10 days') ->> 'workspace_id')::uuid into wb;

  -- Owner usernames at the shared login (the rows no cascade reaches).
  perform public.auth_identity_assign('election_owner', 'owner-a-del', oa, null, null);
  perform public.auth_identity_assign('election_owner', 'owner-b-del', ob, null, null);

  -- Real workspace-scoped data in A, and in B, so "A's deletion did not touch
  -- B" is a statement about rows and not about two empty shells.
  insert into public.election_day_roles (workspace_id, name, description, permissions, scope_type, is_manager)
  values (wa, 'DEL A Role', '', array['voter.viewName'], 'all', false) returning id into a_role;
  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  values (wa, 'DEL A User', extensions.crypt('x', extensions.gen_salt('bf')), a_role) returning id into a_user;
  perform public.auth_identity_assign('worker', 'del-a-worker', null, a_user, wa);
  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (a_user, wa, extensions.digest('del-a-session', 'sha256'), now() + interval '1 day');
  insert into public.election_day_voters (workspace_id, masad, first_name, last_name, city, street, house_number, coordinator)
  values (wa, 'DEL-A', 'DEL', 'A Voter', 'City', 'Street', 1, 'DEL A User');
  insert into public.election_day_ride_coordinators (workspace_id, name, phone)
  values (wa, 'DEL A Driver', '0503333333');
  insert into public.auth_handoff_codes (code_hash, realm, target_origin, auth_user_id, display_name, expires_at)
  values (extensions.digest('del-a-handoff', 'sha256'), 'election_owner', 'https://example.invalid', oa, 'Owner A', now() + interval '5 minutes');

  insert into public.election_day_voters (workspace_id, masad, first_name, last_name, city, street, house_number, coordinator)
  values (wb, 'DEL-B', 'DEL', 'B Voter', 'City', 'Street', 2, 'someone');
  insert into public.election_day_ride_coordinators (workspace_id, name, phone)
  values (wb, 'DEL B Driver', '0504444444');

  -- A Multi-Entity seat that can see BOTH workspaces, so unassignment can be
  -- shown to be scoped to the one being deleted.
  select (public.platform_provision_multi_entity_owner_v2(po, me_auth, 'DEL ME', 'me@del.invalid', null, null) ->> 'owner_id')::uuid into me_owner;
  perform public.platform_assign_workspace_v2(po, me_owner, wa);
  perform public.platform_assign_workspace_v2(po, me_owner, wb);

  perform pg_temp.chk('FIX1 two provisioned workspaces, each with its own Owner, data and Multi-Entity assignment',
    wa is not null and wb is not null and wa <> wb
    and (select count(*) from public.multi_entity_assignments where owner_id = me_owner) = 2
    and pg_temp.owned(wa) > 5 and pg_temp.owned(wb) > 2,
    format('A=%s B=%s ownedA=%s ownedB=%s', wa, wb, pg_temp.owned(wa), pg_temp.owned(wb)));

  -- ---- AUTHORIZATION -----------------------------------------------------
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', nobody, wa, 'DEL WS A'));
  perform pg_temp.chk('AUZ1 a caller who is not the Platform Owner -> UNAUTHORIZED, workspace intact',
    r like '%UNAUTHORIZED%' and exists (select 1 from public.election_workspaces where id = wa), r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(null, %L, %L)', wa, 'DEL WS A'));
  perform pg_temp.chk('AUZ2 a null acting identity -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', oa, wa, 'DEL WS A'));
  perform pg_temp.chk('AUZ3 the workspace OWNER cannot delete their own workspace -> UNAUTHORIZED',
    r like '%UNAUTHORIZED%' and exists (select 1 from public.election_workspaces where id = wa), r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', me_auth, wa, 'DEL WS A'));
  perform pg_temp.chk('AUZ4 a Multi-Entity Owner cannot delete a workspace it can see -> UNAUTHORIZED', r like '%UNAUTHORIZED%', r);

  -- ---- THE TYPED NAME ----------------------------------------------------
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, wa, 'DEL WS B'));
  perform pg_temp.chk('CFM1 another workspace''s name -> WORKSPACE_NAME_MISMATCH, and NEITHER workspace is deleted',
    r like '%WORKSPACE_NAME_MISMATCH%'
    and exists (select 1 from public.election_workspaces where id = wa)
    and exists (select 1 from public.election_workspaces where id = wb), r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, wa, ''));
  perform pg_temp.chk('CFM2 an empty confirmation -> WORKSPACE_NAME_MISMATCH', r like '%WORKSPACE_NAME_MISMATCH%', r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, null)', po, wa));
  perform pg_temp.chk('CFM3 a null confirmation -> WORKSPACE_NAME_MISMATCH', r like '%WORKSPACE_NAME_MISMATCH%', r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, wa, 'del ws a'));
  perform pg_temp.chk('CFM4 the name is matched exactly, not case-folded -> WORKSPACE_NAME_MISMATCH', r like '%WORKSPACE_NAME_MISMATCH%', r);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, '93000000-0000-4000-8000-0000000000ff', 'DEL WS A'));
  perform pg_temp.chk('CFM5 a workspace that does not exist -> WORKSPACE_NOT_FOUND', r like '%WORKSPACE_NOT_FOUND%', r);

  -- ---- THE BUDGET GUARD IS NOT BYPASSED ----------------------------------
  -- Workspace C holds Budget data and has no export at all.
  select c.pending_id into pend_a from public.platform_create_pending_owner_access(
    po, oc, 'Owner C', 'owner-c@del.invalid', null, 7, array['election_day', 'budget']) c;
  select (public.election_day_provision_workspace(oc, 'DEL WS C', now() + interval '10 days') ->> 'workspace_id')::uuid into wc;
  -- Budget writes require an actor context (the append-only audit trigger
  -- refuses a write without one). Transaction-local, like the dispatcher sets it.
  perform pg_catalog.set_config('kolbox.budget_actor',
    pg_catalog.format('{"type":"owner","id":"%s","name":"Owner C","workspace_id":"%s"}', oc, wc), true);
  insert into public.budget_settings (workspace_id) values (wc);
  insert into public.budget_categories (workspace_id, name) values (wc, 'DEL C Category');
  perform pg_catalog.set_config('kolbox.budget_actor', '', true);
  perform pg_temp.chk('BUD0 workspace C really holds Budget data', public.budget_workspace_has_data(wc), 'has data');
  n := pg_temp.owned(wc);
  r := pg_temp.try_sql(format('select public.platform_delete_election_workspace(%L, %L, %L)', po, wc, 'DEL WS C'));
  perform pg_temp.chk('BUD1 Budget data with no verified export -> BUDGET_EXPORT_REQUIRED (the guard, reached through a plain DELETE)',
    r like '%BUDGET_EXPORT_REQUIRED%', r);
  perform pg_temp.chk('BUD2 the refused deletion left workspace C completely intact - row for row',
    exists (select 1 from public.election_workspaces where id = wc)
    and pg_temp.owned(wc) = n
    and exists (select 1 from public.budget_categories where workspace_id = wc and name = 'DEL C Category')
    and exists (select 1 from public.election_owners where workspace_id = wc), format('owned=%s (was %s)', pg_temp.owned(wc), n));
  perform pg_temp.chk('BUD3 a refused deletion rolls back the approval and handoff deletes too - Owner C''s approval survives',
    exists (select 1 from public.election_workspace_pending_owner_access where auth_user_id = oc), 'approval kept');
  perform pg_temp.chk('BUD4 nothing was audited for the refused deletion',
    not exists (select 1 from public.platform_deletion_audit where workspace_id_snapshot = wc), 'no audit');

  -- ---- THE DELETION ------------------------------------------------------
  before_b := pg_temp.owned(wb);
  n := pg_temp.owned(wa);
  select public.platform_delete_election_workspace(po, wa, 'DEL WS A') into res;

  perform pg_temp.chk('DEL1 the workspace row is gone',
    not exists (select 1 from public.election_workspaces where id = wa), res::text);
  perform pg_temp.chk('DEL2 NOTHING anywhere still names it - every table with a workspace_id, counted independently',
    pg_temp.owned(wa) = 0, format('owned=%s (was %s)', pg_temp.owned(wa), n));
  perform pg_temp.chk('DEL3 the Election Owner row is gone, so that account authorizes nothing',
    not exists (select 1 from public.election_owners where workspace_id = wa)
    and not exists (select 1 from public.election_owners where auth_user_id = oa), 'owner gone');
  perform pg_temp.chk('DEL4 the approval the workspace was provisioned from is gone (no foreign key reaches it)',
    not exists (select 1 from public.election_workspace_pending_owner_access where auth_user_id = oa), 'approval gone');
  perform pg_temp.chk('DEL5 the Owner''s USERNAME is released, so it can be claimed again',
    not exists (select 1 from public.auth_identities where auth_user_id = oa)
    and not exists (select 1 from public.auth_identity_resolve('election_owner', 'owner-a-del')), 'username released');
  perform pg_temp.chk('DEL6 the Owner''s outstanding sign-in codes are gone',
    not exists (select 1 from public.auth_handoff_codes where auth_user_id = oa), 'handoff gone');
  perform pg_temp.chk('DEL7 worker sessions and worker usernames went with the workspace (neither has a foreign key to it)',
    not exists (select 1 from public.election_day_sessions where workspace_id = wa)
    and not exists (select 1 from public.auth_identities where workspace_id = wa), 'worker access gone');
  perform pg_temp.chk('DEL8 the module entitlements are gone',
    not exists (select 1 from public.election_workspace_modules where workspace_id = wa), 'modules gone');
  perform pg_temp.chk('DEL9 the Auth ACCOUNT itself is NOT deleted by the database - it is reported for the server to purge',
    exists (select 1 from auth.users where id = oa)
    and (res ->> 'orphanedAuthUserId')::uuid = oa
    and res ->> 'heldBy' is null, res::text);

  -- ---- ISOLATION ---------------------------------------------------------
  perform pg_temp.chk('ISO1 workspace B is untouched - its row, its Owner, its approval, its username and every one of its rows',
    exists (select 1 from public.election_workspaces where id = wb)
    and exists (select 1 from public.election_owners where workspace_id = wb)
    and exists (select 1 from public.election_workspace_pending_owner_access where auth_user_id = ob)
    and exists (select 1 from public.auth_identities where auth_user_id = ob)
    and pg_temp.owned(wb) = before_b,
    format('ownedB=%s (was %s)', pg_temp.owned(wb), before_b));
  perform pg_temp.chk('ISO2 the Multi-Entity seat lost EXACTLY the deleted workspace and kept the other',
    (select count(*) from public.multi_entity_assignments where owner_id = me_owner) = 1
    and exists (select 1 from public.multi_entity_assignments where owner_id = me_owner and workspace_id = wb),
    'one assignment left');
  perform pg_temp.chk('ISO3 workspace C - the one whose deletion was refused - is still there too',
    exists (select 1 from public.election_workspaces where id = wc), 'C intact');

  -- ---- WHAT SURVIVES ON PURPOSE ------------------------------------------
  perform pg_temp.chk('AUD1 exactly one deletion audit row, naming the workspace, its Owner and the acting Platform Owner',
    (select count(*) from public.platform_deletion_audit where workspace_id_snapshot = wa) = 1
    and (select workspace_name_snapshot = 'DEL WS A'
              and owner_email_snapshot = 'owner-a@del.invalid'
              and owner_auth_user_id_snapshot = oa
              and acting_auth_user_id = po
              and deleted_by_platform_owner_id = (select id from public.platform_owners where auth_user_id = po)
              and auth_user_orphaned
              and reason = 'platform_console'
         from public.platform_deletion_audit where workspace_id_snapshot = wa), 'audit row');
  perform pg_temp.chk('AUD2 the audit records what was removed, as counts - and nothing that could be a credential',
    (select (row_counts -> 'public.election_day_voters')::int = 1
              and (row_counts -> 'public.election_owners')::int = 1
              and (row_counts -> 'public.election_day_sessions')::int = 1
              and not (row_counts ?| array['password','token','secret','hash'])
         from public.platform_deletion_audit where workspace_id_snapshot = wa),
    (select row_counts::text from public.platform_deletion_audit where workspace_id_snapshot = wa));
  perform pg_temp.chk('AUD3 the audit row cannot be changed or removed',
    pg_temp.try_sql(format('update public.platform_deletion_audit set reason = %L where workspace_id_snapshot = %L', 'x', wa)) like '%AUDIT_IMMUTABLE%'
    and pg_temp.try_sql(format('delete from public.platform_deletion_audit where workspace_id_snapshot = %L', wa)) like '%AUDIT_IMMUTABLE%'
    and pg_temp.try_sql('truncate public.platform_deletion_audit') like '%AUDIT_IMMUTABLE%', 'immutable');
  perform pg_temp.chk('AUD4 the entitlement history of the deleted workspace survives it - that audit is meant to outlive it',
    (select count(*) from public.platform_entitlement_audit where workspace_id_snapshot = wa) > 0, 'entitlement audit kept');
  perform pg_temp.chk('AUD5 the Multi-Entity history survives too, including the unassignment just performed',
    exists (select 1 from public.multi_entity_audit where workspace_id_snapshot = wa), 'multi-entity audit kept');

  -- ---- A SHARED AUTH IDENTITY IS NEVER TOUCHED ---------------------------
  -- Owner B's account is ALSO made a Multi-Entity seat holder, which is an
  -- anomalous state the exclusivity rules normally prevent - exactly the state
  -- in which deleting the account, or releasing its username, would be wrong.
  update public.multi_entity_owner set auth_user_id = ob;
  select public.platform_delete_election_workspace(po, wb, 'DEL WS B') into res;
  perform pg_temp.chk('SHR1 the workspace is still deleted, and completely',
    not exists (select 1 from public.election_workspaces where id = wb) and pg_temp.owned(wb) = 0, res::text);
  perform pg_temp.chk('SHR2 but the shared account keeps its identity and is NOT reported as orphaned',
    res ->> 'orphanedAuthUserId' is null
    and res ->> 'heldBy' = 'multi_entity'
    and exists (select 1 from public.auth_identities where auth_user_id = ob)
    and exists (select 1 from auth.users where id = ob), res::text);
  perform pg_temp.chk('SHR3 and the audit says so, rather than claiming a purge that did not happen',
    (select not auth_user_orphaned from public.platform_deletion_audit where workspace_id_snapshot = wb), 'not orphaned');

  -- ---- THE AUDIT TABLE IS REACHABLE BY NOBODY ----------------------------
  perform pg_temp.chk('ACL1 no role can read the deletion audit directly - not anon, not authenticated, not service_role',
    pg_temp.try_as('anon',          'select 1 from public.platform_deletion_audit') like '42501%'
    and pg_temp.try_as('authenticated', 'select 1 from public.platform_deletion_audit') like '42501%'
    and pg_temp.try_as('service_role',  'select 1 from public.platform_deletion_audit') like '42501%',
    format('anon=%s auth=%s svc=%s',
      pg_temp.try_as('anon', 'select 1 from public.platform_deletion_audit'),
      pg_temp.try_as('authenticated', 'select 1 from public.platform_deletion_audit'),
      pg_temp.try_as('service_role', 'select 1 from public.platform_deletion_audit')));
  perform pg_temp.chk('ACL2 and none of them can write one either',
    pg_temp.try_as('service_role', format('insert into public.platform_deletion_audit (workspace_id_snapshot, workspace_name_snapshot) values (%L, %L)', wa, 'forged')) like '42501%',
    'no insert');
  perform pg_temp.chk('ACL3 the deletion function is executable only by the privileged server role',
    not pg_catalog.has_function_privilege('anon', 'public.platform_delete_election_workspace(uuid,uuid,text)', 'execute')
    and not pg_catalog.has_function_privilege('authenticated', 'public.platform_delete_election_workspace(uuid,uuid,text)', 'execute')
    and pg_catalog.has_function_privilege('service_role', 'public.platform_delete_election_workspace(uuid,uuid,text)', 'execute'),
    'grants');
  perform pg_temp.chk('ACL4 the row-count helper is executable by no role at all',
    not pg_catalog.has_function_privilege('anon', 'public.platform_workspace_row_counts(uuid)', 'execute')
    and not pg_catalog.has_function_privilege('authenticated', 'public.platform_workspace_row_counts(uuid)', 'execute')
    and not pg_catalog.has_function_privilege('service_role', 'public.platform_workspace_row_counts(uuid)', 'execute'),
    'internal only');
  perform pg_temp.chk('ACL5 both new functions are SECURITY DEFINER with an empty search_path',
    (select bool_and(prosecdef and proconfig @> array['search_path=""'])
       from pg_catalog.pg_proc p join pg_catalog.pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname = 'public'
        and p.proname in ('platform_delete_election_workspace', 'platform_workspace_row_counts')), 'definer');

  -- ---- A DELETED OWNER CAN BE APPROVED AGAIN -----------------------------
  -- The practical consequence of DEL4 + DEL5: the address and the username are
  -- both free again. Without them the console could never re-create that
  -- system - platform_classify_owner_access_email would answer APPROVAL_EXISTS
  -- for the address forever.
  perform pg_temp.chk('REU1 the freed address no longer looks like an existing approval',
    (public.platform_classify_owner_access_email(po, 'owner-a@del.invalid') ->> 'classification') <> 'approval_exists',
    (public.platform_classify_owner_access_email(po, 'owner-a@del.invalid'))::text);
  r := pg_temp.try_sql(format('select public.auth_identity_assign(%L, %L, %L, null, null)', 'election_owner', 'owner-a-del', nobody));
  perform pg_temp.chk('REU2 the freed username can be claimed again', r = 'OK', r);
end $$;

select id, ok, detail from _r order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'WORKSPACE DELETION DB SUITE: % FAILED', f;
  end if;
end $$;

rollback;
