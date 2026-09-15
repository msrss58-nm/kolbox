-- Budget Stage 5 (B/2) - party funding workflow: the calculation layer, the
-- gated party operations and the extended expense view.
--
-- THE PARTY PROCESS (per party allocation of an expense; stable internal
-- values, Hebrew labels in the UI):
--   awaiting_preapproval  ממתין לאישור תקציבי מוקדם   no prior budget approval yet
--   preapproved           אושר תקציבית מראש           approval recorded, nothing collected yet
--   collecting_documents  איסוף מסמכים                 final order form generated or documents added
--   ready                 מוכן להגשה                   the user marked it ready; every gate passed
--   sent                  נשלח                          the user confirmed sending (attempt N)
--   returned              הוחזר לתיקון                  the funder returned attempt N for correction
--   reference_received    התקבלה אסמכתת תשלום          the later payment reference/authorization
-- The state is DERIVED from stored facts by ONE function
-- (budget_party_workflow_state); the party PAYMENT status (unpaid / partial /
-- paid, against the party allocation) is a separate axis - never one enum.
--
-- GATES (server-side; the UI only mirrors them): marking ready and sending
-- both require the prior approval, an expense past draft, a party allocation
-- within the pre-approved amount, and the Stage 4 requirement engine's
-- verdict (required documents, final order form, supplier signature, the
-- latest form not outdated). Sending also requires the 'ready' state and
-- re-checks every gate live. The payment reference needs a sent submission;
-- party payments need the payment reference and never exceed the allocation.
--
-- The party pays the supplier directly: a party payment is a supplier-ledger
-- row with payer 'party'. Nothing here models party money reaching campaign
-- cash or a reimbursement.
--
-- MANUAL ROLLBACK: re-run the Stage 3 (20260917020000) definitions of
-- budget_expense_json, budget_op_set_allocation, budget_op_record_preapproval,
-- budget_op_mark_submission_sent, budget_op_mark_submission_returned and
-- budget_op_record_payment_reference, the Stage 4 (20260918010000)
-- budget_op_order_form_mark_sent and budget_op_permissions, then drop the new
-- functions (budget_party_workflow_state, budget_party_facts,
-- budget_party_submission_blockers, budget_funding_summary_json,
-- budget_party_workflow_json, budget_op_mark_submission_ready) and revert
-- migration A.

begin;

-- ===========================================================================
-- THE CALCULATION LAYER (party). Nothing derived is persisted.
-- ===========================================================================

-- The one derivation of the party process state.
create or replace function public.budget_party_workflow_state(
  p_has_reference boolean, p_has_preapproval boolean, p_state text, p_collecting boolean)
returns text language sql immutable set search_path = '' as $fn$
  select case
    when p_has_reference then 'reference_received'
    when not p_has_preapproval then 'awaiting_preapproval'
    when p_state = 'sent' then 'sent'
    when p_state = 'returned' then 'returned'
    when p_state = 'ready' then 'ready'
    when p_collecting then 'collecting_documents'
    else 'preapproved' end;
$fn$;

-- One row per PARTY allocation of the workspace. Built on Stage 3's
-- budget_allocation_facts (paid = valid party payments only). Stage 6
-- dashboards/reports read this function; they must not re-derive it.
create or replace function public.budget_party_facts(p_ws uuid)
returns table (
  allocation_id uuid,
  expense_id uuid,
  funding_source_id uuid,
  source_name text,
  amount bigint,
  paid bigint,
  remaining bigint,
  payment_status text,
  has_preapproval boolean,
  preapproved_amount bigint,
  exceeds_preapproval boolean,
  submission_state text,
  workflow_state text,
  attempts integer,
  requested_amount bigint,
  has_reference boolean,
  authorized_amount bigint,
  ready_at timestamptz,
  last_sent_at timestamptz,
  last_returned_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select f.allocation_id, f.expense_id, f.funding_source_id, s.name, f.amount, f.paid,
    (f.amount - f.paid)::bigint,
    case when f.paid = 0 then 'unpaid' when f.paid >= f.amount then 'paid' else 'partial' end,
    f.has_preapproval,
    f.preapproved_amount,
    coalesce(f.preapproved_amount is not null and f.amount > f.preapproved_amount, false),
    coalesce(f.submission_state, 'not_sent'),
    public.budget_party_workflow_state(f.has_reference, f.has_preapproval, coalesce(f.submission_state, 'not_sent'),
      exists (select 1 from public.budget_order_form_versions o
              where o.workspace_id = p_ws and o.expense_id = f.expense_id)
      or exists (select 1 from public.budget_documents d
                 where d.workspace_id = p_ws and d.expense_id = f.expense_id and d.status = 'active')),
    (select count(*) from public.budget_party_submission_events ev
     where ev.workspace_id = p_ws and ev.allocation_id = f.allocation_id and ev.event = 'sent')::integer,
    sub.requested_amount_agorot,
    f.has_reference,
    f.authorized_amount,
    sub.ready_at,
    sub.last_sent_at,
    sub.last_returned_at
  from public.budget_allocation_facts(p_ws) f
  join public.budget_funding_sources s on s.workspace_id = p_ws and s.id = f.funding_source_id
  left join public.budget_party_submissions sub on sub.workspace_id = p_ws and sub.allocation_id = f.allocation_id
  where f.kind = 'party';
$fn$;

-- Why this party allocation cannot be marked ready / sent RIGHT NOW (empty =
-- it can). Live evaluation; the documents part is the Stage 4 requirement
-- engine's verdict, never a second rule implementation.
create or replace function public.budget_party_submission_blockers(p_ws uuid, p_allocation uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $fn$
declare
  f record;
  e public.budget_expenses;
  v_missing jsonb;
  v_latest jsonb;
  v_out text[] := '{}';
begin
  select * into f from public.budget_party_facts(p_ws) x where x.allocation_id = p_allocation;
  if not found then
    raise exception 'NOT_A_PARTY_ALLOCATION';
  end if;
  select * into e from public.budget_expenses x where x.workspace_id = p_ws and x.id = f.expense_id;

  if not f.has_preapproval then
    v_out := array_append(v_out, 'PREAPPROVAL_REQUIRED');
  end if;
  if e.status = 'draft' then
    v_out := array_append(v_out, 'EXPENSE_NOT_SUBMITTABLE');
  elsif e.status not in ('committed', 'incurred') then
    v_out := array_append(v_out, 'EXPENSE_LOCKED');
  end if;
  if f.exceeds_preapproval then
    v_out := array_append(v_out, 'PARTY_EXCEEDS_PREAPPROVAL');
  end if;

  v_missing := public.budget_document_requirements_live(p_ws, e.id) -> 'missing';
  if v_missing ? 'order_form' then
    v_out := array_append(v_out, 'ORDER_FORM_MISSING');
  end if;
  if v_missing ? 'order_form_signed' then
    v_out := array_append(v_out, 'SUPPLIER_SIGNATURE_MISSING');
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_missing) m where m not in ('order_form', 'order_form_signed')) then
    v_out := array_append(v_out, 'REQUIRED_DOCUMENTS_MISSING');
  end if;

  -- The latest generated form must still show the current data (an amount,
  -- supplier, prior-approval or rule change since then means version N+1).
  select o.snapshot into v_latest
  from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.expense_id = e.id
  order by o.version_no desc limit 1;
  if v_latest is not null and v_latest is distinct from public.budget_order_form_snapshot(p_ws, e.id) then
    v_out := array_append(v_out, 'ORDER_FORM_OUTDATED');
  end if;
  return v_out;
end;
$fn$;

-- The expense's funding picture. Every figure comes from the Stage 3 facts;
-- the uncovered balance is budget_expense_facts.unfunded - never filled.
create or replace function public.budget_funding_summary_json(p_ws uuid, p_expense_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  with f as (select * from public.budget_allocation_facts(p_ws) x where x.expense_id = p_expense_id),
  ef as (select * from public.budget_expense_facts(p_ws) x where x.expense_id = p_expense_id)
  select jsonb_build_object(
    'total', (select ef.total from ef),
    'allocated', coalesce((select sum(f.amount) from f), 0),
    'party', coalesce((select sum(f.amount) from f where f.kind = 'party'), 0),
    'donation', coalesce((select sum(f.amount) from f where f.kind = 'donation'), 0),
    'personal', coalesce((select sum(f.amount) from f where f.kind = 'personal'), 0),
    'partyPreapproved', (select sum(f.preapproved_amount) from f where f.kind = 'party' and f.preapproved_amount is not null),
    'partyAuthorized', (select sum(f.authorized_amount) from f where f.kind = 'party' and f.has_reference),
    'partyPaid', coalesce((select sum(f.paid) from f where f.kind = 'party'), 0),
    'partyRemaining', coalesce((select sum(f.amount - f.paid) from f where f.kind = 'party'), 0),
    'uncovered', coalesce((select ef.unfunded from ef), 0));
$fn$;

-- The Stage 5 party view of one expense: per party allocation, the derived
-- state, payment status, live readiness (gates) and the approval histories.
create or replace function public.budget_party_workflow_json(p_ws uuid, p_expense_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_out jsonb := '[]'::jsonb;
  v_missing jsonb;
  f record;
  v_blockers text[];
begin
  if not exists (select 1 from public.budget_party_facts(p_ws) x where x.expense_id = p_expense_id) then
    return v_out;
  end if;
  -- What the expense SHOWS (a closed expense: its close-time snapshot).
  select coalesce(jsonb_agg(jsonb_build_object('key', i ->> 'key', 'name', i ->> 'name')), '[]'::jsonb)
  into v_missing
  from jsonb_array_elements(public.budget_expense_requirements(p_ws, p_expense_id) -> 'items') i
  where (i ->> 'required')::boolean and not (i ->> 'satisfied')::boolean;

  for f in
    select x.*, a.created_at from public.budget_party_facts(p_ws) x
    join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = x.allocation_id
    where x.expense_id = p_expense_id order by a.created_at, x.allocation_id
  loop
    v_blockers := public.budget_party_submission_blockers(p_ws, f.allocation_id);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'allocationId', f.allocation_id,
      'sourceId', f.funding_source_id,
      'sourceName', f.source_name,
      'amount', f.amount,
      'paid', f.paid,
      'remaining', f.remaining,
      'paymentStatus', f.payment_status,
      'preapprovedAmount', f.preapproved_amount,
      'exceedsPreapproval', f.exceeds_preapproval,
      'storedState', f.submission_state,
      'workflowState', f.workflow_state,
      'attempts', f.attempts,
      'requestedAmount', f.requested_amount,
      'hasReference', f.has_reference,
      'authorizedAmount', f.authorized_amount,
      'readyAt', f.ready_at,
      'lastSentAt', f.last_sent_at,
      'lastReturnedAt', f.last_returned_at,
      'readiness', jsonb_build_object(
        'ready', cardinality(v_blockers) = 0,
        'blockers', to_jsonb(v_blockers),
        'missingDocuments', v_missing),
      'readyLapsed', f.submission_state = 'ready' and cardinality(v_blockers) > 0,
      'preapprovalHistory', coalesce((
        select jsonb_agg(jsonb_build_object(
          'action', ev.action, 'actorName', ev.actor_name, 'occurredAt', ev.occurred_at,
          'values', ev.after_data - 'workspace_id' - 'allocation_id' - 'row_version' - 'created_at' - 'updated_at')
          order by ev.id)
        from public.budget_audit_events ev
        where ev.workspace_id = p_ws and ev.entity_type = 'budget_party_preapprovals'
          and ev.entity_id = f.allocation_id::text), '[]'::jsonb),
      'referenceHistory', coalesce((
        select jsonb_agg(jsonb_build_object(
          'action', ev.action, 'actorName', ev.actor_name, 'occurredAt', ev.occurred_at,
          'values', ev.after_data - 'workspace_id' - 'allocation_id' - 'row_version' - 'created_at' - 'updated_at')
          order by ev.id)
        from public.budget_audit_events ev
        where ev.workspace_id = p_ws and ev.entity_type = 'budget_party_payment_references'
          and ev.entity_id = f.allocation_id::text), '[]'::jsonb)));
  end loop;
  return v_out;
end;
$fn$;

-- ===========================================================================
-- The expense view: Stage 3's shape + the Stage 5 fields (notes, the derived
-- workflow state as displayState, attempt data on events, the funding summary
-- and the party workflow).
-- ===========================================================================
create or replace function public.budget_expense_json(p_ws uuid, p_expense_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'id', e.id, 'referenceNo', e.reference_no, 'description', e.description,
    'supplierId', e.supplier_id, 'categoryId', e.category_id, 'total', e.total_agorot,
    'net', e.net_agorot, 'vat', e.vat_agorot, 'vatRateBp', e.vat_rate_bp,
    'expenseDate', e.expense_date, 'deliveryDate', e.delivery_date, 'invoiceDate', e.invoice_date,
    'status', e.status, 'notes', e.notes, 'statusReason', e.status_reason, 'closedAt', e.closed_at,
    'version', e.row_version, 'createdAt', e.created_at, 'updatedAt', e.updated_at,
    'facts', (select jsonb_build_object(
        'allocated', f.allocated, 'unfunded', f.unfunded, 'paid', f.paid, 'outstanding', f.outstanding,
        'partyOutstanding', f.party_outstanding, 'campaignOutstanding', f.campaign_outstanding,
        'partyAuthorized', f.party_authorized, 'paymentStatus', f.payment_status,
        'awaitingPreapproval', f.awaiting_preapproval, 'sentWaitingReference', f.sent_waiting_reference,
        'authorizedNotFullyPaid', f.authorized_not_fully_paid, 'preapprovalExceeded', f.preapproval_exceeded)
      from public.budget_expense_facts(p_ws) f where f.expense_id = e.id),
    'funding', public.budget_funding_summary_json(p_ws, e.id),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', af.allocation_id, 'sourceId', af.funding_source_id, 'kind', af.kind, 'payer', af.payer,
        'amount', af.amount, 'paid', af.paid, 'version', a.row_version,
        'preapproval', case when pa.allocation_id is null then null else jsonb_build_object(
          'orderNumber', pa.order_number, 'approvalCode', pa.approval_code, 'approverName', pa.approver_name,
          'approvalDate', pa.approval_date, 'preapprovedAmount', pa.preapproved_amount_agorot,
          'note', pa.note, 'version', pa.row_version) end,
        'submission', case when af.kind <> 'party' then null else jsonb_build_object(
          'state', coalesce(sub.state, 'not_sent'),
          'displayState', pf.workflow_state,
          'requestedAmount', sub.requested_amount_agorot, 'readyAt', sub.ready_at,
          'lastSentAt', sub.last_sent_at, 'lastReturnedAt', sub.last_returned_at) end,
        'reference', case when r.allocation_id is null then null else jsonb_build_object(
          'referenceNumber', r.reference_number, 'authorizedAmount', r.authorized_amount_agorot,
          'receivedDate', r.received_date, 'note', r.note, 'version', r.row_version) end,
        'paymentStatus', case when af.paid = 0 then 'unpaid' when af.paid >= af.amount then 'paid'
                              else 'partial' end
      ) order by a.created_at)
      from public.budget_allocation_facts(p_ws) af
      join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = af.allocation_id
      left join public.budget_party_facts(p_ws) pf on pf.allocation_id = af.allocation_id
      left join public.budget_party_preapprovals pa on pa.workspace_id = p_ws and pa.allocation_id = af.allocation_id
      left join public.budget_party_submissions sub on sub.workspace_id = p_ws and sub.allocation_id = af.allocation_id
      left join public.budget_party_payment_references r on r.workspace_id = p_ws and r.allocation_id = af.allocation_id
      where af.expense_id = e.id), '[]'::jsonb),
    'party', public.budget_party_workflow_json(p_ws, e.id),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'allocationId', p.allocation_id, 'amount', p.amount_agorot, 'paymentDate', p.payment_date,
        'payer', p.payer, 'confirmationSource', p.confirmation_source,
        'externalReference', p.external_reference, 'note', p.note, 'recordedByName', p.recorded_by_name,
        'recordedAt', p.recorded_at, 'voidedAt', p.voided_at, 'voidedByName', p.voided_by_name,
        'voidReason', p.void_reason)
        order by p.payment_date, p.recorded_at)
      from public.budget_supplier_payments p
      where p.workspace_id = p_ws and p.expense_id = e.id), '[]'::jsonb),
    'submissionEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'allocationId', ev.allocation_id, 'event', ev.event,
        'attemptNo', ev.attempt_no, 'orderFormVersionId', ev.order_form_version_id,
        'orderFormVersionNo', o.version_no, 'requestedAmount', ev.requested_amount_agorot,
        'recipientPhone', ev.recipient_phone, 'note', ev.note, 'actorName', ev.actor_name,
        'createdAt', ev.created_at) order by ev.created_at, ev.id)
      from public.budget_party_submission_events ev
      join public.budget_expense_allocations a2 on a2.workspace_id = ev.workspace_id and a2.id = ev.allocation_id
      left join public.budget_order_form_versions o on o.workspace_id = ev.workspace_id and o.id = ev.order_form_version_id
      where ev.workspace_id = p_ws and a2.expense_id = e.id), '[]'::jsonb))
  from public.budget_expenses e
  where e.workspace_id = p_ws and e.id = p_expense_id;
$fn$;

-- ===========================================================================
-- Funding allocations: Stage 3 + the pre-approved cap.
-- ===========================================================================
create or replace function public.budget_op_set_allocation(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'amount', true, 1, 1000000000000);
  v_kind text;
  v_active boolean;
  v_alloc public.budget_expense_allocations;
  v_cap bigint;
begin
  perform public.budget_check_version(p_args, v.row_version, false);
  perform public.budget_require_open_expense(v.status);
  if v.total_agorot is null then
    raise exception 'TOTAL_REQUIRED';
  end if;
  select s.kind, s.is_active into v_kind, v_active
  from public.budget_funding_sources s where s.workspace_id = p_ws and s.id = v_source;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'source';
  end if;

  select * into v_alloc from public.budget_expense_allocations a
  where a.workspace_id = p_ws and a.expense_id = v.id and a.funding_source_id = v_source for update;

  if v_alloc.id is null then
    if not v_active then
      raise exception 'SOURCE_INACTIVE';
    end if;
    insert into public.budget_expense_allocations (workspace_id, expense_id, funding_source_id, amount_agorot)
    values (p_ws, v.id, v_source, v_amount);
  else
    if v_kind = 'party' then
      if exists (select 1 from public.budget_party_payment_references r
                 where r.workspace_id = p_ws and r.allocation_id = v_alloc.id)
         or exists (select 1 from public.budget_party_submissions sub
                    where sub.workspace_id = p_ws and sub.allocation_id = v_alloc.id and sub.state = 'sent')
      then
        raise exception 'ALLOCATION_FROZEN';
      end if;
      -- Stage 5: the party funds at most what it pre-approved (when the prior
      -- approval states an amount). Never raised - the user sets the amount.
      select pa.preapproved_amount_agorot into v_cap
      from public.budget_party_preapprovals pa where pa.workspace_id = p_ws and pa.allocation_id = v_alloc.id;
      if v_cap is not null and v_amount > v_cap then
        raise exception 'PARTY_EXCEEDS_PREAPPROVAL';
      end if;
    end if;
    update public.budget_expense_allocations a set amount_agorot = v_amount
    where a.workspace_id = p_ws and a.id = v_alloc.id and a.amount_agorot <> v_amount;
  end if;
  -- Touch the expense so a concurrent editor holding an older version sees a conflict.
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- PRIOR BUDGET APPROVAL (before the final order form). NOT the payment
-- reference. Stage 3 semantics + a note + idempotent replay: resending the
-- identical approval changes nothing (no version needed, no audit row).
-- Recording an amount BELOW the current party allocation is allowed (a
-- warning, as in Stage 3), but the submission gates refuse it until the user
-- lowers the allocation themselves.
-- ===========================================================================
create or replace function public.budget_op_record_preapproval(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_order text := public.budget_arg_text(p_args, 'orderNumber', 100, false);
  v_code text := public.budget_arg_text(p_args, 'approvalCode', 100, true);
  v_name text := public.budget_arg_text(p_args, 'approverName', 200, true);
  v_date date := public.budget_arg_date(p_args, 'approvalDate', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'preapprovedAmount', false, 1, 1000000000000);
  v_note text := public.budget_arg_text(p_args, 'note', 1000, false);
  v_existing public.budget_party_preapprovals;
begin
  select * into v_existing from public.budget_party_preapprovals pa
  where pa.workspace_id = p_ws and pa.allocation_id = v_alloc for update;
  if v_existing.allocation_id is not null
     and v_existing.order_number is not distinct from v_order and v_existing.approval_code = v_code
     and v_existing.approver_name = v_name and v_existing.approval_date = v_date
     and v_existing.preapproved_amount_agorot is not distinct from v_amount
     and v_existing.note is not distinct from v_note then
    return public.budget_expense_json(p_ws, v.id); -- a replay of what is already recorded
  end if;
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'PREAPPROVAL_LOCKED';
  end if;
  if v_existing.allocation_id is not null then
    perform public.budget_check_version(p_args, v_existing.row_version, true);
  end if;
  insert into public.budget_party_preapprovals (workspace_id, allocation_id, order_number, approval_code,
    approver_name, approval_date, preapproved_amount_agorot, note)
  values (p_ws, v_alloc, v_order, v_code, v_name, v_date, v_amount, v_note)
  on conflict (workspace_id, allocation_id) do update set
    order_number = excluded.order_number, approval_code = excluded.approval_code,
    approver_name = excluded.approver_name, approval_date = excluded.approval_date,
    preapproved_amount_agorot = excluded.preapproved_amount_agorot, note = excluded.note;
  insert into public.budget_party_submissions (workspace_id, allocation_id) values (p_ws, v_alloc)
  on conflict do nothing;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- SUBMISSION: ready -> sent -> (returned -> ready -> sent)* -> reference.
-- Every op locks the expense row first (budget_party_allocation_locked), so
-- concurrent transitions on one expense are serialized.
-- ===========================================================================

-- Shared by the transitions: the replay of a client idempotency key.
-- Returns true when the key already recorded THIS transition on THIS
-- allocation (the caller returns the current view); a key reused for
-- anything else is a conflict.
create or replace function public.budget_party_replayed(p_ws uuid, p_allocation uuid, p_event text, p_key uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
declare
  ev public.budget_party_submission_events;
begin
  if p_key is null then
    return false;
  end if;
  select * into ev from public.budget_party_submission_events x
  where x.workspace_id = p_ws and x.idempotency_key = p_key;
  if not found then
    return false;
  end if;
  if ev.allocation_id <> p_allocation or ev.event <> p_event then
    raise exception 'IDEMPOTENCY_CONFLICT';
  end if;
  return true;
end;
$fn$;

create or replace function public.budget_op_mark_submission_ready(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_sub public.budget_party_submissions;
  v_blockers text[];
begin
  if not exists (select 1 from public.budget_party_preapprovals pa where pa.workspace_id = p_ws and pa.allocation_id = v_alloc) then
    raise exception 'PREAPPROVAL_REQUIRED';
  end if;
  if v.status = 'draft' then
    raise exception 'EXPENSE_NOT_SUBMITTABLE';
  end if;
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'INVALID_TRANSITION';
  end if;
  insert into public.budget_party_submissions (workspace_id, allocation_id) values (p_ws, v_alloc)
  on conflict do nothing;
  select * into v_sub from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc for update;
  if v_sub.state = 'sent' then
    raise exception 'INVALID_TRANSITION';
  end if;
  v_blockers := public.budget_party_submission_blockers(p_ws, v_alloc);
  if cardinality(v_blockers) > 0 then
    raise exception 'SUBMISSION_BLOCKED' using detail = array_to_string(v_blockers, ',');
  end if;
  if v_sub.state = 'ready' then
    return public.budget_expense_json(p_ws, v.id); -- already ready: a repeat changes nothing
  end if;
  update public.budget_party_submissions sub set state = 'ready', ready_at = now()
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  insert into public.budget_party_submission_events (workspace_id, allocation_id, event, note,
    actor_type, actor_id, actor_name)
  values (p_ws, v_alloc, 'ready', public.budget_arg_text(p_args, 'note', 1000, false),
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- Sent to the party (the user's own confirmation - delivery is never
-- claimed). Requires 'ready' and re-checks every gate live; records attempt
-- N with the order-form version, the requested amount and the package.
create or replace function public.budget_op_mark_submission_sent(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_key uuid := public.budget_arg_uuid(p_args, 'idempotencyKey', false);
  v_sub public.budget_party_submissions;
  v_blockers text[];
  v_amount bigint;
  v_attempt integer;
  v_form public.budget_order_form_versions;
  v_req jsonb;
  v_pre public.budget_party_preapprovals;
begin
  if public.budget_party_replayed(p_ws, v_alloc, 'sent', v_key) then
    return public.budget_expense_json(p_ws, v.id);
  end if;
  -- The prior budget approval is THE gate before anything goes out; it is
  -- checked first so the answer names the step the user still owes.
  select * into v_pre from public.budget_party_preapprovals pa where pa.workspace_id = p_ws and pa.allocation_id = v_alloc;
  if v_pre.allocation_id is null then
    raise exception 'PREAPPROVAL_REQUIRED';
  end if;
  if v.status = 'draft' then
    raise exception 'EXPENSE_NOT_SUBMITTABLE';
  end if;
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'INVALID_TRANSITION';
  end if;
  select * into v_sub from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc for update;
  if v_sub.state = 'sent' then
    raise exception 'INVALID_TRANSITION';
  end if;
  if v_sub.state is distinct from 'ready' then
    raise exception 'SUBMISSION_NOT_READY';
  end if;
  v_blockers := public.budget_party_submission_blockers(p_ws, v_alloc);
  if cardinality(v_blockers) > 0 then
    raise exception 'SUBMISSION_BLOCKED' using detail = array_to_string(v_blockers, ',');
  end if;

  select a.amount_agorot into v_amount from public.budget_expense_allocations a
  where a.workspace_id = p_ws and a.id = v_alloc;
  select coalesce(max(ev.attempt_no), 0) + 1 into v_attempt
  from public.budget_party_submission_events ev
  where ev.workspace_id = p_ws and ev.allocation_id = v_alloc and ev.event = 'sent';
  select * into v_form from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.expense_id = v.id order by o.version_no desc limit 1;
  v_req := public.budget_document_requirements_live(p_ws, v.id);

  update public.budget_party_submissions sub set state = 'sent', last_sent_at = now(), requested_amount_agorot = v_amount
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  insert into public.budget_party_submission_events (workspace_id, allocation_id, event, recipient_phone, note,
    attempt_no, order_form_version_id, requested_amount_agorot, package, idempotency_key,
    actor_type, actor_id, actor_name)
  values (p_ws, v_alloc, 'sent', public.budget_arg_text(p_args, 'recipientPhone', 32, false),
    public.budget_arg_text(p_args, 'note', 1000, false),
    v_attempt, v_form.id, v_amount,
    jsonb_build_object(
      'expenseTotal', v.total_agorot,
      'requestedAmount', v_amount,
      'orderFormVersionNo', v_form.version_no,
      'preapproval', jsonb_build_object('approvalCode', v_pre.approval_code, 'approvalDate', v_pre.approval_date,
        'preapprovedAmount', v_pre.preapproved_amount_agorot, 'orderNumber', v_pre.order_number),
      'documents', coalesce((select jsonb_agg(jsonb_build_object(
          'key', i ->> 'key', 'required', (i ->> 'required')::boolean, 'satisfiedBy', i -> 'satisfiedBy'))
        from jsonb_array_elements(v_req -> 'items') i
        where (i ->> 'required')::boolean or (i ->> 'satisfied')::boolean), '[]'::jsonb)),
    v_key, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- The funder returned attempt N for correction (a note is required). The
-- sent attempt stays in the log; the user corrects, marks ready, sends again.
create or replace function public.budget_op_mark_submission_returned(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_note text := public.budget_arg_text(p_args, 'note', 1000, true);
  v_key uuid := public.budget_arg_uuid(p_args, 'idempotencyKey', false);
  v_attempt integer;
begin
  if public.budget_party_replayed(p_ws, v_alloc, 'returned', v_key) then
    return public.budget_expense_json(p_ws, v.id);
  end if;
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'INVALID_TRANSITION';
  end if;
  perform 1 from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc and sub.state = 'sent' for update;
  if not found then
    raise exception 'INVALID_TRANSITION';
  end if;
  select max(ev.attempt_no) into v_attempt
  from public.budget_party_submission_events ev
  where ev.workspace_id = p_ws and ev.allocation_id = v_alloc and ev.event = 'sent';
  update public.budget_party_submissions sub set state = 'returned', last_returned_at = now()
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  insert into public.budget_party_submission_events (workspace_id, allocation_id, event, note, attempt_no,
    idempotency_key, actor_type, actor_id, actor_name)
  values (p_ws, v_alloc, 'returned', v_note, coalesce(v_attempt, 1), v_key,
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- PAYMENT REFERENCE (the party's later authorization; NOT the prior approval
-- and NOT a payment). Stage 3 semantics (the allocation becomes the
-- authorized amount, a lower authorization leaves an explicit gap,
-- correctable until the first valid party payment) + a note + idempotent
-- replay of the identical reference.
-- ===========================================================================
create or replace function public.budget_op_record_payment_reference(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_number text := public.budget_arg_text(p_args, 'referenceNumber', 100, true);
  v_authorized bigint := public.budget_arg_amount(p_args, 'authorizedAmount', true, 1, 1000000000000);
  v_date date := public.budget_arg_date(p_args, 'receivedDate', true);
  v_note text := public.budget_arg_text(p_args, 'note', 1000, false);
  v_sub public.budget_party_submissions;
  v_ref public.budget_party_payment_references;
  v_cap bigint;
begin
  select * into v_sub from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc for update;
  select * into v_ref from public.budget_party_payment_references r
  where r.workspace_id = p_ws and r.allocation_id = v_alloc for update;

  if v_ref.allocation_id is not null and v_ref.reference_number = v_number
     and v_ref.authorized_amount_agorot = v_authorized and v_ref.received_date = v_date
     and v_ref.note is not distinct from v_note then
    return public.budget_expense_json(p_ws, v.id); -- a replay of what is already recorded
  end if;
  if v_ref.allocation_id is null and coalesce(v_sub.state, 'not_sent') <> 'sent' then
    raise exception 'SUBMISSION_NOT_SENT';
  end if;
  if v_ref.allocation_id is not null then
    perform public.budget_check_version(p_args, v_ref.row_version, true);
    if exists (select 1 from public.budget_supplier_payments p
               where p.workspace_id = p_ws and p.allocation_id = v_alloc and p.voided_at is null) then
      raise exception 'REFERENCE_LOCKED';
    end if;
  end if;

  v_cap := coalesce(v_sub.requested_amount_agorot,
                    (select a.amount_agorot from public.budget_expense_allocations a
                     where a.workspace_id = p_ws and a.id = v_alloc));
  if v_authorized > v_cap then
    raise exception 'AUTHORIZED_EXCEEDS_REQUEST';
  end if;

  insert into public.budget_party_payment_references (workspace_id, allocation_id, reference_number,
    authorized_amount_agorot, received_date, note)
  values (p_ws, v_alloc, v_number, v_authorized, v_date, v_note)
  on conflict (workspace_id, allocation_id) do update set
    reference_number = excluded.reference_number,
    authorized_amount_agorot = excluded.authorized_amount_agorot,
    received_date = excluded.received_date,
    note = excluded.note;

  update public.budget_expense_allocations a set amount_agorot = v_authorized
  where a.workspace_id = p_ws and a.id = v_alloc and a.amount_agorot <> v_authorized;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- Stage 4's "sent to the supplier" confirmation + the explicit prior-approval
-- gate (a party allocation added after the form was generated has none).
-- ===========================================================================
create or replace function public.budget_op_order_form_mark_sent(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_order_form_versions;
  v_note text := public.budget_arg_text(p_args, 'note', 500, false);
begin
  select * into v from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.id = public.budget_arg_uuid(p_args, 'orderFormVersionId', true);
  if not found then
    raise exception 'NOT_FOUND' using detail = 'orderform';
  end if;
  perform public.budget_require_open_expense((public.budget_expense_for_update(p_ws, v.expense_id)).status);
  if 'PREAPPROVAL_REQUIRED' = any (public.budget_order_form_blockers(p_ws, v.expense_id, true)) then
    raise exception 'PREAPPROVAL_REQUIRED';
  end if;
  if exists (select 1 from public.budget_order_form_versions o
             where o.workspace_id = p_ws and o.expense_id = v.expense_id and o.version_no > v.version_no) then
    raise exception 'ORDER_FORM_SUPERSEDED';
  end if;
  if v.sent_at is not null then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.budget_order_form_versions o
  set sent_at = now(), sent_by_name = p_actor ->> 'name', sent_note = v_note
  where o.workspace_id = p_ws and o.id = v.id;
  return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', v.expense_id));
end;
$fn$;

-- ===========================================================================
-- The op -> permission map: Stage 3 + 4 entries unchanged + Stage 5.
-- ===========================================================================
create or replace function public.budget_op_permissions(p_op text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  return case p_op
    when 'session'                   then '{}'::text[]
    when 'get_overview'              then '{}'
    when 'list_sources'              then '{}'
    when 'list_source_adjustments'   then '{}'
    when 'list_categories'           then '{}'
    when 'list_plan_adjustments'     then '{}'
    when 'list_suppliers'            then '{}'
    when 'get_supplier'              then '{}'
    when 'list_expenses'             then '{}'
    when 'get_expense'               then '{}'
    when 'list_history'              then '{}'
    when 'get_settings'              then '{}'
    when 'update_settings'           then '{budget.manageSettings}'
    when 'create_category'           then '{budget.manageSettings}'
    when 'update_category'           then '{budget.manageSettings}'
    when 'delete_category'           then '{budget.manageSettings}'
    when 'reorder_categories'        then '{budget.manageSettings}'
    when 'update_document_rule'      then '{budget.manageSettings}'
    when 'create_source'             then '{budget.managePlan,budget.manageSettings}'
    when 'update_source'             then '{budget.managePlan,budget.manageSettings}'
    when 'adjust_source'             then '{budget.managePlan}'
    when 'set_category_plan'         then '{budget.managePlan}'
    when 'adjust_category_plan'      then '{budget.managePlan}'
    when 'transfer_plan'             then '{budget.managePlan}'
    when 'create_supplier'           then '{budget.manageSuppliers}'
    when 'update_supplier'           then '{budget.manageSuppliers}'
    when 'stepup_check'              then '{budget.manageSuppliers}'
    when 'reveal_supplier_bank'      then '{budget.manageSuppliers}'
    when 'set_supplier_bank'         then '{budget.manageSuppliers}'
    when 'record_stepup_failure'     then '{budget.manageSuppliers}'
    when 'create_expense'            then '{budget.manageExpenses}'
    when 'update_expense'            then '{budget.manageExpenses}'
    when 'transition_expense'        then '{budget.manageExpenses}'
    when 'set_allocation'            then '{budget.manageExpenses}'
    when 'remove_allocation'         then '{budget.manageExpenses}'
    when 'record_payment'            then '{budget.manageExpenses}'
    when 'void_payment'              then '{budget.manageExpenses}'
    when 'record_preapproval'        then '{budget.manageFunderSubmissions}'
    when 'mark_submission_sent'      then '{budget.manageFunderSubmissions}'
    when 'mark_submission_returned'  then '{budget.manageFunderSubmissions}'
    when 'record_payment_reference'  then '{budget.manageFunderSubmissions}'
    -- Stage 4. Document ops: the map admits any of the three document
    -- authorities; each op then requires the one its purpose needs
    -- (budget_require_document_authority).
    when 'get_expense_documents'     then '{}'
    when 'get_supplier_file'         then '{}'
    when 'document_version_locate'   then '{}'
    when 'document_upload_start'     then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'document_upload_lookup'    then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'document_upload_finalize'  then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'document_upload_reject'    then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'archive_document'          then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'restore_document'          then '{budget.manageExpenses,budget.manageFunderSubmissions,budget.manageSuppliers}'
    when 'set_expense_document_flag' then '{budget.manageExpenses}'
    when 'order_form_data'           then '{budget.manageFunderSubmissions}'
    when 'order_form_record'         then '{budget.manageFunderSubmissions}'
    when 'order_form_mark_sent'      then '{budget.manageFunderSubmissions}'
    when 'create_document_type'      then '{budget.manageSettings}'
    when 'update_document_type'      then '{budget.manageSettings}'
    -- Stage 5.
    when 'mark_submission_ready'     then '{budget.manageFunderSubmissions}'
    else null
  end;
end;
$fn$;

-- ===========================================================================
-- ACL: re-assert the Stage 3 posture over EVERY budget_* function (the new
-- ones included): granted to no role, except the two dispatchers and the
-- worker step-up mint (service_role only).
-- ===========================================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'budget\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    execute format('revoke all on function %s from service_role', f.sig);
  end loop;
end $$;

grant execute on function public.budget_dispatch_worker(bytea, text, jsonb) to service_role;
grant execute on function public.budget_dispatch_owner(uuid, text, jsonb) to service_role;
grant execute on function public.budget_stepup_mint_worker(bytea, text, text, uuid, bytea) to service_role;

commit;
