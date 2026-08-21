-- Call Outcome Tracking - replaces the old "every dial is an unanswered
-- attempt" assumption (20260806190000/20260811090000) with an explicit,
-- server-verified outcome per call: the dial itself proves nothing; only a
-- deliberate "לא ענה"/"ענה" action after it does.
--
-- call_attempts / last_call_attempt_at (existing columns) keep their exact
-- existing meaning: total raw dial-button clicks, all-time, never reset -
-- election_day_increment_call_attempts still fires on every dial. The old
-- `call_attempts < call_attempts_threshold` quota guard on that RPC is
-- removed here: dialing is no longer capped by anything, since the
-- checkpoint concept moves entirely to the new no_answer_streak below.
-- call_attempts_threshold itself is left in place, untouched, simply unused
-- going forward - dropping it isn't necessary and a bare unused column is
-- lower-risk than a DROP COLUMN.
--
-- Three new columns:
--   no_answer_streak            - consecutive CONFIRMED no-answers since the
--                                  last reset. Only election_day_record_no_answer
--                                  increments this; election_day_record_call_answered
--                                  resets it to 0. Never touched by a plain
--                                  dial.
--   no_answer_streak_threshold  - next checkpoint value. Starts at 3, may
--                                  advance to 6 exactly once
--                                  (election_day_extend_no_answer_streak_threshold),
--                                  never past 6. Resets to 3 alongside the
--                                  streak on an answered call.
--   pending_call_id             - set to a fresh random uuid by
--                                  election_day_increment_call_attempts on
--                                  every dial; cleared back to null by
--                                  whichever outcome RPC successfully
--                                  resolves it. Serves two purposes at once:
--                                  (1) the client only enables the "לא ענה"/
--                                  "ענה" outcome buttons while this is
--                                  non-null - an outcome can never be
--                                  recorded without a real dial having
--                                  happened first; (2) it's the idempotency
--                                  key for the outcome RPCs below - a caller
--                                  must present the exact token the last
--                                  dial produced, so a retried/duplicated
--                                  outcome request (whose token no longer
--                                  matches, because the first successful
--                                  call already cleared it, or a newer dial
--                                  already overwrote it) is a safe, silent
--                                  no-op rather than a double count/double
--                                  log.
--
-- All new/replaced RPCs stay `security invoker` - same posture as every
-- other Election Day mutation (election_day_voters' RLS is already
-- permissive for anon+authenticated).
begin;

alter table public.election_day_voters
  add column no_answer_streak integer not null default 0,
  add column no_answer_streak_threshold integer not null default 3,
  add column pending_call_id uuid;

comment on column public.election_day_voters.no_answer_streak is
  'Consecutive CONFIRMED no-answer outcomes since the last reset. Incremented only by election_day_record_no_answer; reset to 0 by election_day_record_call_answered. Never touched by a plain dial (election_day_increment_call_attempts) - dialing alone proves nothing about the outcome.';
comment on column public.election_day_voters.no_answer_streak_threshold is
  'Next no_answer_streak checkpoint. Starts at 3; election_day_extend_no_answer_streak_threshold may advance it to 6 exactly once (never past 6); resets to 3 alongside no_answer_streak on an answered call.';
comment on column public.election_day_voters.pending_call_id is
  'Set to a fresh random uuid by election_day_increment_call_attempts on every dial; cleared by whichever outcome RPC (election_day_record_no_answer/election_day_record_call_answered) successfully resolves it, or silently overwritten by the next dial if the previous one was never resolved. Non-null gates the UI outcome buttons (no dial = nothing to report) and doubles as the idempotency key those RPCs match against.';

-- ============================================================================
-- election_day_reminder_events.event_type - widened to also carry call
-- outcome events. reminder_at/reason stay null for all 3 new types (already
-- an established pattern in this table - e.g. cancelled events always carry
-- reason = null too); no other column changes needed, this table's existing
-- shape (contact_id/contact_name/coordinator/actor_name/created_at) already
-- fits a call-outcome log exactly.
-- ============================================================================
alter table public.election_day_reminder_events
  drop constraint election_day_reminder_events_event_type_check;

alter table public.election_day_reminder_events
  add constraint election_day_reminder_events_event_type_check
  check (event_type in (
    'created', 'closed', 'cancelled', 'rescheduled',
    'no_answer', 'answered', 'streak_extended'
  ));

comment on table public.election_day_reminder_events is
  'Audit log of every reminder lifecycle transition (created/closed/cancelled/rescheduled) AND every call-outcome transition (no_answer/answered/streak_extended) on election_day_voters. Denormalizes contact name/coordinator so history survives contact deletion or a fresh ride-list re-import - same pattern as election_day_ride_status_events. reason is only ever populated for event_type = closed (handled/voted/case_closed); every other event_type (including the 3 call-outcome ones) always carries reason = null, which the check constraint permits.';

-- ============================================================================
-- election_day_increment_call_attempts - now unconditional (no more quota
-- guard tied to the retired call_attempts_threshold checkpoint concept) and
-- stamps a fresh pending_call_id on every dial, in the same atomic UPDATE.
-- ============================================================================
create or replace function public.election_day_increment_call_attempts(p_id uuid)
returns setof public.election_day_voters
language sql
security invoker
set search_path = ''
as $$
  update public.election_day_voters
  set call_attempts = call_attempts + 1,
      last_call_attempt_at = now(),
      pending_call_id = gen_random_uuid(),
      updated_at = now()
  where id = p_id
  returning *;
$$;

comment on function public.election_day_increment_call_attempts(uuid) is
  'Call Outcome Tracking: atomically increments call_attempts (total, uncapped, unconditional) and stamps last_call_attempt_at + a fresh pending_call_id. Fired on every call-button click. Never touches no_answer_streak - a dial alone proves nothing about the outcome.';

revoke all on function public.election_day_increment_call_attempts(uuid) from public;
grant execute on function public.election_day_increment_call_attempts(uuid) to anon, authenticated;

-- ============================================================================
-- election_day_record_no_answer - fired when the coordinator explicitly
-- confirms a dialed call went unanswered. Rejects (no-op, no error) unless
-- p_call_id matches the contact's current pending_call_id: this is both the
-- "must follow a real dial" guard and the idempotency guard (a retried
-- request, or one whose token was superseded by a newer dial, matches
-- nothing and safely no-ops). Also no-ops if the streak already reached its
-- threshold (awaiting a manager's close/extend decision) rather than
-- silently overshooting it.
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
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id, no_answer_streak, no_answer_streak_threshold
    into v_contact_name, v_coordinator, v_pending, v_streak, v_threshold
  from public.election_day_voters
  where id = p_id
  for update;

  if v_pending is null or v_pending <> p_call_id or v_streak >= v_threshold then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set no_answer_streak = no_answer_streak + 1,
      pending_call_id = null,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'no_answer', p_actor_name);

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_record_no_answer(uuid, uuid, text) is
  'Call Outcome Tracking: confirms the most recent dial went unanswered - increments no_answer_streak and logs a no_answer event, atomically. No-op (idempotent, no error) unless p_call_id matches the row''s current pending_call_id (must follow a real, not-yet-resolved dial) and the streak has not already reached its threshold.';

revoke all on function public.election_day_record_no_answer(uuid, uuid, text) from public;
grant execute on function public.election_day_record_no_answer(uuid, uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_record_call_answered - fired when the coordinator explicitly
-- confirms the voter answered (regardless of what they said - "call me
-- later", "I'm voting", "I need a ride", or anything else). Unconditionally
-- resets the streak to 0/3 - works identically no matter which attempt
-- number the answer happened on. Does NOT touch reminder_at at all; if a
-- callback is needed the coordinator uses the existing, untouched
-- election_day_set_reminder RPC afterward, same as any other reminder.
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
begin
  select first_name || ' ' || last_name, coordinator, pending_call_id
    into v_contact_name, v_coordinator, v_pending
  from public.election_day_voters
  where id = p_id
  for update;

  if v_pending is null or v_pending <> p_call_id then
    return query select * from public.election_day_voters where id = p_id;
    return;
  end if;

  update public.election_day_voters
  set no_answer_streak = 0,
      no_answer_streak_threshold = 3,
      pending_call_id = null,
      updated_at = now()
  where id = p_id;

  insert into public.election_day_reminder_events
    (contact_id, contact_name, coordinator, event_type, actor_name)
  values (p_id, v_contact_name, v_coordinator, 'answered', p_actor_name);

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_record_call_answered(uuid, uuid, text) is
  'Call Outcome Tracking: confirms the most recent dial was answered - unconditionally resets no_answer_streak/no_answer_streak_threshold to 0/3 and logs an answered event, atomically. No-op (idempotent, no error) unless p_call_id matches the row''s current pending_call_id. Never touches reminder_at - a callback reminder, if needed, is set separately via the existing election_day_set_reminder RPC.';

revoke all on function public.election_day_record_call_answered(uuid, uuid, text) from public;
grant execute on function public.election_day_record_call_answered(uuid, uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_extend_no_answer_streak_threshold - the "המשך ניסיונות (+3)"
-- choice from the checkpoint dialog. Not tied to pending_call_id (it's a
-- decision made from the dialog, not a per-dial outcome) - guarded instead
-- on the streak actually having reached exactly the FIRST checkpoint
-- (no_answer_streak = no_answer_streak_threshold = 3), so it can only ever
-- fire once: a second attempt after the threshold is already 6 no longer
-- matches and safely no-ops, same non-error "unchanged" contract as every
-- other guarded RPC in this system.
-- ============================================================================
create or replace function public.election_day_extend_no_answer_streak_threshold(p_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contact_name text;
  v_coordinator text;
begin
  select first_name || ' ' || last_name, coordinator into v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  update public.election_day_voters
  set no_answer_streak_threshold = no_answer_streak_threshold + 3,
      updated_at = now()
  where id = p_id
    and no_answer_streak = no_answer_streak_threshold
    and no_answer_streak_threshold = 3;

  if found then
    insert into public.election_day_reminder_events
      (contact_id, contact_name, coordinator, event_type, actor_name)
    values (p_id, v_contact_name, v_coordinator, 'streak_extended', p_actor_name);
  end if;

  return query select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_extend_no_answer_streak_threshold(uuid, text) is
  'Call Outcome Tracking: the "keep trying (+3)" choice from the no-answer checkpoint dialog - advances no_answer_streak_threshold from 3 to 6 exactly once (guarded on no_answer_streak = no_answer_streak_threshold = 3) and logs a streak_extended event. A second/late call after the threshold already advanced no longer matches and safely no-ops (no error, no double extend, no event).';

revoke all on function public.election_day_extend_no_answer_streak_threshold(uuid, text) from public;
grant execute on function public.election_day_extend_no_answer_streak_threshold(uuid, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_extend_no_answer_streak_threshold(uuid, text);
--   drop function if exists public.election_day_record_call_answered(uuid, uuid, text);
--   drop function if exists public.election_day_record_no_answer(uuid, uuid, text);
--
--   create or replace function public.election_day_increment_call_attempts(p_id uuid)
--   returns setof public.election_day_voters
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $$
--   begin
--     return query
--       update public.election_day_voters
--       set call_attempts = call_attempts + 1,
--           last_call_attempt_at = now(),
--           updated_at = now()
--       where id = p_id
--         and call_attempts < call_attempts_threshold
--       returning *;
--     if found then
--       return;
--     end if;
--     return query select * from public.election_day_voters where id = p_id;
--   end;
--   $$;
--   revoke all on function public.election_day_increment_call_attempts(uuid) from public;
--   grant execute on function public.election_day_increment_call_attempts(uuid) to anon, authenticated;
--
--   alter table public.election_day_reminder_events
--     drop constraint if exists election_day_reminder_events_event_type_check;
--   alter table public.election_day_reminder_events
--     add constraint election_day_reminder_events_event_type_check
--     check (event_type in ('created', 'closed', 'cancelled', 'rescheduled'));
--
--   alter table public.election_day_voters
--     drop column if exists pending_call_id,
--     drop column if exists no_answer_streak_threshold,
--     drop column if exists no_answer_streak;
--   commit;
--
-- Note: rolling back after any election_day_record_no_answer/
-- election_day_record_call_answered/election_day_extend_no_answer_streak_threshold
-- calls have run loses the no_answer/answered/streak_extended rows in
-- election_day_reminder_events (dropped alongside the widened constraint's
-- reversion) - existing created/closed/cancelled/rescheduled rows are
-- unaffected either way.
-- ============================================================================
