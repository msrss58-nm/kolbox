-- Call Attempts Counter - product decision: clicking a voter's phone number
-- (the call button in ElectionDayContactModal) is itself the "dial attempt"
-- event - no separate "mark as dialed" button, no confirmation. Every 3rd
-- attempt since the last checkpoint (3, 6, 9, ... - tracked via a separate
-- threshold column, not derived, since the threshold can also be advanced
-- explicitly without a new click - see below) opens a client-side decision
-- dialog: close the voter as "לא עונה" (no answer), or keep trying (+3).
--
-- Two columns, both integer counters that only ever increase, never reset:
--   call_attempts            - raw click count on the call button.
--   call_attempts_threshold  - the next multiple at which the app should
--                               open the decision dialog. Starts at 3.
--                               Choosing "continue" advances it by 3
--                               immediately (independent of any new click),
--                               e.g. 3/3 -> "continue" -> 3/6 right away,
--                               before a 4th click ever happens.
--
-- Both are updated via a dedicated atomic RPC (not a plain REST .update())
-- because a plain PATCH can't express "current value + 1" without a
-- read-modify-write round trip from the client, which would lose updates
-- under rapid double-clicks or two devices touching the same contact at
-- once - the same reasoning as election_day_import_voters' atomicity.
-- `security invoker` (not definer) because election_day_voters' RLS is
-- already permissive (USING (true) for anon+authenticated) - same posture
-- as every other voter-row mutation (setVoted/setPhone/setNotes), see
-- supabaseElectionDayApi.ts's updateVoter comment.
begin;

alter table public.election_day_voters
  add column call_attempts integer not null default 0,
  add column call_attempts_threshold integer not null default 3;

comment on column public.election_day_voters.call_attempts is
  'Raw count of clicks on the call button. Monotonic - never reset, including after the voter is later closed/marked voted.';
comment on column public.election_day_voters.call_attempts_threshold is
  'Next call_attempts value at which the app opens the "no answer" decision dialog. Starts at 3; advances by 3 each time the user chooses "keep trying" from that dialog - independent of any new click, so the UI can immediately show e.g. 3/6 before a 4th attempt happens.';

-- ============================================================================
-- election_day_increment_call_attempts - fired on every call-button click.
-- ============================================================================
create or replace function public.election_day_increment_call_attempts(p_id uuid)
returns setof public.election_day_voters
language sql
security invoker
set search_path = ''
as $$
  update public.election_day_voters
  set call_attempts = call_attempts + 1,
      updated_at = now()
  where id = p_id
  returning *;
$$;

comment on function public.election_day_increment_call_attempts(uuid) is
  'Call Attempts Counter: atomically increments call_attempts by 1. Fired on every call-button click.';

revoke all on function public.election_day_increment_call_attempts(uuid) from public;
grant execute on function public.election_day_increment_call_attempts(uuid) to anon, authenticated;

-- ============================================================================
-- election_day_extend_call_attempts_threshold - fired when the user chooses
-- "keep trying (+3)" from the decision dialog.
-- ============================================================================
create or replace function public.election_day_extend_call_attempts_threshold(p_id uuid)
returns setof public.election_day_voters
language sql
security invoker
set search_path = ''
as $$
  update public.election_day_voters
  set call_attempts_threshold = call_attempts_threshold + 3,
      updated_at = now()
  where id = p_id
  returning *;
$$;

comment on function public.election_day_extend_call_attempts_threshold(uuid) is
  'Call Attempts Counter: atomically advances call_attempts_threshold by 3. Fired when the user chooses "keep trying" from the no-answer decision dialog.';

revoke all on function public.election_day_extend_call_attempts_threshold(uuid) from public;
grant execute on function public.election_day_extend_call_attempts_threshold(uuid) to anon, authenticated;

-- ============================================================================
-- Product-decision correction (approved explicitly for this migration, not
-- silently changed): the earlier Dynamic Non-Voting Reasons feature backfilled
-- "לא עונה" (no answer) as requires_follow_up = true (still needs a call).
-- The Call Attempts Counter feature's decision dialog explicitly requires
-- that closing a voter as "לא עונה" moves them to "נסגרו" (closed) and off
-- "נותרו לטיפול" (remaining) - i.e. requires_follow_up = false. Since the
-- column is a single source of truth with no separate "closed via dialog"
-- vs "closed via the manual dropdown" distinction, this also changes the
-- outcome of manually picking "לא עונה" from the existing reason dropdown -
-- a deliberate, approved side effect, not an oversight.
-- ============================================================================
update public.election_day_not_voting_reasons
set requires_follow_up = false
where name = 'לא עונה';

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   update public.election_day_not_voting_reasons set requires_follow_up = true where name = 'לא עונה';
--   drop function if exists public.election_day_extend_call_attempts_threshold(uuid);
--   drop function if exists public.election_day_increment_call_attempts(uuid);
--   alter table public.election_day_voters
--     drop column if exists call_attempts_threshold,
--     drop column if exists call_attempts;
--   commit;
-- ============================================================================
