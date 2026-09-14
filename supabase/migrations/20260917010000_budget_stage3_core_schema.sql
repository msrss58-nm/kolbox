-- Budget Stage 3 (B/3) - the Budget core schema.
--
-- Financial data, so every protection that can live in the database does:
--   * ISOLATION: every table carries workspace_id and every parent -> child
--     link is a COMPOSITE foreign key (workspace_id, x_id) -> (workspace_id,
--     id), so a row can never reference another workspace’s row.
--   * ACCESS: RLS enabled with zero policies and every table privilege revoked
--     from PUBLIC/anon/authenticated AND service_role. Only the SECURITY
--     DEFINER functions of migration C (owned by postgres) read or write.
--   * MONEY: bigint agorot, never floating point; every amount is bounded
--     (10^12 agorot = 10 billion ILS per row) and signed only where a delta.
--   * HISTORY: an AFTER trigger on every table writes budget_audit_events,
--     taking the actor from the transaction-local setting kolbox.budget_actor
--     that only the migration-C authorizers set. A write without that context
--     (or for another workspace than the actor’s) is REFUSED, so nothing can
--     write Budget data around the authorized functions. Audit rows,
--     adjustments, submission events and payments are append-only.
--
-- Stage 4 (documents, storage, order forms) adds its own tables later; the
-- document-type / rule tables here are configuration only (thresholds).
--
-- MANUAL ROLLBACK (only with zero Budget data; revert migration C first):
--   begin;
--   drop table if exists public.budget_supplier_payments, public.budget_party_payment_references,
--     public.budget_party_submission_events, public.budget_party_submissions,
--     public.budget_party_preapprovals, public.budget_expense_allocations, public.budget_expenses,
--     public.budget_document_rule_categories, public.budget_document_rules, public.budget_document_types,
--     public.budget_supplier_bank_details, public.budget_suppliers,
--     public.budget_funding_source_adjustments, public.budget_funding_sources,
--     public.budget_plan_adjustments, public.budget_category_plans, public.budget_categories,
--     public.budget_settings, public.budget_audit_events cascade;
--   drop function if exists public.budget_audit_row(), public.budget_refuse_mutation(),
--     public.budget_payments_guard(), public.budget_allocations_check(),
--     public.budget_expense_amounts_check(), public.budget_source_kind_guard(),
--     public.budget_party_allocation_guard(), public.budget_actor_context();
--   commit;

begin;

-- ===========================================================================
-- Actor context (set by migration C’s authorizers, transaction-local).
-- ===========================================================================
create or replace function public.budget_actor_context()
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v text := current_setting('kolbox.budget_actor', true);
begin
  if v is null or v = '' then
    raise exception 'BUDGET_ACTOR_CONTEXT_REQUIRED';
  end if;
  return v::jsonb;
end;
$fn$;

revoke all on function public.budget_actor_context() from public;
revoke all on function public.budget_actor_context() from anon;
revoke all on function public.budget_actor_context() from authenticated;
revoke all on function public.budget_actor_context() from service_role;

-- ===========================================================================
-- Audit history (append-only).
-- ===========================================================================
create table public.budget_audit_events (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.election_workspaces (id) on delete cascade,
  entity_type   text not null,
  entity_id     text not null,
  action        text not null check (action in ('insert', 'update', 'delete', 'event')),
  actor_type    text not null check (actor_type in ('worker', 'owner')),
  actor_id      uuid not null,
  actor_name    text not null,
  before_data   jsonb,
  after_data    jsonb,
  occurred_at   timestamptz not null default now()
);
create index budget_audit_events_entity_idx
  on public.budget_audit_events (workspace_id, entity_type, entity_id, id);

comment on table public.budget_audit_events is
  'Budget Stage 3: append-only financial history. Written ONLY by the budget_audit_row trigger (row changes) and budget_audit_event (non-row events such as bank reveal / step-up failure). UPDATE/DELETE/TRUNCATE refused. Bank-detail values are never stored (last 4 digits + changed flag only).';

create or replace function public.budget_refuse_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BUDGET_APPEND_ONLY: % on %', tg_op, tg_table_name;
end;
$fn$;

revoke all on function public.budget_refuse_mutation() from public;
revoke all on function public.budget_refuse_mutation() from anon;
revoke all on function public.budget_refuse_mutation() from authenticated;
revoke all on function public.budget_refuse_mutation() from service_role;

create trigger budget_audit_events_no_update before update or delete on public.budget_audit_events
  for each row execute function public.budget_refuse_mutation();
create trigger budget_audit_events_no_truncate before truncate on public.budget_audit_events
  for each statement execute function public.budget_refuse_mutation();

-- Row-change audit. The actor context is REQUIRED and must be for the row’s
-- own workspace - the defence in depth behind the migration-C authorizers.
create or replace function public.budget_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor jsonb := public.budget_actor_context();
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ws uuid := (v_row ->> 'workspace_id')::uuid;
  v_entity text;
begin
  if v_ws is distinct from (v_actor ->> 'workspace_id')::uuid then
    raise exception 'BUDGET_WORKSPACE_MISMATCH';
  end if;

  v_entity := coalesce(
    v_row ->> 'id', v_row ->> 'allocation_id', v_row ->> 'supplier_id',
    v_row ->> 'category_id', v_row ->> 'rule_id', v_row ->> 'workspace_id'
  );

  -- Bank details: never copy account data into history.
  if tg_table_name = 'budget_supplier_bank_details' then
    v_new := case when v_new is null then null else jsonb_build_object(
      'supplier_id', v_new ->> 'supplier_id',
      'account_last4', right(coalesce(v_new ->> 'account_number', ''), 4)) end;
    v_old := case when v_old is null then null else jsonb_build_object(
      'supplier_id', v_old ->> 'supplier_id',
      'account_last4', right(coalesce(v_old ->> 'account_number', ''), 4)) end;
  end if;

  insert into public.budget_audit_events
    (workspace_id, entity_type, entity_id, action, actor_type, actor_id, actor_name, before_data, after_data)
  values (
    v_ws, tg_table_name, v_entity, lower(tg_op),
    v_actor ->> 'type', (v_actor ->> 'id')::uuid, v_actor ->> 'name', v_old, v_new
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$fn$;

revoke all on function public.budget_audit_row() from public;
revoke all on function public.budget_audit_row() from anon;
revoke all on function public.budget_audit_row() from authenticated;
revoke all on function public.budget_audit_row() from service_role;

-- ===========================================================================
-- Settings (one row per workspace; lazily created by migration C).
-- ===========================================================================
create table public.budget_settings (
  workspace_id                  uuid primary key references public.election_workspaces (id) on delete cascade,
  period_start                  date,
  period_end                    date,
  next_expense_ref              integer not null default 1 check (next_expense_ref > 0),
  branch_name                   text,
  branch_number                 text,
  default_orderer               text,
  election_year_label           text,
  funder_header_lines           text[] not null default '{}',
  whatsapp_funder_phone         text,
  whatsapp_supplier_template    text,
  whatsapp_funder_template      text,
  alert_missing_docs_days       integer not null default 7 check (alert_missing_docs_days between 0 and 365),
  alert_supplier_form_days      integer not null default 7 check (alert_supplier_form_days between 0 and 365),
  alert_no_reference_days       integer not null default 14 check (alert_no_reference_days between 0 and 365),
  alert_unpaid_days             integer not null default 14 check (alert_unpaid_days between 0 and 365),
  alert_supplier_doc_expiry_days integer not null default 30 check (alert_supplier_doc_expiry_days between 0 and 365),
  category_usage_warning_pct    integer not null default 90 check (category_usage_warning_pct between 1 and 100),
  row_version                   integer not null default 1,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint budget_settings_period_check
    check (period_start is null or period_end is null or period_end >= period_start)
);

-- ===========================================================================
-- Categories and plans.
-- ===========================================================================
create table public.budget_categories (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.election_workspaces (id) on delete cascade,
  name          text not null check (btrim(name) <> '' and length(name) <= 100),
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  row_version   integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint budget_categories_workspace_id_id_key unique (workspace_id, id),
  constraint budget_categories_workspace_name_key unique (workspace_id, name)
);

create table public.budget_category_plans (
  workspace_id          uuid not null,
  category_id           uuid not null,
  original_plan_agorot  bigint not null default 0 check (original_plan_agorot between 0 and 1000000000000),
  row_version           integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (workspace_id, category_id),
  constraint budget_category_plans_category_fkey foreign key (workspace_id, category_id)
    references public.budget_categories (workspace_id, id) on delete cascade
);

create table public.budget_plan_adjustments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  category_id   uuid not null,
  delta_agorot  bigint not null check (delta_agorot <> 0 and abs(delta_agorot) <= 1000000000000),
  kind          text not null check (kind in ('increase', 'decrease', 'transfer')),
  transfer_id   uuid,
  reason        text not null check (btrim(reason) <> '' and length(reason) <= 500),
  actor_type    text not null,
  actor_id      uuid not null,
  actor_name    text not null,
  created_at    timestamptz not null default now(),
  constraint budget_plan_adjustments_category_fkey foreign key (workspace_id, category_id)
    references public.budget_categories (workspace_id, id) on delete restrict,
  constraint budget_plan_adjustments_transfer_check check ((kind = 'transfer') = (transfer_id is not null)),
  constraint budget_plan_adjustments_sign_check check (
    (kind <> 'increase' or delta_agorot > 0) and (kind <> 'decrease' or delta_agorot < 0))
);
create index budget_plan_adjustments_category_idx on public.budget_plan_adjustments (workspace_id, category_id);

-- ===========================================================================
-- Funding sources.
-- ===========================================================================
create table public.budget_funding_sources (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.election_workspaces (id) on delete cascade,
  name                    text not null check (btrim(name) <> '' and length(name) <= 100),
  kind                    text not null check (kind in ('party', 'donation', 'personal')),
  original_amount_agorot  bigint not null default 0 check (original_amount_agorot between 0 and 1000000000000),
  is_active               boolean not null default true,
  sort_order              integer not null default 0,
  row_version             integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint budget_funding_sources_workspace_id_id_key unique (workspace_id, id),
  constraint budget_funding_sources_workspace_name_key unique (workspace_id, name)
);

create table public.budget_funding_source_adjustments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  source_id     uuid not null,
  delta_agorot  bigint not null check (delta_agorot <> 0 and abs(delta_agorot) <= 1000000000000),
  reason        text not null check (btrim(reason) <> '' and length(reason) <= 500),
  actor_type    text not null,
  actor_id      uuid not null,
  actor_name    text not null,
  created_at    timestamptz not null default now(),
  constraint budget_funding_source_adjustments_source_fkey foreign key (workspace_id, source_id)
    references public.budget_funding_sources (workspace_id, id) on delete restrict
);
create index budget_funding_source_adjustments_source_idx
  on public.budget_funding_source_adjustments (workspace_id, source_id);

-- ===========================================================================
-- Suppliers (bank details in their own table).
-- ===========================================================================
create table public.budget_suppliers (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.election_workspaces (id) on delete cascade,
  business_name  text not null check (btrim(business_name) <> '' and length(business_name) <= 200),
  contact_name   text check (contact_name is null or length(contact_name) <= 200),
  phone          text check (phone is null or length(phone) <= 32),
  tax_id         text check (tax_id is null or tax_id ~ '^[0-9]{5,12}$'),
  address        text check (address is null or length(address) <= 300),
  notes          text check (notes is null or length(notes) <= 2000),
  is_active      boolean not null default true,
  row_version    integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint budget_suppliers_workspace_id_id_key unique (workspace_id, id)
);
create unique index budget_suppliers_workspace_tax_id_key
  on public.budget_suppliers (workspace_id, tax_id) where tax_id is not null;

create table public.budget_supplier_bank_details (
  workspace_id    uuid not null,
  supplier_id     uuid not null,
  bank_code       text check (bank_code is null or bank_code ~ '^[0-9]{1,3}$'),
  branch_code     text check (branch_code is null or branch_code ~ '^[0-9]{1,5}$'),
  account_number  text not null check (account_number ~ '^[0-9]{2,20}$'),
  account_holder  text check (account_holder is null or length(account_holder) <= 200),
  row_version     integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (workspace_id, supplier_id),
  constraint budget_supplier_bank_details_supplier_fkey foreign key (workspace_id, supplier_id)
    references public.budget_suppliers (workspace_id, id) on delete cascade
);

-- ===========================================================================
-- Document configuration (types + rules; thresholds live here). Files are
-- Stage 4.
-- ===========================================================================
create table public.budget_document_types (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.election_workspaces (id) on delete cascade,
  key           text not null check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  name          text not null check (btrim(name) <> '' and length(name) <= 100),
  is_system     boolean not null default false,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  row_version   integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint budget_document_types_workspace_id_id_key unique (workspace_id, id),
  constraint budget_document_types_workspace_key_key unique (workspace_id, key)
);

create table public.budget_document_rules (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  document_type_id  uuid not null,
  funding_kind      text check (funding_kind is null or funding_kind in ('party', 'donation', 'personal')),
  condition         text not null check (condition in ('always', 'amount_gt', 'amount_gte', 'category', 'manual')),
  threshold_agorot  bigint check (threshold_agorot is null or threshold_agorot between 0 and 1000000000000),
  is_active         boolean not null default true,
  row_version       integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint budget_document_rules_workspace_id_id_key unique (workspace_id, id),
  constraint budget_document_rules_type_fkey foreign key (workspace_id, document_type_id)
    references public.budget_document_types (workspace_id, id) on delete restrict,
  constraint budget_document_rules_threshold_check
    check ((condition in ('amount_gt', 'amount_gte')) = (threshold_agorot is not null))
);

create table public.budget_document_rule_categories (
  workspace_id  uuid not null,
  rule_id       uuid not null,
  category_id   uuid not null,
  primary key (workspace_id, rule_id, category_id),
  constraint budget_document_rule_categories_rule_fkey foreign key (workspace_id, rule_id)
    references public.budget_document_rules (workspace_id, id) on delete cascade,
  constraint budget_document_rule_categories_category_fkey foreign key (workspace_id, category_id)
    references public.budget_categories (workspace_id, id) on delete restrict
);

-- ===========================================================================
-- Expenses and funding allocations.
-- ===========================================================================
create table public.budget_expenses (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.election_workspaces (id) on delete cascade,
  reference_no    integer not null check (reference_no > 0),
  description     text not null check (btrim(description) <> '' and length(description) <= 500),
  supplier_id     uuid,
  category_id     uuid,
  total_agorot    bigint check (total_agorot is null or total_agorot between 1 and 1000000000000),
  net_agorot      bigint check (net_agorot is null or net_agorot between 0 and 1000000000000),
  vat_agorot      bigint check (vat_agorot is null or vat_agorot between 0 and 1000000000000),
  vat_rate_bp     integer check (vat_rate_bp is null or vat_rate_bp between 0 and 10000),
  expense_date    date,
  delivery_date   date,
  invoice_date    date,
  status          text not null default 'draft'
                  check (status in ('draft', 'committed', 'incurred', 'closed', 'cancelled')),
  notes           text check (notes is null or length(notes) <= 4000),
  status_reason   text check (status_reason is null or length(status_reason) <= 500),
  closed_at       timestamptz,
  row_version     integer not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint budget_expenses_workspace_id_id_key unique (workspace_id, id),
  constraint budget_expenses_workspace_reference_key unique (workspace_id, reference_no),
  constraint budget_expenses_supplier_fkey foreign key (workspace_id, supplier_id)
    references public.budget_suppliers (workspace_id, id) on delete restrict,
  constraint budget_expenses_category_fkey foreign key (workspace_id, category_id)
    references public.budget_categories (workspace_id, id) on delete restrict,
  -- Anything past draft must be complete.
  constraint budget_expenses_complete_check check (
    status in ('draft', 'cancelled')
    or (supplier_id is not null and category_id is not null
        and total_agorot is not null and expense_date is not null)),
  constraint budget_expenses_closed_at_check check ((status = 'closed') = (closed_at is not null))
);
create index budget_expenses_status_idx on public.budget_expenses (workspace_id, status);
create index budget_expenses_supplier_idx on public.budget_expenses (workspace_id, supplier_id);
create index budget_expenses_category_idx on public.budget_expenses (workspace_id, category_id);
create index budget_expenses_date_idx on public.budget_expenses (workspace_id, expense_date);

create table public.budget_expense_allocations (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  expense_id         uuid not null,
  funding_source_id  uuid not null,
  amount_agorot      bigint not null check (amount_agorot between 1 and 1000000000000),
  row_version        integer not null default 1,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint budget_expense_allocations_workspace_id_id_key unique (workspace_id, id),
  constraint budget_expense_allocations_expense_id_key unique (workspace_id, expense_id, id),
  constraint budget_expense_allocations_expense_source_key unique (workspace_id, expense_id, funding_source_id),
  constraint budget_expense_allocations_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict,
  constraint budget_expense_allocations_source_fkey foreign key (workspace_id, funding_source_id)
    references public.budget_funding_sources (workspace_id, id) on delete restrict
);
create index budget_expense_allocations_source_idx
  on public.budget_expense_allocations (workspace_id, funding_source_id);

-- ===========================================================================
-- Party workflow: prior approval, submission, payment reference.
-- ===========================================================================
create table public.budget_party_preapprovals (
  workspace_id               uuid not null,
  allocation_id              uuid not null,
  order_number               text check (order_number is null or length(order_number) <= 100),
  approval_code              text not null check (btrim(approval_code) <> '' and length(approval_code) <= 100),
  approver_name              text not null check (btrim(approver_name) <> '' and length(approver_name) <= 200),
  approval_date              date not null,
  preapproved_amount_agorot  bigint check (preapproved_amount_agorot is null
                                           or preapproved_amount_agorot between 1 and 1000000000000),
  row_version                integer not null default 1,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  primary key (workspace_id, allocation_id),
  constraint budget_party_preapprovals_allocation_fkey foreign key (workspace_id, allocation_id)
    references public.budget_expense_allocations (workspace_id, id) on delete restrict
);

create table public.budget_party_submissions (
  workspace_id             uuid not null,
  allocation_id            uuid not null,
  state                    text not null default 'not_sent' check (state in ('not_sent', 'sent', 'returned')),
  requested_amount_agorot  bigint check (requested_amount_agorot is null
                                         or requested_amount_agorot between 1 and 1000000000000),
  last_sent_at             timestamptz,
  last_returned_at         timestamptz,
  row_version              integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (workspace_id, allocation_id),
  constraint budget_party_submissions_allocation_fkey foreign key (workspace_id, allocation_id)
    references public.budget_expense_allocations (workspace_id, id) on delete restrict
);

create table public.budget_party_submission_events (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  allocation_id    uuid not null,
  event            text not null check (event in ('sent', 'returned')),
  recipient_phone  text check (recipient_phone is null or length(recipient_phone) <= 32),
  note             text check (note is null or length(note) <= 1000),
  actor_type       text not null,
  actor_id         uuid not null,
  actor_name       text not null,
  created_at       timestamptz not null default now(),
  constraint budget_party_submission_events_allocation_fkey foreign key (workspace_id, allocation_id)
    references public.budget_expense_allocations (workspace_id, id) on delete restrict,
  constraint budget_party_submission_events_return_note_check check (event <> 'returned' or btrim(coalesce(note, '')) <> '')
);
create index budget_party_submission_events_allocation_idx
  on public.budget_party_submission_events (workspace_id, allocation_id, created_at);

create table public.budget_party_payment_references (
  workspace_id              uuid not null,
  allocation_id             uuid not null,
  reference_number          text not null check (btrim(reference_number) <> '' and length(reference_number) <= 100),
  authorized_amount_agorot  bigint not null check (authorized_amount_agorot between 1 and 1000000000000),
  received_date             date not null,
  row_version               integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  primary key (workspace_id, allocation_id),
  constraint budget_party_payment_references_allocation_fkey foreign key (workspace_id, allocation_id)
    references public.budget_expense_allocations (workspace_id, id) on delete restrict
);

-- ===========================================================================
-- Supplier payment ledger (insert-only; a mistaken entry is voided, once).
-- ===========================================================================
create table public.budget_supplier_payments (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  expense_id           uuid not null,
  allocation_id        uuid not null,
  amount_agorot        bigint not null check (amount_agorot between 1 and 1000000000000),
  payment_date         date not null,
  payer                text not null check (payer in ('party', 'campaign')),
  confirmation_source  text not null
                       check (confirmation_source in ('funder_notice', 'supplier_confirmation', 'bank_transfer', 'other')),
  external_reference   text check (external_reference is null or length(external_reference) <= 100),
  note                 text check (note is null or length(note) <= 1000),
  idempotency_key      uuid not null,
  recorded_by_type     text not null,
  recorded_by_id       uuid not null,
  recorded_by_name     text not null,
  recorded_at          timestamptz not null default now(),
  voided_at            timestamptz,
  voided_by_name       text,
  void_reason          text check (void_reason is null or (btrim(void_reason) <> '' and length(void_reason) <= 500)),
  constraint budget_supplier_payments_workspace_id_id_key unique (workspace_id, id),
  constraint budget_supplier_payments_idempotency_key unique (workspace_id, idempotency_key),
  constraint budget_supplier_payments_allocation_fkey foreign key (workspace_id, expense_id, allocation_id)
    references public.budget_expense_allocations (workspace_id, expense_id, id) on delete restrict,
  constraint budget_supplier_payments_void_check check (
    (voided_at is null) = (void_reason is null) and (voided_at is null) = (voided_by_name is null))
);
create index budget_supplier_payments_allocation_idx
  on public.budget_supplier_payments (workspace_id, allocation_id) where voided_at is null;
create index budget_supplier_payments_expense_idx on public.budget_supplier_payments (workspace_id, expense_id);

-- ===========================================================================
-- Integrity triggers.
-- ===========================================================================

-- A source’s kind drives the party workflow and the expected payer, so it
-- cannot change once any allocation uses the source.
create or replace function public.budget_source_kind_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.kind is distinct from old.kind and exists (
    select 1 from public.budget_expense_allocations a
    where a.workspace_id = old.workspace_id and a.funding_source_id = old.id
  ) then
    raise exception 'SOURCE_KIND_LOCKED';
  end if;
  return new;
end;
$fn$;

-- Party-only rows may only hang off an allocation of a party source.
create or replace function public.budget_party_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if not exists (
    select 1
    from public.budget_expense_allocations a
    join public.budget_funding_sources s
      on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
    where a.workspace_id = new.workspace_id and a.id = new.allocation_id and s.kind = 'party'
  ) then
    raise exception 'NOT_A_PARTY_ALLOCATION';
  end if;
  return new;
end;
$fn$;

-- Sum of allocations never exceeds the expense total; an expense without a
-- total holds no allocations. Deferred, so a multi-row edit in one
-- transaction is judged on its final state.
create or replace function public.budget_allocations_check()
returns trigger
language plpgsql
-- SECURITY DEFINER: a DEFERRED trigger fires at COMMIT as the session role
-- (service_role), which has no Budget table privileges by design.
security definer
set search_path = ''
as $fn$
declare
  v_ws uuid;
  v_expense uuid;
  v_total bigint;
  v_sum bigint;
begin
  if tg_op = 'DELETE' then
    v_ws := old.workspace_id;
    v_expense := old.expense_id;
  else
    v_ws := new.workspace_id;
    v_expense := new.expense_id;
  end if;
  select e.total_agorot into v_total
  from public.budget_expenses e where e.workspace_id = v_ws and e.id = v_expense;
  select coalesce(sum(a.amount_agorot), 0) into v_sum
  from public.budget_expense_allocations a where a.workspace_id = v_ws and a.expense_id = v_expense;
  if v_sum > 0 and (v_total is null or v_sum > v_total) then
    raise exception 'ALLOCATIONS_EXCEED_TOTAL';
  end if;
  return null;
end;
$fn$;

-- The expense side of the same invariant plus: the total can never drop below
-- what has already been paid.
create or replace function public.budget_expense_amounts_check()
returns trigger
language plpgsql
-- SECURITY DEFINER: deferred, fires at COMMIT (see budget_allocations_check).
security definer
set search_path = ''
as $fn$
declare
  v_sum bigint;
  v_paid bigint;
begin
  select coalesce(sum(a.amount_agorot), 0) into v_sum
  from public.budget_expense_allocations a where a.workspace_id = new.workspace_id and a.expense_id = new.id;
  if v_sum > 0 and (new.total_agorot is null or v_sum > new.total_agorot) then
    raise exception 'ALLOCATIONS_EXCEED_TOTAL';
  end if;
  select coalesce(sum(p.amount_agorot), 0) into v_paid
  from public.budget_supplier_payments p
  where p.workspace_id = new.workspace_id and p.expense_id = new.id and p.voided_at is null;
  if v_paid > 0 and (new.total_agorot is null or v_paid > new.total_agorot) then
    raise exception 'TOTAL_BELOW_PAID';
  end if;
  return null;
end;
$fn$;

-- Payments: insert-only; the only update ever allowed is a one-way void; the
-- payer must match the allocation’s source kind; valid payments per
-- allocation never exceed the allocation.
create or replace function public.budget_payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_kind text;
  v_amount bigint;
  v_paid bigint;
  v_expected_payer text;
begin
  if tg_op = 'DELETE' then
    raise exception 'BUDGET_APPEND_ONLY: DELETE on budget_supplier_payments';
  end if;

  if tg_op = 'UPDATE' then
    if old.voided_at is not null then
      raise exception 'PAYMENT_ALREADY_VOIDED';
    end if;
    if new.voided_at is null
       or (to_jsonb(new) - array['voided_at', 'voided_by_name', 'void_reason'])
          is distinct from (to_jsonb(old) - array['voided_at', 'voided_by_name', 'void_reason'])
    then
      raise exception 'BUDGET_APPEND_ONLY: UPDATE on budget_supplier_payments';
    end if;
    return new;
  end if;

  select s.kind, a.amount_agorot into v_kind, v_amount
  from public.budget_expense_allocations a
  join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
  where a.workspace_id = new.workspace_id and a.id = new.allocation_id
  for update of a;

  -- Computed first: the Supabase CLI statement splitter mis-reads an
  -- END THEN sequence inside a function body.
  v_expected_payer := case when v_kind = 'party' then 'party' else 'campaign' end;
  if new.payer <> v_expected_payer then
    raise exception 'PAYER_MISMATCH';
  end if;

  select coalesce(sum(p.amount_agorot), 0) into v_paid
  from public.budget_supplier_payments p
  where p.workspace_id = new.workspace_id and p.allocation_id = new.allocation_id and p.voided_at is null;
  if v_paid + new.amount_agorot > v_amount then
    raise exception 'PAYMENT_EXCEEDS_ALLOCATION';
  end if;
  return new;
end;
$fn$;

-- An allocation can never shrink below what was already paid against it.
create or replace function public.budget_allocation_paid_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_paid bigint;
begin
  select coalesce(sum(p.amount_agorot), 0) into v_paid
  from public.budget_supplier_payments p
  where p.workspace_id = old.workspace_id and p.allocation_id = old.id and p.voided_at is null;
  if tg_op = 'DELETE' then
    if v_paid > 0 then
      raise exception 'ALLOCATION_HAS_PAYMENTS';
    end if;
    return old;
  end if;
  if new.amount_agorot < v_paid then
    raise exception 'ALLOCATION_BELOW_PAID';
  end if;
  return new;
end;
$fn$;

do $$
declare
  f text;
begin
  foreach f in array array['budget_source_kind_guard', 'budget_party_allocation_guard',
                           'budget_allocations_check', 'budget_expense_amounts_check',
                           'budget_payments_guard', 'budget_allocation_paid_guard']
  loop
    execute format('revoke all on function public.%I() from public, anon, authenticated, service_role', f);
  end loop;
end $$;

create trigger budget_funding_sources_kind_guard before update of kind on public.budget_funding_sources
  for each row execute function public.budget_source_kind_guard();
create trigger budget_party_preapprovals_party_guard before insert or update on public.budget_party_preapprovals
  for each row execute function public.budget_party_allocation_guard();
create trigger budget_party_submissions_party_guard before insert or update on public.budget_party_submissions
  for each row execute function public.budget_party_allocation_guard();
create trigger budget_party_submission_events_party_guard before insert on public.budget_party_submission_events
  for each row execute function public.budget_party_allocation_guard();
create trigger budget_party_payment_references_party_guard before insert or update on public.budget_party_payment_references
  for each row execute function public.budget_party_allocation_guard();
create constraint trigger budget_expense_allocations_sum_check
  after insert or update or delete on public.budget_expense_allocations
  deferrable initially deferred for each row execute function public.budget_allocations_check();
create constraint trigger budget_expenses_amounts_check
  after insert or update on public.budget_expenses
  deferrable initially deferred for each row execute function public.budget_expense_amounts_check();
create trigger budget_supplier_payments_guard before insert or update or delete on public.budget_supplier_payments
  for each row execute function public.budget_payments_guard();
create trigger budget_supplier_payments_no_truncate before truncate on public.budget_supplier_payments
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_expense_allocations_paid_guard before update or delete on public.budget_expense_allocations
  for each row execute function public.budget_allocation_paid_guard();

-- Append-only history tables.
create trigger budget_plan_adjustments_append_only before update or delete on public.budget_plan_adjustments
  for each row execute function public.budget_refuse_mutation();
create trigger budget_funding_source_adjustments_append_only before update or delete on public.budget_funding_source_adjustments
  for each row execute function public.budget_refuse_mutation();
create trigger budget_party_submission_events_append_only before update or delete on public.budget_party_submission_events
  for each row execute function public.budget_refuse_mutation();
create trigger budget_plan_adjustments_no_truncate before truncate on public.budget_plan_adjustments
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_funding_source_adjustments_no_truncate before truncate on public.budget_funding_source_adjustments
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_party_submission_events_no_truncate before truncate on public.budget_party_submission_events
  for each statement execute function public.budget_refuse_mutation();

-- ===========================================================================
-- Access lock-down + audit triggers on every Budget table.
-- ===========================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'budget_audit_events', 'budget_settings', 'budget_categories', 'budget_category_plans',
    'budget_plan_adjustments', 'budget_funding_sources', 'budget_funding_source_adjustments',
    'budget_suppliers', 'budget_supplier_bank_details', 'budget_document_types',
    'budget_document_rules', 'budget_document_rule_categories', 'budget_expenses',
    'budget_expense_allocations', 'budget_party_preapprovals', 'budget_party_submissions',
    'budget_party_submission_events', 'budget_party_payment_references', 'budget_supplier_payments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('revoke all on table public.%I from service_role', t);
    if t <> 'budget_audit_events' then
      execute format(
        'create trigger %I after insert or update or delete on public.%I for each row execute function public.budget_audit_row()',
        t || '_audit', t);
    end if;
  end loop;
end $$;

revoke all on sequence public.budget_audit_events_id_seq from public, anon, authenticated, service_role;

commit;
