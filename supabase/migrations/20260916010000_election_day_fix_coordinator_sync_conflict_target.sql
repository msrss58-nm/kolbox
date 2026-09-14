-- ============================================================================
-- Election Day hotfix - restore trusted voter import.
--
-- ROOT CAUSE: election_day_sync_coordinators_from_voters_for_workspace
-- (20260829050000) inserts with
--   ON CONFLICT (display_name) WHERE status = 'active'
-- which matched the GLOBAL partial unique index
-- election_day_coordinators_active_display_name_key (20260811100100). Multi-
-- Tenant Phase 4A (20260830010000) replaced that index with the per-workspace
-- election_day_coordinators_workspace_active_display_name_key
--   (workspace_id, display_name) WHERE status = 'active'
-- and did not update this function. PostgreSQL resolves the ON CONFLICT
-- arbiter when the statement is planned, so the INSERT raised 42P10 ("there is
-- no unique or exclusion constraint matching the ON CONFLICT specification")
-- on EVERY call - every trusted import (election_day_import_voters_v3 ->
-- election_day_import_voters_core -> this function) rolled back and the API
-- answered 500.
--
-- FIX: the ONLY change is the conflict target, which now names the existing
-- per-workspace index exactly (same columns, same predicate). Everything else
-- is byte-for-byte the 20260829050000 body: SECURITY DEFINER, empty
-- search_path, the same-workspace NOT EXISTS de-duplication (display_name OR
-- linked_assignment_name, any status), the ACTOR_WORKSPACE_REQUIRED guard, and
-- no grant to any role (internal-only; reached only from
-- election_day_import_voters_core).
--
-- No index, table, data or other function changes. No backfill: the failed
-- imports wrote nothing, and existing rows already satisfy the index.
-- A side effect is intended: an active coordinator with the same display name
-- in ANOTHER workspace no longer absorbs this workspace's insert (the
-- limitation documented on the 20260829050000 function comment).
-- ============================================================================

create or replace function public.election_day_sync_coordinators_from_voters_for_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  insert into public.election_day_coordinators (display_name, workspace_id)
  select distinct trimmed.name, p_workspace_id
  from (
    select btrim(v.coordinator) as name
    from public.election_day_voters v
    where v.coordinator is not null and btrim(v.coordinator) <> ''
      and v.workspace_id = p_workspace_id
  ) as trimmed
  where not exists (
    select 1 from public.election_day_coordinators c
    where (c.display_name = trimmed.name or c.linked_assignment_name = trimmed.name)
      and c.workspace_id = p_workspace_id
  )
  on conflict (workspace_id, display_name) where status = 'active' do nothing;
end;
$$;

comment on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) is
  'Phase 3 Import/Clear: workspace-aware coordinator sync, used only by election_day_import_voters_core. Inspects election_day_voters.coordinator values ONLY within p_workspace_id and inserts new election_day_coordinators rows with workspace_id = p_workspace_id, deduped against existing coordinators (display_name or linked_assignment_name, any status) in that SAME workspace. The ON CONFLICT target (workspace_id, display_name) WHERE status = ''active'' matches the per-workspace partial unique index election_day_coordinators_workspace_active_display_name_key (Phase 4A); hotfix 20260916010000 corrected it from the former global (display_name) target, which no longer had a matching index and made every import fail with 42P10. Internal-only.';

-- Internal-only, exactly as in 20260829050000: no role may execute it directly.
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from public;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from anon;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from authenticated;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from service_role;

-- ============================================================================
-- ROLLBACK (manual, not executed): re-create the function with the previous
-- conflict target `on conflict (display_name) where status = 'active' do
-- nothing;` and the 20260829050000 comment. This restores the broken state
-- (every trusted import fails with 42P10); there is no data to reverse.
-- ============================================================================
