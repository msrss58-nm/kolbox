-- Budget Stage 3 (C/3) - authorization, operations and the calculation layer.
--
-- Shape: exactly TWO entry points reach Budget data, one per principal, both
-- service_role-only and both called only by api/budget/actions.ts:
--   budget_dispatch_worker(session_hash, op, args)  - PermissionUser session
--   budget_dispatch_owner(auth_user_id, op, args)   - Election Owner (JWT
--                                                      verified by the handler)
-- plus budget_stepup_mint_worker for the bank-detail step-up.
--
-- Every call, in ONE transaction:
--   1. authenticates (session hash -> workspace_resolve_session / owner row);
--   2. takes the workspace row FOR SHARE (serializes with entitlement edits,
--      which lock it FOR UPDATE in platform_set_workspace_modules);
--   3. requires EFFECTIVE Budget entitlement (MODULE_NOT_ENABLED);
--   4. requires budget.view, then the op’s own permission (FORBIDDEN) - the
--      Owner holds intrinsic authority, a PermissionUser only what its role
--      grants (is_manager grants nothing);
--   5. sets the transaction-local actor context the audit trigger requires;
--   6. runs the op against ITS OWN workspace only - no workspace id is ever
--      accepted from the client; every entity id is looked up WHERE
--      workspace_id = the actor’s workspace, a miss is NOT_FOUND.
-- Op functions are internal (granted to no role, service_role included).
--
-- Money is integer agorot end to end. Nothing here reads election_end_at.
--
-- MANUAL ROLLBACK: drop every function created below (all named budget_*),
-- then migration B’s rollback.

begin;

-- ===========================================================================
-- row_version / updated_at bookkeeping for every mutable Budget table.
-- ===========================================================================
create or replace function public.budget_touch_row()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$fn$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'budget_settings', 'budget_categories', 'budget_category_plans', 'budget_funding_sources',
    'budget_suppliers', 'budget_supplier_bank_details', 'budget_document_types', 'budget_document_rules',
    'budget_expenses', 'budget_expense_allocations', 'budget_party_preapprovals',
    'budget_party_submissions', 'budget_party_payment_references']
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.budget_touch_row()',
      t || '_touch', t);
  end loop;
end $$;

-- ===========================================================================
-- Typed argument parsing (the client never supplies a trusted value).
-- ===========================================================================
create or replace function public.budget_arg_text(p jsonb, k text, p_max integer, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text;
begin
  if p ? k and jsonb_typeof(p -> k) not in ('string', 'null') then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  v := nullif(btrim(p ->> k), '');
  if v is null and p_required then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  if v is not null and length(v) > p_max then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  return v;
end;
$fn$;

create or replace function public.budget_arg_uuid(p jsonb, k text, p_required boolean)
returns uuid
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text := public.budget_arg_text(p, k, 36, p_required);
begin
  if v is null then
    return null;
  end if;
  if v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  return v::uuid;
end;
$fn$;

-- An integer number of agorot. p_min/p_max bound it; JSON numbers only (no
-- strings, no fractions), so a client cannot smuggle floating point in.
create or replace function public.budget_arg_amount(p jsonb, k text, p_required boolean, p_min bigint, p_max bigint)
returns bigint
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v numeric;
begin
  if not (p ? k) or jsonb_typeof(p -> k) = 'null' then
    if p_required then
      raise exception 'INVALID_INPUT' using detail = k;
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> k) <> 'number' then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  v := (p ->> k)::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  return v::bigint;
end;
$fn$;

create or replace function public.budget_arg_int(p jsonb, k text, p_required boolean, p_min integer, p_max integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  return public.budget_arg_amount(p, k, p_required, p_min, p_max)::integer;
end;
$fn$;

create or replace function public.budget_arg_date(p jsonb, k text, p_required boolean)
returns date
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text := public.budget_arg_text(p, k, 10, p_required);
begin
  if v is null then
    return null;
  end if;
  if v !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  begin
    return v::date;
  exception when others then
    raise exception 'INVALID_INPUT' using detail = k;
  end;
end;
$fn$;

create or replace function public.budget_arg_bool(p jsonb, k text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  if not (p ? k) or jsonb_typeof(p -> k) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p -> k) <> 'boolean' then
    raise exception 'INVALID_INPUT' using detail = k;
  end if;
  return (p ->> k)::boolean;
end;
$fn$;

-- Optimistic concurrency: a supplied expectedVersion must match.
create or replace function public.budget_check_version(p jsonb, p_current integer, p_required boolean)
returns void
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v integer := public.budget_arg_int(p, 'expectedVersion', p_required, 1, 2147483647);
begin
  if v is not null and v <> p_current then
    raise exception 'STALE_VERSION';
  end if;
end;
$fn$;

-- ===========================================================================
-- Audit of non-row events (bank reveal, step-up failures).
-- ===========================================================================
create or replace function public.budget_audit_event(p_ws uuid, p_entity_type text, p_entity_id text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor jsonb := public.budget_actor_context();
begin
  if p_ws is distinct from (v_actor ->> 'workspace_id')::uuid then
    raise exception 'BUDGET_WORKSPACE_MISMATCH';
  end if;
  insert into public.budget_audit_events
    (workspace_id, entity_type, entity_id, action, actor_type, actor_id, actor_name, before_data, after_data)
  values (p_ws, p_entity_type, p_entity_id, 'event', v_actor ->> 'type', (v_actor ->> 'id')::uuid,
          v_actor ->> 'name', null, p_detail);
end;
$fn$;

-- ===========================================================================
-- Lazy per-workspace initialisation (settings row, system document types,
-- the current document rules with the 1,500 ILS thresholds). Idempotent.
-- ===========================================================================
create or replace function public.budget_ensure_initialized(p_ws uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_type uuid;
begin
  if exists (select 1 from public.budget_settings s where s.workspace_id = p_ws) then
    return;
  end if;

  insert into public.budget_settings (workspace_id) values (p_ws) on conflict do nothing;
  if not found then
    return; -- a concurrent first call initialised it
  end if;

  insert into public.budget_document_types (workspace_id, key, name, is_system, sort_order)
  values
    (p_ws, 'order_form',              'טופס הזמנה',                      true, 1),
    (p_ws, 'order_form_signed',       'טופס הזמנה חתום ע"י ספק',         true, 2),
    (p_ws, 'quotation',               'הצעת מחיר',                       true, 3),
    (p_ws, 'invoice',                 'חשבונית',                          true, 4),
    (p_ws, 'receipt',                 'קבלה',                             true, 5),
    (p_ws, 'photo',                   'צילום',                            true, 6),
    (p_ws, 'bank_confirmation',       'אישור ניהול חשבון',               true, 7),
    (p_ws, 'payment_confirmation',    'אישור תשלום',                      true, 8),
    (p_ws, 'party_payment_reference', 'אסמכתא לתשלום מהמפלגה',          true, 9),
    (p_ws, 'preapproval',             'אישור תקציבי מוקדם',              true, 10),
    (p_ws, 'other',                   'אחר',                              true, 11);

  -- The current party-funded rules (Stage 1). Thresholds are data.
  insert into public.budget_document_rules (workspace_id, document_type_id, funding_kind, condition, threshold_agorot)
  select p_ws, t.id, 'party', r.condition, r.threshold
  from (values
    ('order_form',        'always',    null::bigint),
    ('order_form_signed', 'amount_gt', 150000::bigint),
    ('quotation',         'always',    null::bigint),
    ('bank_confirmation', 'always',    null::bigint),
    ('invoice',           'amount_gt', 150000::bigint),
    ('photo',             'category',  null::bigint),
    ('photo',             'manual',    null::bigint)
  ) as r(key, condition, threshold)
  join public.budget_document_types t on t.workspace_id = p_ws and t.key = r.key;
end;
$fn$;

-- ===========================================================================
-- Authorizers.
-- ===========================================================================
create or replace function public.budget_set_actor(p_type text, p_id uuid, p_name text, p_ws uuid)
returns void
language plpgsql
set search_path = ''
as $fn$
begin
  perform pg_catalog.set_config('kolbox.budget_actor',
    jsonb_build_object('type', p_type, 'id', p_id, 'name', p_name, 'workspace_id', p_ws)::text, true);
end;
$fn$;

create or replace function public.budget_lock_entitled_workspace(p_ws uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform 1 from public.election_workspaces w where w.id = p_ws for share;
  if not found or not public.budget_workspace_entitled(p_ws) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;
end;
$fn$;

-- The op -> required permission map. A PermissionUser needs budget.view for
-- everything plus ANY ONE of the listed permissions (empty = view only).
create or replace function public.budget_op_permissions(p_op text)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  return case p_op
    when 'session'                  then '{}'::text[]
    when 'get_overview'             then '{}'
    when 'list_sources'             then '{}'
    when 'list_source_adjustments'  then '{}'
    when 'list_categories'          then '{}'
    when 'list_plan_adjustments'    then '{}'
    when 'list_suppliers'           then '{}'
    when 'get_supplier'             then '{}'
    when 'list_expenses'            then '{}'
    when 'get_expense'              then '{}'
    when 'list_history'             then '{}'
    when 'get_settings'             then '{}'
    when 'update_settings'          then '{budget.manageSettings}'
    when 'create_category'          then '{budget.manageSettings}'
    when 'update_category'          then '{budget.manageSettings}'
    when 'delete_category'          then '{budget.manageSettings}'
    when 'reorder_categories'       then '{budget.manageSettings}'
    when 'update_document_rule'     then '{budget.manageSettings}'
    when 'create_source'            then '{budget.managePlan,budget.manageSettings}'
    when 'update_source'            then '{budget.managePlan,budget.manageSettings}'
    when 'adjust_source'            then '{budget.managePlan}'
    when 'set_category_plan'        then '{budget.managePlan}'
    when 'adjust_category_plan'     then '{budget.managePlan}'
    when 'transfer_plan'            then '{budget.managePlan}'
    when 'create_supplier'          then '{budget.manageSuppliers}'
    when 'update_supplier'          then '{budget.manageSuppliers}'
    when 'stepup_check'             then '{budget.manageSuppliers}'
    when 'reveal_supplier_bank'     then '{budget.manageSuppliers}'
    when 'set_supplier_bank'        then '{budget.manageSuppliers}'
    when 'record_stepup_failure'    then '{budget.manageSuppliers}'
    when 'create_expense'           then '{budget.manageExpenses}'
    when 'update_expense'           then '{budget.manageExpenses}'
    when 'transition_expense'       then '{budget.manageExpenses}'
    when 'set_allocation'           then '{budget.manageExpenses}'
    when 'remove_allocation'        then '{budget.manageExpenses}'
    when 'record_payment'           then '{budget.manageExpenses}'
    when 'void_payment'             then '{budget.manageExpenses}'
    when 'record_preapproval'       then '{budget.manageFunderSubmissions}'
    when 'mark_submission_sent'     then '{budget.manageFunderSubmissions}'
    when 'mark_submission_returned' then '{budget.manageFunderSubmissions}'
    when 'record_payment_reference' then '{budget.manageFunderSubmissions}'
    else null
  end;
end;
$fn$;

-- ===========================================================================
-- The calculation layer (one definition; lists, overview and - later -
-- dashboard/reports all read it). Nothing derived is persisted.
-- ===========================================================================
create or replace function public.budget_allocation_facts(p_ws uuid)
returns table (
  allocation_id uuid,
  expense_id uuid,
  funding_source_id uuid,
  kind text,
  payer text,
  amount bigint,
  paid bigint,
  has_preapproval boolean,
  preapproved_amount bigint,
  submission_state text,
  has_reference boolean,
  authorized_amount bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.expense_id, a.funding_source_id, s.kind,
         case when s.kind = 'party' then 'party' else 'campaign' end,
         a.amount_agorot,
         coalesce((select sum(p.amount_agorot) from public.budget_supplier_payments p
                   where p.workspace_id = a.workspace_id and p.allocation_id = a.id
                     and p.voided_at is null), 0)::bigint,
         pa.allocation_id is not null,
         pa.preapproved_amount_agorot,
         sub.state,
         r.allocation_id is not null,
         r.authorized_amount_agorot
  from public.budget_expense_allocations a
  join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
  left join public.budget_party_preapprovals pa on pa.workspace_id = a.workspace_id and pa.allocation_id = a.id
  left join public.budget_party_submissions sub on sub.workspace_id = a.workspace_id and sub.allocation_id = a.id
  left join public.budget_party_payment_references r on r.workspace_id = a.workspace_id and r.allocation_id = a.id
  where a.workspace_id = p_ws;
$fn$;

create or replace function public.budget_expense_facts(p_ws uuid)
returns table (
  expense_id uuid,
  reference_no integer,
  status text,
  description text,
  supplier_id uuid,
  category_id uuid,
  total bigint,
  expense_date date,
  updated_at timestamptz,
  row_version integer,
  allocated bigint,
  unfunded bigint,
  paid bigint,
  outstanding bigint,
  party_allocated bigint,
  party_paid bigint,
  party_outstanding bigint,
  campaign_allocated bigint,
  campaign_paid bigint,
  campaign_outstanding bigint,
  party_authorized bigint,
  payment_status text,
  party_allocations integer,
  awaiting_preapproval integer,
  sent_waiting_reference integer,
  authorized_not_fully_paid integer,
  authorized_unpaid_amount bigint,
  preapproval_exceeded integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with f as (select * from public.budget_allocation_facts(p_ws)),
  agg as (
    select f.expense_id,
      sum(f.amount) as allocated,
      sum(f.paid) as paid,
      sum(f.amount) filter (where f.payer = 'party') as party_allocated,
      sum(f.paid) filter (where f.payer = 'party') as party_paid,
      sum(f.amount) filter (where f.payer = 'campaign') as campaign_allocated,
      sum(f.paid) filter (where f.payer = 'campaign') as campaign_paid,
      sum(f.authorized_amount) filter (where f.has_reference) as party_authorized,
      count(*) filter (where f.kind = 'party') as party_allocations,
      count(*) filter (where f.kind = 'party' and not f.has_preapproval) as awaiting_preapproval,
      count(*) filter (where f.kind = 'party' and f.submission_state = 'sent' and not f.has_reference)
        as sent_waiting_reference,
      count(*) filter (where f.has_reference and f.paid < f.authorized_amount) as authorized_not_fully_paid,
      sum(f.authorized_amount - f.paid) filter (where f.has_reference and f.paid < f.authorized_amount)
        as authorized_unpaid_amount,
      count(*) filter (where f.has_preapproval and f.preapproved_amount is not null
                        and f.amount > f.preapproved_amount) as preapproval_exceeded
    from f group by f.expense_id
  )
  select e.id, e.reference_no, e.status, e.description, e.supplier_id, e.category_id, e.total_agorot,
    e.expense_date, e.updated_at, e.row_version,
    coalesce(agg.allocated, 0)::bigint,
    case when e.total_agorot is null or e.status = 'cancelled' then 0
         else e.total_agorot - coalesce(agg.allocated, 0) end::bigint,
    coalesce(agg.paid, 0)::bigint,
    case when e.status in ('committed', 'incurred') then e.total_agorot - coalesce(agg.paid, 0)
         else 0 end::bigint,
    coalesce(agg.party_allocated, 0)::bigint,
    coalesce(agg.party_paid, 0)::bigint,
    case when e.status in ('committed', 'incurred')
         then coalesce(agg.party_allocated, 0) - coalesce(agg.party_paid, 0) else 0 end::bigint,
    coalesce(agg.campaign_allocated, 0)::bigint,
    coalesce(agg.campaign_paid, 0)::bigint,
    case when e.status in ('committed', 'incurred')
         then coalesce(agg.campaign_allocated, 0) - coalesce(agg.campaign_paid, 0) else 0 end::bigint,
    coalesce(agg.party_authorized, 0)::bigint,
    case when coalesce(agg.paid, 0) = 0 then 'unpaid'
         when e.total_agorot is not null and agg.paid >= e.total_agorot then 'paid'
         else 'partial' end,
    coalesce(agg.party_allocations, 0)::integer,
    case when e.status in ('draft', 'committed', 'incurred') then coalesce(agg.awaiting_preapproval, 0) else 0 end::integer,
    case when e.status in ('committed', 'incurred') then coalesce(agg.sent_waiting_reference, 0) else 0 end::integer,
    case when e.status in ('committed', 'incurred') then coalesce(agg.authorized_not_fully_paid, 0) else 0 end::integer,
    case when e.status in ('committed', 'incurred') then coalesce(agg.authorized_unpaid_amount, 0) else 0 end::bigint,
    coalesce(agg.preapproval_exceeded, 0)::integer
  from public.budget_expenses e
  left join agg on agg.expense_id = e.id
  where e.workspace_id = p_ws;
$fn$;

create or replace function public.budget_source_facts(p_ws uuid)
returns table (
  source_id uuid,
  name text,
  kind text,
  is_active boolean,
  sort_order integer,
  original_amount bigint,
  adjustments bigint,
  current_amount bigint,
  committed bigint,
  actual bigint,
  remaining bigint,
  overrun boolean,
  row_version integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with adj as (
    select d.source_id, sum(d.delta_agorot) as total
    from public.budget_funding_source_adjustments d where d.workspace_id = p_ws group by d.source_id
  ),
  used as (
    select a.funding_source_id,
      sum(a.amount_agorot) filter (where e.status = 'committed') as committed,
      sum(a.amount_agorot) filter (where e.status in ('incurred', 'closed')) as actual
    from public.budget_expense_allocations a
    join public.budget_expenses e on e.workspace_id = a.workspace_id and e.id = a.expense_id
    where a.workspace_id = p_ws
    group by a.funding_source_id
  )
  select s.id, s.name, s.kind, s.is_active, s.sort_order, s.original_amount_agorot,
    coalesce(adj.total, 0)::bigint,
    (s.original_amount_agorot + coalesce(adj.total, 0))::bigint,
    coalesce(used.committed, 0)::bigint,
    coalesce(used.actual, 0)::bigint,
    (s.original_amount_agorot + coalesce(adj.total, 0) - coalesce(used.committed, 0) - coalesce(used.actual, 0))::bigint,
    coalesce(used.committed, 0) + coalesce(used.actual, 0) > s.original_amount_agorot + coalesce(adj.total, 0),
    s.row_version
  from public.budget_funding_sources s
  left join adj on adj.source_id = s.id
  left join used on used.funding_source_id = s.id
  where s.workspace_id = p_ws;
$fn$;

create or replace function public.budget_category_facts(p_ws uuid)
returns table (
  category_id uuid,
  name text,
  sort_order integer,
  is_active boolean,
  original_plan bigint,
  adjustments bigint,
  current_plan bigint,
  committed bigint,
  actual bigint,
  remaining bigint,
  overrun boolean,
  in_use boolean,
  row_version integer
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with adj as (
    select d.category_id, sum(d.delta_agorot) as total
    from public.budget_plan_adjustments d where d.workspace_id = p_ws group by d.category_id
  ),
  used as (
    select e.category_id,
      sum(e.total_agorot) filter (where e.status = 'committed') as committed,
      sum(e.total_agorot) filter (where e.status in ('incurred', 'closed')) as actual,
      count(*) as expenses
    from public.budget_expenses e
    where e.workspace_id = p_ws and e.category_id is not null
    group by e.category_id
  )
  select c.id, c.name, c.sort_order, c.is_active,
    coalesce(pl.original_plan_agorot, 0)::bigint,
    coalesce(adj.total, 0)::bigint,
    (coalesce(pl.original_plan_agorot, 0) + coalesce(adj.total, 0))::bigint,
    coalesce(used.committed, 0)::bigint,
    coalesce(used.actual, 0)::bigint,
    (coalesce(pl.original_plan_agorot, 0) + coalesce(adj.total, 0)
      - coalesce(used.committed, 0) - coalesce(used.actual, 0))::bigint,
    coalesce(used.committed, 0) + coalesce(used.actual, 0)
      > coalesce(pl.original_plan_agorot, 0) + coalesce(adj.total, 0),
    coalesce(used.expenses, 0) > 0 or adj.total is not null or exists (
      select 1 from public.budget_document_rule_categories rc
      where rc.workspace_id = p_ws and rc.category_id = c.id),
    c.row_version
  from public.budget_categories c
  left join public.budget_category_plans pl on pl.workspace_id = c.workspace_id and pl.category_id = c.id
  left join adj on adj.category_id = c.id
  left join used on used.category_id = c.id
  where c.workspace_id = p_ws;
$fn$;

-- One summary object. Every figure is derived from the facts functions above.
create or replace function public.budget_summary(p_ws uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with s as (select * from public.budget_source_facts(p_ws) where is_active),
  c as (select * from public.budget_category_facts(p_ws)),
  e as (select * from public.budget_expense_facts(p_ws)),
  totals as (
    select
      coalesce((select sum(current_amount) from s), 0) as total_budget,
      coalesce((select sum(current_amount) from s where kind = 'party'), 0) as party_budget,
      coalesce((select sum(current_amount) from s where kind = 'donation'), 0) as donation_budget,
      coalesce((select sum(current_amount) from s where kind = 'personal'), 0) as personal_budget,
      coalesce((select sum(total) from e where status = 'committed'), 0) as committed,
      coalesce((select sum(total) from e where status in ('incurred', 'closed')), 0) as actual,
      coalesce((select sum(current_plan) from c), 0) as planned
  )
  select jsonb_build_object(
    'totalBudget', t.total_budget,
    'partyBudget', t.party_budget,
    'donationBudget', t.donation_budget,
    'personalBudget', t.personal_budget,
    'committed', t.committed,
    'actual', t.actual,
    'available', t.total_budget - t.committed - t.actual,
    'plannedInCategories', t.planned,
    'unallocatedPlan', t.total_budget - t.planned,
    'unfundedTotal', coalesce((select sum(unfunded) from e where status in ('committed', 'incurred')), 0),
    'paid', coalesce((select sum(paid) from e where status <> 'cancelled'), 0),
    'outstanding', coalesce((select sum(outstanding) from e), 0),
    'partyOutstanding', coalesce((select sum(party_outstanding) from e), 0),
    'campaignLiability', coalesce((select sum(campaign_outstanding) from e), 0),
    -- Queue counts are EXPENSES (each equals its drill-down list total);
    -- amounts are summed across the expense’s party allocations.
    'authorizedNotFullyPaid', jsonb_build_object(
      'count', (select count(*) from e where authorized_not_fully_paid > 0),
      'amount', coalesce((select sum(authorized_unpaid_amount) from e), 0)),
    'awaitingPreapproval', (select count(*) from e where awaiting_preapproval > 0),
    'sentWaitingReference', (select count(*) from e where sent_waiting_reference > 0),
    'unfundedExpenses', (select count(*) from e where status in ('committed', 'incurred') and unfunded > 0),
    'overrunCategories', (select count(*) from c where overrun),
    'overrunSources', (select count(*) from public.budget_source_facts(p_ws) where overrun)
  )
  from totals t;
$fn$;

-- ===========================================================================
-- Shared lookups (always scoped to the actor’s workspace).
-- ===========================================================================
create or replace function public.budget_expense_for_update(p_ws uuid, p_expense_id uuid)
returns public.budget_expenses
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v public.budget_expenses;
begin
  select * into v from public.budget_expenses e
  where e.workspace_id = p_ws and e.id = p_expense_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;
  return v;
end;
$fn$;

create or replace function public.budget_allocation_row(p_ws uuid, p_allocation_id uuid)
returns table (allocation_id uuid, expense_id uuid, kind text)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
    select a.id, a.expense_id, s.kind
    from public.budget_expense_allocations a
    join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
    where a.workspace_id = p_ws and a.id = p_allocation_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'allocation';
  end if;
end;
$fn$;

create or replace function public.budget_require_open_expense(p_status text)
returns void
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  if p_status not in ('draft', 'committed', 'incurred') then
    raise exception 'EXPENSE_LOCKED';
  end if;
end;
$fn$;

-- ===========================================================================
-- READ operations.
-- ===========================================================================
create or replace function public.budget_op_get_overview(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select public.budget_summary(p_ws);
$fn$;

create or replace function public.budget_op_list_sources(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.source_id, 'name', f.name, 'kind', f.kind, 'isActive', f.is_active, 'sortOrder', f.sort_order,
    'originalAmount', f.original_amount, 'adjustments', f.adjustments, 'currentAmount', f.current_amount,
    'committed', f.committed, 'actual', f.actual, 'remaining', f.remaining, 'overrun', f.overrun,
    'version', f.row_version) order by f.sort_order, f.name), '[]'::jsonb)
  from public.budget_source_facts(p_ws) f;
$fn$;

create or replace function public.budget_op_list_source_adjustments(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', false);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'sourceId', d.source_id, 'delta', d.delta_agorot, 'reason', d.reason,
      'actorName', d.actor_name, 'createdAt', d.created_at) order by d.created_at desc)
    from public.budget_funding_source_adjustments d
    where d.workspace_id = p_ws and (v_source is null or d.source_id = v_source)), '[]'::jsonb);
end;
$fn$;

create or replace function public.budget_op_list_categories(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.category_id, 'name', f.name, 'sortOrder', f.sort_order, 'isActive', f.is_active,
    'originalPlan', f.original_plan, 'adjustments', f.adjustments, 'currentPlan', f.current_plan,
    'committed', f.committed, 'actual', f.actual, 'remaining', f.remaining, 'overrun', f.overrun,
    'inUse', f.in_use, 'version', f.row_version) order by f.sort_order, f.name), '[]'::jsonb)
  from public.budget_category_facts(p_ws) f;
$fn$;

create or replace function public.budget_op_list_plan_adjustments(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_category uuid := public.budget_arg_uuid(p_args, 'categoryId', false);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'categoryId', d.category_id, 'delta', d.delta_agorot, 'kind', d.kind,
      'transferId', d.transfer_id, 'reason', d.reason, 'actorName', d.actor_name,
      'createdAt', d.created_at) order by d.created_at desc, d.id)
    from public.budget_plan_adjustments d
    where d.workspace_id = p_ws and (v_category is null or d.category_id = v_category)), '[]'::jsonb);
end;
$fn$;

create or replace function public.budget_supplier_json(p_ws uuid, p_supplier_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'id', s.id, 'businessName', s.business_name, 'contactName', s.contact_name, 'phone', s.phone,
    'taxId', s.tax_id, 'address', s.address, 'notes', s.notes, 'isActive', s.is_active,
    'version', s.row_version,
    'bank', case when b.supplier_id is null then null
                 else jsonb_build_object('accountLast4', right(b.account_number, 4)) end,
    'expenseCount', (select count(*) from public.budget_expenses e
                     where e.workspace_id = p_ws and e.supplier_id = s.id and e.status <> 'cancelled'),
    'totalAmount', coalesce((select sum(f.total) from public.budget_expense_facts(p_ws) f
                             where f.supplier_id = s.id and f.status in ('committed', 'incurred', 'closed')), 0),
    'outstanding', coalesce((select sum(f.outstanding) from public.budget_expense_facts(p_ws) f
                             where f.supplier_id = s.id), 0),
    'partyOutstanding', coalesce((select sum(f.party_outstanding) from public.budget_expense_facts(p_ws) f
                                  where f.supplier_id = s.id), 0),
    'campaignOutstanding', coalesce((select sum(f.campaign_outstanding) from public.budget_expense_facts(p_ws) f
                                     where f.supplier_id = s.id), 0),
    'unfundedOutstanding', coalesce((select sum(f.unfunded) from public.budget_expense_facts(p_ws) f
                                     where f.supplier_id = s.id and f.status in ('committed', 'incurred')), 0))
  from public.budget_suppliers s
  left join public.budget_supplier_bank_details b on b.workspace_id = s.workspace_id and b.supplier_id = s.id
  where s.workspace_id = p_ws and s.id = p_supplier_id;
$fn$;

create or replace function public.budget_op_list_suppliers(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(public.budget_supplier_json(p_ws, s.id) order by s.business_name), '[]'::jsonb)
  from public.budget_suppliers s where s.workspace_id = p_ws;
$fn$;

create or replace function public.budget_op_get_supplier(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v jsonb := public.budget_supplier_json(p_ws, public.budget_arg_uuid(p_args, 'supplierId', true));
begin
  if v is null then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  return v;
end;
$fn$;

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
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', af.allocation_id, 'sourceId', af.funding_source_id, 'kind', af.kind, 'payer', af.payer,
        'amount', af.amount, 'paid', af.paid, 'version', a.row_version,
        'preapproval', case when pa.allocation_id is null then null else jsonb_build_object(
          'orderNumber', pa.order_number, 'approvalCode', pa.approval_code, 'approverName', pa.approver_name,
          'approvalDate', pa.approval_date, 'preapprovedAmount', pa.preapproved_amount_agorot,
          'version', pa.row_version) end,
        'submission', case when af.kind <> 'party' then null else jsonb_build_object(
          'state', coalesce(sub.state, 'not_sent'),
          'displayState', case
            when r.allocation_id is not null then 'reference_received'
            when pa.allocation_id is null then 'awaiting_preapproval'
            when sub.state = 'sent' then 'sent'
            when sub.state = 'returned' then 'returned'
            else 'preapproved' end,
          'requestedAmount', sub.requested_amount_agorot, 'lastSentAt', sub.last_sent_at,
          'lastReturnedAt', sub.last_returned_at) end,
        'reference', case when r.allocation_id is null then null else jsonb_build_object(
          'referenceNumber', r.reference_number, 'authorizedAmount', r.authorized_amount_agorot,
          'receivedDate', r.received_date, 'version', r.row_version) end,
        'paymentStatus', case when af.paid = 0 then 'unpaid' when af.paid >= af.amount then 'paid'
                              else 'partial' end
      ) order by a.created_at)
      from public.budget_allocation_facts(p_ws) af
      join public.budget_expense_allocations a on a.workspace_id = p_ws and a.id = af.allocation_id
      left join public.budget_party_preapprovals pa on pa.workspace_id = p_ws and pa.allocation_id = af.allocation_id
      left join public.budget_party_submissions sub on sub.workspace_id = p_ws and sub.allocation_id = af.allocation_id
      left join public.budget_party_payment_references r on r.workspace_id = p_ws and r.allocation_id = af.allocation_id
      where af.expense_id = e.id), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'allocationId', p.allocation_id, 'amount', p.amount_agorot, 'paymentDate', p.payment_date,
        'payer', p.payer, 'confirmationSource', p.confirmation_source,
        'externalReference', p.external_reference, 'note', p.note, 'recordedByName', p.recorded_by_name,
        'recordedAt', p.recorded_at, 'voidedAt', p.voided_at, 'voidReason', p.void_reason)
        order by p.payment_date, p.recorded_at)
      from public.budget_supplier_payments p
      where p.workspace_id = p_ws and p.expense_id = e.id), '[]'::jsonb),
    'submissionEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'allocationId', ev.allocation_id, 'event', ev.event,
        'recipientPhone', ev.recipient_phone, 'note', ev.note, 'actorName', ev.actor_name,
        'createdAt', ev.created_at) order by ev.created_at)
      from public.budget_party_submission_events ev
      join public.budget_expense_allocations a2 on a2.workspace_id = ev.workspace_id and a2.id = ev.allocation_id
      where ev.workspace_id = p_ws and a2.expense_id = e.id), '[]'::jsonb))
  from public.budget_expenses e
  where e.workspace_id = p_ws and e.id = p_expense_id;
$fn$;

create or replace function public.budget_op_get_expense(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v jsonb := public.budget_expense_json(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
begin
  if v is null then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;
  return v;
end;
$fn$;

create or replace function public.budget_op_list_expenses(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_status text := public.budget_arg_text(p_args, 'status', 20, false);
  v_category uuid := public.budget_arg_uuid(p_args, 'categoryId', false);
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', false);
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', false);
  v_queue text := public.budget_arg_text(p_args, 'queue', 40, false);
  v_search text := public.budget_arg_text(p_args, 'search', 100, false);
  v_from date := public.budget_arg_date(p_args, 'from', false);
  v_to date := public.budget_arg_date(p_args, 'to', false);
  v_limit integer := coalesce(public.budget_arg_int(p_args, 'limit', false, 1, 200), 50);
  v_offset integer := coalesce(public.budget_arg_int(p_args, 'offset', false, 0, 1000000), 0);
  v_rows jsonb;
  v_count bigint;
  v_sum bigint;
begin
  if v_status is not null and v_status not in ('draft', 'committed', 'incurred', 'closed', 'cancelled') then
    raise exception 'INVALID_INPUT' using detail = 'status';
  end if;
  if v_queue is not null and v_queue not in (
    'awaiting_preapproval', 'sent_waiting_reference', 'authorized_not_fully_paid', 'unfunded', 'unpaid') then
    raise exception 'INVALID_INPUT' using detail = 'queue';
  end if;

  with filtered as (
    select f.*
    from public.budget_expense_facts(p_ws) f
    left join public.budget_suppliers s on s.workspace_id = p_ws and s.id = f.supplier_id
    where (v_status is null or f.status = v_status)
      and (v_category is null or f.category_id = v_category)
      and (v_supplier is null or f.supplier_id = v_supplier)
      and (v_source is null or exists (
            select 1 from public.budget_expense_allocations a
            where a.workspace_id = p_ws and a.expense_id = f.expense_id and a.funding_source_id = v_source))
      and (v_from is null or f.expense_date >= v_from)
      and (v_to is null or f.expense_date <= v_to)
      and (v_search is null or f.description ilike '%' || v_search || '%'
           or s.business_name ilike '%' || v_search || '%' or f.reference_no::text = v_search)
      and (v_queue is null
           or (v_queue = 'awaiting_preapproval' and f.awaiting_preapproval > 0)
           or (v_queue = 'sent_waiting_reference' and f.sent_waiting_reference > 0)
           or (v_queue = 'authorized_not_fully_paid' and f.authorized_not_fully_paid > 0)
           or (v_queue = 'unfunded' and f.status in ('committed', 'incurred') and f.unfunded > 0)
           or (v_queue = 'unpaid' and f.outstanding > 0))
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
        'authorizedNotFullyPaid', x.authorized_not_fully_paid, 'version', x.row_version))
      from (select * from filtered order by expense_date desc nulls last, reference_no desc
            limit v_limit offset v_offset) x), '[]'::jsonb)
  into v_count, v_sum, v_rows;

  return jsonb_build_object('total', v_count, 'totalAmount', v_sum, 'rows', v_rows);
end;
$fn$;

create or replace function public.budget_op_list_history(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_type text := public.budget_arg_text(p_args, 'entityType', 60, true);
  v_id uuid := public.budget_arg_uuid(p_args, 'entityId', true);
begin
  if v_type = 'expense' then
    if not exists (select 1 from public.budget_expenses e where e.workspace_id = p_ws and e.id = v_id) then
      raise exception 'NOT_FOUND' using detail = 'expense';
    end if;
    -- The expense row plus everything hanging off it.
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'entityType', ev.entity_type, 'action', ev.action, 'actorType', ev.actor_type,
        'actorName', ev.actor_name, 'before', ev.before_data, 'after', ev.after_data,
        'occurredAt', ev.occurred_at) order by ev.id)
      from public.budget_audit_events ev
      where ev.workspace_id = p_ws
        and ((ev.entity_type = 'budget_expenses' and ev.entity_id = v_id::text)
          or coalesce(ev.after_data, ev.before_data) ->> 'expense_id' = v_id::text
          or (coalesce(ev.after_data, ev.before_data) ->> 'allocation_id') in (
               select a.id::text from public.budget_expense_allocations a
               where a.workspace_id = p_ws and a.expense_id = v_id))), '[]'::jsonb);
  elsif v_type = 'supplier' then
    if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_id) then
      raise exception 'NOT_FOUND' using detail = 'supplier';
    end if;
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ev.id, 'entityType', ev.entity_type, 'action', ev.action, 'actorType', ev.actor_type,
        'actorName', ev.actor_name, 'before', ev.before_data, 'after', ev.after_data,
        'occurredAt', ev.occurred_at) order by ev.id)
      from public.budget_audit_events ev
      where ev.workspace_id = p_ws
        and ev.entity_type in ('budget_suppliers', 'budget_supplier_bank_details', 'supplier')
        and ev.entity_id = v_id::text), '[]'::jsonb);
  else
    raise exception 'INVALID_INPUT' using detail = 'entityType';
  end if;
end;
$fn$;

create or replace function public.budget_op_get_settings(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'periodStart', s.period_start, 'periodEnd', s.period_end,
    'branchName', s.branch_name, 'branchNumber', s.branch_number, 'defaultOrderer', s.default_orderer,
    'electionYearLabel', s.election_year_label, 'funderHeaderLines', to_jsonb(s.funder_header_lines),
    'whatsappFunderPhone', s.whatsapp_funder_phone,
    'whatsappSupplierTemplate', s.whatsapp_supplier_template,
    'whatsappFunderTemplate', s.whatsapp_funder_template,
    'alertMissingDocsDays', s.alert_missing_docs_days, 'alertSupplierFormDays', s.alert_supplier_form_days,
    'alertNoReferenceDays', s.alert_no_reference_days, 'alertUnpaidDays', s.alert_unpaid_days,
    'alertSupplierDocExpiryDays', s.alert_supplier_doc_expiry_days,
    'categoryUsageWarningPct', s.category_usage_warning_pct, 'version', s.row_version,
    'documentTypes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'key', t.key, 'name', t.name, 'isSystem', t.is_system, 'isActive', t.is_active,
        'sortOrder', t.sort_order) order by t.sort_order)
      from public.budget_document_types t where t.workspace_id = p_ws), '[]'::jsonb),
    'documentRules', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'documentTypeId', r.document_type_id, 'documentTypeKey', t.key,
        'fundingKind', r.funding_kind, 'condition', r.condition, 'threshold', r.threshold_agorot,
        'isActive', r.is_active, 'version', r.row_version,
        'categoryIds', coalesce((select jsonb_agg(rc.category_id)
                                 from public.budget_document_rule_categories rc
                                 where rc.workspace_id = p_ws and rc.rule_id = r.id), '[]'::jsonb))
        order by t.sort_order, r.condition)
      from public.budget_document_rules r
      join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
      where r.workspace_id = p_ws), '[]'::jsonb))
  from public.budget_settings s where s.workspace_id = p_ws;
$fn$;

-- ===========================================================================
-- SETTINGS operations.
-- ===========================================================================
create or replace function public.budget_op_update_settings(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_settings;
  v_lines text[];
begin
  select * into v from public.budget_settings s where s.workspace_id = p_ws for update;
  perform public.budget_check_version(p_args, v.row_version, false);

  if p_args ? 'funderHeaderLines' then
    if jsonb_typeof(p_args -> 'funderHeaderLines') <> 'array'
       or jsonb_array_length(p_args -> 'funderHeaderLines') > 6 then
      raise exception 'INVALID_INPUT' using detail = 'funderHeaderLines';
    end if;
    select coalesce(array_agg(btrim(x)), '{}') into v_lines
    from jsonb_array_elements_text(p_args -> 'funderHeaderLines') x;
    if exists (select 1 from unnest(v_lines) l where length(l) > 200) then
      raise exception 'INVALID_INPUT' using detail = 'funderHeaderLines';
    end if;
  end if;

  update public.budget_settings s set
    period_start = case when p_args ? 'periodStart' then public.budget_arg_date(p_args, 'periodStart', false) else s.period_start end,
    period_end = case when p_args ? 'periodEnd' then public.budget_arg_date(p_args, 'periodEnd', false) else s.period_end end,
    branch_name = case when p_args ? 'branchName' then public.budget_arg_text(p_args, 'branchName', 200, false) else s.branch_name end,
    branch_number = case when p_args ? 'branchNumber' then public.budget_arg_text(p_args, 'branchNumber', 50, false) else s.branch_number end,
    default_orderer = case when p_args ? 'defaultOrderer' then public.budget_arg_text(p_args, 'defaultOrderer', 200, false) else s.default_orderer end,
    election_year_label = case when p_args ? 'electionYearLabel' then public.budget_arg_text(p_args, 'electionYearLabel', 50, false) else s.election_year_label end,
    funder_header_lines = case when p_args ? 'funderHeaderLines' then v_lines else s.funder_header_lines end,
    whatsapp_funder_phone = case when p_args ? 'whatsappFunderPhone' then public.budget_arg_text(p_args, 'whatsappFunderPhone', 32, false) else s.whatsapp_funder_phone end,
    whatsapp_supplier_template = case when p_args ? 'whatsappSupplierTemplate' then public.budget_arg_text(p_args, 'whatsappSupplierTemplate', 1000, false) else s.whatsapp_supplier_template end,
    whatsapp_funder_template = case when p_args ? 'whatsappFunderTemplate' then public.budget_arg_text(p_args, 'whatsappFunderTemplate', 1000, false) else s.whatsapp_funder_template end,
    alert_missing_docs_days = coalesce(public.budget_arg_int(p_args, 'alertMissingDocsDays', false, 0, 365), s.alert_missing_docs_days),
    alert_supplier_form_days = coalesce(public.budget_arg_int(p_args, 'alertSupplierFormDays', false, 0, 365), s.alert_supplier_form_days),
    alert_no_reference_days = coalesce(public.budget_arg_int(p_args, 'alertNoReferenceDays', false, 0, 365), s.alert_no_reference_days),
    alert_unpaid_days = coalesce(public.budget_arg_int(p_args, 'alertUnpaidDays', false, 0, 365), s.alert_unpaid_days),
    alert_supplier_doc_expiry_days = coalesce(public.budget_arg_int(p_args, 'alertSupplierDocExpiryDays', false, 0, 365), s.alert_supplier_doc_expiry_days),
    category_usage_warning_pct = coalesce(public.budget_arg_int(p_args, 'categoryUsageWarningPct', false, 1, 100), s.category_usage_warning_pct)
  where s.workspace_id = p_ws;

  return public.budget_op_get_settings(p_ws, p_actor, '{}'::jsonb);
end;
$fn$;

create or replace function public.budget_op_create_category(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_name text := public.budget_arg_text(p_args, 'name', 100, true);
  v_id uuid;
begin
  if exists (select 1 from public.budget_categories c where c.workspace_id = p_ws and c.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  insert into public.budget_categories (workspace_id, name, sort_order)
  values (p_ws, v_name, coalesce((select max(c.sort_order) + 1 from public.budget_categories c
                                  where c.workspace_id = p_ws), 1))
  returning id into v_id;
  insert into public.budget_category_plans (workspace_id, category_id) values (p_ws, v_id);
  return jsonb_build_object('id', v_id);
end;
$fn$;

create or replace function public.budget_op_update_category(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_categories;
  v_name text := public.budget_arg_text(p_args, 'name', 100, false);
  v_active boolean := public.budget_arg_bool(p_args, 'isActive');
begin
  select * into v from public.budget_categories c
  where c.workspace_id = p_ws and c.id = public.budget_arg_uuid(p_args, 'categoryId', true) for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  perform public.budget_check_version(p_args, v.row_version, false);
  if v_name is not null and v_name <> v.name and exists (
    select 1 from public.budget_categories c where c.workspace_id = p_ws and c.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  update public.budget_categories c
  set name = coalesce(v_name, c.name), is_active = coalesce(v_active, c.is_active)
  where c.workspace_id = p_ws and c.id = v.id;
  return jsonb_build_object('id', v.id);
end;
$fn$;

-- "Delete only if unused": the RESTRICT foreign keys are the real guard; this
-- reports it as CATEGORY_IN_USE instead of a raw constraint error.
create or replace function public.budget_op_delete_category(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'categoryId', true);
begin
  perform 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = v_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  if exists (select 1 from public.budget_expenses e where e.workspace_id = p_ws and e.category_id = v_id)
     or exists (select 1 from public.budget_plan_adjustments d where d.workspace_id = p_ws and d.category_id = v_id)
     or exists (select 1 from public.budget_document_rule_categories rc where rc.workspace_id = p_ws and rc.category_id = v_id)
     or exists (select 1 from public.budget_category_plans pl
                where pl.workspace_id = p_ws and pl.category_id = v_id and pl.original_plan_agorot <> 0)
  then
    raise exception 'CATEGORY_IN_USE';
  end if;
  delete from public.budget_categories c where c.workspace_id = p_ws and c.id = v_id;
  return jsonb_build_object('id', v_id);
end;
$fn$;

create or replace function public.budget_op_reorder_categories(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_ids uuid[];
begin
  if jsonb_typeof(p_args -> 'categoryIds') <> 'array' then
    raise exception 'INVALID_INPUT' using detail = 'categoryIds';
  end if;
  begin
    select array_agg(x::uuid order by ord) into v_ids
    from jsonb_array_elements_text(p_args -> 'categoryIds') with ordinality as t(x, ord);
  exception when others then
    raise exception 'INVALID_INPUT' using detail = 'categoryIds';
  end;
  -- Must be exactly this workspace’s categories, each once.
  if coalesce(array_length(v_ids, 1), 0) <> (select count(*) from public.budget_categories c where c.workspace_id = p_ws)
     or (select count(distinct x) from unnest(v_ids) x) <> coalesce(array_length(v_ids, 1), 0)
     or exists (select 1 from unnest(v_ids) x
                where not exists (select 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = x))
  then
    raise exception 'REORDER_ID_MISMATCH';
  end if;
  update public.budget_categories c
  set sort_order = t.ord
  from unnest(v_ids) with ordinality as t(id, ord)
  where c.workspace_id = p_ws and c.id = t.id and c.sort_order is distinct from t.ord;
  return jsonb_build_object('ok', true);
end;
$fn$;

create or replace function public.budget_op_update_document_rule(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_document_rules;
  v_threshold bigint := public.budget_arg_amount(p_args, 'threshold', false, 0, 1000000000000);
  v_active boolean := public.budget_arg_bool(p_args, 'isActive');
  v_ids uuid[];
begin
  select * into v from public.budget_document_rules r
  where r.workspace_id = p_ws and r.id = public.budget_arg_uuid(p_args, 'ruleId', true) for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'rule';
  end if;
  perform public.budget_check_version(p_args, v.row_version, false);
  if v_threshold is not null and v.condition not in ('amount_gt', 'amount_gte') then
    raise exception 'INVALID_INPUT' using detail = 'threshold';
  end if;
  update public.budget_document_rules r
  set threshold_agorot = coalesce(v_threshold, r.threshold_agorot), is_active = coalesce(v_active, r.is_active)
  where r.workspace_id = p_ws and r.id = v.id;

  if p_args ? 'categoryIds' then
    if v.condition <> 'category' or jsonb_typeof(p_args -> 'categoryIds') <> 'array' then
      raise exception 'INVALID_INPUT' using detail = 'categoryIds';
    end if;
    begin
      select coalesce(array_agg(distinct x::uuid), '{}') into v_ids
      from jsonb_array_elements_text(p_args -> 'categoryIds') x;
    exception when others then
      raise exception 'INVALID_INPUT' using detail = 'categoryIds';
    end;
    if exists (select 1 from unnest(v_ids) x
               where not exists (select 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = x)) then
      raise exception 'NOT_FOUND' using detail = 'category';
    end if;
    delete from public.budget_document_rule_categories rc
    where rc.workspace_id = p_ws and rc.rule_id = v.id and rc.category_id <> all (v_ids);
    insert into public.budget_document_rule_categories (workspace_id, rule_id, category_id)
    select p_ws, v.id, x from unnest(v_ids) x on conflict do nothing;
  end if;
  return jsonb_build_object('id', v.id);
end;
$fn$;

-- ===========================================================================
-- PLAN operations (sources, adjustments, category plans, transfers).
-- ===========================================================================
create or replace function public.budget_op_create_source(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_name text := public.budget_arg_text(p_args, 'name', 100, true);
  v_kind text := public.budget_arg_text(p_args, 'kind', 20, true);
  v_amount bigint := coalesce(public.budget_arg_amount(p_args, 'originalAmount', false, 0, 1000000000000), 0);
  v_id uuid;
begin
  if v_kind not in ('party', 'donation', 'personal') then
    raise exception 'INVALID_INPUT' using detail = 'kind';
  end if;
  -- Money is plan authority: a settings-only user may create a source (name,
  -- kind) but only budget.managePlan (or the Owner) may give it an amount.
  if v_amount <> 0 and not ((p_actor -> 'permissions') ? 'budget.managePlan') then
    raise exception 'FORBIDDEN';
  end if;
  if exists (select 1 from public.budget_funding_sources s where s.workspace_id = p_ws and s.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  insert into public.budget_funding_sources (workspace_id, name, kind, original_amount_agorot, sort_order)
  values (p_ws, v_name, v_kind, v_amount,
          coalesce((select max(s.sort_order) + 1 from public.budget_funding_sources s where s.workspace_id = p_ws), 1))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$fn$;

-- Name / kind / active / sort. The ORIGINAL amount changes only while the
-- source has no adjustment yet (after that, every change is an adjustment).
create or replace function public.budget_op_update_source(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_funding_sources;
  v_name text := public.budget_arg_text(p_args, 'name', 100, false);
  v_kind text := public.budget_arg_text(p_args, 'kind', 20, false);
  v_active boolean := public.budget_arg_bool(p_args, 'isActive');
  v_amount bigint := public.budget_arg_amount(p_args, 'originalAmount', false, 0, 1000000000000);
begin
  select * into v from public.budget_funding_sources s
  where s.workspace_id = p_ws and s.id = public.budget_arg_uuid(p_args, 'sourceId', true) for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'source';
  end if;
  perform public.budget_check_version(p_args, v.row_version, false);
  if v_kind is not null and v_kind not in ('party', 'donation', 'personal') then
    raise exception 'INVALID_INPUT' using detail = 'kind';
  end if;
  if v_name is not null and v_name <> v.name and exists (
    select 1 from public.budget_funding_sources s where s.workspace_id = p_ws and s.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  if v_amount is not null and v_amount <> v.original_amount_agorot then
    -- Money is plan authority (a settings-only user edits name/kind/active).
    if not ((p_actor -> 'permissions') ? 'budget.managePlan') then
      raise exception 'FORBIDDEN';
    end if;
    if exists (select 1 from public.budget_funding_source_adjustments d
               where d.workspace_id = p_ws and d.source_id = v.id) then
      raise exception 'ORIGINAL_LOCKED';
    end if;
  end if;
  update public.budget_funding_sources s set
    name = coalesce(v_name, s.name),
    kind = coalesce(v_kind, s.kind),
    is_active = coalesce(v_active, s.is_active),
    original_amount_agorot = coalesce(v_amount, s.original_amount_agorot),
    sort_order = coalesce(public.budget_arg_int(p_args, 'sortOrder', false, 0, 100000), s.sort_order)
  where s.workspace_id = p_ws and s.id = v.id;
  return jsonb_build_object('id', v.id);
end;
$fn$;

create or replace function public.budget_op_adjust_source(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'sourceId', true);
  v_delta bigint := public.budget_arg_amount(p_args, 'delta', true, -1000000000000, 1000000000000);
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, true);
  v_current bigint;
begin
  if v_delta = 0 then
    raise exception 'INVALID_INPUT' using detail = 'delta';
  end if;
  perform 1 from public.budget_funding_sources s where s.workspace_id = p_ws and s.id = v_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'source';
  end if;
  select f.current_amount into v_current from public.budget_source_facts(p_ws) f where f.source_id = v_id;
  if v_current + v_delta < 0 then
    raise exception 'AMOUNT_BELOW_ZERO';
  end if;
  insert into public.budget_funding_source_adjustments
    (workspace_id, source_id, delta_agorot, reason, actor_type, actor_id, actor_name)
  values (p_ws, v_id, v_delta, v_reason, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return jsonb_build_object('currentAmount', v_current + v_delta);
end;
$fn$;

create or replace function public.budget_op_set_category_plan(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'categoryId', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'originalPlan', true, 0, 1000000000000);
begin
  perform 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = v_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  if exists (select 1 from public.budget_plan_adjustments d where d.workspace_id = p_ws and d.category_id = v_id) then
    raise exception 'ORIGINAL_LOCKED';
  end if;
  insert into public.budget_category_plans (workspace_id, category_id, original_plan_agorot)
  values (p_ws, v_id, v_amount)
  on conflict (workspace_id, category_id)
  do update set original_plan_agorot = excluded.original_plan_agorot
  where public.budget_category_plans.original_plan_agorot is distinct from excluded.original_plan_agorot;
  return jsonb_build_object('categoryId', v_id, 'originalPlan', v_amount);
end;
$fn$;

create or replace function public.budget_op_adjust_category_plan(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'categoryId', true);
  v_delta bigint := public.budget_arg_amount(p_args, 'delta', true, -1000000000000, 1000000000000);
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, true);
  v_plan bigint;
begin
  if v_delta = 0 then
    raise exception 'INVALID_INPUT' using detail = 'delta';
  end if;
  insert into public.budget_category_plans (workspace_id, category_id)
  select p_ws, c.id from public.budget_categories c where c.workspace_id = p_ws and c.id = v_id
  on conflict do nothing;
  perform 1 from public.budget_category_plans pl where pl.workspace_id = p_ws and pl.category_id = v_id for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  select f.current_plan into v_plan from public.budget_category_facts(p_ws) f where f.category_id = v_id;
  if v_plan + v_delta < 0 then
    raise exception 'AMOUNT_BELOW_ZERO';
  end if;
  insert into public.budget_plan_adjustments
    (workspace_id, category_id, delta_agorot, kind, reason, actor_type, actor_id, actor_name)
  values (p_ws, v_id, v_delta, case when v_delta > 0 then 'increase' else 'decrease' end, v_reason,
          p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return jsonb_build_object('currentPlan', v_plan + v_delta);
end;
$fn$;

-- Transfer: capped at the source category’s UNUSED plan, both plan rows locked
-- in a fixed order, so two concurrent transfers can never spend the same
-- unused amount twice.
create or replace function public.budget_op_transfer_plan(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_from uuid := public.budget_arg_uuid(p_args, 'fromCategoryId', true);
  v_to uuid := public.budget_arg_uuid(p_args, 'toCategoryId', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'amount', true, 1, 1000000000000);
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, true);
  v_unused bigint;
  v_transfer uuid := gen_random_uuid();
begin
  if v_from = v_to then
    raise exception 'INVALID_INPUT' using detail = 'toCategoryId';
  end if;
  insert into public.budget_category_plans (workspace_id, category_id)
  select p_ws, c.id from public.budget_categories c where c.workspace_id = p_ws and c.id in (v_from, v_to)
  on conflict do nothing;
  if (select count(*) from public.budget_category_plans pl
      where pl.workspace_id = p_ws and pl.category_id in (v_from, v_to)) <> 2 then
    raise exception 'NOT_FOUND' using detail = 'category';
  end if;
  perform 1 from public.budget_category_plans pl
  where pl.workspace_id = p_ws and pl.category_id in (v_from, v_to)
  order by pl.category_id for update;

  select f.remaining into v_unused from public.budget_category_facts(p_ws) f where f.category_id = v_from;
  if v_amount > v_unused then
    raise exception 'INSUFFICIENT_PLAN';
  end if;
  insert into public.budget_plan_adjustments
    (workspace_id, category_id, delta_agorot, kind, transfer_id, reason, actor_type, actor_id, actor_name)
  values
    (p_ws, v_from, -v_amount, 'transfer', v_transfer, v_reason, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name'),
    (p_ws, v_to, v_amount, 'transfer', v_transfer, v_reason, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return jsonb_build_object('transferId', v_transfer);
end;
$fn$;

-- ===========================================================================
-- SUPPLIER operations (bank details only through the step-up ops).
-- ===========================================================================
create or replace function public.budget_normalize_tax_id(p text)
returns text language sql immutable set search_path = '' as $fn$
  select nullif(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g'), '');
$fn$;

create or replace function public.budget_op_create_supplier(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_tax text := public.budget_normalize_tax_id(public.budget_arg_text(p_args, 'taxId', 20, false));
  v_id uuid;
  v_existing uuid;
begin
  if v_tax is not null then
    if v_tax !~ '^[0-9]{5,12}$' then
      raise exception 'INVALID_INPUT' using detail = 'taxId';
    end if;
    select s.id into v_existing from public.budget_suppliers s where s.workspace_id = p_ws and s.tax_id = v_tax;
    if v_existing is not null then
      raise exception 'DUPLICATE_TAX_ID' using detail = v_existing::text;
    end if;
  end if;
  insert into public.budget_suppliers (workspace_id, business_name, contact_name, phone, tax_id, address, notes)
  values (p_ws,
    public.budget_arg_text(p_args, 'businessName', 200, true),
    public.budget_arg_text(p_args, 'contactName', 200, false),
    public.budget_arg_text(p_args, 'phone', 32, false),
    v_tax,
    public.budget_arg_text(p_args, 'address', 300, false),
    public.budget_arg_text(p_args, 'notes', 2000, false))
  returning id into v_id;
  return public.budget_supplier_json(p_ws, v_id);
end;
$fn$;

create or replace function public.budget_op_update_supplier(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_suppliers;
  v_tax text;
  v_existing uuid;
begin
  select * into v from public.budget_suppliers s
  where s.workspace_id = p_ws and s.id = public.budget_arg_uuid(p_args, 'supplierId', true) for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  perform public.budget_check_version(p_args, v.row_version, false);
  if p_args ? 'taxId' then
    v_tax := public.budget_normalize_tax_id(public.budget_arg_text(p_args, 'taxId', 20, false));
    if v_tax is not null and v_tax !~ '^[0-9]{5,12}$' then
      raise exception 'INVALID_INPUT' using detail = 'taxId';
    end if;
    select s.id into v_existing from public.budget_suppliers s
    where s.workspace_id = p_ws and s.tax_id = v_tax and s.id <> v.id;
    if v_existing is not null then
      raise exception 'DUPLICATE_TAX_ID' using detail = v_existing::text;
    end if;
  end if;
  update public.budget_suppliers s set
    business_name = coalesce(public.budget_arg_text(p_args, 'businessName', 200, false), s.business_name),
    contact_name = case when p_args ? 'contactName' then public.budget_arg_text(p_args, 'contactName', 200, false) else s.contact_name end,
    phone = case when p_args ? 'phone' then public.budget_arg_text(p_args, 'phone', 32, false) else s.phone end,
    tax_id = case when p_args ? 'taxId' then v_tax else s.tax_id end,
    address = case when p_args ? 'address' then public.budget_arg_text(p_args, 'address', 300, false) else s.address end,
    notes = case when p_args ? 'notes' then public.budget_arg_text(p_args, 'notes', 2000, false) else s.notes end,
    is_active = coalesce(public.budget_arg_bool(p_args, 'isActive'), s.is_active)
  where s.workspace_id = p_ws and s.id = v.id;
  return public.budget_supplier_json(p_ws, v.id);
end;
$fn$;

-- Step-up action literal: budget_bank_<reveal|change>:<supplier uuid>.
create or replace function public.budget_stepup_action(p_kind text, p_supplier uuid)
returns text language sql immutable set search_path = '' as $fn$
  select 'budget_bank_' || p_kind || ':' || p_supplier::text;
$fn$;

create or replace function public.budget_op_stepup_check(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_kind text := public.budget_arg_text(p_args, 'kind', 10, true);
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', true);
begin
  if v_kind not in ('reveal', 'change') then
    raise exception 'INVALID_INPUT' using detail = 'kind';
  end if;
  if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  -- actorId is not a secret: the endpoint uses it only as the rate-limit bucket.
  return jsonb_build_object('action', public.budget_stepup_action(v_kind, v_supplier),
                            'actorId', p_actor ->> 'id');
end;
$fn$;

-- Consumes ONE step-up proof bound to {principal, workspace, action}. Worker
-- proofs live in election_day_reauth_proofs (minted by budget_stepup_mint_worker
-- with the shared credential check); Owner proofs in
-- election_owner_reauth_proofs (minted by the existing election_day_owner_reauth
-- after a Supabase Auth password check). Only the proof’s sha256 is stored;
-- the DELETE ... RETURNING is the verification, so it is single-use.
create or replace function public.budget_consume_stepup(p_ws uuid, p_actor jsonb, p_args jsonb, p_action text)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_hash_hex text := public.budget_arg_text(p_args, 'proofHash', 64, false);
  v_hash bytea;
  v_hit uuid;
begin
  if v_hash_hex is null or v_hash_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'STEPUP_REQUIRED';
  end if;
  v_hash := decode(v_hash_hex, 'hex');
  if p_actor ->> 'type' = 'worker' then
    delete from public.election_day_reauth_proofs p
    where p.proof_hash = v_hash and p.action = p_action and p.expires_at > now()
      and p.actor_id = (p_actor ->> 'id')::uuid and p.workspace_id = p_ws
    returning p.id into v_hit;
  else
    delete from public.election_owner_reauth_proofs p
    where p.proof_hash = v_hash and p.action = p_action and p.expires_at > now()
      and p.owner_id = (p_actor ->> 'id')::uuid and p.workspace_id = p_ws
    returning p.id into v_hit;
  end if;
  if v_hit is null then
    raise exception 'STEPUP_REQUIRED';
  end if;
end;
$fn$;

create or replace function public.budget_op_reveal_supplier_bank(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', true);
  v public.budget_supplier_bank_details;
begin
  if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  perform public.budget_consume_stepup(p_ws, p_actor, p_args, public.budget_stepup_action('reveal', v_supplier));
  select * into v from public.budget_supplier_bank_details b where b.workspace_id = p_ws and b.supplier_id = v_supplier;
  perform public.budget_audit_event(p_ws, 'supplier', v_supplier::text,
    jsonb_build_object('event', 'bank_revealed', 'hadDetails', v.supplier_id is not null));
  if v.supplier_id is null then
    return jsonb_build_object('bank', null);
  end if;
  return jsonb_build_object('bank', jsonb_build_object(
    'bankCode', v.bank_code, 'branchCode', v.branch_code, 'accountNumber', v.account_number,
    'accountHolder', v.account_holder));
end;
$fn$;

create or replace function public.budget_op_set_supplier_bank(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', true);
  v_account text := regexp_replace(coalesce(public.budget_arg_text(p_args, 'accountNumber', 30, true), ''), '[\s-]', '', 'g');
  v_bank text := public.budget_arg_text(p_args, 'bankCode', 3, false);
  v_branch text := public.budget_arg_text(p_args, 'branchCode', 5, false);
begin
  if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  if v_account !~ '^[0-9]{2,20}$' then
    raise exception 'INVALID_INPUT' using detail = 'accountNumber';
  end if;
  if v_bank is not null and v_bank !~ '^[0-9]{1,3}$' then
    raise exception 'INVALID_INPUT' using detail = 'bankCode';
  end if;
  if v_branch is not null and v_branch !~ '^[0-9]{1,5}$' then
    raise exception 'INVALID_INPUT' using detail = 'branchCode';
  end if;
  perform public.budget_consume_stepup(p_ws, p_actor, p_args, public.budget_stepup_action('change', v_supplier));
  insert into public.budget_supplier_bank_details (workspace_id, supplier_id, bank_code, branch_code, account_number, account_holder)
  values (p_ws, v_supplier, v_bank, v_branch, v_account, public.budget_arg_text(p_args, 'accountHolder', 200, false))
  on conflict (workspace_id, supplier_id) do update set
    bank_code = excluded.bank_code, branch_code = excluded.branch_code,
    account_number = excluded.account_number, account_holder = excluded.account_holder;
  return jsonb_build_object('bank', jsonb_build_object('accountLast4', right(v_account, 4)));
end;
$fn$;

create or replace function public.budget_op_record_stepup_failure(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_kind text := public.budget_arg_text(p_args, 'kind', 10, true);
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', true);
  v_reason text := public.budget_arg_text(p_args, 'reason', 30, true);
begin
  if v_kind not in ('reveal', 'change') or v_reason not in ('invalid_password', 'rate_limited') then
    raise exception 'INVALID_INPUT';
  end if;
  if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  perform public.budget_audit_event(p_ws, 'supplier', v_supplier::text,
    jsonb_build_object('event', 'stepup_failed', 'kind', v_kind, 'reason', v_reason));
  return jsonb_build_object('ok', true);
end;
$fn$;

-- ===========================================================================
-- EXPENSE operations.
-- ===========================================================================
create or replace function public.budget_validate_expense_refs(p_ws uuid, p_supplier uuid, p_category uuid, p_new boolean)
returns void language plpgsql stable security definer set search_path = '' as $fn$
begin
  if p_supplier is not null then
    if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = p_supplier) then
      raise exception 'NOT_FOUND' using detail = 'supplier';
    end if;
    if p_new and not exists (select 1 from public.budget_suppliers s
                             where s.workspace_id = p_ws and s.id = p_supplier and s.is_active) then
      raise exception 'SUPPLIER_INACTIVE';
    end if;
  end if;
  if p_category is not null then
    if not exists (select 1 from public.budget_categories c where c.workspace_id = p_ws and c.id = p_category) then
      raise exception 'NOT_FOUND' using detail = 'category';
    end if;
    if p_new and not exists (select 1 from public.budget_categories c
                             where c.workspace_id = p_ws and c.id = p_category and c.is_active) then
      raise exception 'CATEGORY_INACTIVE';
    end if;
  end if;
end;
$fn$;

create or replace function public.budget_op_create_expense(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_supplier uuid := public.budget_arg_uuid(p_args, 'supplierId', false);
  v_category uuid := public.budget_arg_uuid(p_args, 'categoryId', false);
  v_ref integer;
  v_id uuid;
begin
  perform public.budget_validate_expense_refs(p_ws, v_supplier, v_category, true);
  update public.budget_settings s set next_expense_ref = s.next_expense_ref + 1
  where s.workspace_id = p_ws returning s.next_expense_ref - 1 into v_ref;
  insert into public.budget_expenses (workspace_id, reference_no, description, supplier_id, category_id,
    total_agorot, net_agorot, vat_agorot, vat_rate_bp, expense_date, delivery_date, invoice_date, notes)
  values (p_ws, v_ref,
    public.budget_arg_text(p_args, 'description', 500, true), v_supplier, v_category,
    public.budget_arg_amount(p_args, 'total', false, 1, 1000000000000),
    public.budget_arg_amount(p_args, 'net', false, 0, 1000000000000),
    public.budget_arg_amount(p_args, 'vat', false, 0, 1000000000000),
    public.budget_arg_int(p_args, 'vatRateBp', false, 0, 10000),
    public.budget_arg_date(p_args, 'expenseDate', false),
    public.budget_arg_date(p_args, 'deliveryDate', false),
    public.budget_arg_date(p_args, 'invoiceDate', false),
    public.budget_arg_text(p_args, 'notes', 4000, false))
  returning id into v_id;
  return public.budget_expense_json(p_ws, v_id);
end;
$fn$;

create or replace function public.budget_op_update_expense(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_supplier uuid := case when p_args ? 'supplierId' then public.budget_arg_uuid(p_args, 'supplierId', false) else v.supplier_id end;
  v_category uuid := case when p_args ? 'categoryId' then public.budget_arg_uuid(p_args, 'categoryId', false) else v.category_id end;
begin
  perform public.budget_check_version(p_args, v.row_version, true);
  perform public.budget_require_open_expense(v.status);
  perform public.budget_validate_expense_refs(p_ws,
    case when v_supplier is distinct from v.supplier_id then v_supplier end,
    case when v_category is distinct from v.category_id then v_category end, true);
  update public.budget_expenses e set
    description = coalesce(public.budget_arg_text(p_args, 'description', 500, false), e.description),
    supplier_id = v_supplier,
    category_id = v_category,
    total_agorot = case when p_args ? 'total' then public.budget_arg_amount(p_args, 'total', false, 1, 1000000000000) else e.total_agorot end,
    net_agorot = case when p_args ? 'net' then public.budget_arg_amount(p_args, 'net', false, 0, 1000000000000) else e.net_agorot end,
    vat_agorot = case when p_args ? 'vat' then public.budget_arg_amount(p_args, 'vat', false, 0, 1000000000000) else e.vat_agorot end,
    vat_rate_bp = case when p_args ? 'vatRateBp' then public.budget_arg_int(p_args, 'vatRateBp', false, 0, 10000) else e.vat_rate_bp end,
    expense_date = case when p_args ? 'expenseDate' then public.budget_arg_date(p_args, 'expenseDate', false) else e.expense_date end,
    delivery_date = case when p_args ? 'deliveryDate' then public.budget_arg_date(p_args, 'deliveryDate', false) else e.delivery_date end,
    invoice_date = case when p_args ? 'invoiceDate' then public.budget_arg_date(p_args, 'invoiceDate', false) else e.invoice_date end,
    notes = case when p_args ? 'notes' then public.budget_arg_text(p_args, 'notes', 4000, false) else e.notes end
  where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- The close guard (Stage 3 part; Stage 4 adds documents / order form).
-- Returns the list of unmet conditions; empty = closable.
create or replace function public.budget_close_blockers(p_ws uuid, p_expense_id uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_out text[] := '{}';
  f record;
begin
  select * into f from public.budget_expense_facts(p_ws) x where x.expense_id = p_expense_id;
  if f.total is null or f.allocated <> f.total then
    v_out := array_append(v_out, 'FUNDING_NOT_RECONCILED');
  end if;
  if f.total is null or f.paid <> f.total then
    v_out := array_append(v_out, 'SUPPLIER_NOT_FULLY_PAID');
  end if;
  if exists (select 1 from public.budget_allocation_facts(p_ws) a
             where a.expense_id = p_expense_id and a.kind = 'party' and not a.has_preapproval) then
    v_out := array_append(v_out, 'PARTY_PREAPPROVAL_MISSING');
  end if;
  if exists (select 1 from public.budget_allocation_facts(p_ws) a
             where a.expense_id = p_expense_id and a.kind = 'party' and not a.has_reference) then
    v_out := array_append(v_out, 'PARTY_REFERENCE_MISSING');
  end if;
  if exists (select 1 from public.budget_allocation_facts(p_ws) a
             where a.expense_id = p_expense_id and a.paid <> a.amount) then
    v_out := array_append(v_out, 'ALLOCATION_NOT_FULLY_PAID');
  end if;
  return v_out;
end;
$fn$;

create or replace function public.budget_op_transition_expense(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_to text := public.budget_arg_text(p_args, 'toStatus', 20, true);
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, false);
  v_blockers text[];
begin
  perform public.budget_check_version(p_args, v.row_version, true);

  if not (
       (v.status = 'draft' and v_to in ('committed', 'incurred', 'cancelled'))
    or (v.status = 'committed' and v_to in ('incurred', 'cancelled'))
    or (v.status = 'incurred' and v_to in ('closed', 'cancelled'))
    or (v.status = 'closed' and v_to = 'incurred')
  ) then
    raise exception 'INVALID_TRANSITION';
  end if;

  if v_to = 'cancelled' and v.status <> 'draft' and v_reason is null then
    raise exception 'REASON_REQUIRED';
  end if;
  if v.status = 'closed' and v_reason is null then
    raise exception 'REASON_REQUIRED';
  end if;

  if v.status = 'draft' and v_to in ('committed', 'incurred') then
    if v.supplier_id is null or v.category_id is null or v.total_agorot is null or v.expense_date is null then
      raise exception 'EXPENSE_INCOMPLETE';
    end if;
    if not exists (select 1 from public.budget_expense_allocations a
                   where a.workspace_id = p_ws and a.expense_id = v.id) then
      raise exception 'ALLOCATION_REQUIRED';
    end if;
  end if;

  if v_to = 'cancelled' and exists (
    select 1 from public.budget_supplier_payments p
    where p.workspace_id = p_ws and p.expense_id = v.id and p.voided_at is null) then
    raise exception 'PAYMENTS_EXIST';
  end if;

  if v_to = 'closed' then
    v_blockers := public.budget_close_blockers(p_ws, v.id);
    if cardinality(v_blockers) > 0 then
      raise exception 'CLOSE_BLOCKED' using detail = array_to_string(v_blockers, ',');
    end if;
  end if;

  update public.budget_expenses e set
    status = v_to,
    status_reason = v_reason,
    closed_at = case when v_to = 'closed' then now() else null end
  where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- Upsert the allocation of ONE source on ONE expense. The client chooses the
-- source; nothing is ever assigned automatically.
create or replace function public.budget_op_set_allocation(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_source uuid := public.budget_arg_uuid(p_args, 'sourceId', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'amount', true, 1, 1000000000000);
  v_kind text;
  v_active boolean;
  v_alloc public.budget_expense_allocations;
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
    end if;
    update public.budget_expense_allocations a set amount_agorot = v_amount
    where a.workspace_id = p_ws and a.id = v_alloc.id and a.amount_agorot <> v_amount;
  end if;
  -- Touch the expense so a concurrent editor holding an older version sees a conflict.
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

create or replace function public.budget_op_remove_allocation(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid;
  v_expense uuid;
  v_kind text;
  v public.budget_expenses;
begin
  select r.allocation_id, r.expense_id, r.kind into v_alloc, v_expense, v_kind
  from public.budget_allocation_row(p_ws, public.budget_arg_uuid(p_args, 'allocationId', true)) r;
  v := public.budget_expense_for_update(p_ws, v_expense);
  perform public.budget_check_version(p_args, v.row_version, false);
  perform public.budget_require_open_expense(v.status);
  if exists (select 1 from public.budget_party_preapprovals pa where pa.workspace_id = p_ws and pa.allocation_id = v_alloc)
     or exists (select 1 from public.budget_party_submission_events ev where ev.workspace_id = p_ws and ev.allocation_id = v_alloc)
     or exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc)
  then
    raise exception 'ALLOCATION_HAS_PARTY_WORKFLOW';
  end if;
  if exists (select 1 from public.budget_supplier_payments p where p.workspace_id = p_ws and p.allocation_id = v_alloc) then
    raise exception 'ALLOCATION_HAS_PAYMENTS';
  end if;
  if (v.status <> 'draft') and (select count(*) from public.budget_expense_allocations x
                                where x.workspace_id = p_ws and x.expense_id = v.id) = 1 then
    raise exception 'ALLOCATION_REQUIRED';
  end if;
  delete from public.budget_party_submissions sub where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  delete from public.budget_expense_allocations x where x.workspace_id = p_ws and x.id = v_alloc;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

create or replace function public.budget_op_record_payment(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid;
  v_expense uuid;
  v_kind text;
  v public.budget_expenses;
  v_key uuid := public.budget_arg_uuid(p_args, 'idempotencyKey', true);
  v_amount bigint := public.budget_arg_amount(p_args, 'amount', true, 1, 1000000000000);
  v_existing public.budget_supplier_payments;
  v_source text := public.budget_arg_text(p_args, 'confirmationSource', 30, true);
begin
  select r.allocation_id, r.expense_id, r.kind into v_alloc, v_expense, v_kind
  from public.budget_allocation_row(p_ws, public.budget_arg_uuid(p_args, 'allocationId', true)) r;

  -- Serialize on the expense first, so a concurrent replay of the same
  -- idempotency key waits and then sees the first request’s row.
  v := public.budget_expense_for_update(p_ws, v_expense);

  -- Replayed request (same idempotency key): return what it did the first time.
  select * into v_existing from public.budget_supplier_payments p
  where p.workspace_id = p_ws and p.idempotency_key = v_key;
  if v_existing.id is not null then
    if v_existing.allocation_id <> v_alloc or v_existing.amount_agorot <> v_amount then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return public.budget_expense_json(p_ws, v_existing.expense_id);
  end if;

  if v.status not in ('committed', 'incurred') then
    raise exception 'EXPENSE_NOT_PAYABLE';
  end if;
  if v_source not in ('funder_notice', 'supplier_confirmation', 'bank_transfer', 'other') then
    raise exception 'INVALID_INPUT' using detail = 'confirmationSource';
  end if;
  if v_kind = 'party' and not exists (
    select 1 from public.budget_party_payment_references r
    where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'PARTY_REFERENCE_REQUIRED';
  end if;

  insert into public.budget_supplier_payments (workspace_id, expense_id, allocation_id, amount_agorot, payment_date,
    payer, confirmation_source, external_reference, note, idempotency_key,
    recorded_by_type, recorded_by_id, recorded_by_name)
  values (p_ws, v.id, v_alloc, v_amount, public.budget_arg_date(p_args, 'paymentDate', true),
    case when v_kind = 'party' then 'party' else 'campaign' end,
    v_source,
    public.budget_arg_text(p_args, 'externalReference', 100, false),
    public.budget_arg_text(p_args, 'note', 1000, false),
    v_key, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

create or replace function public.budget_op_void_payment(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_payment public.budget_supplier_payments;
  v public.budget_expenses;
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, true);
begin
  select * into v_payment from public.budget_supplier_payments p
  where p.workspace_id = p_ws and p.id = public.budget_arg_uuid(p_args, 'paymentId', true);
  if not found then
    raise exception 'NOT_FOUND' using detail = 'payment';
  end if;
  v := public.budget_expense_for_update(p_ws, v_payment.expense_id);
  perform public.budget_require_open_expense(v.status);
  if v_payment.voided_at is not null then
    raise exception 'PAYMENT_ALREADY_VOIDED';
  end if;
  update public.budget_supplier_payments p
  set voided_at = now(), voided_by_name = p_actor ->> 'name', void_reason = v_reason
  where p.workspace_id = p_ws and p.id = v_payment.id;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- PARTY WORKFLOW operations (prior approval, submission, payment reference).
-- ===========================================================================
create or replace function public.budget_party_allocation_locked(p_ws uuid, p_allocation uuid)
returns public.budget_expenses language plpgsql security definer set search_path = '' as $fn$
declare
  v_expense uuid;
  v_kind text;
  v public.budget_expenses;
begin
  select r.expense_id, r.kind into v_expense, v_kind
  from public.budget_allocation_row(p_ws, p_allocation) r;
  if v_kind <> 'party' then
    raise exception 'NOT_A_PARTY_ALLOCATION';
  end if;
  v := public.budget_expense_for_update(p_ws, v_expense);
  perform public.budget_require_open_expense(v.status);
  return v;
end;
$fn$;

-- Records (or corrects) the prior budget approval. It is NOT the later payment
-- reference. Corrections stay possible until a payment reference exists.
create or replace function public.budget_op_record_preapproval(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_existing public.budget_party_preapprovals;
begin
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'PREAPPROVAL_LOCKED';
  end if;
  select * into v_existing from public.budget_party_preapprovals pa
  where pa.workspace_id = p_ws and pa.allocation_id = v_alloc for update;
  if v_existing.allocation_id is not null then
    perform public.budget_check_version(p_args, v_existing.row_version, true);
  end if;
  insert into public.budget_party_preapprovals (workspace_id, allocation_id, order_number, approval_code,
    approver_name, approval_date, preapproved_amount_agorot)
  values (p_ws, v_alloc,
    public.budget_arg_text(p_args, 'orderNumber', 100, false),
    public.budget_arg_text(p_args, 'approvalCode', 100, true),
    public.budget_arg_text(p_args, 'approverName', 200, true),
    public.budget_arg_date(p_args, 'approvalDate', true),
    public.budget_arg_amount(p_args, 'preapprovedAmount', false, 1, 1000000000000))
  on conflict (workspace_id, allocation_id) do update set
    order_number = excluded.order_number, approval_code = excluded.approval_code,
    approver_name = excluded.approver_name, approval_date = excluded.approval_date,
    preapproved_amount_agorot = excluded.preapproved_amount_agorot;
  insert into public.budget_party_submissions (workspace_id, allocation_id) values (p_ws, v_alloc)
  on conflict do nothing;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- Sent to the party. Requires the prior approval (Stage 4 adds the
-- required-documents gate). "Sent" is the user’s own confirmation - delivery
-- is never claimed.
create or replace function public.budget_op_mark_submission_sent(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_sub public.budget_party_submissions;
begin
  -- The prior budget approval is THE gate before anything goes out; it is
  -- checked first so the answer names the step the user still owes.
  if not exists (select 1 from public.budget_party_preapprovals pa where pa.workspace_id = p_ws and pa.allocation_id = v_alloc) then
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
  update public.budget_party_submissions sub set
    state = 'sent', last_sent_at = now(),
    requested_amount_agorot = (select a.amount_agorot from public.budget_expense_allocations a
                               where a.workspace_id = p_ws and a.id = v_alloc)
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  insert into public.budget_party_submission_events (workspace_id, allocation_id, event, recipient_phone, note,
    actor_type, actor_id, actor_name)
  values (p_ws, v_alloc, 'sent', public.budget_arg_text(p_args, 'recipientPhone', 32, false),
    public.budget_arg_text(p_args, 'note', 1000, false),
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

create or replace function public.budget_op_mark_submission_returned(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_note text := public.budget_arg_text(p_args, 'note', 1000, true);
begin
  if exists (select 1 from public.budget_party_payment_references r where r.workspace_id = p_ws and r.allocation_id = v_alloc) then
    raise exception 'INVALID_TRANSITION';
  end if;
  perform 1 from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc and sub.state = 'sent' for update;
  if not found then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.budget_party_submissions sub set state = 'returned', last_returned_at = now()
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc;
  insert into public.budget_party_submission_events (workspace_id, allocation_id, event, note, actor_type, actor_id, actor_name)
  values (p_ws, v_alloc, 'returned', v_note, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- The party’s payment reference with the AUTHORIZED amount. The allocation
-- becomes exactly the authorized amount (never more than was requested); a
-- lower authorization leaves an explicit unfunded gap on the SAME expense for
-- the user to fund from a source they choose. Correctable until the first
-- party payment.
create or replace function public.budget_op_record_payment_reference(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_alloc uuid := public.budget_arg_uuid(p_args, 'allocationId', true);
  v public.budget_expenses := public.budget_party_allocation_locked(p_ws, v_alloc);
  v_authorized bigint := public.budget_arg_amount(p_args, 'authorizedAmount', true, 1, 1000000000000);
  v_sub public.budget_party_submissions;
  v_ref public.budget_party_payment_references;
  v_cap bigint;
begin
  select * into v_sub from public.budget_party_submissions sub
  where sub.workspace_id = p_ws and sub.allocation_id = v_alloc for update;
  select * into v_ref from public.budget_party_payment_references r
  where r.workspace_id = p_ws and r.allocation_id = v_alloc for update;

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
    authorized_amount_agorot, received_date)
  values (p_ws, v_alloc,
    public.budget_arg_text(p_args, 'referenceNumber', 100, true), v_authorized,
    public.budget_arg_date(p_args, 'receivedDate', true))
  on conflict (workspace_id, allocation_id) do update set
    reference_number = excluded.reference_number,
    authorized_amount_agorot = excluded.authorized_amount_agorot,
    received_date = excluded.received_date;

  update public.budget_expense_allocations a set amount_agorot = v_authorized
  where a.workspace_id = p_ws and a.id = v_alloc and a.amount_agorot <> v_authorized;
  update public.budget_expenses e set updated_at = now() where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- ===========================================================================
-- Session info (navigation metadata only).
-- ===========================================================================
create or replace function public.budget_op_session(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'actorType', p_actor ->> 'type',
    'actorName', p_actor ->> 'name',
    'workspaceName', (select w.name from public.election_workspaces w where w.id = p_ws),
    'permissions', p_actor -> 'permissions',
    'modules', to_jsonb(public.election_day_workspace_worker_modules(p_ws)));
$fn$;

-- ===========================================================================
-- The dispatchers (the ONLY functions reachable by the Budget endpoint).
-- ===========================================================================
create or replace function public.budget_run_op(p_ws uuid, p_actor jsonb, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_result jsonb;
begin
  -- p_op was validated against budget_op_permissions’ fixed list by the caller,
  -- so this dynamic call can only ever name a budget_op_* function.
  execute format('select public.%I($1, $2, $3)', 'budget_op_' || p_op)
    into v_result using p_ws, p_actor, coalesce(p_args, '{}'::jsonb);
  return v_result;
end;
$fn$;

create or replace function public.budget_dispatch_worker(p_session_hash bytea, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_needed text[] := public.budget_op_permissions(p_op);
  v_actor_id uuid;
  v_actor_name text;
  v_role_id uuid;
  v_ws uuid;
  v_perms text[];
  v_actor jsonb;
begin
  if v_needed is null then
    raise exception 'UNKNOWN_OP';
  end if;
  if p_args is not null and jsonb_typeof(p_args) <> 'object' then
    raise exception 'INVALID_INPUT';
  end if;

  select r.actor_id, r.actor_name, r.role_id, r.workspace_id
    into v_actor_id, v_actor_name, v_role_id, v_ws
  from public.workspace_resolve_session(p_session_hash) r;

  perform public.budget_lock_entitled_workspace(v_ws);

  select coalesce(ro.permissions, '{}') into v_perms
  from public.election_day_roles ro where ro.id = v_role_id and ro.workspace_id = v_ws;
  if not ('budget.view' = any(coalesce(v_perms, '{}'))) then
    raise exception 'FORBIDDEN';
  end if;
  if cardinality(v_needed) > 0 and not (v_perms && v_needed) then
    raise exception 'FORBIDDEN';
  end if;

  perform public.budget_set_actor('worker', v_actor_id, v_actor_name, v_ws);
  -- The read-only session/navigation op never writes; every other op may
  -- lazily create the workspace settings on first use.
  if p_op <> 'session' then
    perform public.budget_ensure_initialized(v_ws);
  end if;

  v_actor := jsonb_build_object('type', 'worker', 'id', v_actor_id, 'name', v_actor_name,
    'permissions', to_jsonb(array(select p from unnest(v_perms) p where p like 'budget.%' order by p)));
  return public.budget_run_op(v_ws, v_actor, p_op, p_args);
end;
$fn$;

create or replace function public.budget_dispatch_owner(p_auth_user_id uuid, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_needed text[] := public.budget_op_permissions(p_op);
  v_owner_id uuid;
  v_owner_name text;
  v_ws uuid;
  v_actor jsonb;
begin
  if v_needed is null then
    raise exception 'UNKNOWN_OP';
  end if;
  if p_args is not null and jsonb_typeof(p_args) <> 'object' then
    raise exception 'INVALID_INPUT';
  end if;
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select o.id, o.name, o.workspace_id into v_owner_id, v_owner_name, v_ws
  from public.election_owners o where o.auth_user_id = p_auth_user_id;
  if v_owner_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  perform public.budget_lock_entitled_workspace(v_ws);
  perform public.budget_set_actor('owner', v_owner_id, v_owner_name, v_ws);
  if p_op <> 'session' then
    perform public.budget_ensure_initialized(v_ws);
  end if;

  -- The Owner holds intrinsic authority over the workspace’s Budget.
  v_actor := jsonb_build_object('type', 'owner', 'id', v_owner_id, 'name', v_owner_name,
    'permissions', to_jsonb(array['budget.manageExpenses', 'budget.manageFunderSubmissions', 'budget.managePlan',
      'budget.manageSettings', 'budget.manageSuppliers', 'budget.view', 'budget.viewReports']));
  return public.budget_run_op(v_ws, v_actor, p_op, p_args);
end;
$fn$;

-- Worker step-up mint: the SAME credential check as login/reauth, a proof
-- bound to {actor, workspace, budget_bank_<kind>:<supplier>} in the SAME proof
-- table the Election Day reauth uses (only its sha256), 5-minute expiry,
-- consumed once by budget_consume_stepup. Module-neutral session resolution, so
-- a Budget-only worker can step up; Budget entitlement + manageSuppliers are
-- still required. Election Day consumers match only their own exact actions.
create or replace function public.budget_stepup_mint_worker(
  p_session_hash bytea,
  p_password text,
  p_kind text,
  p_supplier_id uuid,
  p_proof_hash bytea
)
returns table (actor_id uuid, workspace_id uuid, action text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_id uuid;
  v_role_id uuid;
  v_ws uuid;
  v_perms text[];
  v_action text;
  v_expires timestamptz;
begin
  if p_proof_hash is null or p_kind not in ('reveal', 'change') or p_supplier_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select r.actor_id, r.role_id, r.workspace_id into v_actor_id, v_role_id, v_ws
  from public.workspace_resolve_session(p_session_hash) r;

  perform public.budget_lock_entitled_workspace(v_ws);

  select coalesce(ro.permissions, '{}') into v_perms
  from public.election_day_roles ro where ro.id = v_role_id and ro.workspace_id = v_ws;
  if not ('budget.view' = any(v_perms) and 'budget.manageSuppliers' = any(v_perms)) then
    raise exception 'FORBIDDEN';
  end if;
  if not exists (select 1 from public.budget_suppliers s where s.workspace_id = v_ws and s.id = p_supplier_id) then
    raise exception 'NOT_FOUND';
  end if;

  if not public.election_day_verify_permission_user_password(v_actor_id, p_password) then
    raise exception 'UNAUTHORIZED';
  end if;

  v_action := public.budget_stepup_action(p_kind, p_supplier_id);
  delete from public.election_day_reauth_proofs p
  where p.actor_id = v_actor_id and p.action = v_action and p.expires_at < now();
  v_expires := now() + interval '5 minutes';
  insert into public.election_day_reauth_proofs (actor_id, workspace_id, action, proof_hash, expires_at)
  values (v_actor_id, v_ws, v_action, p_proof_hash, v_expires);
  return query select v_actor_id, v_ws, v_action, v_expires;
end;
$fn$;

-- ===========================================================================
-- ACL: the two dispatchers + the worker step-up mint are service_role-only;
-- every other function in this migration is granted to no role at all.
-- ===========================================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
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
