-- Dynamic Non-Voting Reasons - Phase 0 (cont'd): the additive columns on
-- election_day_voters. `voted`/`voted_at` and the mark-voted RPC/permission
-- path are completely untouched by this migration - the reason is purely
-- additive metadata on the existing row.
--
-- not_voting_reason_id is nullable/optional and, by product decision, is
-- NEVER cleared when a voter is later marked voted - it just stops being
-- shown for editing in the UI while voted = true (client-side condition
-- only). This preserves the value for future history/reports (e.g. "said
-- wouldn't come, but voted anyway"), so `on delete restrict` (not cascade,
-- not set null) is the correct FK action: a reason still referenced by any
-- voter - voted or not - can never be silently deleted out from under that
-- history.
--
-- not_voting_reason_set_by is a denormalized PermissionUser name (same
-- pattern as election_day_ride_status_events.contact_name/coordinator) -
-- not a FK, since PermissionUser has no real auth identity backing it and
-- roster churn (a user later deleted from the roster) should never orphan
-- this historical field.
begin;

alter table public.election_day_voters
  add column not_voting_reason_id uuid
    references public.election_day_not_voting_reasons(id) on delete restrict,
  add column not_voting_reason_set_at timestamptz,
  add column not_voting_reason_set_by text;

comment on column public.election_day_voters.not_voting_reason_id is
  'FK to election_day_not_voting_reasons - only ever an ID, never free text. Nullable/optional. Not auto-cleared when voted flips to true (product decision) - kept for history/reports, just not shown for editing in the UI while voted = true.';
comment on column public.election_day_voters.not_voting_reason_set_at is
  'When not_voting_reason_id was last set/changed - report-readiness for a future "by date" breakdown.';
comment on column public.election_day_voters.not_voting_reason_set_by is
  'Denormalized PermissionUser name at the time the reason was set (not a FK - see election_day_ride_status_events.coordinator for the same pattern) - report-readiness for a future "by updating user" breakdown.';

create index election_day_voters_not_voting_reason_idx
  on public.election_day_voters (not_voting_reason_id);

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop index if exists public.election_day_voters_not_voting_reason_idx;
--   alter table public.election_day_voters
--     drop column if exists not_voting_reason_set_by,
--     drop column if exists not_voting_reason_set_at,
--     drop column if exists not_voting_reason_id;
--   commit;
-- ============================================================================
