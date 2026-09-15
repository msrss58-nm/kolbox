-- Budget Stage 5 (A/2) - party funding workflow: schema additions to the
-- Stage 3 party tables.
--
-- The party process stays keyed by the PARTY ALLOCATION of an expense (Stage
-- 3): prior approval (budget_party_preapprovals), the submission row
-- (budget_party_submissions), its append-only event log
-- (budget_party_submission_events) and the payment reference
-- (budget_party_payment_references). The party pays the supplier directly:
-- party payments are rows of the Stage 3 supplier ledger with payer 'party'
-- (never campaign cash, never a reimbursement).
--
-- What Stage 5 adds here:
--   * submission state 'ready' ("מוכן להגשה") between document collection and
--     'sent', and a 'ready' event;
--   * every 'sent' / 'returned' event is an ATTEMPT (attempt_no), and a 'sent'
--     event keeps what was sent: the order-form version, the requested amount
--     and the document package (the requirement items and the versions that
--     satisfied them). Events stay append-only, so earlier attempts are never
--     overwritten;
--   * an optional client idempotency key per transition event (a retried or
--     double-clicked transition returns the first result);
--   * a free-text note on the prior approval and on the payment reference.
--
-- Same protections as Stage 3: RLS on / zero policies / no table privileges,
-- composite (workspace_id, x) foreign keys, the actor-context audit trigger
-- (already on all four tables - the new columns are audited with the row).
--
-- MANUAL ROLLBACK (only with zero Stage 5 rows; revert migration B first):
--   begin;
--   alter table public.budget_party_submission_events
--     drop constraint budget_party_submission_events_attempt_check,
--     drop constraint budget_party_submission_events_order_form_fkey,
--     drop column attempt_no, drop column order_form_version_id,
--     drop column requested_amount_agorot, drop column package, drop column idempotency_key;
--   drop index if exists public.budget_party_submission_events_idempotency_key;
--   alter table public.budget_party_submission_events drop constraint budget_party_submission_events_event_check,
--     add constraint budget_party_submission_events_event_check check (event in ('sent', 'returned'));
--   alter table public.budget_party_submissions drop constraint budget_party_submissions_state_check,
--     add constraint budget_party_submissions_state_check check (state in ('not_sent', 'sent', 'returned')),
--     drop column ready_at;
--   alter table public.budget_party_preapprovals drop column note;
--   alter table public.budget_party_payment_references drop column note;
--   commit;

begin;

-- Submission: the 'ready' state.
alter table public.budget_party_submissions
  drop constraint budget_party_submissions_state_check,
  add constraint budget_party_submissions_state_check
    check (state in ('not_sent', 'ready', 'sent', 'returned')),
  add column ready_at timestamptz;

-- Submission events: 'ready' + attempts + what was sent + idempotency.
alter table public.budget_party_submission_events
  drop constraint budget_party_submission_events_event_check,
  add constraint budget_party_submission_events_event_check
    check (event in ('ready', 'sent', 'returned')),
  add column attempt_no integer check (attempt_no is null or attempt_no between 1 and 10000),
  add column order_form_version_id uuid,
  add column requested_amount_agorot bigint
    check (requested_amount_agorot is null or requested_amount_agorot between 1 and 1000000000000),
  add column package jsonb check (package is null or jsonb_typeof(package) = 'object'),
  add column idempotency_key uuid,
  add constraint budget_party_submission_events_order_form_fkey foreign key (workspace_id, order_form_version_id)
    references public.budget_order_form_versions (workspace_id, id) on delete restrict;

-- Every 'sent' / 'returned' event names its attempt; a 'sent' event records
-- the requested amount and the package. NOT VALID only so a local database
-- that already holds Stage 3 test events can take the migration; every new
-- row is checked (no Budget table exists in Production yet).
alter table public.budget_party_submission_events
  add constraint budget_party_submission_events_attempt_check check (
    event = 'ready'
    or (attempt_no is not null
        and (event <> 'sent' or (requested_amount_agorot is not null and package is not null)))) not valid;

create unique index budget_party_submission_events_idempotency_key
  on public.budget_party_submission_events (workspace_id, idempotency_key)
  where idempotency_key is not null;

-- Notes on the two party approvals (prior approval / payment reference).
alter table public.budget_party_preapprovals
  add column note text check (note is null or length(note) <= 1000);
alter table public.budget_party_payment_references
  add column note text check (note is null or length(note) <= 1000);

commit;
