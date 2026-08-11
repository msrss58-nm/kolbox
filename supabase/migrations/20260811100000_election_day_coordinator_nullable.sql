-- Coordinator Allocation Management - Phase 1 (DB foundation), step 1/5.
-- Product decision (approved, architecture locked): a future import may
-- create voters with no coordinator at all - assignment happens afterwards
-- via Initial Allocation, not at import time. election_day_voters.coordinator
-- was `not null` since the original core-tables migration; this relaxes it
-- to nullable so a future schema can actually hold an unassigned voter.
--
-- Deliberately NOT touched by this migration (out of Phase 1 scope, per the
-- approved plan): the import parser/RPC still writes a non-null string for
-- every row exactly as today - no behavior change yet, only the column
-- constraint. election_day_import_voters passes `x.coordinator` through with
-- no `coalesce` already, so once a future import phase legitimately sends
-- null, no RPC change will be needed then either.

alter table public.election_day_voters
  alter column coordinator drop not null;

comment on column public.election_day_voters.coordinator is
  'Free-text coordinator name, as typed in the imported Excel file or left blank. Nullable since Coordinator Allocation Management Phase 1 (2026-08-11) - a voter may be imported with no coordinator and later assigned via Initial Allocation. No FK to election_day_coordinators by design (see election_day_coordinators.linked_assignment_name) - stays a plain string, matched to a coordinator entity only via explicit manual linkage, never automatically.';

-- ============================================================================
-- ROLLBACK (manual - only safe if no row currently has coordinator = null):
--
--   alter table public.election_day_voters alter column coordinator set not null;
-- ============================================================================
