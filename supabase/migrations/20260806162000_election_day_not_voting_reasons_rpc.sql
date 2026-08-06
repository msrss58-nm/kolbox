-- Dynamic Non-Voting Reasons - Phase 0 (cont'd): catalog-management RPCs.
-- Mirrors election_day_dynamic_roles_phase2 exactly: SECURITY DEFINER,
-- set search_path = '', explicit revoke/grant to anon+authenticated, a
-- shared validation helper that raises loudly on invalid input (never
-- silently drops it), a pg_advisory_xact_lock guard against two admins
-- editing/reordering the catalog concurrently, and "delete rejected if still
-- in use" surfaced as a friendly error code (REASON_IN_USE) - the FK
-- (ON DELETE RESTRICT, previous migration) is the unbreakable backstop; this
-- check just gives a clear error instead of a raw foreign_key_violation.
--
-- Setting a voter's own reason (election_day_voters.not_voting_reason_id)
-- deliberately has NO RPC here - it's a plain REST update via the app's
-- existing updateVoter path, exactly like voted/phone/notes/reminder_at
-- already are, since election_day_voters' RLS is already permissive
-- (USING (true)) - see supabaseElectionDayApi.ts.
begin;

-- ============================================================================
-- Shared validation helper - not reachable by anon/authenticated directly,
-- only from within the SECURITY DEFINER RPCs below.
-- ============================================================================
create or replace function public.election_day_validate_non_voting_reason_input(
  p_name text
)
returns void
language plpgsql
as $$
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'REASON_NAME_REQUIRED';
  end if;
end;
$$;

comment on function public.election_day_validate_non_voting_reason_input(text) is
  'Dynamic Non-Voting Reasons: shared create/update validation, mirroring election_day_validate_role_input.';

revoke all on function public.election_day_validate_non_voting_reason_input(text)
  from public, anon, authenticated;

-- ============================================================================
-- election_day_list_non_voting_reasons - returns the full catalog, including
-- inactive rows, so the management screen can show/re-enable them; the
-- voter-level dropdown filters to is_active = true client-side.
-- ============================================================================
create or replace function public.election_day_list_non_voting_reasons()
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer
)
language sql
security definer
set search_path = ''
stable
as $$
  select r.id, r.name, r.description, r.is_active, r.sort_order
  from public.election_day_not_voting_reasons r
  order by r.sort_order asc, r.created_at asc;
$$;

comment on function public.election_day_list_non_voting_reasons() is
  'Dynamic Non-Voting Reasons: lists the full catalog (active and inactive) ordered by sort_order.';

revoke all on function public.election_day_list_non_voting_reasons() from public;
grant execute on function public.election_day_list_non_voting_reasons() to anon, authenticated;

-- ============================================================================
-- election_day_create_non_voting_reason - new rows always land at the end
-- of the current sort order.
-- ============================================================================
create or replace function public.election_day_create_non_voting_reason(
  p_name text, p_description text
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_next_sort integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);
  perform public.election_day_validate_non_voting_reason_input(p_name);

  select coalesce(max(r.sort_order), -1) + 1 into v_next_sort
  from public.election_day_not_voting_reasons r;

  insert into public.election_day_not_voting_reasons (name, description, sort_order)
  values (btrim(p_name), coalesce(p_description, ''), v_next_sort)
  returning public.election_day_not_voting_reasons.id into v_id;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order
    from public.election_day_not_voting_reasons r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_non_voting_reason(text, text) is
  'Dynamic Non-Voting Reasons: creates a new reason, appended to the end of the sort order.';

revoke all on function public.election_day_create_non_voting_reason(text, text) from public;
grant execute on function public.election_day_create_non_voting_reason(text, text) to anon, authenticated;

-- ============================================================================
-- election_day_update_non_voting_reason - name/description only. is_active/
-- sort_order are never writable through this RPC (dedicated RPCs below),
-- same convention as election_day_update_role never accepting
-- legacy_role_key.
-- ============================================================================
create or replace function public.election_day_update_non_voting_reason(
  p_id uuid, p_name text, p_description text
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);

  if not exists (select 1 from public.election_day_not_voting_reasons r where r.id = p_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;
  perform public.election_day_validate_non_voting_reason_input(p_name);

  update public.election_day_not_voting_reasons as r
  set name = btrim(p_name), description = coalesce(p_description, '')
  where r.id = p_id;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order
    from public.election_day_not_voting_reasons r
    where r.id = p_id;
end;
$$;

comment on function public.election_day_update_non_voting_reason(uuid, text, text) is
  'Dynamic Non-Voting Reasons: edits an existing reason''s name/description. is_active/sort_order are never writable through this RPC.';

revoke all on function public.election_day_update_non_voting_reason(uuid, text, text) from public;
grant execute on function public.election_day_update_non_voting_reason(uuid, text, text) to anon, authenticated;

-- ============================================================================
-- election_day_set_non_voting_reason_active - enable/disable. Allowed even
-- on a reason currently in use (product decision: disable ≠ delete) - since
-- only the ID is ever stored on a voter, disabling a reason never corrupts
-- any existing voter row; it only removes the reason from the active list
-- offered for NEW assignments.
-- ============================================================================
create or replace function public.election_day_set_non_voting_reason_active(
  p_id uuid, p_is_active boolean
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);

  if not exists (select 1 from public.election_day_not_voting_reasons r where r.id = p_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;

  update public.election_day_not_voting_reasons as r
  set is_active = p_is_active
  where r.id = p_id;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order
    from public.election_day_not_voting_reasons r
    where r.id = p_id;
end;
$$;

comment on function public.election_day_set_non_voting_reason_active(uuid, boolean) is
  'Dynamic Non-Voting Reasons: enables/disables a reason. Allowed even while in use - disabling only removes it from the active list offered for new assignments, never affects existing voter references.';

revoke all on function public.election_day_set_non_voting_reason_active(uuid, boolean) from public;
grant execute on function public.election_day_set_non_voting_reason_active(uuid, boolean) to anon, authenticated;

-- ============================================================================
-- election_day_delete_non_voting_reason - blocked (REASON_IN_USE) if any
-- election_day_voters row still references it, regardless of that voter's
-- current voted status (a reason kept for history on a now-voted voter still
-- counts as "in use"). ON DELETE RESTRICT (previous migration) is the
-- unbreakable backstop; this check exists only to give a clear error instead
-- of a raw foreign_key_violation.
-- ============================================================================
create or replace function public.election_day_delete_non_voting_reason(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);

  if not exists (select 1 from public.election_day_not_voting_reasons where id = p_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;

  select count(*) into v_used_count
  from public.election_day_voters
  where not_voting_reason_id = p_id;

  if v_used_count > 0 then
    raise exception 'REASON_IN_USE';
  end if;

  delete from public.election_day_not_voting_reasons where id = p_id;
end;
$$;

comment on function public.election_day_delete_non_voting_reason(uuid) is
  'Dynamic Non-Voting Reasons: deletes a reason. Rejects (REASON_IN_USE) if any voter - voted or not - still references it.';

revoke all on function public.election_day_delete_non_voting_reason(uuid) from public;
grant execute on function public.election_day_delete_non_voting_reason(uuid) to anon, authenticated;

-- ============================================================================
-- election_day_reorder_non_voting_reasons - a single bulk RPC (one
-- transaction) rather than per-row "move up/down" calls, so two admins
-- reordering concurrently can't interleave into a corrupted order. Requires
-- the FULL current set of ids, each exactly once - a partial/mismatched list
-- is rejected outright (REORDER_ID_MISMATCH) rather than silently applied.
-- ============================================================================
create or replace function public.election_day_reorder_non_voting_reasons(
  p_ordered_ids uuid[]
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);

  select count(*) into v_existing_count from public.election_day_not_voting_reasons;

  if p_ordered_ids is null
     or array_length(p_ordered_ids, 1) is distinct from v_existing_count
     or (select count(distinct x) from unnest(p_ordered_ids) as x) <> v_existing_count
     or exists (
       select 1 from unnest(p_ordered_ids) as x(rid)
       left join public.election_day_not_voting_reasons r on r.id = x.rid
       where r.id is null
     )
  then
    raise exception 'REORDER_ID_MISMATCH';
  end if;

  update public.election_day_not_voting_reasons as r
  set sort_order = o.new_order
  from (
    select rid, ordinality - 1 as new_order
    from unnest(p_ordered_ids) with ordinality as t(rid, ordinality)
  ) as o
  where r.id = o.rid;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order
    from public.election_day_not_voting_reasons r
    order by r.sort_order asc;
end;
$$;

comment on function public.election_day_reorder_non_voting_reasons(uuid[]) is
  'Dynamic Non-Voting Reasons: bulk-reorders the catalog in one transaction. Rejects (REORDER_ID_MISMATCH) unless given every existing id exactly once.';

revoke all on function public.election_day_reorder_non_voting_reasons(uuid[]) from public;
grant execute on function public.election_day_reorder_non_voting_reasons(uuid[]) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_reorder_non_voting_reasons(uuid[]);
--   drop function if exists public.election_day_delete_non_voting_reason(uuid);
--   drop function if exists public.election_day_set_non_voting_reason_active(uuid, boolean);
--   drop function if exists public.election_day_update_non_voting_reason(uuid, text, text);
--   drop function if exists public.election_day_create_non_voting_reason(text, text);
--   drop function if exists public.election_day_list_non_voting_reasons();
--   drop function if exists public.election_day_validate_non_voting_reason_input(text);
--   commit;
-- ============================================================================
