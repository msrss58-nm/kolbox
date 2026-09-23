-- EXPAND-PHASE COMPATIBILITY suite.
--
-- THE QUESTION THIS ANSWERS: if the EXPAND migration (20260926000000) is
-- applied to Production while the PREVIOUS deployment is still serving, does
-- that deployment keep working?
--
-- Every check below calls the EXACT signature or reads the EXACT response key
-- that the pre-multi-owner application uses, and asserts the behaviour it
-- expects - not merely that the call does not error.
--
-- PHASE-SPECIFIC BY DESIGN. This suite is expected to pass on an EXPAND-only
-- database and to FAIL once the CONTRACT migration (20260927000000) has
-- removed the compatibility layer. That is the point: it is the gate that
-- says "the old code is still safe", and after CONTRACT the old code is gone.
-- Section Z asserts the new contract is present too, so a pass here also
-- means both contracts coexist.
--
-- Run ONLY against the isolated scratch stack, with EXPAND applied and
-- CONTRACT withheld:
--   docker exec -i supabase_db_kolboxs5 psql -U postgres -v ON_ERROR_STOP=1 < scripts/multi-owner/db-expand-compat.sql
--
-- One transaction, ROLLED BACK at the end. Synthetic identities only.

\set ON_ERROR_STOP on
\pset pager off
begin;

create temp table _r (n serial primary key, id text not null, ok boolean not null, detail text);

create function pg_temp.chk(p_id text, p_ok boolean, p_detail text) returns void
language sql as $$ insert into _r (id, ok, detail) values (p_id, coalesce(p_ok, false), p_detail) $$;

delete from public.multi_entity_assignments;
delete from public.multi_entity_owner;
delete from public.election_owners;
delete from public.election_workspace_pending_owner_access;
delete from public.platform_owners;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('70000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','xc-po@expandcompat.invalid', now(), now()),
  ('70000000-0000-4000-8000-00000000000a','00000000-0000-0000-0000-000000000000','authenticated','authenticated','xc-a@expandcompat.invalid', now(), now()),
  ('70000000-0000-4000-8000-00000000000b','00000000-0000-0000-0000-000000000000','authenticated','authenticated','xc-b@expandcompat.invalid', now(), now());

insert into public.platform_owners (auth_user_id, name, email)
values ('70000000-0000-4000-8000-000000000001', 'XC Platform Owner', 'xc-po@expandcompat.invalid');

insert into public.election_workspaces (id, name, election_end_at, login_code) values
  ('71000000-0000-4000-8000-00000000000a', 'XC Alpha', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
  ('71000000-0000-4000-8000-00000000000b', 'XC Beta',  now() + interval '10 days', public.election_day_generate_workspace_login_code());

-- ===========================================================================
-- A. THE LEGACY SIGNATURES STILL EXIST, WITH THEIR GRANTS
-- ===========================================================================
do $$
begin
  perform pg_temp.chk('A1 platform_assign_workspace(uuid,uuid) still exists',
    to_regprocedure('public.platform_assign_workspace(uuid,uuid)') is not null, '');
  perform pg_temp.chk('A2 platform_unassign_workspace(uuid,uuid) still exists',
    to_regprocedure('public.platform_unassign_workspace(uuid,uuid)') is not null, '');
  perform pg_temp.chk('A3 platform_provision_multi_entity_owner(uuid,uuid,text,text,text) still exists',
    to_regprocedure('public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)') is not null, '');
  perform pg_temp.chk('A4 each keeps its service_role grant (the API calls them as service_role)',
    has_function_privilege('service_role', 'public.platform_assign_workspace(uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.platform_unassign_workspace(uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)', 'execute'), '');
  perform pg_temp.chk('A5 none of them became reachable by a browser role',
    not has_function_privilege('anon', 'public.platform_assign_workspace(uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.platform_assign_workspace(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)', 'execute'), '');
  perform pg_temp.chk('A6 the compatibility helper is callable by NO role',
    not has_function_privilege('service_role', 'public.platform_multi_entity_sole_owner()', 'execute')
      and not has_function_privilege('anon', 'public.platform_multi_entity_sole_owner()', 'execute')
      and not has_function_privilege('authenticated', 'public.platform_multi_entity_sole_owner()', 'execute'), '');
end $$;

-- ===========================================================================
-- B. THE OLD APPLICATION'S OWN FLOW, END TO END, UNCHANGED
-- ===========================================================================
do $$
declare
  r jsonb;
  st jsonb;
begin
  -- 1. Provision the seat exactly as the old handler does: 5 arguments, no
  --    owner selector, because it has none to give.
  r := public.platform_provision_multi_entity_owner(
    '70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-00000000000a',
    'Seat A','xc-a@expandcompat.invalid','0501112222');
  perform pg_temp.chk('B1 legacy provision creates the seat and reports the old contract',
    (r->>'replaced') = 'false' and (r->>'already_existed') = 'false'
      and r->>'previous_auth_user_id' is null
      and (r->>'seat_auth_user_id')::uuid = '70000000-0000-4000-8000-00000000000a'::uuid,
    r::text);
  perform pg_temp.chk('B2 exactly one owner row exists', (select count(*) from public.multi_entity_owner) = 1, '');

  -- 2. Assign, the old way.
  r := public.platform_assign_workspace(
    '70000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('B3 legacy assign works and reports the old contract',
    (r->>'already_assigned') = 'false' and r->>'assignment_id' is not null, r::text);
  perform pg_temp.chk('B4 ... and the row it wrote IS attributed to that owner (not left unowned)',
    (select a.owner_id from public.multi_entity_assignments a
      where a.workspace_id = '71000000-0000-4000-8000-00000000000a')
    = (select m.owner_id from public.multi_entity_owner m), '');

  r := public.platform_assign_workspace(
    '70000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('B5 legacy assign is still idempotent', (r->>'already_assigned') = 'true', r::text);

  -- 3. The seat holder sees it - the read path the old app relies on.
  perform pg_temp.chk('B6 the seat holder sees their workspace through the unchanged reader',
    (select count(*) from public.multi_entity_list_assigned_workspaces('70000000-0000-4000-8000-00000000000a')) = 1, '');

  -- 4. The old console's state read.
  st := public.platform_get_multi_entity_state('70000000-0000-4000-8000-000000000001');
  perform pg_temp.chk('B7 the state read still returns a `seat` OBJECT for the old console',
    st -> 'seat' ->> 'auth_user_id' = '70000000-0000-4000-8000-00000000000a'
      and st -> 'seat' ->> 'email' = 'xc-a@expandcompat.invalid', (st->'seat')::text);
  perform pg_temp.chk('B8 ... and per-workspace `is_assigned` / `assigned_at` the old rows render',
    (select (w ->> 'is_assigned')::boolean from jsonb_array_elements(st -> 'workspaces') w
      where w ->> 'workspace_id' = '71000000-0000-4000-8000-00000000000a')
      and (select w ->> 'assigned_at' from jsonb_array_elements(st -> 'workspaces') w
            where w ->> 'workspace_id' = '71000000-0000-4000-8000-00000000000a') is not null, '');
  perform pg_temp.chk('B9 ... and an UNassigned workspace still reports is_assigned false',
    (select (w ->> 'is_assigned')::boolean from jsonb_array_elements(st -> 'workspaces') w
      where w ->> 'workspace_id' = '71000000-0000-4000-8000-00000000000b') = false, '');

  -- 5. Replacement, the old way: same 5-argument call, different identity.
  r := public.platform_provision_multi_entity_owner(
    '70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-00000000000b',
    'Seat B','xc-b@expandcompat.invalid','0501112223');
  perform pg_temp.chk('B10 legacy replacement reports replaced + the previous holder',
    (r->>'replaced') = 'true'
      and (r->>'previous_auth_user_id')::uuid = '70000000-0000-4000-8000-00000000000a'::uuid, r::text);
  perform pg_temp.chk('B11 ... still exactly one owner row (an UPDATE, never delete+insert)',
    (select count(*) from public.multi_entity_owner) = 1, '');
  perform pg_temp.chk('B12 ... and the assignment carried over to the new holder',
    (select count(*) from public.multi_entity_list_assigned_workspaces('70000000-0000-4000-8000-00000000000b')) = 1, '');
  perform pg_temp.chk('B13 ... and the predecessor is refused, as before',
    (select count(*) from public.multi_entity_owner where auth_user_id = '70000000-0000-4000-8000-00000000000a') = 0, '');

  -- 6. Idempotent re-provision of the SAME identity: refresh, no audit event.
  r := public.platform_provision_multi_entity_owner(
    '70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-00000000000b',
    'Seat B Renamed','xc-b@expandcompat.invalid','0501112299');
  perform pg_temp.chk('B14 legacy idempotent re-provision refreshes metadata only',
    (r->>'already_existed') = 'true' and (r->>'replaced') = 'false'
      and (select name from public.multi_entity_owner) = 'Seat B Renamed', r::text);

  -- 7. Unassign, the old way.
  r := public.platform_unassign_workspace(
    '70000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('B15 legacy unassign removes it', (r->>'removed') = 'true', r::text);
  r := public.platform_unassign_workspace(
    '70000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-00000000000a');
  perform pg_temp.chk('B16 ... and unassigning again is still a successful no-op',
    (r->>'removed') = 'false' and r->>'audit_id' is null, r::text);
end $$;

-- ===========================================================================
-- C. THE LEGACY PATH REFUSES RATHER THAN GUESSING ONCE THERE ARE SEVERAL
-- ===========================================================================
do $$
declare
  r jsonb;
  st jsonb;
  failed boolean;
begin
  -- The NEW code adds a second owner during the overlap window.
  perform public.platform_provision_multi_entity_owner_v2(
    '70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-00000000000a',
    'Owner Two','xc-a@expandcompat.invalid','0501112230', null);
  perform pg_temp.chk('C1 two owners now exist', (select count(*) from public.multi_entity_owner) = 2, '');

  -- A legacy caller cannot say which one it means. It must REFUSE, not pick.
  failed := false;
  begin
    perform public.platform_assign_workspace(
      '70000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-00000000000b');
  exception when others then
    failed := sqlerrm like '%MULTI_ENTITY_OWNER_AMBIGUOUS%';
  end;
  perform pg_temp.chk('C2 legacy assign REFUSES when several owners exist (never guesses)', failed, '');

  failed := false;
  begin
    perform public.platform_provision_multi_entity_owner(
      '70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-00000000000b',
      'X','xc-b@expandcompat.invalid','0501112231');
  exception when others then
    failed := sqlerrm like '%MULTI_ENTITY_OWNER_AMBIGUOUS%';
  end;
  perform pg_temp.chk('C3 legacy provision REFUSES too (it would otherwise replace the wrong person)', failed, '');

  perform pg_temp.chk('C4 nothing was written by either refusal',
    (select count(*) from public.multi_entity_assignments
      where workspace_id = '71000000-0000-4000-8000-00000000000b') = 0
    and (select count(*) from public.multi_entity_owner) = 2, '');

  -- And the legacy `seat` key goes null rather than naming an arbitrary owner.
  st := public.platform_get_multi_entity_state('70000000-0000-4000-8000-000000000001');
  perform pg_temp.chk('C5 `seat` is null with several owners - never an arbitrary one',
    st -> 'seat' = 'null'::jsonb or st -> 'seat' is null, (st->'seat')::text);
  perform pg_temp.chk('C6 ... while `owners` reports both, for the new console',
    jsonb_array_length(st -> 'owners') = 2, '');

  -- The NEW path is unaffected by the ambiguity that stops the old one.
  r := public.platform_assign_workspace_v2(
    '70000000-0000-4000-8000-000000000001',
    (select owner_id from public.multi_entity_owner order by created_at limit 1),
    '71000000-0000-4000-8000-00000000000b');
  perform pg_temp.chk('C7 the _v2 path still works in exactly that state', (r->>'already_assigned') = 'false', r::text);
end $$;

-- ===========================================================================
-- Z. BOTH CONTRACTS COEXIST (this is what makes the overlap window safe)
-- ===========================================================================
do $$
begin
  perform pg_temp.chk('Z1 the _v2 contract is present alongside the legacy one',
    to_regprocedure('public.platform_assign_workspace_v2(uuid,uuid,uuid)') is not null
      and to_regprocedure('public.platform_unassign_workspace_v2(uuid,uuid,uuid)') is not null
      and to_regprocedure('public.platform_provision_multi_entity_owner_v2(uuid,uuid,text,text,text,uuid)') is not null
      and to_regprocedure('public.platform_remove_multi_entity_owner(uuid,uuid)') is not null, '');
  perform pg_temp.chk('Z2 the multi-owner schema is in place',
    not exists (select 1 from pg_constraint where conname = 'multi_entity_owner_singleton')
      and exists (select 1 from pg_constraint where conname = 'multi_entity_assignments_owner_workspace_key'), '');
  perform pg_temp.chk('Z3 table ACLs are unchanged - postgres only, no new grant',
    (select coalesce(relacl::text,'owner-only') from pg_class where oid = 'public.multi_entity_owner'::regclass)
      in ('owner-only','{postgres=arwdDxtm/postgres}')
    and (select coalesce(relacl::text,'owner-only') from pg_class where oid = 'public.multi_entity_assignments'::regclass)
      in ('owner-only','{postgres=arwdDxtm/postgres}'), '');
end $$;

select n, case when ok then 'PASS' else '**FAIL**' end as result, id, detail from _r order by n;
select count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail, count(*) as total from _r;

do $$
declare f int := (select count(*) from _r where not ok);
begin
  if f > 0 then
    raise exception 'EXPAND_COMPAT_SUITE_FAILED: % assertion(s) failed', f;
  end if;
end $$;

rollback;
