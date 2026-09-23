-- ===========================================================================
-- KOLBOX Multi-Entity multi-owner - *** CONTRACT PHASE ***
--
-- ROLLOUT SHAPE: EXPAND -> DEPLOY -> VERIFY -> CONTRACT.
--
-- 20260926000000 (EXPAND) added the multi-owner model while keeping every
-- signature and response key the THEN-deployed application used. This
-- migration removes that compatibility layer.
--
-- APPLY THIS ONLY AFTER the multi-owner application is deployed to every
-- surface AND verified in Production. Applying it while the previous
-- deployment is still serving would break it immediately - which is precisely
-- the failure mode the two-phase split exists to prevent.
--
-- WHAT IS REMOVED, and why each is safe once the new code is live:
--   * platform_assign_workspace(uuid,uuid)                  - the new handler
--   * platform_unassign_workspace(uuid,uuid)                  calls the _v2
--   * platform_provision_multi_entity_owner(uuid,..,text)     signatures with
--                                                             an explicit
--                                                             owner id.
--   * platform_multi_entity_sole_owner()                    - existed only to
--                                                             serve those three.
--   * the `seat`, `is_assigned` and `assigned_at` keys       - the new console
--     in platform_get_multi_entity_state                      reads `owners`
--                                                             and
--                                                             `assigned_owner_ids`.
--
-- WHAT IS NOT TOUCHED: the schema, the backfilled data, every _v2 operation,
-- every owner-scoped reader, the audit model, and every grant. This migration
-- only deletes a bridge that nothing crosses any more.
--
-- NOTE FOR THE PRODUCTION DRIFT SNAPSHOTS. The gitignored pre/post comparison
-- scripts under node_modules/.kolbox-verify/ read
-- `platform_get_multi_entity_state(...)->'seat'` as a scalar. After this
-- migration that key is absent and those snapshots must be updated in the same
-- operation, or they will report a false drift.
--
-- ROLLBACK NOTE (manual): re-apply section 6b and section 7 of
-- 20260926000000 verbatim - they are self-contained `create or replace`
-- blocks plus their grants, and restore the compatibility layer exactly.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Gate - EXPAND must already be applied, and the replacement contract must
--    be the one actually in place before anything is taken away.
-- ---------------------------------------------------------------------------
do $gate$
begin
  if to_regprocedure('public.platform_provision_multi_entity_owner_v2(uuid,uuid,text,text,text,uuid)') is null
     or to_regprocedure('public.platform_assign_workspace_v2(uuid,uuid,uuid)') is null
     or to_regprocedure('public.platform_unassign_workspace_v2(uuid,uuid,uuid)') is null
     or to_regprocedure('public.platform_remove_multi_entity_owner(uuid,uuid)') is null then
    raise exception 'MULTI_OWNER_CONTRACT_GATE_FAILED: 20260926000000 (EXPAND) must be applied first';
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'multi_entity_owner_singleton'
      and conrelid = 'public.multi_entity_owner'::regclass
  ) then
    raise exception 'MULTI_OWNER_CONTRACT_GATE_FAILED: the singleton CHECK is still present - EXPAND did not complete';
  end if;

  if exists (
    select 1 from public.multi_entity_assignments where owner_id is null
  ) then
    raise exception 'MULTI_OWNER_CONTRACT_GATE_FAILED: unattributed assignment rows remain';
  end if;
end;
$gate$;

-- ---------------------------------------------------------------------------
-- 1. Drop the legacy operation signatures.
--
--    Dropped by EXACT signature. The _v2 functions have different arities, so
--    there is no chance of removing the replacement by mistake.
-- ---------------------------------------------------------------------------
drop function if exists public.platform_assign_workspace(uuid, uuid);
drop function if exists public.platform_unassign_workspace(uuid, uuid);
drop function if exists public.platform_provision_multi_entity_owner(uuid, uuid, text, text, text);

-- Only ever existed to serve the three above.
drop function if exists public.platform_multi_entity_sole_owner();

-- ---------------------------------------------------------------------------
-- 2. The console's state read - drop the legacy keys.
--
--    Identical to the EXPAND definition except that `seat` is gone from the
--    returned object and the per-workspace `is_assigned` / `assigned_at`
--    legacy fields are gone with it. `owners` and `assigned_owner_ids` are
--    unchanged, so the deployed console needs no change for this.
-- ---------------------------------------------------------------------------
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
  v_owners jsonb;
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

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'owner_id', m.owner_id,
               'auth_user_id', m.auth_user_id,
               'name', m.name,
               'email', m.email,
               'phone', m.phone,
               'created_at', m.created_at,
               'updated_at', m.updated_at,
               'assigned_workspace_ids', coalesce(
                 (select pg_catalog.jsonb_agg(a.workspace_id order by a.assigned_at)
                    from public.multi_entity_assignments a
                   where a.owner_id = m.owner_id),
                 '[]'::jsonb
               )
             )
             order by m.created_at, m.owner_id
           ),
           '[]'::jsonb
         )
    into v_owners
  from public.multi_entity_owner m;

  -- is_active is DERIVED from election_end_at, never stored. login_code is
  -- included because election_workspaces.name carries no uniqueness constraint
  -- of any kind - it is a tenant SELECTOR, not a secret.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'workspace_id', w.id,
               'name', w.name,
               'login_code', w.login_code,
               'election_end_at', w.election_end_at,
               'is_active', (w.election_end_at > pg_catalog.now()),
               'assigned_owner_ids', coalesce(
                 (select pg_catalog.jsonb_agg(a.owner_id order by a.assigned_at)
                    from public.multi_entity_assignments a
                   where a.workspace_id = w.id),
                 '[]'::jsonb
               )
             )
             order by w.created_at
           ),
           '[]'::jsonb
         )
    into v_workspaces
  from public.election_workspaces w;

  -- REPLACEMENT / REMOVAL orphans - unchanged from EXPAND.
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
    where r.action in ('replaced', 'removed')
      and not exists (
        select 1 from public.multi_entity_audit s
        where s.action = 'previous_auth_deleted'
          and s.previous_auth_user_id = r.previous_auth_user_id
      )
      and public.multi_entity_auth_user_held_by(r.previous_auth_user_id) is null
    group by r.previous_auth_user_id
  ) p;

  -- PROVISIONING orphans - unchanged from EXPAND.
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
    'owners', v_owners,
    'workspaces', v_workspaces,
    'pending_auth_cleanup', v_pending_cleanup,
    'pending_provisioning_orphans', v_pending_orphans
  );
end;
$fn$;

comment on function public.platform_get_multi_entity_state(uuid) is
  'The Platform console''s Multi-Entity read: EVERY Multi-Entity Owner with their own assigned workspace ids, every workspace with the owner ids holding it, and both cleanup queues. The legacy `seat` / `is_assigned` / `assigned_at` keys were removed by 20260927000000 (CONTRACT). service_role only.';

revoke all on function public.platform_get_multi_entity_state(uuid) from public;
revoke all on function public.platform_get_multi_entity_state(uuid) from anon;
revoke all on function public.platform_get_multi_entity_state(uuid) from authenticated;
grant execute on function public.platform_get_multi_entity_state(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Post-condition - the bridge is gone and the replacement is intact.
-- ---------------------------------------------------------------------------
do $verify$
begin
  if to_regprocedure('public.platform_assign_workspace(uuid,uuid)') is not null
     or to_regprocedure('public.platform_unassign_workspace(uuid,uuid)') is not null
     or to_regprocedure('public.platform_provision_multi_entity_owner(uuid,uuid,text,text,text)') is not null
     or to_regprocedure('public.platform_multi_entity_sole_owner()') is not null then
    raise exception 'MULTI_OWNER_CONTRACT_VERIFY_FAILED: a legacy signature survived';
  end if;

  if to_regprocedure('public.platform_assign_workspace_v2(uuid,uuid,uuid)') is null
     or to_regprocedure('public.platform_unassign_workspace_v2(uuid,uuid,uuid)') is null
     or to_regprocedure('public.platform_provision_multi_entity_owner_v2(uuid,uuid,text,text,text,uuid)') is null
     or to_regprocedure('public.platform_remove_multi_entity_owner(uuid,uuid)') is null then
    raise exception 'MULTI_OWNER_CONTRACT_VERIFY_FAILED: a _v2 operation is missing';
  end if;

  -- Data is untouched by this migration; assert it rather than assume it.
  if exists (select 1 from public.multi_entity_assignments where owner_id is null) then
    raise exception 'MULTI_OWNER_CONTRACT_VERIFY_FAILED: unattributed assignment rows appeared';
  end if;

  if has_function_privilege('anon', 'public.platform_get_multi_entity_state(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.platform_get_multi_entity_state(uuid)', 'execute') then
    raise exception 'MULTI_OWNER_CONTRACT_VERIFY_FAILED: the state read became reachable by a browser role';
  end if;
end;
$verify$;
