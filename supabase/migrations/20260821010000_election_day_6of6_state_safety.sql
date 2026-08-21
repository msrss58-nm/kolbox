-- Final 6/6 State-Safety Fix (local checkpoint, not yet applied to Production).
--
-- Two independent gaps found while verifying the 6/6 "close as לא עונה" flow:
--
-- 1. election_day_record_no_answer already refuses to increment the streak
--    once no_answer_streak >= no_answer_streak_threshold (the hard cap), but
--    its no-op early-return left pending_call_id untouched - a dial made
--    after the cap was already reached (a real, reachable path: reopening a
--    6/6-but-not-yet-closed voter and dialing again) stamped a fresh
--    pending_call_id that a capped "no_answer" click could never clear,
--    stranding it and leaving the outcome buttons stuck showing.
--
-- 2. None of the three call-outcome RPCs (increment_call_attempts,
--    record_no_answer, record_call_answered) checked whether the voter's
--    case was already closed (a non-voting reason with requires_follow_up =
--    false). A dial - or worse, an "answered" outcome, which has no cap
--    guard at all - against an already-closed voter would silently reopen
--    it (dial stamps a fresh pending_call_id; answered unconditionally
--    resets no_answer_streak to 0/3) with no explicit reopen action ever
--    having been taken.
--
-- Fix: all three RPCs now resolve the same "is this case closed" condition
-- election_day_voters.not_voting_reason_id joined against
-- election_day_not_voting_reasons.requires_follow_up (the exact same
-- predicate the client's resolveFollowUpStatus() already uses for its
-- "closed" branch - no new/duplicate state introduced) and refuse to act if
-- so. increment_call_attempts additionally never being called successfully
-- means no fresh pending_call_id can ever be stamped on a closed voter,
-- which combined with the two outcome RPCs' own defense-in-depth closed
-- check makes "answered/no_answer can never reopen a closed case" true by
-- construction, not just by relying on the UI never offering the button.

create or replace function public.election_day_increment_call_attempts(p_id uuid)
returns setof public.election_day_voters
language plpgsql
set search_path to ''
as $function$
declare
  v_reason_id uuid;
  v_closed boolean;
begin
  select not_voting_reason_id into v_reason_id
  from public.election_day_voters
  where id = p_id
  for update;

  v_closed := v_reason_id is not null and exists (
    select 1 from public.election_day_not_voting_reasons r
    where r.id = v_reason_id and r.requires_follow_up = false
  );

  -- Already-closed case: no new dial - a fresh pending_call_id must never
  -- be stampable on a closed voter (see migration header).
  if v_closed then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set call_attempts = call_attempts + 1,
      last_call_attempt_at = now(),
      pending_call_id = gen_random_uuid(),
      updated_at = now()
  where id = p_id;

  return query select * from public.election_day_voters where id = p_id;
end;
$function$;

create or replace function public.election_day_record_no_answer(p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
set search_path to ''
as $function$
declare
  v_contact_name text;
  v_coordinator text;
  v_pending uuid;
  v_streak integer;
  v_threshold integer;
  v_reminder_at timestamptz;
  v_reason_id uuid;
  v_closed boolean;
  v_close_reminder boolean;
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, no_answer_streak, no_answer_streak_threshold, reminder_at, not_voting_reason_id
    into v_contact_name, v_coordinator, v_pending, v_streak, v_threshold, v_reminder_at, v_reason_id
  from public.election_day_voters
  where id = p_id
  for update;

  v_closed := v_reason_id is not null and exists (
    select 1 from public.election_day_not_voting_reasons r
    where r.id = v_reason_id and r.requires_follow_up = false
  );

  -- Already-closed case: defense-in-depth alongside the dial-blocking guard
  -- above - never let a no-answer implicitly reopen a closed case, and
  -- clear any pending_call_id that could somehow still be sitting there.
  if v_closed then
    update public.election_day_voters
    set pending_call_id = null,
        updated_at = now()
    where id = p_id and pending_call_id is not null;

    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  if v_pending is null or v_pending <> p_call_id then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  -- Hard cap already reached: this no-answer is real (the call_id matches
  -- the live pending call) but must not increment past the cap - only
  -- clear the now-resolved pending_call_id so it never lingers (the actual
  -- 6/6 state-safety fix - previously this branch left pending_call_id
  -- untouched).
  if v_streak >= v_threshold then
    update public.election_day_voters
    set pending_call_id = null,
        updated_at = now()
    where id = p_id;

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
$function$;

create or replace function public.election_day_record_call_answered(p_id uuid, p_call_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
set search_path to ''
as $function$
declare
  v_contact_name text;
  v_coordinator text;
  v_pending uuid;
  v_reminder_at timestamptz;
  v_reason_id uuid;
  v_closed boolean;
  v_close_reminder boolean;
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, reminder_at, not_voting_reason_id
    into v_contact_name, v_coordinator, v_pending, v_reminder_at, v_reason_id
  from public.election_day_voters
  where id = p_id
  for update;

  v_closed := v_reason_id is not null and exists (
    select 1 from public.election_day_not_voting_reasons r
    where r.id = v_reason_id and r.requires_follow_up = false
  );

  -- Already-closed case: an "answered" outcome must never implicitly
  -- reopen it (this RPC previously had no cap/closed guard at all) - clear
  -- any stray pending_call_id defensively, same as record_no_answer above.
  if v_closed then
    update public.election_day_voters
    set pending_call_id = null,
        updated_at = now()
    where id = p_id and pending_call_id is not null;

    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

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
$function$;
