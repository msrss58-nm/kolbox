-- Platform Stage 8B - DATABASE suite: Election Owner approval recovery
-- (migration 20260914000000). Covers catalog/ACL, the approvals list, the
-- re-issue business rules (active / expired / status-lagged expired /
-- consumed / held by another principal / not found / windows / authorization),
-- the pre-creation email classification (approval_exists / new / adoptable /
-- registered), and Stage 3B regression (create + Owner provisioning-state
-- resolution see a renewed approval as pending again).
--
-- Run ONLY against the isolated scratch stack (scripts/stage5/mkScratchStack.mjs):
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/stage8/db-stage8.sql
--
-- ONE transaction, ROLLED BACK at the end: re-runnable, leaves no rows.
-- Synthetic identities only. Non-zero exit on any failed assertion.

\set ON_ERROR_STOP on
\pset pager off
begin;

create temp table _r (n serial primary key, id text not null, ok boolean not null, detail text);

create function pg_temp.chk(p_id text, p_ok boolean, p_detail text) returns void
language sql as $$ insert into _r (id, ok, detail) values (p_id, coalesce(p_ok, false), p_detail) $$;

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

create function pg_temp.st(p_list jsonb, p_email text) returns text
language sql as $$
  select e ->> 'state' from jsonb_array_elements(p_list) e where e ->> 'email' = p_email
$$;

-- ---------------------------------------------------------------------------
-- Fixtures (inside the rolled-back transaction)
-- ---------------------------------------------------------------------------
delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, created_at, updated_at) values
  ('81000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','po@s8.invalid',              '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','active@s8.invalid',          '{"kolbox_mint":"election_owner_approval"}', now(), now()),
  ('81000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','expired@s8.invalid',         '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','expired-status@s8.invalid',  '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','consumed@s8.invalid',        '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','held-me@s8.invalid',         '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000000','authenticated','authenticated','held-eo@s8.invalid',         '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000000','authenticated','authenticated','orphan@s8.invalid',          '{"kolbox_mint":"election_owner_approval"}', now(), now()),
  ('81000000-0000-4000-8000-000000000009','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreign@s8.invalid',         '{}', now(), now()),
  ('81000000-0000-4000-8000-00000000000a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','marked-eo@s8.invalid',       '{"kolbox_mint":"election_owner_approval"}', now(), now()),
  ('81000000-0000-4000-8000-00000000000b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','mismatch-auth@s8.invalid',   '{}', now(), now()),
  ('81000000-0000-4000-8000-00000000000c','00000000-0000-0000-0000-000000000000','authenticated','authenticated','Dup@s8.invalid',             '{"kolbox_mint":"election_owner_approval"}', now(), now()),
  ('81000000-0000-4000-8000-00000000000d','00000000-0000-0000-0000-000000000000','authenticated','authenticated','dup@s8.invalid',             '{"kolbox_mint":"election_owner_approval"}', now(), now()),
  ('81000000-0000-4000-8000-00000000000e','00000000-0000-0000-0000-000000000000','authenticated','authenticated','expired2@s8.invalid',        '{}', now(), now()),
  ('81000000-0000-4000-8000-00000000000f','00000000-0000-0000-0000-000000000000','authenticated','authenticated','stranger@s8.invalid',        '{}', now(), now()),
  ('81000000-0000-4000-8000-000000000010','00000000-0000-0000-0000-000000000000','authenticated','authenticated','marked-me@s8.invalid',       '{"kolbox_mint":"election_owner_approval"}', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('81000000-0000-4000-8000-000000000001', 'S8 Platform Owner', 'po@s8.invalid');

insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('82000000-0000-4000-8000-000000000001', 'S8 Consumed WS', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('82000000-0000-4000-8000-000000000002', 'S8 HeldEo WS',   now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('82000000-0000-4000-8000-000000000003', 'S8 MarkedEo WS', now() + interval '10 days', public.election_day_generate_workspace_login_code());

insert into public.election_owners (workspace_id, auth_user_id, name, email) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000005', 'Consumed Owner', 'consumed@s8.invalid'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000007', 'HeldEo Owner',   'held-eo@s8.invalid'),
  ('82000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-00000000000a', 'MarkedEo Owner', 'marked-eo@s8.invalid');

insert into public.multi_entity_owner (auth_user_id, name, email)
values ('81000000-0000-4000-8000-000000000006', 'S8 Seat', 'held-me@s8.invalid');

insert into public.election_workspace_pending_owner_access
  (id, auth_user_id, name, email, status, expires_at, consumed_at, created_at) values
  ('83000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', 'Active',   'active@s8.invalid',          'pending',  now() + interval '3 days', null, now() - interval '1 minute'),
  ('83000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000003', 'Expired',  'expired@s8.invalid',         'pending',  now() - interval '1 day',  null, now() - interval '2 minutes'),
  ('83000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', 'ExpStat',  'expired-status@s8.invalid',  'expired',  now() - interval '2 days', null, now() - interval '3 minutes'),
  ('83000000-0000-4000-8000-000000000005', '81000000-0000-4000-8000-000000000005', 'Consumed', 'consumed@s8.invalid',        'consumed', now() + interval '3 days', now() - interval '1 day', now() - interval '4 minutes'),
  ('83000000-0000-4000-8000-000000000006', '81000000-0000-4000-8000-000000000006', 'HeldMe',   'held-me@s8.invalid',         'pending',  now() - interval '1 day',  null, now() - interval '5 minutes'),
  ('83000000-0000-4000-8000-000000000007', '81000000-0000-4000-8000-000000000007', 'HeldEo',   'held-eo@s8.invalid',         'pending',  now() - interval '1 day',  null, now() - interval '6 minutes'),
  ('83000000-0000-4000-8000-00000000000b', '81000000-0000-4000-8000-00000000000b', 'Mismatch', 'mismatch-row@s8.invalid',    'pending',  now() + interval '3 days', null, now() - interval '7 minutes'),
  ('83000000-0000-4000-8000-00000000000e', '81000000-0000-4000-8000-00000000000e', 'Expired2', 'expired2@s8.invalid',        'pending',  now() - interval '1 hour', null, now() - interval '8 minutes');

-- ===========================================================================
-- Tests
-- ===========================================================================
do $$
declare
  po constant uuid := '81000000-0000-4000-8000-000000000001';
  stranger constant uuid := '81000000-0000-4000-8000-00000000000f';
  fns constant text[] := array['platform_list_owner_access', 'platform_reissue_pending_owner_access', 'platform_classify_owner_access_email'];
  users_before int := (select count(*) from auth.users);
  j jsonb;
  k jsonb;
  t timestamptz;
  r text;
begin
  -- ---- catalog / ACL -------------------------------------------------------
  perform pg_temp.chk('C1 three Stage 8B functions: SECURITY DEFINER, search_path empty, owned by postgres',
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any(fns) and p.prosecdef
        and array_to_string(p.proconfig, ',') = 'search_path=""'
        and pg_get_userbyid(p.proowner) = 'postgres') = 3, 'defs');
  perform pg_temp.chk('C2 anon/authenticated have NO execute; service_role has execute (all three)',
    (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')
                 and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 and has_function_privilege('service_role', p.oid, 'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any(fns)), 'has_function_privilege');
  perform pg_temp.chk('C3 proacl is exactly {postgres=X/postgres,service_role=X/postgres} (no PUBLIC)',
    (select bool_and(p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any(fns)),
    (select string_agg(p.proname || '=' || p.proacl::text, ' ; ')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any(fns)));
  perform pg_temp.chk('C4 anon cannot call the list (42501)',
    pg_temp.try_as('anon', format('select public.platform_list_owner_access(%L)', po)) like '42501%', 'anon');
  perform pg_temp.chk('C4 authenticated cannot call reissue (42501)',
    pg_temp.try_as('authenticated', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', po, '83000000-0000-4000-8000-000000000003')) like '42501%', 'authenticated');
  perform pg_temp.chk('C4 anon cannot call classify (42501)',
    pg_temp.try_as('anon', format('select public.platform_classify_owner_access_email(%L, %L)', po, 'x@s8.invalid')) like '42501%', 'anon');

  -- ---- list ----------------------------------------------------------------
  j := public.platform_list_owner_access(po);
  perform pg_temp.chk('L1 list returns every approval (8)', jsonb_array_length(j) = 8, jsonb_array_length(j)::text);
  perform pg_temp.chk('L2 states: active / expired / status-lagged expired / consumed',
    pg_temp.st(j, 'active@s8.invalid') = 'active'
    and pg_temp.st(j, 'expired@s8.invalid') = 'expired'
    and pg_temp.st(j, 'expired-status@s8.invalid') = 'expired'
    and pg_temp.st(j, 'consumed@s8.invalid') = 'consumed', 'states');
  perform pg_temp.chk('L3 workspace_name only on the consumed (provisioned) row',
    (select e ->> 'workspace_name' from jsonb_array_elements(j) e where e ->> 'email' = 'consumed@s8.invalid') = 'S8 Consumed WS'
    and (select e -> 'workspace_name' from jsonb_array_elements(j) e where e ->> 'email' = 'active@s8.invalid') = 'null'::jsonb, 'ws');
  perform pg_temp.chk('L4 exact row keys (no auth_user_id, no credential field)',
    (select bool_and((select array_agg(x order by x) from jsonb_object_keys(e) x)
        = array['consumed_at','created_at','email','expires_at','name','pending_id','phone','state','workspace_name'])
      from jsonb_array_elements(j) e), 'keys');
  perform pg_temp.chk('L5 newest first', j -> 0 ->> 'email' = 'active@s8.invalid', j -> 0 ->> 'email');
  perform pg_temp.chk('L6 non-Platform-Owner caller refused',
    pg_temp.try_as('postgres', format('select public.platform_list_owner_access(%L)', stranger)) like '%UNAUTHORIZED%', 'stranger');
  perform pg_temp.chk('L6 null caller refused',
    pg_temp.try_as('postgres', 'select public.platform_list_owner_access(null)') like '%UNAUTHORIZED%', 'null');

  -- ---- re-issue ------------------------------------------------------------
  t := (select expires_at from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000002');
  k := public.platform_reissue_pending_owner_access(po, '83000000-0000-4000-8000-000000000002', 7);
  perform pg_temp.chk('R1 active -> renewed=false, window UNCHANGED, own auth user returned',
    (k ->> 'renewed')::boolean = false
    and (select expires_at from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000002') = t
    and (k ->> 'auth_user_id')::uuid = '81000000-0000-4000-8000-000000000002', k::text);

  perform pg_temp.chk('R2 pre: Owner flow sees the expired approval as expired',
    (select state from public.election_day_resolve_owner_provisioning_state('81000000-0000-4000-8000-000000000003')) = 'expired', 'pre');
  k := public.platform_reissue_pending_owner_access(po, '83000000-0000-4000-8000-000000000003', 7);
  perform pg_temp.chk('R2 expired -> renewed=true, window = now()+7d, status pending',
    (k ->> 'renewed')::boolean = true
    and (select expires_at = now() + interval '7 days' and status = 'pending' and consumed_at is null
         from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000003'), k::text);
  perform pg_temp.chk('R2 post: Owner flow now sees it as pending (recoverable)',
    (select state from public.election_day_resolve_owner_provisioning_state('81000000-0000-4000-8000-000000000003')) = 'pending', 'post');
  k := public.platform_reissue_pending_owner_access(po, '83000000-0000-4000-8000-000000000003', 7);
  perform pg_temp.chk('R3 repeat on the renewed row -> renewed=false, window unchanged (idempotent)',
    (k ->> 'renewed')::boolean = false and (k ->> 'expires_at')::timestamptz = now() + interval '7 days', k::text);

  k := public.platform_reissue_pending_owner_access(po, '83000000-0000-4000-8000-000000000004', 7);
  perform pg_temp.chk('R4 status-lagged expired row (status=expired) -> renewed, status back to pending',
    (k ->> 'renewed')::boolean = true
    and (select status from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000004') = 'pending', k::text);

  r := pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', po, '83000000-0000-4000-8000-000000000005'));
  perform pg_temp.chk('R5 consumed -> PENDING_ACCESS_ALREADY_CONSUMED, row untouched',
    r like '%PENDING_ACCESS_ALREADY_CONSUMED%'
    and (select status = 'consumed' and expires_at = now() + interval '3 days'
         from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000005'), r);

  r := pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', po, '83000000-0000-4000-8000-000000000006'));
  perform pg_temp.chk('R6 account now the Multi-Entity Owner -> IDENTITY_ALREADY_PRINCIPAL, not renewed',
    r like '%IDENTITY_ALREADY_PRINCIPAL%'
    and (select expires_at < now() from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000006'), r);

  r := pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', po, '83000000-0000-4000-8000-000000000007'));
  perform pg_temp.chk('R7 account already an Election Owner -> OWNER_ALREADY_PROVISIONED, not renewed',
    r like '%OWNER_ALREADY_PROVISIONED%'
    and (select expires_at < now() from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-000000000007'), r);

  perform pg_temp.chk('R8 unknown pending id -> PENDING_ACCESS_NOT_FOUND',
    pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', po, '83000000-0000-4000-8000-0000000000ff')) like '%PENDING_ACCESS_NOT_FOUND%', 'unknown');
  perform pg_temp.chk('R8 null pending id -> INVALID_PENDING_ID',
    pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, null, 7)', po)) like '%INVALID_PENDING_ID%', 'null');

  perform pg_temp.chk('R9 window 0 -> INVALID_EXPIRY_WINDOW',
    pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 0)', po, '83000000-0000-4000-8000-00000000000e')) like '%INVALID_EXPIRY_WINDOW%', '0');
  perform pg_temp.chk('R9 window 31 -> INVALID_EXPIRY_WINDOW',
    pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 31)', po, '83000000-0000-4000-8000-00000000000e')) like '%INVALID_EXPIRY_WINDOW%', '31');
  perform pg_temp.chk('R9 rejected windows left the expired row untouched',
    (select expires_at = now() - interval '1 hour' from public.election_workspace_pending_owner_access where id = '83000000-0000-4000-8000-00000000000e'), 'untouched');
  k := public.platform_reissue_pending_owner_access(po, '83000000-0000-4000-8000-00000000000e', 3);
  perform pg_temp.chk('R9 window 3 -> expires now()+3d',
    (k ->> 'expires_at')::timestamptz = now() + interval '3 days', k::text);

  perform pg_temp.chk('R10 non-Platform-Owner caller refused',
    pg_temp.try_as('postgres', format('select public.platform_reissue_pending_owner_access(%L, %L, 7)', stranger, '83000000-0000-4000-8000-000000000002')) like '%UNAUTHORIZED%', 'stranger');
  perform pg_temp.chk('R11 no Auth user created or removed by any re-issue',
    (select count(*) from auth.users) = users_before, 'auth.users');

  -- ---- classification ------------------------------------------------------
  k := public.platform_classify_owner_access_email(po, '  ACTIVE@s8.invalid ');
  perform pg_temp.chk('K1 address with an approval (any case / whitespace) -> approval_exists + its pending_id',
    k ->> 'classification' = 'approval_exists' and k ->> 'pending_id' = '83000000-0000-4000-8000-000000000002', k::text);
  k := public.platform_classify_owner_access_email(po, 'nobody@s8.invalid');
  perform pg_temp.chk('K2 unknown address -> new (and nothing else in the answer)',
    k = '{"classification":"new"}'::jsonb, k::text);
  k := public.platform_classify_owner_access_email(po, 'orphan@s8.invalid');
  perform pg_temp.chk('K3 unheld account carrying the mint marker -> adoptable + its id',
    k ->> 'classification' = 'adoptable' and k ->> 'auth_user_id' = '81000000-0000-4000-8000-000000000008', k::text);
  k := public.platform_classify_owner_access_email(po, 'foreign@s8.invalid');
  perform pg_temp.chk('K4 existing account WITHOUT the marker (e.g. campaign user) -> registered, never adopted',
    k = '{"classification":"registered"}'::jsonb, k::text);
  k := public.platform_classify_owner_access_email(po, 'marked-eo@s8.invalid');
  perform pg_temp.chk('K5 marker but already an Election Owner -> registered', k ->> 'classification' = 'registered', k::text);
  k := public.platform_classify_owner_access_email(po, 'marked-me@s8.invalid');
  perform pg_temp.chk('K5 marker, unheld, but distinct from the seat -> adoptable (control)', k ->> 'classification' = 'adoptable', k::text);
  update auth.users set raw_app_meta_data = '{"kolbox_mint":"election_owner_approval"}' where id = '81000000-0000-4000-8000-000000000006';
  k := public.platform_classify_owner_access_email(po, 'held-me@s8.invalid');
  perform pg_temp.chk('K5 marker but holds an approval + the seat -> approval_exists (never adopted)',
    k ->> 'classification' = 'approval_exists', k::text);
  k := public.platform_classify_owner_access_email(po, 'mismatch-auth@s8.invalid');
  perform pg_temp.chk('K6 account whose approval row carries another address -> approval_exists via the account',
    k ->> 'classification' = 'approval_exists' and k ->> 'pending_id' = '83000000-0000-4000-8000-00000000000b', k::text);
  k := public.platform_classify_owner_access_email(po, 'DUP@s8.invalid');
  perform pg_temp.chk('K7 two accounts differing only by case -> registered (ambiguous, never adopted)',
    k = '{"classification":"registered"}'::jsonb, k::text);
  perform pg_temp.chk('K8 empty address -> MISSING_OWNER_EMAIL',
    pg_temp.try_as('postgres', format('select public.platform_classify_owner_access_email(%L, %L)', po, '   ')) like '%MISSING_OWNER_EMAIL%', 'empty');
  perform pg_temp.chk('K8 non-Platform-Owner caller refused',
    pg_temp.try_as('postgres', format('select public.platform_classify_owner_access_email(%L, %L)', stranger, 'x@s8.invalid')) like '%UNAUTHORIZED%', 'stranger');

  -- ---- Stage 3B regression + adoption semantics ----------------------------
  k := (select to_jsonb(x) from public.platform_create_pending_owner_access(po, '81000000-0000-4000-8000-000000000008', 'Orphan', 'orphan@s8.invalid', null, 7) x);
  perform pg_temp.chk('G1 an adopted account is attached by the unchanged Stage 3B RPC (already_existed=false)',
    (k ->> 'already_existed')::boolean = false and k ->> 'pending_id' is not null, k::text);
  k := public.platform_classify_owner_access_email(po, 'orphan@s8.invalid');
  perform pg_temp.chk('G2 once attached it is approval_exists (no second adoption)', k ->> 'classification' = 'approval_exists', k::text);
  k := (select to_jsonb(x) from public.platform_create_pending_owner_access(po, '81000000-0000-4000-8000-000000000002', 'Active', 'active@s8.invalid', null, 7) x);
  perform pg_temp.chk('G3 Stage 3B idempotent branch unchanged (active row -> already_existed=true, window unchanged)',
    (k ->> 'already_existed')::boolean = true and (k ->> 'expires_at')::timestamptz = now() + interval '3 days', k::text);
  perform pg_temp.chk('G4 Stage 3B still refuses an expired approval on create (renewal is ONLY via re-issue)',
    pg_temp.try_as('postgres', format('select * from public.platform_create_pending_owner_access(%L, %L, %L, %L, null, 7)', po, '81000000-0000-4000-8000-000000000006', 'HeldMe', 'held-me@s8.invalid')) like '%PENDING_ACCESS_EXPIRED%', 'expired');
end $$;

-- ===========================================================================
-- REPORT + VERDICT
-- ===========================================================================
select n, case when ok then 'PASS' else '**FAIL**' end as result, id, detail from _r order by n;
select count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail, count(*) as total from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'STAGE8_DB_SUITE_FAILED: % assertion(s) failed', f;
  end if;
end $$;

rollback;
