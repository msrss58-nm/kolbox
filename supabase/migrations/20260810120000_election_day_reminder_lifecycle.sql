-- Reminder Lifecycle v1 - today, election_day_voters.reminder_at is a single
-- nullable timestamp with no history: no record of who set it, when it was
-- closed, why, or what it was rescheduled from. This migration replaces that
-- with a real lifecycle. FUTURE/DUE are purely time-derived from reminder_at
-- (never stored - a reminder simply becomes "due" the moment its timestamp
-- passes, no polling job flips a flag) and stay entirely a frontend concern.
-- CLOSED/CANCELLED are real business events with audit: 3 new columns on
-- election_day_voters record the terminal state of the most recent reminder,
-- and a new election_day_reminder_events table records full history (every
-- create/close/cancel/reschedule), mirroring how election_day_ride_status_events
-- already audits ride-arranged changes.
--
-- RLS/security posture: kept explicitly consistent with the app's existing
-- architecture, not tightened or loosened for this feature ("RLS: עקבי עם
-- architecture הקיימת... אל תחמיר או תשנה את מודל האבטחה הכללי" - stay
-- consistent with the existing architecture, don't tighten or loosen the
-- general security model). election_day_reminder_events gets the same
-- permissive `USING (true)` policy as election_day_ride_status_events -
-- NOT the locked-down RLS-enabled-zero-policy pattern used by
-- election_day_permission_users/election_day_roles, since this table (like
-- ride_status_events) has no sensitive credential material in it, just
-- reminder history denormalized with contact name/coordinator for the same
-- "survives contact deletion or a fresh re-import" reason. No Realtime is
-- added for this table - it's a history/audit log, not a live-watched
-- surface, matching the already-approved plan.
--
-- All 5 new RPCs below use `security invoker` (not definer) for the same
-- reason as election_day_import_voters/election_day_increment_call_attempts:
-- election_day_voters' RLS is already permissive for anon+authenticated, so
-- no elevated privilege is needed - these functions just do atomically, in
-- one round trip, what the client was already allowed to do piecemeal.
begin;

-- ============================================================================
-- election_day_voters: 3 new columns recording the terminal state of the
-- most recently closed/cancelled reminder.
--
-- Purely additive, nullable, no default needed. Every one of the live
-- table's ~1928 existing rows has an unambiguously correct value for these
-- 3 columns: null. reminder_closed_at never existed before this migration,
-- so null isn't a fabricated backfill guess - it's the only truthful value
-- ("this reminder has never been closed by this new mechanism, because this
-- mechanism didn't exist until now"). Also note: this migration does NOT
-- touch the existing reminder_at column's value on any row. A reminder_at
-- that's currently in the future stays a valid FUTURE reminder after this
-- migration; a reminder_at that's currently in the past simply becomes a
-- valid DUE reminder for the first time, instead of being silently treated
-- as stale. Auto-clearing a past-due reminder client-side (if wanted at all)
-- is a separate, already-approved frontend change, not part of this
-- migration.
-- ============================================================================
alter table public.election_day_voters
  add column reminder_closed_at timestamptz,
  add column reminder_closed_reason text,
  add column reminder_closed_by text;

comment on column public.election_day_voters.reminder_closed_at is
  'When the most recent reminder was closed or cancelled. Null while a reminder is open (FUTURE/DUE, derived client-side from reminder_at) or if no reminder has ever been closed on this contact.';
comment on column public.election_day_voters.reminder_closed_reason is
  'Why the most recent reminder was closed. One of handled/voted/case_closed/cancelled - see the check constraint below. Null alongside reminder_closed_at.';
comment on column public.election_day_voters.reminder_closed_by is
  'Denormalized actor name (PermissionUser.name) who closed/cancelled the most recent reminder - same denormalization pattern as not_voting_reason_set_by, survives roster changes.';

alter table public.election_day_voters
  add constraint election_day_voters_reminder_closed_reason_check
  check (reminder_closed_reason is null or reminder_closed_reason in ('handled', 'voted', 'case_closed', 'cancelled'));

-- ============================================================================
-- election_day_reminder_events - full audit history of every reminder
-- create/close/cancel/reschedule, same shape/style as
-- election_day_ride_status_events: denormalizes contact_name/coordinator so
-- history survives contact deletion or a fresh ride-list re-import.
-- ============================================================================
create table public.election_day_reminder_events (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid references public.election_day_voters(id) on delete cascade,
  contact_name text not null,
  coordinator  text not null,
  event_type   text not null check (event_type in ('created', 'closed', 'cancelled', 'rescheduled')),
  reminder_at  timestamptz,
  reason       text check (reason is null or reason in ('handled', 'voted', 'case_closed')),
  actor_name   text,
  created_at   timestamptz not null default now()
);

comment on table public.election_day_reminder_events is
  'Audit log of every reminder lifecycle transition (created/closed/cancelled/rescheduled) on election_day_voters. Denormalizes contact name/coordinator so history survives contact deletion or a fresh ride-list re-import - same pattern as election_day_ride_status_events. reason is only ever populated for event_type = closed (handled/voted/case_closed); cancelled events always carry reason = null, which the check constraint permits.';

create index election_day_reminder_events_contact_id_idx
  on public.election_day_reminder_events (contact_id);
create index election_day_reminder_events_created_at_idx
  on public.election_day_reminder_events (created_at desc);

alter table public.election_day_reminder_events enable row level security;
create policy election_day_reminder_events_all on public.election_day_reminder_events
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ============================================================================
-- election_day_set_reminder - creates a NEW reminder, or reschedules an
-- existing OPEN one (reminder_at not null) without silently overwriting it.
-- Always logs the outgoing value as a 'rescheduled' event before logging the
-- new value as a 'created' event, so a reschedule chain is fully
-- reconstructable from election_day_reminder_events alone.
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
  select reminder_at, first_name || ' ' || last_name, coordinator
    into v_old_reminder_at, v_contact_name, v_coordinator
  from public.election_day_voters
  where id = p_id
  for update;

  -- Idempotency guard: a repeat call with the identical timestamp (a
  -- double-tap on the same ReminderMenu option, or a client retry after a
  -- request that actually succeeded) is a true no-op - the reminder didn't
  -- change - so it must not log a phantom rescheduled+created event pair.
  -- Only a genuine change in the scheduled time (or creating one where none
  -- existed) is a real event.
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
  'Reminder Lifecycle: creates a new reminder, or reschedules an existing open one (logs a rescheduled event for the outgoing value, then a created event for the new value) - never silently overwrites. Idempotent: a repeat call with the identical timestamp is a no-op, no phantom event pair.';

revoke all on function public.election_day_set_reminder(uuid, timestamptz, text) from public;
grant execute on function public.election_day_set_reminder(uuid, timestamptz, text) to anon, authenticated;

-- ============================================================================
-- election_day_close_reminder - explicit "mark handled".
--
-- The `select ... for update` row lock is what makes this idempotent/
-- race-safe: if two callers race to close the same reminder, the second
-- blocks on the row lock until the first commits, then re-reads
-- v_old_reminder_at as already null (the first call already cleared it) and
-- takes the no-op branch below - no double 'closed' event, no double-close.
-- Same reasoning as election_day_increment_call_attempts' atomicity, applied
-- to a lock-then-branch shape instead of a pure read-modify-write.
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  'Reminder Lifecycle: explicit "mark handled" - closes an open reminder with reason=handled. No-op (idempotent) if no reminder is currently open; the for-update row lock makes concurrent double-clicks/double-devices race-safe with no double event.';

revoke all on function public.election_day_close_reminder(uuid, text) from public;
grant execute on function public.election_day_close_reminder(uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_cancel_reminder - identical shape to election_day_close_reminder,
-- but reason=cancelled and event_type=cancelled. Same for-update idempotency
-- reasoning applies.
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  'Reminder Lifecycle: cancels an open reminder with reason=cancelled (event reason column left null - only closed events carry a reason). No-op (idempotent) if no reminder is currently open; same for-update race-safety as election_day_close_reminder.';

revoke all on function public.election_day_cancel_reminder(uuid, text) from public;
grant execute on function public.election_day_cancel_reminder(uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_set_voted - replaces today's plain PATCH of voted/voted_at.
-- Only CLOSES an open reminder (reason=voted) when marking p_voted = true
-- AND a reminder is currently open. Marking p_voted = false (un-voting) does
-- NOT touch reminder state at all - closing is one-directional by product
-- decision, un-voting never reopens or otherwise mutates a closed reminder.
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
  select reminder_at, first_name || ' ' || last_name, coordinator
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
  'Reminder Lifecycle: sets voted/voted_at (replaces the old plain PATCH). Marking voted=true with an open reminder closes it with reason=voted. Marking voted=false never touches reminder state - closing a reminder is one-directional.';

revoke all on function public.election_day_set_voted(uuid, boolean, text) from public;
grant execute on function public.election_day_set_voted(uuid, boolean, text) to anon, authenticated;

-- ============================================================================
-- election_day_set_non_voting_reason - replaces today's plain PATCH of
-- not_voting_reason_id/set_at/set_by. Looks up requires_follow_up for the
-- given reason and only closes an open reminder (reason=case_closed) when
-- requires_follow_up = false. Clearing the reason (p_reason_id null) or
-- picking a reason that still requires follow-up leaves reminder state
-- completely untouched.
--
-- coalesce(v_requires_follow_up, true): if p_reason_id doesn't resolve to
-- any row (a deleted/invalid id somehow passed in), default to true (still
-- requires follow-up / do NOT close) - never silently close a reminder
-- based on a reason this function can't actually verify. Matches this
-- codebase's existing resolveFollowUpStatus philosophy of never silently
-- closing a case it can't verify is closed.
-- ============================================================================
create or replace function public.election_day_set_non_voting_reason(p_id uuid, p_reason_id uuid, p_actor_name text)
returns setof public.election_day_voters
language plpgsql
security invoker
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
  'Reminder Lifecycle: sets not_voting_reason_id/set_at/set_by (replaces the old plain PATCH). Closes an open reminder with reason=case_closed only when the reason resolves and requires_follow_up=false. An unresolvable reason id defaults to requires_follow_up=true (do not close) - never silently closes a case it cannot verify is closed.';

revoke all on function public.election_day_set_non_voting_reason(uuid, uuid, text) from public;
grant execute on function public.election_day_set_non_voting_reason(uuid, uuid, text) to anon, authenticated;

-- ============================================================================
-- voter.viewReminderHistory - product decision approved after a live truth
-- check against election_day_list_roles(): grant 1:1 to the same 2 roles
-- that already hold voter.viewReminderStatus today (מנהל / משתמש), no more,
-- no less. Matched by id (not name) since these are the exact live
-- production role ids confirmed immediately before this migration was
-- authored - name-matching would also work but is less precise against a
-- role an admin could rename via the Role Management screen. This follows
-- the dynamic-roles model exactly: permissions are data on election_day_roles
-- rows, not a seed-file concept - no change to builtInRoleSeed.ts, no change
-- to the permission catalog's shape, only 2 existing rows' `permissions`
-- array gain one string each. Idempotent: the `not (... = any(permissions))`
-- guard means re-running this migration a second time is a no-op, never a
-- duplicate array entry.
-- ============================================================================
update public.election_day_roles
set permissions = array_append(permissions, 'voter.viewReminderHistory')
where id in (
  '6dd2601d-99da-43b4-b4e7-97ad6d007fa8', -- מנהל
  '188e233b-7801-4db6-827b-ed68fee04047'  -- משתמש
)
and not ('voter.viewReminderHistory' = any(permissions));

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
-- Rolling back after any writes have gone through the 5 RPCs above would
-- lose reminder-closure history (the 3 election_day_voters columns and the
-- whole election_day_reminder_events table are dropped) - but would NOT
-- affect election_day_voters' other columns or row count at all; reminder_at
-- itself is untouched by this rollback, same as it was untouched by the
-- migration going forward.
--
--   begin;
--   update public.election_day_roles
--   set permissions = array_remove(permissions, 'voter.viewReminderHistory')
--   where id in ('6dd2601d-99da-43b4-b4e7-97ad6d007fa8', '188e233b-7801-4db6-827b-ed68fee04047');
--   drop function if exists public.election_day_set_non_voting_reason(uuid, uuid, text);
--   drop function if exists public.election_day_set_voted(uuid, boolean, text);
--   drop function if exists public.election_day_cancel_reminder(uuid, text);
--   drop function if exists public.election_day_close_reminder(uuid, text);
--   drop function if exists public.election_day_set_reminder(uuid, timestamptz, text);
--   drop policy if exists election_day_reminder_events_all on public.election_day_reminder_events;
--   drop table if exists public.election_day_reminder_events;
--   alter table public.election_day_voters
--     drop constraint if exists election_day_voters_reminder_closed_reason_check;
--   alter table public.election_day_voters
--     drop column if exists reminder_closed_by,
--     drop column if exists reminder_closed_reason,
--     drop column if exists reminder_closed_at;
--   commit;
-- ============================================================================
