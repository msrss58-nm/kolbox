-- Budget Stage 6 - dashboard, reports & controls: read-only extensions of the
-- ONE calculation layer, the dashboard op, seven report ops and two indexes.
--
-- Nothing here stores a derived figure and nothing re-implements a rule:
--   * money figures come from the Stage 3 facts (budget_expense_facts,
--     budget_allocation_facts, budget_source_facts, budget_category_facts,
--     budget_summary);
--   * document readiness comes from the Stage 4 requirement engine, now
--     expressed SET-BASED (budget_requirement_items: one statement for any
--     number of expenses; Stage 4's budget_document_requirements_live is a
--     thin wrapper over it - verified byte-identical output for every expense
--     of the scratch data set). A closed expense still shows its close-time
--     snapshot. Measured on 1,000 expenses: per-expense evaluation 3.0 s ->
--     set-based 75 ms;
--   * the party process comes from Stage 5's budget_party_facts;
--   * the queue definitions live in ONE function (budget_expense_queue_facts)
--     and the list / report filters in ONE function (budget_expense_filter),
--     so a dashboard count always equals the list it drills into.
--
-- KPI formulas (integer agorot):
--   total budget   = sum of the current amounts (original + adjustments) of
--                    ACTIVE funding sources (Stage 3); party / donations /
--                    personal are the same sum per source kind;
--   committed      = sum of totals of expenses in status 'committed';
--   actual         = sum of totals of expenses in status 'incurred' / 'closed';
--   total expenses = committed + actual (drafts and cancelled excluded);
--   available      = total budget - committed - actual (Stage 3).
--
-- Every op runs behind the Stage 3 dispatchers (session -> workspace FOR SHARE
-- -> entitlement -> permission). Reports need budget.viewReports; the
-- dashboard needs budget.view. No bank-account data is read by any report.
--
-- MANUAL ROLLBACK: re-run the Stage 3 (20260917020000) definition of
-- budget_op_list_expenses, the Stage 4 (20260918010000) definition of
-- budget_document_requirements_live and the Stage 5 (20260919010000)
-- budget_op_permissions, then drop the functions created here and the two
-- indexes.

begin;

-- ===========================================================================
-- Indexes for the new read paths.
-- ===========================================================================
create index budget_supplier_payments_date_idx
  on public.budget_supplier_payments (workspace_id, payment_date desc, recorded_at desc, id desc);
create index budget_expenses_created_idx
  on public.budget_expenses (workspace_id, created_at desc, id desc);

-- ===========================================================================
-- THE requirement engine, set-based. Stage 4's per-expense evaluation is
-- re-expressed as ONE statement over any number of expenses (p_expense_id
-- null = the whole workspace), so dashboards and reports evaluate every
-- expense in one pass instead of once per row. Same rules, same candidates,
-- same precedence as Stage 4 - budget_document_requirements_live (below) is
-- now a thin wrapper around it, so there is still exactly one engine.
-- ===========================================================================
--
-- plpgsql with force_custom_plan: every call is planned with the real
-- workspace / ids (a LANGUAGE sql function is planned with opaque parameters,
-- which measured ~15x slower on 1,000 expenses).
create or replace function public.budget_requirement_items(p_ws uuid, p_expense_ids uuid[])
returns table (
  expense_id uuid,
  document_type_id uuid,
  key text,
  name text,
  sort_order integer,
  required boolean,
  rules jsonb,
  satisfied boolean,
  satisfied_by jsonb
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
#variable_conflict use_column
begin
  return query
  with e as materialized (
    select x.id, x.total_agorot, x.category_id, x.supplier_id
    from public.budget_expenses x
    where x.workspace_id = p_ws and (p_expense_ids is null or x.id = any (p_expense_ids))
  ),
  kinds as (
    select a.expense_id, array_agg(distinct s.kind order by s.kind) as kinds
    from public.budget_expense_allocations a
    join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
    where a.workspace_id = p_ws and a.expense_id in (select e.id from e)
    group by a.expense_id
  ),
  latest_of as (
    select distinct on (o.expense_id) o.expense_id, o.id
    from public.budget_order_form_versions o
    where o.workspace_id = p_ws and o.expense_id in (select e.id from e)
    order by o.expense_id, o.version_no desc
  ),
  -- Every ACTIVE rule of an ACTIVE type that applies to one of the expense's
  -- funding kinds (null = every expense), and whether it matches.
  rule_eval as materialized (
    select e.id as expense_id, r.id as rule_id, r.document_type_id, r.condition, r.threshold_agorot,
      (case r.condition
        when 'always' then true
        when 'amount_gt' then coalesce(e.total_agorot > r.threshold_agorot, false)
        when 'amount_gte' then coalesce(e.total_agorot >= r.threshold_agorot, false)
        when 'category' then e.category_id is not null and exists (
          select 1 from public.budget_document_rule_categories rc
          where rc.workspace_id = p_ws and rc.rule_id = r.id and rc.category_id = e.category_id)
        when 'manual' then exists (
          select 1 from public.budget_expense_document_flags f
          where f.workspace_id = p_ws and f.expense_id = e.id and f.document_type_id = r.document_type_id)
        else false
      end) as matched
    from e
    left join kinds k on k.expense_id = e.id
    join public.budget_document_rules r on r.workspace_id = p_ws and r.is_active
      and (r.funding_kind is null or r.funding_kind = any (coalesce(k.kinds, '{}')))
    join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id and t.is_active
  ),
  rule_agg as (
    select r.expense_id, r.document_type_id, bool_or(r.matched) as required,
      jsonb_agg(jsonb_build_object(
        'ruleId', r.rule_id, 'condition', r.condition, 'threshold', r.threshold_agorot, 'matched', r.matched)
        order by r.condition, r.rule_id) as rules
    from rule_eval r
    group by r.expense_id, r.document_type_id
  ),
  candidates as (
    -- (1) the expense's own active documents (latest version of each), every
    --     type except the supplier-signed order form;
    select d.expense_id, d.document_type_id, d.id as document_id, v.id as version_id, v.version_no,
           'expense'::text as source, 1 as priority, v.created_at
    from public.budget_documents d
    join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
    join lateral (
      select vv.id, vv.version_no, vv.created_at from public.budget_document_versions vv
      where vv.workspace_id = p_ws and vv.document_id = d.id
      order by vv.version_no desc limit 1) v on true
    where d.workspace_id = p_ws and d.expense_id in (select e.id from e) and d.status = 'active'
      and t.key <> 'order_form_signed'
    union all
    -- (2) the supplier's still-valid bank-account confirmation;
    select e.id, d.document_type_id, d.id, v.id, v.version_no, 'supplier', 2, v.created_at
    from e
    join public.budget_documents d on d.workspace_id = p_ws and d.supplier_id = e.supplier_id
    join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
    join lateral (
      select vv.id, vv.version_no, vv.created_at from public.budget_document_versions vv
      where vv.workspace_id = p_ws and vv.document_id = d.id
      order by vv.version_no desc limit 1) v on true
    where e.supplier_id is not null and d.status = 'active' and t.key = 'bank_confirmation'
      and (d.valid_until is null or d.valid_until >= current_date)
    union all
    -- (3) the supplier-signed form counts ONLY when it answers the LATEST
    --     generated order form (a regeneration needs a fresh signature).
    select lo.expense_id, d.document_type_id, d.id, v.id, v.version_no, 'order_form_return', 1, v.created_at
    from latest_of lo
    join public.budget_document_versions v on v.workspace_id = p_ws and v.order_form_version_id = lo.id
    join public.budget_documents d on d.workspace_id = v.workspace_id and d.id = v.document_id
    where d.expense_id = lo.expense_id and d.status = 'active'
  ),
  present as (
    select distinct on (c.expense_id, c.document_type_id) c.*
    from candidates c
    order by c.expense_id, c.document_type_id, c.priority, c.created_at desc
  )
  select coalesce(ra.expense_id, p.expense_id), t.id, t.key, t.name, t.sort_order,
    coalesce(ra.required, false),
    coalesce(ra.rules, '[]'::jsonb),
    p.version_id is not null,
    case when p.version_id is null then null else jsonb_build_object(
      'documentId', p.document_id, 'versionId', p.version_id, 'versionNo', p.version_no, 'source', p.source) end
  from rule_agg ra
  full join present p on p.expense_id = ra.expense_id and p.document_type_id = ra.document_type_id
  join public.budget_document_types t on t.workspace_id = p_ws and t.id = coalesce(ra.document_type_id, p.document_type_id);
end;
$fn$;

-- Stage 4's single-expense view, now built on the set-based engine (same
-- output shape and values).
create or replace function public.budget_document_requirements_live(p_ws uuid, p_expense_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  e public.budget_expenses;
  v_kinds text[];
  v_latest_of uuid;
  v_items jsonb;
  v_missing jsonb;
begin
  select * into e from public.budget_expenses x where x.workspace_id = p_ws and x.id = p_expense_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;

  select coalesce(array_agg(distinct s.kind order by s.kind), '{}') into v_kinds
  from public.budget_expense_allocations a
  join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
  where a.workspace_id = p_ws and a.expense_id = p_expense_id;

  select o.id into v_latest_of
  from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.expense_id = p_expense_id
  order by o.version_no desc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'documentTypeId', i.document_type_id,
      'key', i.key,
      'name', i.name,
      'required', i.required,
      'rules', i.rules,
      'satisfied', i.satisfied,
      'satisfiedBy', i.satisfied_by)
    order by i.sort_order, i.key), '[]'::jsonb)
  into v_items
  from public.budget_requirement_items(p_ws, array[p_expense_id]) i;

  select coalesce(jsonb_agg(i ->> 'key' order by ord), '[]'::jsonb) into v_missing
  from jsonb_array_elements(v_items) with ordinality as x(i, ord)
  where (i ->> 'required')::boolean and not (i ->> 'satisfied')::boolean;

  return jsonb_build_object(
    'mode', 'live',
    'total', e.total_agorot,
    'fundingKinds', to_jsonb(v_kinds),
    'partyFunded', 'party' = any (v_kinds),
    'invoiceRequired', exists (select 1 from jsonb_array_elements(v_items) i
                               where i ->> 'key' = 'invoice' and (i ->> 'required')::boolean),
    'supplierSignatureRequired', exists (select 1 from jsonb_array_elements(v_items) i
                                         where i ->> 'key' = 'order_form_signed' and (i ->> 'required')::boolean),
    'photoRequired', exists (select 1 from jsonb_array_elements(v_items) i
                             where i ->> 'key' = 'photo' and (i ->> 'required')::boolean),
    'latestOrderFormVersionId', v_latest_of,
    'items', v_items,
    'missing', v_missing,
    'ready', jsonb_array_length(v_missing) = 0);
end;
$fn$;

-- ===========================================================================
-- Document facts per (non-cancelled) expense, in ONE pass: the set-based
-- engine for open expenses; a closed expense shows its close-time snapshot
-- (exactly as budget_expense_requirements does - live when none exists).
-- ===========================================================================
-- p_expense_ids null = every expense of the workspace; an empty array = none.
create or replace function public.budget_expense_document_facts(p_ws uuid, p_expense_ids uuid[])
returns table (
  expense_id uuid,
  required_count integer,
  missing_count integer,
  missing text[],
  docs_ready boolean,
  form_generated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
#variable_conflict use_column
begin
  return query
  with e as materialized (
    select x.id, x.status,
      case when x.status = 'closed' then (
        select s.snapshot from public.budget_expense_requirement_snapshots s
        where s.workspace_id = p_ws and s.expense_id = x.id
        order by s.created_at desc, s.id limit 1) end as snap
    from public.budget_expenses x
    where x.workspace_id = p_ws and x.status <> 'cancelled'
      and (p_expense_ids is null or x.id = any (p_expense_ids))
  ),
  items as materialized (
    select * from public.budget_requirement_items(p_ws, case when p_expense_ids is null then null
      else array(select e.id from e where e.snap is null) end)),
  live as (
    select e.id,
      (count(*) filter (where i.required))::integer as required_count,
      coalesce(array_agg(i.key order by i.sort_order, i.key) filter (where i.required and not i.satisfied), '{}') as missing
    from e left join items i on i.expense_id = e.id
    where e.snap is null
    group by e.id
  ),
  snap as (
    select e.id,
      (select count(*) from jsonb_array_elements(e.snap -> 'items') i where (i ->> 'required')::boolean)::integer as required_count,
      array(select jsonb_array_elements_text(e.snap -> 'missing')) as missing
    from e where e.snap is not null
  ),
  forms as (
    select o.expense_id, max(o.created_at) as generated_at
    from public.budget_order_form_versions o where o.workspace_id = p_ws group by o.expense_id
  ),
  u as (select * from live union all select * from snap)
  select u.id, u.required_count, cardinality(u.missing), u.missing, cardinality(u.missing) = 0, f.generated_at
  from u left join forms f on f.expense_id = u.id;
end;
$fn$;

-- ===========================================================================
-- THE queue definitions (one row per expense). The dashboard counts, the
-- attention alerts and the expense list's `queue` filter all read this.
-- ===========================================================================
create or replace function public.budget_expense_queue_facts(p_ws uuid)
returns table (
  expense_id uuid,
  awaiting_preapproval boolean,
  missing_documents boolean,
  waiting_supplier_form boolean,
  ready_to_submit boolean,
  sent_waiting_reference boolean,
  authorized_not_fully_paid boolean,
  authorized_unpaid boolean,
  authorized_partial boolean,
  unfunded boolean,
  unpaid boolean,
  missing_documents_overdue boolean,
  supplier_form_overdue boolean,
  no_reference_overdue boolean,
  unpaid_overdue boolean,
  docs_ready boolean,
  missing_count integer,
  party_state text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with s as (
    select coalesce(max(x.alert_missing_docs_days), 7) as md,
           coalesce(max(x.alert_supplier_form_days), 7) as sf,
           coalesce(max(x.alert_no_reference_days), 14) as nr,
           coalesce(max(x.alert_unpaid_days), 14) as up
    from public.budget_settings x where x.workspace_id = p_ws
  ),
  f as (select * from public.budget_expense_facts(p_ws)),
  d as (select * from public.budget_expense_document_facts(p_ws, null)),
  p as (
    select pf.expense_id,
      bool_or(pf.workflow_state = 'ready') as any_ready,
      bool_or(pf.has_reference and pf.paid = 0) as ref_unpaid,
      bool_or(pf.has_reference and pf.paid > 0 and pf.paid < pf.amount) as ref_partial,
      bool_or(pf.workflow_state = 'sent' and pf.last_sent_at <= now() - make_interval(days => (select s.nr from s))) as sent_overdue,
      bool_or(pf.has_reference and pf.paid < pf.amount and r.received_date <= current_date - (select s.up from s)) as ref_unpaid_overdue,
      (array_agg(pf.workflow_state order by a.created_at, pf.allocation_id))[1] as first_state
    from public.budget_party_facts(p_ws) pf
    join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = pf.allocation_id
    left join public.budget_party_payment_references r on r.workspace_id = p_ws and r.allocation_id = pf.allocation_id
    group by pf.expense_id
  ),
  q as (
    select f.expense_id, f.status,
      e.created_at,
      f.status in ('committed', 'incurred') as live,
      f.awaiting_preapproval > 0 as awaiting_preapproval,
      coalesce(exists (select 1 from unnest(d.missing) m where m <> 'order_form_signed'), false) as docs_missing,
      coalesce('order_form_signed' = any (d.missing) and d.form_generated_at is not null, false) as form_waiting,
      d.form_generated_at,
      f.sent_waiting_reference > 0 as sent_waiting_reference,
      f.authorized_not_fully_paid > 0 as authorized_not_fully_paid,
      f.unfunded, f.outstanding,
      d.docs_ready, d.missing_count,
      p.any_ready, p.ref_unpaid, p.ref_partial, p.sent_overdue, p.ref_unpaid_overdue, p.first_state
    from f
    join public.budget_expenses e on e.workspace_id = p_ws and e.id = f.expense_id
    left join d on d.expense_id = f.expense_id
    left join p on p.expense_id = f.expense_id
  )
  select q.expense_id,
    q.awaiting_preapproval,
    q.live and q.docs_missing,
    q.live and q.form_waiting,
    q.live and coalesce(q.any_ready, false),
    q.sent_waiting_reference,
    q.authorized_not_fully_paid,
    q.live and coalesce(q.ref_unpaid, false),
    q.live and coalesce(q.ref_partial, false),
    q.live and q.unfunded > 0,
    q.outstanding > 0,
    q.live and q.docs_missing and q.created_at <= now() - make_interval(days => (select s.md from s)),
    q.live and q.form_waiting and q.form_generated_at <= now() - make_interval(days => (select s.sf from s)),
    q.live and coalesce(q.sent_overdue, false),
    q.live and coalesce(q.ref_unpaid_overdue, false),
    q.docs_ready,
    q.missing_count,
    q.first_state
  from q;
$fn$;

-- ===========================================================================
-- THE expense filter (server-validated). Used by the expense list and every
-- expense-based report; ids must belong to the caller's workspace.
-- ===========================================================================
create or replace function public.budget_expense_filter(p_ws uuid, p_args jsonb)
returns table (expense_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_status text := public.budget_arg_text(p_args, 'status', 20, false);
  v_group text := public.budget_arg_text(p_args, 'statusGroup', 20, false);
  v_category uuid := public.budget_arg_uuid(p_args, 'categoryId', false);
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', false);
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', false);
  v_queue text := public.budget_arg_text(p_args, 'queue', 40, false);
  v_search text := public.budget_arg_text(p_args, 'search', 100, false);
  v_from date := public.budget_arg_date(p_args, 'from', false);
  v_to date := public.budget_arg_date(p_args, 'to', false);
  v_workflow text := public.budget_arg_text(p_args, 'workflowState', 30, false);
  v_payment text := public.budget_arg_text(p_args, 'paymentStatus', 20, false);
  v_docs text := public.budget_arg_text(p_args, 'docReadiness', 20, false);
  v_needs_q boolean;
begin
  if v_status is not null and v_status not in ('draft', 'committed', 'incurred', 'closed', 'cancelled') then
    raise exception 'INVALID_INPUT' using detail = 'status';
  end if;
  if v_group is not null and v_group not in ('obligations', 'open', 'live') then
    raise exception 'INVALID_INPUT' using detail = 'statusGroup';
  end if;
  if v_queue is not null and v_queue not in (
    'awaiting_preapproval', 'missing_documents', 'waiting_supplier_form', 'ready_to_submit',
    'sent_waiting_reference', 'authorized_not_fully_paid', 'authorized_unpaid', 'authorized_partial',
    'unfunded', 'unpaid', 'missing_documents_overdue', 'supplier_form_overdue', 'no_reference_overdue',
    'unpaid_overdue') then
    raise exception 'INVALID_INPUT' using detail = 'queue';
  end if;
  if v_workflow is not null and v_workflow not in (
    'awaiting_preapproval', 'preapproved', 'collecting_documents', 'ready', 'sent', 'returned', 'reference_received') then
    raise exception 'INVALID_INPUT' using detail = 'workflowState';
  end if;
  if v_payment is not null and v_payment not in ('unpaid', 'partial', 'paid') then
    raise exception 'INVALID_INPUT' using detail = 'paymentStatus';
  end if;
  if v_docs is not null and v_docs not in ('ready', 'missing') then
    raise exception 'INVALID_INPUT' using detail = 'docReadiness';
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    raise exception 'INVALID_INPUT' using detail = 'to';
  end if;
  -- An id from another workspace is simply not found (no enumeration, no leak).
  if v_category is not null and not exists (select 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = v_category) then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  if v_supplier is not null and not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  if v_source is not null and not exists (select 1 from public.budget_funding_sources s where s.workspace_id = p_ws and s.id = v_source) then
    raise exception 'NOT_FOUND' using detail = 'source';
  end if;
  v_needs_q := v_queue is not null or v_docs is not null;

  return query
    with f as (select * from public.budget_expense_facts(p_ws)),
    q as (select * from public.budget_expense_queue_facts(p_ws) where v_needs_q),
    pw as (select distinct pf.expense_id from public.budget_party_facts(p_ws) pf
           where v_workflow is not null and pf.workflow_state = v_workflow)
    select f.expense_id
    from f
    left join public.budget_suppliers s on s.workspace_id = p_ws and s.id = f.supplier_id
    left join q on q.expense_id = f.expense_id
    where (v_status is null or f.status = v_status)
      and (v_group is null
           or (v_group = 'obligations' and f.status in ('committed', 'incurred', 'closed'))
           or (v_group = 'open' and f.status in ('draft', 'committed', 'incurred'))
           or (v_group = 'live' and f.status in ('committed', 'incurred')))
      and (v_category is null or f.category_id = v_category)
      and (v_supplier is null or f.supplier_id = v_supplier)
      and (v_source is null or exists (
            select 1 from public.budget_expense_allocations a
            where a.workspace_id = p_ws and a.expense_id = f.expense_id and a.funding_source_id = v_source))
      and (v_from is null or f.expense_date >= v_from)
      and (v_to is null or f.expense_date <= v_to)
      and (v_search is null or f.description ilike '%' || v_search || '%'
           or s.business_name ilike '%' || v_search || '%' or f.reference_no::text = v_search)
      and (v_payment is null or f.payment_status = v_payment)
      and (v_workflow is null or f.expense_id in (select pw.expense_id from pw))
      and (v_docs is null or (v_docs = 'ready' and q.docs_ready) or (v_docs = 'missing' and q.docs_ready = false))
      and (v_queue is null
           or (v_queue = 'awaiting_preapproval' and q.awaiting_preapproval)
           or (v_queue = 'missing_documents' and q.missing_documents)
           or (v_queue = 'waiting_supplier_form' and q.waiting_supplier_form)
           or (v_queue = 'ready_to_submit' and q.ready_to_submit)
           or (v_queue = 'sent_waiting_reference' and q.sent_waiting_reference)
           or (v_queue = 'authorized_not_fully_paid' and q.authorized_not_fully_paid)
           or (v_queue = 'authorized_unpaid' and q.authorized_unpaid)
           or (v_queue = 'authorized_partial' and q.authorized_partial)
           or (v_queue = 'unfunded' and q.unfunded)
           or (v_queue = 'unpaid' and q.unpaid)
           or (v_queue = 'missing_documents_overdue' and q.missing_documents_overdue)
           or (v_queue = 'supplier_form_overdue' and q.supplier_form_overdue)
           or (v_queue = 'no_reference_overdue' and q.no_reference_overdue)
           or (v_queue = 'unpaid_overdue' and q.unpaid_overdue));
end;
$fn$;

-- Bounded paging arguments shared by every list / report.
create or replace function public.budget_page_args(p_args jsonb)
returns integer[]
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  return array[
    coalesce(public.budget_arg_int(p_args, 'limit', false, 1, 200), 50),
    coalesce(public.budget_arg_int(p_args, 'offset', false, 0, 1000000), 0)];
end;
$fn$;

-- ===========================================================================
-- The expense list (Stage 3 shape, unchanged output) on the shared filter.
-- ===========================================================================
create or replace function public.budget_op_list_expenses(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_page integer[] := public.budget_page_args(p_args);
  v_rows jsonb;
  v_count bigint;
  v_sum bigint;
begin
  with filtered as (
    select f.* from public.budget_expense_facts(p_ws) f
    join public.budget_expense_filter(p_ws, p_args) i on i.expense_id = f.expense_id
  )
  select
    (select count(*) from filtered),
    (select coalesce(sum(total), 0) from filtered),
    coalesce((select jsonb_agg(jsonb_build_object(
        'id', x.expense_id, 'referenceNo', x.reference_no, 'status', x.status, 'description', x.description,
        'supplierId', x.supplier_id, 'categoryId', x.category_id, 'total', x.total,
        'expenseDate', x.expense_date, 'allocated', x.allocated, 'unfunded', x.unfunded, 'paid', x.paid,
        'outstanding', x.outstanding, 'paymentStatus', x.payment_status,
        'partyAllocations', x.party_allocations, 'awaitingPreapproval', x.awaiting_preapproval,
        'sentWaitingReference', x.sent_waiting_reference,
        'authorizedNotFullyPaid', x.authorized_not_fully_paid, 'version', x.row_version)
        order by x.expense_date desc nulls last, x.reference_no desc)
      from (select * from filtered order by expense_date desc nulls last, reference_no desc
            limit v_page[1] offset v_page[2]) x), '[]'::jsonb)
  into v_count, v_sum, v_rows;

  return jsonb_build_object('total', v_count, 'totalAmount', v_sum, 'rows', v_rows);
end;
$fn$;

-- ===========================================================================
-- DASHBOARD (budget.view).
-- ===========================================================================
create or replace function public.budget_op_get_dashboard(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_sum jsonb := public.budget_summary(p_ws);
  v_set public.budget_settings;
  v_queues jsonb;
  v_counts jsonb;
  v_cat_over integer;
  v_cat_warn integer;
  v_src_over integer;
  v_docs_expiring integer;
  v_committed bigint := (v_sum ->> 'committed')::bigint;
  v_actual bigint := (v_sum ->> 'actual')::bigint;
  v_total_budget bigint := (v_sum ->> 'totalBudget')::bigint;
  v_alerts jsonb := '[]'::jsonb;
begin
  select * into v_set from public.budget_settings s where s.workspace_id = p_ws;

  select jsonb_build_object(
    'awaiting_preapproval', count(*) filter (where q.awaiting_preapproval),
    'missing_documents', count(*) filter (where q.missing_documents),
    'waiting_supplier_form', count(*) filter (where q.waiting_supplier_form),
    'ready_to_submit', count(*) filter (where q.ready_to_submit),
    'sent_waiting_reference', count(*) filter (where q.sent_waiting_reference),
    'authorized_not_fully_paid', count(*) filter (where q.authorized_not_fully_paid),
    'authorized_unpaid', count(*) filter (where q.authorized_unpaid),
    'authorized_partial', count(*) filter (where q.authorized_partial),
    'unfunded', count(*) filter (where q.unfunded),
    'missing_documents_overdue', count(*) filter (where q.missing_documents_overdue),
    'supplier_form_overdue', count(*) filter (where q.supplier_form_overdue),
    'no_reference_overdue', count(*) filter (where q.no_reference_overdue),
    'unpaid_overdue', count(*) filter (where q.unpaid_overdue))
  into v_queues
  from public.budget_expense_queue_facts(p_ws) q;

  select count(*) filter (where c.overrun),
         count(*) filter (where not c.overrun and c.current_plan > 0
                          and (c.committed + c.actual) * 100 >= c.current_plan * coalesce(v_set.category_usage_warning_pct, 90))
  into v_cat_over, v_cat_warn
  from public.budget_category_facts(p_ws) c;
  select count(*) into v_src_over from public.budget_source_facts(p_ws) s where s.overrun;
  select count(distinct d.supplier_id) into v_docs_expiring
  from public.budget_documents d
  join public.budget_suppliers sp on sp.workspace_id = d.workspace_id and sp.id = d.supplier_id and sp.is_active
  where d.workspace_id = p_ws and d.supplier_id is not null and d.status = 'active' and d.valid_until is not null
    and d.valid_until <= current_date + coalesce(v_set.alert_supplier_doc_expiry_days, 30);

  select jsonb_build_object(
    'sources', (select count(*) from public.budget_funding_sources s where s.workspace_id = p_ws),
    'categories', (select count(*) from public.budget_categories c where c.workspace_id = p_ws),
    'plannedCategories', (select count(*) from public.budget_category_facts(p_ws) c where c.current_plan > 0),
    'suppliers', (select count(*) from public.budget_suppliers s where s.workspace_id = p_ws),
    'expenses', (select count(*) from public.budget_expenses e where e.workspace_id = p_ws))
  into v_counts;

  -- Attention alerts: only what is non-zero, each backed by a queue / report
  -- filter that lists exactly the counted records.
  select coalesce(jsonb_agg(a.x order by a.ord), '[]'::jsonb) into v_alerts
  from (values
    (1, jsonb_build_object('key', 'total_overrun', 'severity', 'danger', 'count', 1,
        'amount', v_committed + v_actual - v_total_budget), v_committed + v_actual > v_total_budget),
    (2, jsonb_build_object('key', 'category_overrun', 'severity', 'danger', 'count', v_cat_over), v_cat_over > 0),
    (3, jsonb_build_object('key', 'source_overrun', 'severity', 'danger', 'count', v_src_over), v_src_over > 0),
    (4, jsonb_build_object('key', 'unfunded', 'severity', 'warning', 'count', (v_queues ->> 'unfunded')::integer,
        'amount', (v_sum ->> 'unfundedTotal')::bigint), (v_queues ->> 'unfunded')::integer > 0),
    (5, jsonb_build_object('key', 'missing_documents_overdue', 'severity', 'warning',
        'count', (v_queues ->> 'missing_documents_overdue')::integer, 'days', coalesce(v_set.alert_missing_docs_days, 7)),
        (v_queues ->> 'missing_documents_overdue')::integer > 0),
    (6, jsonb_build_object('key', 'supplier_form_overdue', 'severity', 'warning',
        'count', (v_queues ->> 'supplier_form_overdue')::integer, 'days', coalesce(v_set.alert_supplier_form_days, 7)),
        (v_queues ->> 'supplier_form_overdue')::integer > 0),
    (7, jsonb_build_object('key', 'no_reference_overdue', 'severity', 'warning',
        'count', (v_queues ->> 'no_reference_overdue')::integer, 'days', coalesce(v_set.alert_no_reference_days, 14)),
        (v_queues ->> 'no_reference_overdue')::integer > 0),
    (8, jsonb_build_object('key', 'unpaid_overdue', 'severity', 'warning',
        'count', (v_queues ->> 'unpaid_overdue')::integer, 'days', coalesce(v_set.alert_unpaid_days, 14)),
        (v_queues ->> 'unpaid_overdue')::integer > 0),
    (9, jsonb_build_object('key', 'awaiting_preapproval', 'severity', 'info',
        'count', (v_queues ->> 'awaiting_preapproval')::integer), (v_queues ->> 'awaiting_preapproval')::integer > 0),
    (10, jsonb_build_object('key', 'category_warning', 'severity', 'info', 'count', v_cat_warn,
        'pct', coalesce(v_set.category_usage_warning_pct, 90)), v_cat_warn > 0),
    (11, jsonb_build_object('key', 'supplier_docs_expiring', 'severity', 'warning', 'count', v_docs_expiring,
        'days', coalesce(v_set.alert_supplier_doc_expiry_days, 30)), v_docs_expiring > 0),
    (12, jsonb_build_object('key', 'plan_exceeds_budget', 'severity', 'warning', 'count', 1,
        'amount', -((v_sum ->> 'unallocatedPlan')::bigint)), (v_sum ->> 'unallocatedPlan')::bigint < 0)
  ) as a(ord, x, show)
  where a.show;

  return jsonb_build_object(
    'kpis', jsonb_build_object(
      'totalBudget', v_total_budget,
      'partyBudget', (v_sum ->> 'partyBudget')::bigint,
      'donationBudget', (v_sum ->> 'donationBudget')::bigint,
      'personalBudget', (v_sum ->> 'personalBudget')::bigint,
      'totalExpenses', v_committed + v_actual,
      'committed', v_committed,
      'actual', v_actual,
      'available', (v_sum ->> 'available')::bigint,
      'plannedInCategories', (v_sum ->> 'plannedInCategories')::bigint,
      'unallocatedPlan', (v_sum ->> 'unallocatedPlan')::bigint,
      'unfundedTotal', (v_sum ->> 'unfundedTotal')::bigint,
      'paid', (v_sum ->> 'paid')::bigint,
      'outstanding', (v_sum ->> 'outstanding')::bigint,
      'partyOutstanding', (v_sum ->> 'partyOutstanding')::bigint,
      'authorizedUnpaidAmount', (v_sum -> 'authorizedNotFullyPaid' ->> 'amount')::bigint),
    'queues', v_queues,
    'overruns', jsonb_build_object(
      'categories', v_cat_over, 'sources', v_src_over,
      'total', v_committed + v_actual > v_total_budget,
      'totalExcess', greatest(v_committed + v_actual - v_total_budget, 0)),
    'charts', jsonb_build_object(
      'byCategory', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.category_id, 'name', c.name, 'plan', c.current_plan, 'committed', c.committed, 'actual', c.actual,
          'overrun', c.overrun) order by c.sort_order, c.name)
        from public.budget_category_facts(p_ws) c
        where c.current_plan <> 0 or c.committed <> 0 or c.actual <> 0), '[]'::jsonb),
      'bySource', coalesce((select jsonb_agg(jsonb_build_object(
          'id', s.source_id, 'name', s.name, 'kind', s.kind, 'isActive', s.is_active, 'budget', s.current_amount,
          'committed', s.committed, 'actual', s.actual, 'overrun', s.overrun) order by s.sort_order, s.name)
        from public.budget_source_facts(p_ws) s), '[]'::jsonb),
      -- Expenses over time: committed / actual totals per month of the expense
      -- date, inside the budget period when one is set (max 36 months).
      'overTime', coalesce((select jsonb_agg(jsonb_build_object('month', m.month, 'committed', m.committed, 'actual', m.actual)
          order by m.month)
        from (
          select to_char(date_trunc('month', f.expense_date), 'YYYY-MM') as month,
            coalesce(sum(f.total) filter (where f.status = 'committed'), 0)::bigint as committed,
            coalesce(sum(f.total) filter (where f.status in ('incurred', 'closed')), 0)::bigint as actual
          from public.budget_expense_facts(p_ws) f
          where f.status in ('committed', 'incurred', 'closed') and f.expense_date is not null
            and (v_set.period_start is null or f.expense_date >= v_set.period_start)
            and (v_set.period_end is null or f.expense_date <= v_set.period_end)
          group by 1 order by 1 desc limit 36) m), '[]'::jsonb)),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.expense_id, 'referenceNo', f.reference_no, 'description', f.description, 'expenseDate', f.expense_date,
        'categoryName', c.name, 'supplierName', sp.business_name, 'total', f.total, 'allocated', f.allocated,
        'unfunded', f.unfunded, 'status', f.status, 'paymentStatus', f.payment_status, 'partyState', ps.party_state)
        order by e.created_at desc, e.id desc)
      from (select x.id, x.created_at from public.budget_expenses x
            where x.workspace_id = p_ws and x.status <> 'cancelled'
            order by x.created_at desc, x.id desc limit 8) e
      join public.budget_expense_facts(p_ws) f on f.expense_id = e.id
      left join public.budget_categories c on c.workspace_id = p_ws and c.id = f.category_id
      left join public.budget_suppliers sp on sp.workspace_id = p_ws and sp.id = f.supplier_id
      left join (
        select pf.expense_id, (array_agg(pf.workflow_state order by a.created_at, pf.allocation_id))[1] as party_state
        from public.budget_party_facts(p_ws) pf
        join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = pf.allocation_id
        group by pf.expense_id) ps on ps.expense_id = f.expense_id), '[]'::jsonb),
    'alerts', v_alerts,
    'counts', v_counts,
    'period', jsonb_build_object('start', v_set.period_start, 'end', v_set.period_end),
    'categoryUsageWarningPct', coalesce(v_set.category_usage_warning_pct, 90));
end;
$fn$;

-- ===========================================================================
-- REPORTS (budget.viewReports). Paged lists are deterministically ordered
-- (unique tie-breaker) and bounded (limit <= 200); totals are computed over
-- the whole filtered set, so they reconcile with the detail rows.
-- ===========================================================================

-- 1. Expense report.
create or replace function public.budget_op_report_expenses(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_page integer[] := public.budget_page_args(p_args);
  v_out jsonb;
begin
  with f as (
    select x.* from public.budget_expense_facts(p_ws) x
    join public.budget_expense_filter(p_ws, p_args) i on i.expense_id = x.expense_id
  ),
  pg as (select * from f order by f.expense_date desc nulls last, f.reference_no desc limit v_page[1] offset v_page[2]),
  pstate as (
    select pf.expense_id, (array_agg(pf.workflow_state order by a.created_at, pf.allocation_id))[1] as party_state
    from public.budget_party_facts(p_ws) pf
    join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = pf.allocation_id
    where pf.expense_id in (select pg.expense_id from pg)
    group by pf.expense_id
  ),
  -- Readiness for the PAGE rows only, in one engine pass.
  pd as (select * from public.budget_expense_document_facts(p_ws, coalesce((select array_agg(pg.expense_id) from pg), '{}')))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'totals', (select jsonb_build_object(
        'amount', coalesce(sum(f.total), 0),
        'committed', coalesce(sum(f.total) filter (where f.status = 'committed'), 0),
        'actual', coalesce(sum(f.total) filter (where f.status in ('incurred', 'closed')), 0),
        'allocated', coalesce(sum(f.allocated), 0),
        'unfunded', coalesce(sum(f.unfunded), 0),
        'paid', coalesce(sum(f.paid), 0),
        'outstanding', coalesce(sum(f.outstanding), 0),
        'partyAllocated', coalesce(sum(f.party_allocated), 0),
        'partyPaid', coalesce(sum(f.party_paid), 0)) from f),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.expense_id, 'referenceNo', r.reference_no, 'expenseDate', r.expense_date, 'description', r.description,
        'status', r.status, 'categoryId', r.category_id, 'categoryName', c.name,
        'supplierId', r.supplier_id, 'supplierName', sp.business_name,
        'total', r.total, 'allocated', r.allocated, 'unfunded', r.unfunded, 'paid', r.paid,
        'outstanding', r.outstanding, 'paymentStatus', r.payment_status,
        'partyAllocated', r.party_allocated, 'partyState', ps.party_state,
        'docsReady', pd.docs_ready, 'missingCount', pd.missing_count)
        order by r.expense_date desc nulls last, r.reference_no desc)
      from pg r
      left join public.budget_categories c on c.workspace_id = p_ws and c.id = r.category_id
      left join public.budget_suppliers sp on sp.workspace_id = p_ws and sp.id = r.supplier_id
      left join pstate ps on ps.expense_id = r.expense_id
      left join pd on pd.expense_id = r.expense_id), '[]'::jsonb))
  into v_out;
  return v_out || jsonb_build_object('limit', v_page[1], 'offset', v_page[2]);
end;
$fn$;

-- 2. Category report (spending of the filtered expenses per category).
create or replace function public.budget_op_report_categories(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_out jsonb;
begin
  with f as (
    select x.* from public.budget_expense_facts(p_ws) x
    join public.budget_expense_filter(p_ws, p_args) i on i.expense_id = x.expense_id
  ),
  agg as (
    select f.category_id, count(*) as expenses,
      coalesce(sum(f.total) filter (where f.status = 'committed'), 0)::bigint as committed,
      coalesce(sum(f.total) filter (where f.status in ('incurred', 'closed')), 0)::bigint as actual,
      coalesce(sum(f.total) filter (where f.status = 'draft'), 0)::bigint as draft,
      coalesce(sum(f.paid), 0)::bigint as paid,
      coalesce(sum(f.outstanding), 0)::bigint as outstanding
    from f group by f.category_id
  ),
  rows as (
    select c.id, c.name, c.sort_order, c.is_active, coalesce(a.expenses, 0) as expenses,
      coalesce(a.committed, 0) as committed, coalesce(a.actual, 0) as actual, coalesce(a.draft, 0) as draft,
      coalesce(a.paid, 0) as paid, coalesce(a.outstanding, 0) as outstanding
    from public.budget_categories c
    left join agg a on a.category_id = c.id
    where c.workspace_id = p_ws
    union all
    select null, null, 2147483647, true, a.expenses, a.committed, a.actual, a.draft, a.paid, a.outstanding
    from agg a where a.category_id is null
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'categoryId', r.id, 'name', r.name, 'isActive', r.is_active, 'expenses', r.expenses,
        'committed', r.committed, 'actual', r.actual, 'draft', r.draft, 'paid', r.paid, 'outstanding', r.outstanding)
        order by r.sort_order, r.name, r.id) from rows r), '[]'::jsonb),
    'totals', (select jsonb_build_object('expenses', coalesce(sum(r.expenses), 0), 'committed', coalesce(sum(r.committed), 0),
        'actual', coalesce(sum(r.actual), 0), 'draft', coalesce(sum(r.draft), 0), 'paid', coalesce(sum(r.paid), 0),
        'outstanding', coalesce(sum(r.outstanding), 0)) from rows r))
  into v_out;
  return v_out;
end;
$fn$;

-- 3. Funding-source report (the Stage 3 source facts + valid payments).
create or replace function public.budget_op_report_sources(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_kind text := public.budget_arg_text(p_args, 'kind', 20, false);
  v_attention text := public.budget_arg_text(p_args, 'attention', 20, false);
  v_out jsonb;
begin
  if v_kind is not null and v_kind not in ('party', 'donation', 'personal') then
    raise exception 'INVALID_INPUT' using detail = 'kind';
  end if;
  if v_attention is not null and v_attention <> 'overrun' then
    raise exception 'INVALID_INPUT' using detail = 'attention';
  end if;
  with paid as (
    select a.funding_source_id, sum(a.paid)::bigint as paid, sum(a.amount)::bigint as allocated
    from public.budget_allocation_facts(p_ws) a
    join public.budget_expenses e on e.workspace_id = p_ws and e.id = a.expense_id and e.status <> 'cancelled'
    group by a.funding_source_id
  ),
  rows as (
    select s.*, coalesce(p.paid, 0) as paid, coalesce(p.allocated, 0) as allocated
    from public.budget_source_facts(p_ws) s
    left join paid p on p.funding_source_id = s.source_id
    where (v_kind is null or s.kind = v_kind) and (v_attention is null or s.overrun)
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'sourceId', r.source_id, 'name', r.name, 'kind', r.kind, 'isActive', r.is_active,
        'originalAmount', r.original_amount, 'adjustments', r.adjustments, 'currentAmount', r.current_amount,
        'committed', r.committed, 'actual', r.actual, 'remaining', r.remaining, 'overrun', r.overrun,
        'allocated', r.allocated, 'paid', r.paid) order by r.sort_order, r.name, r.source_id) from rows r), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'currentAmount', coalesce(sum(r.current_amount) filter (where r.is_active), 0),
        'committed', coalesce(sum(r.committed), 0), 'actual', coalesce(sum(r.actual), 0),
        'allocated', coalesce(sum(r.allocated), 0), 'paid', coalesce(sum(r.paid), 0)) from rows r))
  into v_out;
  return v_out;
end;
$fn$;

-- 4. Supplier report (no bank-account data: only whether details are on file).
create or replace function public.budget_op_report_suppliers(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_page integer[] := public.budget_page_args(p_args);
  v_search text := public.budget_arg_text(p_args, 'search', 100, false);
  v_active text := public.budget_arg_text(p_args, 'active', 20, false);
  v_expiring boolean := coalesce(public.budget_arg_bool(p_args, 'docsExpiring'), false);
  v_days integer := coalesce((select s.alert_supplier_doc_expiry_days from public.budget_settings s where s.workspace_id = p_ws), 30);
  v_out jsonb;
begin
  if v_active is not null and v_active not in ('active', 'inactive') then
    raise exception 'INVALID_INPUT' using detail = 'active';
  end if;
  with f as (select * from public.budget_expense_facts(p_ws) x where x.status <> 'cancelled'),
  agg as (
    select f.supplier_id, count(*) as expenses,
      coalesce(sum(f.total) filter (where f.status in ('committed', 'incurred', 'closed')), 0)::bigint as amount,
      coalesce(sum(f.party_allocated), 0)::bigint as party_allocated,
      coalesce(sum(f.paid), 0)::bigint as paid,
      coalesce(sum(f.party_paid), 0)::bigint as party_paid,
      coalesce(sum(f.party_outstanding), 0)::bigint as party_outstanding,
      coalesce(sum(f.outstanding), 0)::bigint as outstanding,
      coalesce(sum(f.unfunded) filter (where f.status in ('committed', 'incurred')), 0)::bigint as unfunded
    from f where f.supplier_id is not null group by f.supplier_id
  ),
  docs as (
    select d.supplier_id,
      bool_or(t.key = 'bank_confirmation') as has_bank_confirmation,
      max(d.valid_until) filter (where t.key = 'bank_confirmation') as bank_confirmation_valid_until,
      bool_or(d.valid_until is not null and d.valid_until <= current_date + v_days) as docs_expiring
    from public.budget_documents d
    join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
    where d.workspace_id = p_ws and d.supplier_id is not null and d.status = 'active'
    group by d.supplier_id
  ),
  rows as (
    select s.id, s.business_name, s.is_active, s.tax_id,
      exists (select 1 from public.budget_supplier_bank_details b where b.workspace_id = p_ws and b.supplier_id = s.id) as bank_on_file,
      coalesce(dc.has_bank_confirmation, false) as has_bank_confirmation, dc.bank_confirmation_valid_until,
      coalesce(dc.docs_expiring, false) as docs_expiring,
      coalesce(a.expenses, 0) as expenses, coalesce(a.amount, 0) as amount, coalesce(a.party_allocated, 0) as party_allocated,
      coalesce(a.paid, 0) as paid, coalesce(a.party_paid, 0) as party_paid, coalesce(a.party_outstanding, 0) as party_outstanding,
      coalesce(a.outstanding, 0) as outstanding, coalesce(a.unfunded, 0) as unfunded
    from public.budget_suppliers s
    left join agg a on a.supplier_id = s.id
    left join docs dc on dc.supplier_id = s.id
    where s.workspace_id = p_ws
      and (v_search is null or s.business_name ilike '%' || v_search || '%')
      and (v_active is null or (v_active = 'active') = s.is_active)
      and (not v_expiring or (s.is_active and coalesce(dc.docs_expiring, false)))
  )
  select jsonb_build_object(
    'total', (select count(*) from rows),
    'totals', (select jsonb_build_object('expenses', coalesce(sum(r.expenses), 0), 'amount', coalesce(sum(r.amount), 0),
        'partyAllocated', coalesce(sum(r.party_allocated), 0), 'paid', coalesce(sum(r.paid), 0),
        'partyPaid', coalesce(sum(r.party_paid), 0), 'partyOutstanding', coalesce(sum(r.party_outstanding), 0),
        'outstanding', coalesce(sum(r.outstanding), 0), 'unfunded', coalesce(sum(r.unfunded), 0)) from rows r),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'supplierId', r.id, 'name', r.business_name, 'isActive', r.is_active, 'taxId', r.tax_id,
        'bankOnFile', r.bank_on_file, 'hasBankConfirmation', r.has_bank_confirmation,
        'bankConfirmationValidUntil', r.bank_confirmation_valid_until, 'docsExpiring', r.docs_expiring,
        'expenses', r.expenses, 'amount', r.amount, 'partyAllocated', r.party_allocated, 'paid', r.paid,
        'partyPaid', r.party_paid, 'partyOutstanding', r.party_outstanding, 'outstanding', r.outstanding,
        'unfunded', r.unfunded) order by r.business_name, r.id)
      from (select * from rows order by business_name, id limit v_page[1] offset v_page[2]) r), '[]'::jsonb),
    'limit', v_page[1], 'offset', v_page[2])
  into v_out;
  return v_out;
end;
$fn$;

-- 5. Party workflow report (Stage 5 party facts + Stage 4 readiness).
create or replace function public.budget_op_report_party(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_page integer[] := public.budget_page_args(p_args);
  v_workflow text := public.budget_arg_text(p_args, 'workflowState', 30, false);
  v_payment text := public.budget_arg_text(p_args, 'paymentStatus', 20, false);
  v_docs text := public.budget_arg_text(p_args, 'docReadiness', 20, false);
  v_expense_args jsonb := p_args - 'workflowState' - 'paymentStatus' - 'docReadiness' - 'limit' - 'offset';
  v_out jsonb;
begin
  if v_workflow is not null and v_workflow not in (
    'awaiting_preapproval', 'preapproved', 'collecting_documents', 'ready', 'sent', 'returned', 'reference_received') then
    raise exception 'INVALID_INPUT' using detail = 'workflowState';
  end if;
  if v_payment is not null and v_payment not in ('unpaid', 'partial', 'paid') then
    raise exception 'INVALID_INPUT' using detail = 'paymentStatus';
  end if;
  if v_docs is not null and v_docs not in ('ready', 'missing') then
    raise exception 'INVALID_INPUT' using detail = 'docReadiness';
  end if;
  with ids as (select * from public.budget_expense_filter(p_ws, v_expense_args)),
  d as (select * from public.budget_expense_document_facts(p_ws, null) where v_docs is not null),
  pf as (
    select pf.*, f.reference_no, f.description, f.status, f.expense_date, f.supplier_id, f.category_id, a.created_at as alloc_created
    from public.budget_party_facts(p_ws) pf
    join ids on ids.expense_id = pf.expense_id
    join public.budget_expense_facts(p_ws) f on f.expense_id = pf.expense_id
    join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = pf.allocation_id
    left join d on d.expense_id = pf.expense_id
    where (v_workflow is null or pf.workflow_state = v_workflow)
      and (v_payment is null or pf.payment_status = v_payment)
      and (v_docs is null or (v_docs = 'ready' and d.docs_ready) or (v_docs = 'missing' and d.docs_ready = false))
  ),
  pg as (select * from pf order by pf.expense_date desc nulls last, pf.reference_no desc, pf.alloc_created, pf.allocation_id
         limit v_page[1] offset v_page[2]),
  pd as (select * from public.budget_expense_document_facts(p_ws, coalesce((select array_agg(distinct pg.expense_id) from pg), '{}')))
  select jsonb_build_object(
    'total', (select count(*) from pf),
    'totals', (select jsonb_build_object('amount', coalesce(sum(pf.amount), 0), 'paid', coalesce(sum(pf.paid), 0),
        'remaining', coalesce(sum(pf.remaining), 0),
        'preapproved', coalesce(sum(pf.preapproved_amount), 0),
        'authorized', coalesce(sum(pf.authorized_amount), 0)) from pf),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'allocationId', r.allocation_id, 'expenseId', r.expense_id, 'referenceNo', r.reference_no,
        'description', r.description, 'expenseStatus', r.status, 'expenseDate', r.expense_date,
        'supplierName', sp.business_name, 'sourceName', r.source_name,
        'workflowState', r.workflow_state, 'hasPreapproval', r.has_preapproval,
        'preapprovalCode', pa.approval_code, 'preapprovedAmount', r.preapproved_amount,
        'exceedsPreapproval', r.exceeds_preapproval,
        'hasReference', r.has_reference, 'referenceNumber', rf.reference_number, 'authorizedAmount', r.authorized_amount,
        'attempts', r.attempts, 'amount', r.amount, 'paid', r.paid, 'remaining', r.remaining,
        'paymentStatus', r.payment_status,
        'docsReady', pd.docs_ready, 'missingCount', pd.missing_count)
        order by r.expense_date desc nulls last, r.reference_no desc, r.alloc_created, r.allocation_id)
      from pg r
      left join public.budget_suppliers sp on sp.workspace_id = p_ws and sp.id = r.supplier_id
      left join public.budget_party_preapprovals pa on pa.workspace_id = p_ws and pa.allocation_id = r.allocation_id
      left join public.budget_party_payment_references rf on rf.workspace_id = p_ws and rf.allocation_id = r.allocation_id
      left join pd on pd.expense_id = r.expense_id), '[]'::jsonb),
    'limit', v_page[1], 'offset', v_page[2])
  into v_out;
  return v_out;
end;
$fn$;

-- 6. Plan vs actual (category plans; no percentage when the plan is zero).
create or replace function public.budget_op_report_plan(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_attention text := public.budget_arg_text(p_args, 'attention', 20, false);
  v_pct integer := coalesce((select s.category_usage_warning_pct from public.budget_settings s where s.workspace_id = p_ws), 90);
  v_sum jsonb := public.budget_summary(p_ws);
  v_out jsonb;
begin
  if v_attention is not null and v_attention not in ('overrun', 'warning') then
    raise exception 'INVALID_INPUT' using detail = 'attention';
  end if;
  with rows as (
    select c.*, (c.committed + c.actual) as used,
      case
        when c.overrun then 'overrun'
        when c.current_plan = 0 then 'no_plan'
        when (c.committed + c.actual) * 100 >= c.current_plan * v_pct then 'warning'
        else 'ok' end as state
    from public.budget_category_facts(p_ws) c
  ),
  sel as (select * from rows r where v_attention is null or r.state = v_attention)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'categoryId', r.category_id, 'name', r.name, 'isActive', r.is_active,
        'originalPlan', r.original_plan, 'adjustments', r.adjustments, 'plan', r.current_plan,
        'committed', r.committed, 'actual', r.actual, 'used', r.used,
        'remaining', r.remaining, 'variance', r.used - r.current_plan,
        'pctUsed', case when r.current_plan > 0 then (r.used * 100 / r.current_plan) else null end,
        'state', r.state) order by r.sort_order, r.name, r.category_id) from sel r), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'plan', coalesce(sum(r.current_plan), 0), 'committed', coalesce(sum(r.committed), 0),
        'actual', coalesce(sum(r.actual), 0), 'used', coalesce(sum(r.used), 0),
        'remaining', coalesce(sum(r.remaining), 0)) from sel r),
    'budget', jsonb_build_object(
        'totalBudget', (v_sum ->> 'totalBudget')::bigint,
        'plannedInCategories', (v_sum ->> 'plannedInCategories')::bigint,
        'unallocatedPlan', (v_sum ->> 'unallocatedPlan')::bigint,
        'committed', (v_sum ->> 'committed')::bigint,
        'actual', (v_sum ->> 'actual')::bigint,
        'available', (v_sum ->> 'available')::bigint),
    'warningPct', v_pct)
  into v_out;
  return v_out;
end;
$fn$;

-- 7. Payment report (every ledger row; voided rows stay listed but never
-- count in the paid total).
create or replace function public.budget_op_report_payments(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_page integer[] := public.budget_page_args(p_args);
  v_from date := public.budget_arg_date(p_args, 'from', false);
  v_to date := public.budget_arg_date(p_args, 'to', false);
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', false);
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', false);
  v_expense uuid := public.budget_arg_uuid(p_args, 'expenseId', false);
  v_payer text := public.budget_arg_text(p_args, 'payer', 20, false);
  v_state text := public.budget_arg_text(p_args, 'state', 20, false);
  v_out jsonb;
begin
  if v_payer is not null and v_payer not in ('party', 'campaign') then
    raise exception 'INVALID_INPUT' using detail = 'payer';
  end if;
  if v_state is not null and v_state not in ('active', 'voided') then
    raise exception 'INVALID_INPUT' using detail = 'state';
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    raise exception 'INVALID_INPUT' using detail = 'to';
  end if;
  if v_supplier is not null and not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  if v_source is not null and not exists (select 1 from public.budget_funding_sources s where s.workspace_id = p_ws and s.id = v_source) then
    raise exception 'NOT_FOUND' using detail = 'source';
  end if;
  if v_expense is not null and not exists (select 1 from public.budget_expenses e where e.workspace_id = p_ws and e.id = v_expense) then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;
  with p as (
    select p.*, a.funding_source_id, e.supplier_id, e.reference_no, e.description
    from public.budget_supplier_payments p
    join public.budget_expense_allocations a on a.workspace_id = p.workspace_id and a.id = p.allocation_id
    join public.budget_expenses e on e.workspace_id = p.workspace_id and e.id = p.expense_id
    where p.workspace_id = p_ws
      and (v_from is null or p.payment_date >= v_from) and (v_to is null or p.payment_date <= v_to)
      and (v_supplier is null or e.supplier_id = v_supplier)
      and (v_source is null or a.funding_source_id = v_source)
      and (v_expense is null or p.expense_id = v_expense)
      and (v_payer is null or p.payer = v_payer)
      and (v_state is null or (v_state = 'active') = (p.voided_at is null))
  ),
  pg as (select * from p order by p.payment_date desc, p.recorded_at desc, p.id desc limit v_page[1] offset v_page[2]),
  af as (select * from public.budget_allocation_facts(p_ws) x where x.allocation_id in (select pg.allocation_id from pg))
  select jsonb_build_object(
    'total', (select count(*) from p),
    'totals', (select jsonb_build_object(
        'activeAmount', coalesce(sum(p.amount_agorot) filter (where p.voided_at is null), 0),
        'activeCount', count(*) filter (where p.voided_at is null),
        'voidedAmount', coalesce(sum(p.amount_agorot) filter (where p.voided_at is not null), 0),
        'voidedCount', count(*) filter (where p.voided_at is not null)) from p),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'paymentId', r.id, 'paymentDate', r.payment_date, 'amount', r.amount_agorot, 'payer', r.payer,
        'sourceId', r.funding_source_id, 'sourceName', fs.name, 'kind', fs.kind,
        'expenseId', r.expense_id, 'referenceNo', r.reference_no, 'description', r.description,
        'supplierId', r.supplier_id, 'supplierName', sp.business_name,
        'externalReference', r.external_reference, 'confirmationSource', r.confirmation_source,
        'recordedByName', r.recorded_by_name, 'recordedAt', r.recorded_at,
        'state', case when r.voided_at is null then 'active' else 'voided' end,
        'voidedAt', r.voided_at, 'voidReason', r.void_reason,
        'partyRemaining', case when r.payer = 'party' then af.amount - af.paid end)
        order by r.payment_date desc, r.recorded_at desc, r.id desc)
      from pg r
      left join public.budget_funding_sources fs on fs.workspace_id = p_ws and fs.id = r.funding_source_id
      left join public.budget_suppliers sp on sp.workspace_id = p_ws and sp.id = r.supplier_id
      left join af on af.allocation_id = r.allocation_id), '[]'::jsonb),
    'limit', v_page[1], 'offset', v_page[2])
  into v_out;
  return v_out;
end;
$fn$;

-- ===========================================================================
-- The op -> permission map: Stage 3 / 4 / 5 entries unchanged + Stage 6.
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
    -- Stage 6. The dashboard is part of viewing; reports need viewReports.
    when 'get_dashboard'             then '{}'
    when 'report_expenses'           then '{budget.viewReports}'
    when 'report_categories'         then '{budget.viewReports}'
    when 'report_sources'            then '{budget.viewReports}'
    when 'report_suppliers'          then '{budget.viewReports}'
    when 'report_party'              then '{budget.viewReports}'
    when 'report_plan'               then '{budget.viewReports}'
    when 'report_payments'           then '{budget.viewReports}'
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
