-- Follow-up fix: election_day_set_non_voting_reason - security invoker ->
-- security definer.
--
-- Root cause, confirmed live in production by 2 independent verification
-- agents: this function reads election_day_not_voting_reasons to check
-- requires_follow_up, but that table's RLS is enabled with zero policies
-- (locked down by design - every other consumer reads it exclusively
-- through a security definer RPC, e.g. election_day_list_non_voting_reasons
-- in 20260806162000_election_day_not_voting_reasons_rpc.sql). Running as
-- invoker (the caller's own anon/authenticated role), the function's
-- internal SELECT against that table was silently blocked by RLS and
-- always returned 0 rows - so requires_follow_up was never actually read,
-- coalesce(null, true) always defaulted to "still requires follow-up", and
-- the reminder was never closed with reason=case_closed, for any reason,
-- ever.
--
-- Fix: security definer, matching the exact pattern already used by every
-- other RPC that needs to read this locked-down table. The function runs
-- with the privileges of its owner for exactly this one read, inside
-- exactly this one function body - no policy added to
-- election_day_not_voting_reasons, no change to that table's RLS, no
-- broader privilege widening anywhere else. election_day_voters' own
-- RLS/permissions model, and every other RPC from the prior migration, are
-- completely untouched by this file.
--
-- Everything else is byte-for-byte unchanged from the version applied in
-- 20260810120000_election_day_reminder_lifecycle.sql: identical signature
-- (uuid, uuid, text), identical business logic, identical for-update
-- row-locking atomicity/idempotency, identical set search_path = ''
-- (matters even more for security definer - prevents search_path
-- hijacking), identical revoke/grant. CREATE OR REPLACE FUNCTION with an
-- unchanged signature replaces the existing function in place - no new
-- overload is created, and PostgreSQL preserves the function's existing
-- grants across a CREATE OR REPLACE (the revoke/grant pair below just
-- restates them explicitly, matching this codebase's existing convention).
begin;

create or replace function public.election_day_set_non_voting_reason(p_id uuid, p_reason_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_reminder_at timestamptz;
  v_contact_name text;
  v_coordinator text;
  v_requires_follow_up boolean;
  v_close boolean;
begin
  select reminder_at, first_name || ' ' || last_name, coordinator
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  if p_reason_id is not null then
    select requires_follow_up into v_requires_follow_up
    from public.election_day_not_voting_reasons
    where id = p_reason_id;
  end if;

  v_close := p_reason_id is not null and coalesce(v_requires_follow_up, true) = false and v_old_reminder_at is not null;

  update public.election_day_voters
  set not_voting_reason_id = p_reason_id,
      not_voting_reason_set_at = case when p_reason_id is not null then now() else null end,
      not_voting_reason_set_by = case when p_reason_id is not null then p_actor_name else null end,
      reminder_at = case when v_close then null else reminder_at end,
      reminder_closed_at = case when v_close then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close then 'case_closed' else reminder_closed_reason end,
      reminder_closed_by = case when v_close then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id;

  if v_close then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'case_closed', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_set_non_voting_reason(uuid, uuid, text) is
  'Reminder Lifecycle: sets not_voting_reason_id/set_at/set_by (replaces the old plain PATCH). Closes an open reminder with reason=case_closed only when the reason resolves and requires_follow_up=false. security definer (fixed from invoker in this follow-up migration) so its internal read of the locked-down election_day_not_voting_reasons table (RLS-enabled, zero policies) can actually resolve - previously always saw 0 rows and coalesce-defaulted to "still requires follow-up", silently never closing. An unresolvable reason id still defaults to requires_follow_up=true (do not close) - never silently closes a case it cannot verify is closed.';

revoke all on function public.election_day_set_non_voting_reason(uuid, uuid, text) from public;
grant execute on function public.election_day_set_non_voting_reason(uuid, uuid, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual): reverts to security invoker (restores the bug - not
-- recommended, but included for completeness as a schema-only, no-data-loss
-- revert). Same body, only the security clause changes back.
--
--   begin;
--   create or replace function public.election_day_set_non_voting_reason(p_id uuid, p_reason_id uuid, p_actor_name text)
--   returns setof public.election_day_voters
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--     -- identical body to the function above
--   $$;
--   revoke all on function public.election_day_set_non_voting_reason(uuid, uuid, text) from public;
--   grant execute on function public.election_day_set_non_voting_reason(uuid, uuid, text) to anon, authenticated;
--   commit;
-- ============================================================================
