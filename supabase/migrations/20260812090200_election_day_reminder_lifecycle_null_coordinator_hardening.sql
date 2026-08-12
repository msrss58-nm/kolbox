-- Coordinator Allocation Management - Phase 2 (import safety), follow-up
-- hardening after focused audit.
--
-- Repository-wide audit of every reference to election_day_voters.coordinator
-- across all migrations (reads, writes to other tables, NOT NULL target
-- columns, any function assuming coordinator is never null) confirmed the
-- full blast radius is exactly these 5 pre-existing RPCs - no other sink
-- exists:
--   election_day_set_reminder(uuid, timestamptz, text)
--   election_day_close_reminder(uuid, text)
--   election_day_cancel_reminder(uuid, text)
--   election_day_set_voted(uuid, boolean, text)
--   election_day_set_non_voting_reason(uuid, uuid, text)
--
-- All 5 read `coordinator` directly from election_day_voters (a column made
-- nullable by 20260811100000_election_day_coordinator_nullable.sql) into a
-- local variable, then insert that value into
-- election_day_reminder_events.coordinator, which is `text not null`
-- (20260810120000_election_day_reminder_lifecycle.sql). Before this phase, a
-- voter always had a non-null coordinator, so this was never reachable; this
-- phase's import parser can now legitimately produce a coordinator-less
-- voter, making it a real, reachable NOT NULL violation the first time any
-- of these 5 actions is taken on such a voter.
--
-- Every other reference to election_day_voters.coordinator across the whole
-- migration history was checked and confirmed NOT a sink:
--   - election_day_ride_status_events.coordinator (also `text not null`,
--     same denormalization pattern) is written exclusively from client-side
--     JS (SupabaseElectionDayApi.setRideArranged), never from a SQL
--     function - it inserts `updated.coordinator`, which already flows
--     through toVoter()'s coordinator ?? "" coercion (see the Phase 2
--     TypeScript changes) before it ever reaches this insert. Not a SQL-level
--     sink; already safe.
--   - election_day_ride_coordinators is the unrelated fixed driver roster
--     (RideCoordinator), textually similar but a completely different
--     entity - no read of election_day_voters.coordinator anywhere near it.
--   - No other table, RPC, view, or trigger in this schema reads or writes
--     election_day_voters.coordinator.
--
-- Fix, applied identically to all 5: the single `select ... coordinator ...
-- into ... v_coordinator ...` line becomes
-- `select ... coalesce(coordinator, ''), ...` - the local snapshot variable
-- is now '' instead of null for a coordinator-less voter, exactly matching
-- this app's own pre-existing read-side sentinel for "no coordinator"
-- (already established in nonVotingReasonReport.ts's domain-level
-- convention, and now mirrored at the DB snapshot level for consistency).
-- election_day_reminder_events.coordinator is deliberately left `text not
-- null` (not made nullable) - coalescing at the read site is sufficient and
-- avoids a schema/event-model change that isn't needed here.
--
-- Nothing else changes in any of the 5 functions: identical signature,
-- identical SECURITY mode (4 of the 5 are SECURITY INVOKER, matching
-- 20260810120000; election_day_set_non_voting_reason is SECURITY DEFINER,
-- matching its later correction in
-- 20260810130000_election_day_set_non_voting_reason_security_definer_fix.sql -
-- preserved exactly, not reverted to INVOKER here), identical
-- `set search_path = ''`, identical for-update row-locking
-- atomicity/idempotency, identical business conditions (v_close logic,
-- requires_follow_up handling, etc.), identical return contract (setof
-- election_day_voters), identical grants.
begin;

-- ============================================================================
-- election_day_set_reminder - unchanged except coordinator read is now
-- null-safe.
-- ============================================================================
create or replace function public.election_day_set_reminder(p_id uuid, p_reminder_at timestamptz, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_reminder_at timestamptz;
  v_contact_name text;
  v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  if v_old_reminder_at is not null and v_old_reminder_at = p_reminder_at then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = p_reminder_at,
      reminder_closed_at = null,
      reminder_closed_reason = null,
      reminder_closed_by = null,
      updated_at = now()
  where id = p_id;

  if v_old_reminder_at is not null then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'rescheduled', v_old_reminder_at, null, p_actor_name);
  end if;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'created', p_reminder_at, null, p_actor_name);

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_set_reminder(uuid, timestamptz, text) is
  'Reminder Lifecycle: creates a new reminder, or reschedules an existing open one (logs a rescheduled event for the outgoing value, then a created event for the new value) - never silently overwrites. Idempotent: a repeat call with the identical timestamp is a no-op, no phantom event pair. Coordinator Allocation Management Phase 2: the coordinator snapshot read is now null-safe (coalesce(coordinator, '')) so a coordinator-less voter never hits election_day_reminder_events.coordinator''s NOT NULL constraint.';

revoke all on function public.election_day_set_reminder(uuid, timestamptz, text) from public;
grant execute on function public.election_day_set_reminder(uuid, timestamptz, text) to anon, authenticated;

-- ============================================================================
-- election_day_close_reminder - unchanged except coordinator read is now
-- null-safe.
-- ============================================================================
create or replace function public.election_day_close_reminder(p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_reminder_at timestamptz;
  v_contact_name text;
  v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  if v_old_reminder_at is null then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = null,
      reminder_closed_at = now(),
      reminder_closed_reason = 'handled',
      reminder_closed_by = p_actor_name,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'handled', p_actor_name);

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_close_reminder(uuid, text) is
  'Reminder Lifecycle: explicit "mark handled" - closes an open reminder with reason=handled. No-op (idempotent) if no reminder is currently open; the for-update row lock makes concurrent double-clicks/double-devices race-safe with no double event. Coordinator Allocation Management Phase 2: the coordinator snapshot read is now null-safe (coalesce(coordinator, '')) so a coordinator-less voter never hits election_day_reminder_events.coordinator''s NOT NULL constraint.';

revoke all on function public.election_day_close_reminder(uuid, text) from public;
grant execute on function public.election_day_close_reminder(uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_cancel_reminder - unchanged except coordinator read is now
-- null-safe.
-- ============================================================================
create or replace function public.election_day_cancel_reminder(p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_reminder_at timestamptz;
  v_contact_name text;
  v_coordinator text;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  if v_old_reminder_at is null then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set reminder_at = null,
      reminder_closed_at = now(),
      reminder_closed_reason = 'cancelled',
      reminder_closed_by = p_actor_name,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'cancelled', v_old_reminder_at, null, p_actor_name);

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_cancel_reminder(uuid, text) is
  'Reminder Lifecycle: cancels an open reminder with reason=cancelled (event reason column left null - only closed events carry a reason). No-op (idempotent) if no reminder is currently open; same for-update race-safety as election_day_close_reminder. Coordinator Allocation Management Phase 2: the coordinator snapshot read is now null-safe (coalesce(coordinator, '')) so a coordinator-less voter never hits election_day_reminder_events.coordinator''s NOT NULL constraint.';

revoke all on function public.election_day_cancel_reminder(uuid, text) from public;
grant execute on function public.election_day_cancel_reminder(uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_set_voted - unchanged except coordinator read is now
-- null-safe.
-- ============================================================================
create or replace function public.election_day_set_voted(p_id uuid, p_voted boolean, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_reminder_at timestamptz;
  v_contact_name text;
  v_coordinator text;
  v_close boolean;
begin
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  v_close := p_voted and v_old_reminder_at is not null;

  update public.election_day_voters
  set voted = p_voted,
      voted_at = case when p_voted then now() else null end,
      reminder_at = case when v_close then null else reminder_at end,
      reminder_closed_at = case when v_close then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close then 'voted' else reminder_closed_reason end,
      reminder_closed_by = case when v_close then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id;

  if v_close then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'closed', v_old_reminder_at, 'voted', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_set_voted(uuid, boolean, text) is
  'Reminder Lifecycle: sets voted/voted_at (replaces the old plain PATCH). Marking voted=true with an open reminder closes it with reason=voted. Marking voted=false never touches reminder state - closing a reminder is one-directional. Coordinator Allocation Management Phase 2: the coordinator snapshot read is now null-safe (coalesce(coordinator, '')) so a coordinator-less voter never hits election_day_reminder_events.coordinator''s NOT NULL constraint.';

revoke all on function public.election_day_set_voted(uuid, boolean, text) from public;
grant execute on function public.election_day_set_voted(uuid, boolean, text) to anon, authenticated;

-- ============================================================================
-- election_day_set_non_voting_reason - unchanged except coordinator read is
-- now null-safe. SECURITY DEFINER preserved exactly as corrected by
-- 20260810130000_election_day_set_non_voting_reason_security_definer_fix.sql
-- (NOT reverted to invoker here) - this function's internal read of
-- election_day_not_voting_reasons (RLS-enabled, zero client policies)
-- requires definer rights to actually resolve requires_follow_up.
-- ============================================================================
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
  select reminder_at, first_name || ' ' || last_name, coalesce(coordinator, '')
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
  'Reminder Lifecycle: sets not_voting_reason_id/set_at/set_by (replaces the old plain PATCH). Closes an open reminder with reason=case_closed only when the reason resolves and requires_follow_up=false. security definer (fixed from invoker in 20260810130000) so its internal read of the locked-down election_day_not_voting_reasons table can actually resolve. An unresolvable reason id still defaults to requires_follow_up=true (do not close). Coordinator Allocation Management Phase 2: the coordinator snapshot read is now null-safe (coalesce(coordinator, '')) so a coordinator-less voter never hits election_day_reminder_events.coordinator''s NOT NULL constraint.';

revoke all on function public.election_day_set_non_voting_reason(uuid, uuid, text) from public;
grant execute on function public.election_day_set_non_voting_reason(uuid, uuid, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - restores the pre-this-migration bodies, i.e. a bare
-- `coordinator` read with no coalesce; only safe to roll back while every
-- election_day_voters row still has a non-null coordinator, otherwise this
-- re-opens the exact NOT NULL violation this migration closes):
--
--   begin;
--   -- election_day_set_reminder: restore bare `coordinator` read (see
--   -- 20260810120000_election_day_reminder_lifecycle.sql for the full body).
--   -- election_day_close_reminder: same, restore bare `coordinator` read.
--   -- election_day_cancel_reminder: same, restore bare `coordinator` read.
--   -- election_day_set_voted: same, restore bare `coordinator` read.
--   -- election_day_set_non_voting_reason: restore bare `coordinator` read,
--   -- keep security definer (see
--   -- 20260810130000_election_day_set_non_voting_reason_security_definer_fix.sql
--   -- for the full body - do NOT revert this one to security invoker).
--   commit;
-- ============================================================================
