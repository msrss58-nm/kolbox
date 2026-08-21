-- Due-Reminder Auto-Close - when a DUE reminder led to a real, validated
-- dial (election_day_record_no_answer/election_day_record_call_answered's
-- own p_call_id === pending_call_id check already proves this) and the
-- coordinator records that call's outcome, the reminder it followed closes
-- automatically, atomically, in the same RPC call/transaction that records
-- the outcome - no separate round trip, no window where the counter update
-- succeeds but the reminder is left dangling.
--
-- Deliberately narrow scope: only a DUE reminder (reminder_at <= now()) is
-- closed this way. A FUTURE reminder is left completely untouched even if
-- the coordinator makes an ad-hoc call and records an outcome before it's
-- due - broadening auto-close to future reminders was explicitly called out
-- as out of scope for this change.
--
-- Two new closure reasons - 'no_answer' and 'answered' - deliberately reuse
-- the exact same literal names as the call-outcome event_type this feature
-- already introduced (20260820010000), so "why was this reminder closed" and
-- "what was the call outcome" are trivially the same word, not a new
-- vocabulary. Neither is 'handled' - that reason is retired from new writes
-- (its UI trigger was already removed) and reusing it here would blur "a
-- coordinator manually waved this off" with "an actual call outcome closed
-- it", which is exactly the distinction this feature exists to make.
--
-- Audit shape: each RPC call still logs its own no_answer/answered
-- call-outcome event exactly as before (reminder_at/reason left null on that
-- row, unchanged). When the due-reminder closure ALSO applies, a SEPARATE
-- 'closed' event is logged alongside it (reminder_at = the closed reminder's
-- old time, reason = 'no_answer'/'answered') - the same two-events-per-
-- closure shape election_day_set_voted/election_day_set_non_voting_reason
-- already use for their own side-effect closures, so a contact's history
-- reads consistently regardless of which path closed a given reminder.
begin;

alter table public.election_day_voters
  drop constraint election_day_voters_reminder_closed_reason_check;

alter table public.election_day_voters
  add constraint election_day_voters_reminder_closed_reason_check
  check (reminder_closed_reason is null or reminder_closed_reason in (
    'handled', 'voted', 'case_closed', 'cancelled', 'no_answer', 'answered'
  ));

alter table public.election_day_reminder_events
  drop constraint election_day_reminder_events_reason_check;

alter table public.election_day_reminder_events
  add constraint election_day_reminder_events_reason_check
  check (reason is null or reason in (
    'handled', 'voted', 'case_closed', 'no_answer', 'answered'
  ));

comment on column public.election_day_voters.reminder_closed_reason is
  'Why the most recent reminder was closed. One of handled/voted/case_closed/cancelled/no_answer/answered - see the check constraint below. no_answer/answered mean a DUE reminder was auto-closed because a real call outcome was recorded for it (Due-Reminder Auto-Close) - distinct from handled, which is a legacy manual close no longer offered in the UI. Null alongside reminder_closed_at.';

-- ============================================================================
-- election_day_record_no_answer - now also closes a DUE reminder, atomically.
-- ============================================================================
create or replace function public.election_day_record_no_answer(p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_name text;
  v_coordinator text;
  v_pending uuid;
  v_streak integer;
  v_threshold integer;
  v_reminder_at timestamptz;
  v_close_reminder boolean;
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, no_answer_streak, no_answer_streak_threshold, reminder_at
    into v_contact_name, v_coordinator, v_pending, v_streak, v_threshold, v_reminder_at
  from public.election_day_voters
  where id = p_id
  for update;

  if v_pending is null or v_pending <> p_call_id or v_streak >= v_threshold then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  -- Due-Reminder Auto-Close: only a currently DUE reminder closes here - a
  -- future one is left untouched (see the migration header comment).
  v_close_reminder := v_reminder_at is not null and v_reminder_at <= now();

  update public.election_day_voters
  set no_answer_streak = no_answer_streak + 1,
      pending_call_id = null,
      reminder_at = case when v_close_reminder then null else reminder_at end,
      reminder_closed_at = case when v_close_reminder then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close_reminder then 'no_answer' else reminder_closed_reason end,
      reminder_closed_by = case when v_close_reminder then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'no_answer', p_actor_name);

  if v_close_reminder then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'closed', v_reminder_at, 'no_answer', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_record_no_answer(uuid, uuid, text) is
  'Call Outcome Tracking + Due-Reminder Auto-Close: confirms the most recent dial went unanswered - increments no_answer_streak, and if a DUE reminder was active, closes it (reason=no_answer) in the same transaction. Logs a no_answer call-outcome event always, plus a separate closed event when the reminder closure applies. No-op unless p_call_id matches pending_call_id and the streak has not already reached its threshold.';

-- ============================================================================
-- election_day_record_call_answered - now also closes a DUE reminder,
-- atomically. Never touches a FUTURE reminder (unchanged scope decision).
-- ============================================================================
create or replace function public.election_day_record_call_answered(p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_name text;
  v_coordinator text;
  v_pending uuid;
  v_reminder_at timestamptz;
  v_close_reminder boolean;
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, reminder_at
    into v_contact_name, v_coordinator, v_pending, v_reminder_at
  from public.election_day_voters
  where id = p_id
  for update;

  if v_pending is null or v_pending <> p_call_id then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  v_close_reminder := v_reminder_at is not null and v_reminder_at <= now();

  update public.election_day_voters
  set no_answer_streak = 0,
      no_answer_streak_threshold = 3,
      pending_call_id = null,
      reminder_at = case when v_close_reminder then null else reminder_at end,
      reminder_closed_at = case when v_close_reminder then now() else reminder_closed_at end,
      reminder_closed_reason = case when v_close_reminder then 'answered' else reminder_closed_reason end,
      reminder_closed_by = case when v_close_reminder then p_actor_name else reminder_closed_by end,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'answered', p_actor_name);

  if v_close_reminder then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, reminder_at, reason, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'closed', v_reminder_at, 'answered', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_record_call_answered(uuid, uuid, text) is
  'Call Outcome Tracking + Due-Reminder Auto-Close: confirms the most recent dial was answered - unconditionally resets no_answer_streak/no_answer_streak_threshold to 0/3, and if a DUE reminder was active, closes it (reason=answered) in the same transaction. A callback reminder, if needed, is set separately afterward via election_day_set_reminder - this RPC never creates one itself. No-op unless p_call_id matches pending_call_id.';

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   create or replace function public.election_day_record_no_answer(p_id uuid, p_call_id uuid, p_actor_name text)
--   returns setof public.election_day_voters
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     v_contact_name text;
--     v_coordinator text;
--     v_pending uuid;
--     v_streak integer;
--     v_threshold integer;
--   begin
--     select first_name || ' ' || last_name, coordinator, pending_call_id, no_answer_streak, no_answer_streak_threshold
--       into v_contact_name, v_coordinator, v_pending, v_streak, v_threshold
--     from public.election_day_voters where id = p_id for update;
--     if v_pending is null or v_pending <> p_call_id or v_streak >= v_threshold then
--       return query select * from public.election_day_voters where id = p_id;
--       return;
--     end if;
--     update public.election_day_voters
--     set no_answer_streak = no_answer_streak + 1, pending_call_id = null, updated_at = now()
--     where id = p_id;
--     insert into public.election_day_reminder_events (contact_id, contact_name, coordinator, event_type, actor_name)
--     values (p_id, v_contact_name, v_coordinator, 'no_answer', p_actor_name);
--     return query select * from public.election_day_voters where id = p_id;
--   end;
--   $$;
--
--   create or replace function public.election_day_record_call_answered(p_id uuid, p_call_id uuid, p_actor_name text)
--   returns setof public.election_day_voters
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   declare
--     v_contact_name text;
--     v_coordinator text;
--     v_pending uuid;
--   begin
--     select first_name || ' ' || last_name, coordinator, pending_call_id
--       into v_contact_name, v_coordinator, v_pending
--     from public.election_day_voters where id = p_id for update;
--     if v_pending is null or v_pending <> p_call_id then
--       return query select * from public.election_day_voters where id = p_id;
--       return;
--     end if;
--     update public.election_day_voters
--     set no_answer_streak = 0, no_answer_streak_threshold = 3, pending_call_id = null, updated_at = now()
--     where id = p_id;
--     insert into public.election_day_reminder_events (contact_id, contact_name, coordinator, event_type, actor_name)
--     values (p_id, v_contact_name, v_coordinator, 'answered', p_actor_name);
--     return query select * from public.election_day_voters where id = p_id;
--   end;
--   $$;
--
--   alter table public.election_day_reminder_events
--     drop constraint if exists election_day_reminder_events_reason_check;
--   alter table public.election_day_reminder_events
--     add constraint election_day_reminder_events_reason_check
--     check (reason is null or reason in ('handled', 'voted', 'case_closed'));
--
--   alter table public.election_day_voters
--     drop constraint if exists election_day_voters_reminder_closed_reason_check;
--   alter table public.election_day_voters
--     add constraint election_day_voters_reminder_closed_reason_check
--     check (reminder_closed_reason is null or reminder_closed_reason in ('handled', 'voted', 'case_closed', 'cancelled'));
--   commit;
--
-- Note: rolling back after any no_answer/answered-triggered reminder closure
-- has occurred does NOT retroactively reopen those reminders or delete their
-- history - it only stops the mechanism from firing going forward.
-- ============================================================================
