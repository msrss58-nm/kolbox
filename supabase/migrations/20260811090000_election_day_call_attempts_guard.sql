-- Call Attempts Counter - quota guard + last-attempt timestamp. Three
-- additive changes to the existing Call Attempts Counter feature
-- (20260806190000_election_day_call_attempts.sql). No new column beyond
-- last_call_attempt_at, no new RPC, no model change - the quota stays
-- open-ended (3/6/9/12...), never a hardcoded ceiling.
--
-- 1. last_call_attempt_at (nullable timestamptz) - a dedicated, reliable
--    "last call attempt" timestamp. The existing updated_at column is NOT
--    usable for this: it's also written by setVoted/setPhone/setNotes/the
--    reminder-lifecycle RPCs/setNonVotingReason/extend below, so it
--    conflates "last call attempt" with "last edit of any kind." This
--    column is written ONLY by election_day_increment_call_attempts, in the
--    same atomic UPDATE that bumps call_attempts - no new round trip, no
--    separate write, and NEVER touched by extend_call_attempts_threshold or
--    any other RPC. No backfill: every existing row has no reliable
--    historical attempt time to backfill from, so all existing rows read
--    NULL until their next real call attempt (UI shows "-" for NULL, per
--    product decision).
--
-- 2. election_day_increment_call_attempts - server-side quota guard. Until
--    now this RPC always incremented unconditionally; nothing stopped
--    call_attempts from exceeding call_attempts_threshold before a manager
--    chose "keep trying" (+3) from CallAttemptsDialog - a UI-only guard
--    (fire-and-forget click handler, no busy/disable state) was the only
--    thing standing in the way, and a race/double-click/second device could
--    still push e.g. 3/3 to 4/3. The RPC's UPDATE...WHERE now includes
--    `call_attempts < call_attempts_threshold` as an atomic, authoritative
--    guard. When the quota is already exhausted, the RPC does NOT raise -
--    it falls through to a plain SELECT of the voter's current (unchanged)
--    row. This is a deliberate, non-error "already at the threshold"
--    response: since the row returned still has call_attempts ===
--    call_attempts_threshold, the EXISTING client-side check in
--    ElectionDayContactModal.tsx (`updated.callAttempts ===
--    updated.callAttemptsThreshold` -> open CallAttemptsDialog) fires
--    identically whether this click was the one that reached the threshold
--    or a stray click after it - no new client branching needed, and no raw
--    error toast for what is really an expected state, not a failure.
--
-- 3. election_day_extend_call_attempts_threshold - server-side quota guard,
--    same shape and same non-error "unchanged" contract as increment above,
--    added for the exact same double-click/concurrent-request reason.
--    Product rule: extending by +3 is only valid when the current quota has
--    actually been reached (call_attempts = call_attempts_threshold) - not
--    a client-trusted state. The RPC's UPDATE...WHERE now includes
--    `call_attempts = call_attempts_threshold`; a second/concurrent extend
--    request after the threshold has already advanced (e.g. 3/6, quota not
--    yet re-reached) no longer matches and falls through to the same
--    unchanged-row SELECT, never raising and never silently applying a
--    second +3.
--
-- Concurrency safety (both RPCs, single UPDATE...WHERE, no new locking
-- needed): under Postgres's default READ COMMITTED isolation, an UPDATE
-- that finds its target row locked by a concurrent, not-yet-committed
-- UPDATE blocks until that transaction commits, THEN RE-EVALUATES its own
-- WHERE clause against the just-committed row version (not its original
-- snapshot) - this is documented Postgres behavior (Read Committed
-- Isolation Level: "the search condition is re-evaluated to see if the
-- updated version of the row still matches"). Concretely, for extend at
-- 3/3 with two concurrent requests A and B: A acquires the row lock, sets
-- threshold 3->6, commits. B was blocked on the same row; once unblocked it
-- re-checks `call_attempts = call_attempts_threshold` against the NOW-
-- committed row (3 = 6 -> false) and does not match, so B affects zero rows
-- and falls through to the unchanged-row SELECT. Final state is
-- deterministically 3/6, never 3/9. The identical reasoning applies to two
-- concurrent increments at 2/3 (both can't both succeed in a way that
-- exceeds the threshold) and was already true of the original 20260806190000
-- migration's plain atomic increment - this migration only adds a second
-- guard condition to the same already-safe pattern, not a new locking
-- mechanism.
begin;

alter table public.election_day_voters
  add column last_call_attempt_at timestamptz;

comment on column public.election_day_voters.last_call_attempt_at is
  'Server-side timestamp of the most recent call-button click, written only by election_day_increment_call_attempts in the same atomic UPDATE as the call_attempts increment. NULL for any voter with no attempt since this column was added (no backfill - there is no reliable historical attempt time to backfill from) or who has never had a call attempt at all. Never written by any other RPC (including election_day_extend_call_attempts_threshold) - unlike updated_at, this is never conflated with an unrelated edit (notes/reason/voted/extend/etc).';

create or replace function public.election_day_increment_call_attempts(p_id uuid)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
    update public.election_day_voters
    set call_attempts = call_attempts + 1,
        last_call_attempt_at = now(),
        updated_at = now()
    where id = p_id
      and call_attempts < call_attempts_threshold
    returning *;

  if found then
    return;
  end if;

  -- Either p_id doesn't exist (returns no rows, same as before this
  -- migration) or the quota is already exhausted awaiting a manager
  -- decision - return the row UNCHANGED rather than raising, see the header
  -- comment above.
  return query
    select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_increment_call_attempts(uuid) is
  'Call Attempts Counter: atomically increments call_attempts by 1 and stamps last_call_attempt_at = now(), but ONLY if call_attempts < call_attempts_threshold (server-side quota guard, race-free via row locking + WHERE re-evaluation on the UPDATE...WHERE) - fired on every call-button click. If the quota is already reached, returns the current row unchanged (no error) so the existing client-side "callAttempts === callAttemptsThreshold" check still opens CallAttemptsDialog. Grants/security posture unchanged from the original 20260806190000 migration.';

revoke all on function public.election_day_increment_call_attempts(uuid) from public;
grant execute on function public.election_day_increment_call_attempts(uuid) to anon, authenticated;

create or replace function public.election_day_extend_call_attempts_threshold(p_id uuid)
returns setof public.election_day_voters
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
    update public.election_day_voters
    set call_attempts_threshold = call_attempts_threshold + 3,
        updated_at = now()
    where id = p_id
      and call_attempts = call_attempts_threshold
    returning *;

  if found then
    return;
  end if;

  -- Either p_id doesn't exist, or the quota was already extended by a
  -- concurrent/duplicate request (call_attempts no longer equals the
  -- (now-stale) threshold this caller thinks it's extending from) - return
  -- the row UNCHANGED rather than raising or silently double-extending, see
  -- the header comment above. last_call_attempt_at is never touched here.
  return query
    select * from public.election_day_voters where id = p_id;
end;
$$;

comment on function public.election_day_extend_call_attempts_threshold(uuid) is
  'Call Attempts Counter: atomically advances call_attempts_threshold by 3, but ONLY if call_attempts = call_attempts_threshold (server-side guard - the quota must actually be reached, never trusted from client state) - fired when the user chooses "keep trying" from the no-answer decision dialog. Race-free the same way as election_day_increment_call_attempts: a second/concurrent extend request re-evaluates this condition against the just-committed row and is a no-op (returns the row unchanged, no error) once the threshold has already advanced - so two concurrent "keep trying" clicks at 3/3 can never produce 3/9. Never writes last_call_attempt_at. Grants/security posture unchanged from the original 20260806190000 migration.';

revoke all on function public.election_day_extend_call_attempts_threshold(uuid) from public;
grant execute on function public.election_day_extend_call_attempts_threshold(uuid) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   create or replace function public.election_day_increment_call_attempts(p_id uuid)
--   returns setof public.election_day_voters
--   language sql
--   security invoker
--   set search_path = ''
--   as $$
--     update public.election_day_voters
--     set call_attempts = call_attempts + 1,
--         updated_at = now()
--     where id = p_id
--     returning *;
--   $$;
--   revoke all on function public.election_day_increment_call_attempts(uuid) from public;
--   grant execute on function public.election_day_increment_call_attempts(uuid) to anon, authenticated;
--
--   create or replace function public.election_day_extend_call_attempts_threshold(p_id uuid)
--   returns setof public.election_day_voters
--   language sql
--   security invoker
--   set search_path = ''
--   as $$
--     update public.election_day_voters
--     set call_attempts_threshold = call_attempts_threshold + 3,
--         updated_at = now()
--     where id = p_id
--     returning *;
--   $$;
--   revoke all on function public.election_day_extend_call_attempts_threshold(uuid) from public;
--   grant execute on function public.election_day_extend_call_attempts_threshold(uuid) to anon, authenticated;
--
--   alter table public.election_day_voters drop column if exists last_call_attempt_at;
--   commit;
-- ============================================================================
