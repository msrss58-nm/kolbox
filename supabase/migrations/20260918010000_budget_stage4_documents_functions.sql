-- Budget Stage 4 (B/2) - the document requirement engine, document / version /
-- upload / order-form operations, the close guard's document part and the
-- close-time requirement snapshot.
--
-- Same shape as Stage 3 (20260917020000): every op is an internal
-- budget_op_<op>(workspace, actor, args) reached ONLY through the two
-- service_role dispatchers, after authentication -> workspace FOR SHARE ->
-- effective entitlement -> budget.view -> the op's permission (the map below).
-- No workspace id or storage path is ever accepted from a client: the path is
-- generated here, and the ops that take a path / hash / snapshot are
-- handler-internal (api/budget/actions.ts refuses them from a client, exactly
-- like the Stage 3 step-up internals).
--
-- ONE requirement engine (budget_document_requirements_live) answers, for an
-- expense: which document types are required / conditional / optional, which
-- are present, which version satisfies each, whether the invoice and the
-- supplier signature are required, and whether the expense is document-ready.
-- The expense page, the order form, the supplier file, the close guard and the
-- close snapshot all read it - no rule logic lives anywhere else.
--
-- Threshold semantics (thresholds are rule DATA, default 150000 agorot =
-- 1,500 ILS, editable per workspace): condition amount_gt is STRICTLY greater
-- (total > threshold): 149,999 and 150,000 are not required, 150,001 is.
--
-- MANUAL ROLLBACK: re-create budget_op_permissions, budget_close_blockers,
-- budget_op_transition_expense and budget_op_list_history from 20260917020000,
-- drop every function created below, re-run that migration's ACL block; then
-- migration A's rollback.

begin;

-- ===========================================================================
-- Small helpers.
-- ===========================================================================

-- Display-name sanitizer. The name is METADATA only (the object path is
-- <workspace>/<uuid>), but it becomes the download file name, so: no path
-- components, no control / bidi-override / reserved characters, bounded, and
-- always ending in an extension that matches the verified type.
create or replace function public.budget_sanitize_file_name(p_name text, p_mime text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text := coalesce(p_name, '');
  v_ext text := case p_mime
    when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png'
    when 'image/heic' then 'heic' when 'image/heif' then 'heif' else 'bin' end;
  v_ok text := case p_mime
    when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpe?g' when 'image/png' then 'png'
    else 'hei[cf]' end;
begin
  v := regexp_replace(v, '^.*[/\\]', '');
  -- control chars, Windows-reserved chars, and the bidi marks / overrides
  -- (U+200E/F, U+202A-202E, U+2066-2069) that could disguise an extension.
  v := regexp_replace(v, '[[:cntrl:]<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]', '', 'g');
  v := regexp_replace(v, '\s+', ' ', 'g');
  v := btrim(v, ' .');
  if lower(v) ~ ('\.' || v_ok || '$') then
    v := regexp_replace(v, '\.[^.]*$', '');
  end if;
  v := btrim(left(v, 110), ' .');
  if v = '' then
    v := 'document';
  end if;
  return v || '.' || v_ext;
end;
$fn$;

create or replace function public.budget_is_allowed_mime(p_mime text)
returns boolean language sql immutable set search_path = '' as $fn$
  select p_mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif');
$fn$;

-- The two types the order-form workflow owns: produced only by generation
-- (order_form) and by the supplier-return upload (order_form_signed).
create or replace function public.budget_is_workflow_type(p_key text)
returns boolean language sql immutable set search_path = '' as $fn$
  select p_key in ('order_form', 'order_form_signed');
$fn$;

create or replace function public.budget_expense_is_party(p_ws uuid, p_expense_id uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.budget_expense_allocations a
    join public.budget_funding_sources s on s.workspace_id = a.workspace_id and s.id = a.funding_source_id
    where a.workspace_id = p_ws and a.expense_id = p_expense_id and s.kind = 'party');
$fn$;

-- Who may add / replace / archive a document:
--   expense            -> budget.manageExpenses, or budget.manageFunderSubmissions
--                         on a party-funded expense (the funder package)
--   supplier           -> budget.manageSuppliers
--   order_form_return  -> budget.manageFunderSubmissions
create or replace function public.budget_require_document_authority(p_actor jsonb, p_purpose text, p_ws uuid, p_expense_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_perms jsonb := p_actor -> 'permissions';
begin
  if p_purpose = 'expense' then
    if (v_perms ? 'budget.manageExpenses')
       or ((v_perms ? 'budget.manageFunderSubmissions') and public.budget_expense_is_party(p_ws, p_expense_id)) then
      return;
    end if;
  elsif p_purpose = 'supplier' then
    if v_perms ? 'budget.manageSuppliers' then
      return;
    end if;
  elsif p_purpose = 'order_form_return' then
    if v_perms ? 'budget.manageFunderSubmissions' then
      return;
    end if;
  end if;
  raise exception 'FORBIDDEN';
end;
$fn$;

-- ===========================================================================
-- THE requirement engine (live evaluation).
-- ===========================================================================
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

  with rule_eval as (
    -- Every ACTIVE rule of an ACTIVE type that applies to one of the expense's
    -- funding kinds (null = every expense), and whether it matches.
    select r.id as rule_id, r.document_type_id, r.condition, r.threshold_agorot,
      (case r.condition
        when 'always' then true
        when 'amount_gt' then coalesce(e.total_agorot > r.threshold_agorot, false)
        when 'amount_gte' then coalesce(e.total_agorot >= r.threshold_agorot, false)
        when 'category' then e.category_id is not null and exists (
          select 1 from public.budget_document_rule_categories rc
          where rc.workspace_id = p_ws and rc.rule_id = r.id and rc.category_id = e.category_id)
        when 'manual' then exists (
          select 1 from public.budget_expense_document_flags f
          where f.workspace_id = p_ws and f.expense_id = p_expense_id and f.document_type_id = r.document_type_id)
        else false
      end) as matched
    from public.budget_document_rules r
    join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
    where r.workspace_id = p_ws and r.is_active and t.is_active
      and (r.funding_kind is null or r.funding_kind = any (v_kinds))
  ),
  candidates as (
    -- (1) the expense's own active documents (latest version of each), every
    --     type except the supplier-signed order form;
    select d.document_type_id, d.id as document_id, v.id as version_id, v.version_no,
           'expense'::text as source, 1 as priority, v.created_at
    from public.budget_documents d
    join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
    join lateral (
      select vv.id, vv.version_no, vv.created_at from public.budget_document_versions vv
      where vv.workspace_id = p_ws and vv.document_id = d.id
      order by vv.version_no desc limit 1) v on true
    where d.workspace_id = p_ws and d.expense_id = p_expense_id and d.status = 'active'
      and t.key <> 'order_form_signed'
    union all
    -- (2) the supplier's still-valid bank-account confirmation;
    select d.document_type_id, d.id, v.id, v.version_no, 'supplier', 2, v.created_at
    from public.budget_documents d
    join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
    join lateral (
      select vv.id, vv.version_no, vv.created_at from public.budget_document_versions vv
      where vv.workspace_id = p_ws and vv.document_id = d.id
      order by vv.version_no desc limit 1) v on true
    where d.workspace_id = p_ws and e.supplier_id is not null and d.supplier_id = e.supplier_id
      and d.status = 'active' and t.key = 'bank_confirmation'
      and (d.valid_until is null or d.valid_until >= current_date)
    union all
    -- (3) the supplier-signed form counts ONLY when it answers the LATEST
    --     generated order form (a regeneration needs a fresh signature).
    select d.document_type_id, d.id, v.id, v.version_no, 'order_form_return', 1, v.created_at
    from public.budget_document_versions v
    join public.budget_documents d on d.workspace_id = v.workspace_id and d.id = v.document_id
    where v.workspace_id = p_ws and v_latest_of is not null and v.order_form_version_id = v_latest_of
      and d.expense_id = p_expense_id and d.status = 'active'
  ),
  present as (
    select distinct on (c.document_type_id) c.*
    from candidates c
    order by c.document_type_id, c.priority, c.created_at desc
  ),
  types as (
    select t.id, t.key, t.name, t.sort_order
    from public.budget_document_types t
    where t.workspace_id = p_ws
      and (exists (select 1 from rule_eval r where r.document_type_id = t.id)
           or exists (select 1 from present p where p.document_type_id = t.id))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'documentTypeId', t.id,
      'key', t.key,
      'name', t.name,
      'required', coalesce((select bool_or(r.matched) from rule_eval r where r.document_type_id = t.id), false),
      'rules', coalesce((select jsonb_agg(jsonb_build_object(
          'ruleId', r.rule_id, 'condition', r.condition, 'threshold', r.threshold_agorot, 'matched', r.matched)
          order by r.condition, r.rule_id)
        from rule_eval r where r.document_type_id = t.id), '[]'::jsonb),
      'satisfied', p.version_id is not null,
      'satisfiedBy', case when p.version_id is null then null else jsonb_build_object(
        'documentId', p.document_id, 'versionId', p.version_id, 'versionNo', p.version_no, 'source', p.source) end)
    order by t.sort_order, t.key), '[]'::jsonb)
  into v_items
  from types t
  left join present p on p.document_type_id = t.id;

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

-- What an expense SHOWS: a closed expense shows the snapshot taken when it
-- closed; anything else is evaluated live.
create or replace function public.budget_expense_requirements(p_ws uuid, p_expense_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_status text;
  v_snap jsonb;
begin
  select e.status into v_status from public.budget_expenses e where e.workspace_id = p_ws and e.id = p_expense_id;
  if v_status = 'closed' then
    select s.snapshot into v_snap
    from public.budget_expense_requirement_snapshots s
    where s.workspace_id = p_ws and s.expense_id = p_expense_id
    order by s.created_at desc, s.id
    limit 1;
    if v_snap is not null then
      return v_snap;
    end if;
  end if;
  return public.budget_document_requirements_live(p_ws, p_expense_id);
end;
$fn$;

-- ===========================================================================
-- JSON views.
-- ===========================================================================
create or replace function public.budget_documents_json(p_ws uuid, p_expense_id uuid, p_supplier_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'documentTypeId', d.document_type_id, 'typeKey', t.key, 'typeName', t.name,
      'expenseId', d.expense_id, 'supplierId', d.supplier_id,
      'title', d.title, 'notes', d.notes, 'validUntil', d.valid_until, 'status', d.status,
      'archivedAt', d.archived_at, 'archiveReason', d.archive_reason, 'version', d.row_version,
      'createdAt', d.created_at,
      'versions', coalesce((select jsonb_agg(jsonb_build_object(
          'id', v.id, 'versionNo', v.version_no, 'fileName', v.file_name, 'mimeType', v.mime_type,
          'sizeBytes', v.size_bytes, 'sha256', v.sha256, 'origin', v.origin,
          'orderFormVersionId', v.order_form_version_id, 'note', v.note,
          'createdByName', v.created_by_name, 'createdAt', v.created_at) order by v.version_no desc)
        from public.budget_document_versions v
        where v.workspace_id = p_ws and v.document_id = d.id), '[]'::jsonb))
    order by t.sort_order, d.created_at, d.id), '[]'::jsonb)
  from public.budget_documents d
  join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
  where d.workspace_id = p_ws
    and (p_expense_id is null or d.expense_id = p_expense_id)
    and (p_supplier_id is null or d.supplier_id = p_supplier_id);
$fn$;

-- Why the FINAL order form cannot be generated right now (empty = it can).
-- Preview skips only the prior-approval gate ("preview and draft are allowed").
create or replace function public.budget_order_form_blockers(p_ws uuid, p_expense_id uuid, p_final boolean)
returns text[] language plpgsql stable security definer set search_path = '' as $fn$
declare
  e public.budget_expenses;
  v_out text[] := '{}';
begin
  select * into e from public.budget_expenses x where x.workspace_id = p_ws and x.id = p_expense_id;
  if not public.budget_expense_is_party(p_ws, p_expense_id) then
    v_out := array_append(v_out, 'ORDER_FORM_NOT_APPLICABLE');
  end if;
  if e.status not in ('draft', 'committed', 'incurred') then
    v_out := array_append(v_out, 'EXPENSE_LOCKED');
  end if;
  if e.supplier_id is null or e.category_id is null or e.total_agorot is null or e.expense_date is null then
    v_out := array_append(v_out, 'EXPENSE_INCOMPLETE');
  end if;
  -- The final PDF never exists before the prior budget approval: every party
  -- allocation of the expense must carry one.
  if p_final and exists (
    select 1 from public.budget_allocation_facts(p_ws) a
    where a.expense_id = p_expense_id and a.kind = 'party' and not a.has_preapproval) then
    v_out := array_append(v_out, 'PREAPPROVAL_REQUIRED');
  end if;
  return v_out;
end;
$fn$;

-- The exact data the order-form PDF renders. Deterministic (no clock): the
-- same expense data always yields the same jsonb, and the generated version
-- stores it verbatim.
create or replace function public.budget_order_form_snapshot(p_ws uuid, p_expense_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'template', 'kolbox-order-form-v1',
    'header', jsonb_build_object('lines', to_jsonb(s.funder_header_lines), 'electionYearLabel', s.election_year_label),
    'branch', jsonb_build_object('name', s.branch_name, 'number', s.branch_number, 'orderer', s.default_orderer),
    'order', jsonb_build_object(
      'referenceNo', e.reference_no, 'description', e.description, 'category', c.name,
      'orderDate', e.expense_date, 'deliveryDate', e.delivery_date,
      'net', e.net_agorot, 'vat', e.vat_agorot, 'vatRateBp', e.vat_rate_bp, 'total', e.total_agorot,
      'partyAmount', coalesce((select sum(a.amount_agorot) from public.budget_expense_allocations a
        join public.budget_funding_sources fs on fs.workspace_id = a.workspace_id and fs.id = a.funding_source_id
        where a.workspace_id = p_ws and a.expense_id = e.id and fs.kind = 'party'), 0)),
    'supplier', jsonb_build_object(
      'businessName', sp.business_name, 'taxId', sp.tax_id, 'address', sp.address,
      'phone', sp.phone, 'contactName', sp.contact_name),
    'preapprovals', coalesce((select jsonb_agg(jsonb_build_object(
        'orderNumber', pa.order_number, 'approvalCode', pa.approval_code, 'approverName', pa.approver_name,
        'approvalDate', pa.approval_date, 'preapprovedAmount', pa.preapproved_amount_agorot)
        order by a.created_at, a.id)
      from public.budget_expense_allocations a
      join public.budget_party_preapprovals pa on pa.workspace_id = a.workspace_id and pa.allocation_id = a.id
      where a.workspace_id = p_ws and a.expense_id = e.id), '[]'::jsonb),
    'supplierSignatureRequired',
      (public.budget_document_requirements_live(p_ws, e.id) ->> 'supplierSignatureRequired')::boolean,
    'rules', jsonb_build_object(
      'supplierSignature', (select jsonb_build_object('condition', r.condition, 'threshold', r.threshold_agorot)
        from public.budget_document_rules r
        join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
        where r.workspace_id = p_ws and t.key = 'order_form_signed' and r.is_active
          and r.condition in ('amount_gt', 'amount_gte')
        order by r.threshold_agorot, r.id limit 1),
      'invoice', (select jsonb_build_object('condition', r.condition, 'threshold', r.threshold_agorot)
        from public.budget_document_rules r
        join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
        where r.workspace_id = p_ws and t.key = 'invoice' and r.is_active
          and r.condition in ('amount_gt', 'amount_gte')
        order by r.threshold_agorot, r.id limit 1)))
  from public.budget_expenses e
  join public.budget_settings s on s.workspace_id = e.workspace_id
  left join public.budget_categories c on c.workspace_id = e.workspace_id and c.id = e.category_id
  left join public.budget_suppliers sp on sp.workspace_id = e.workspace_id and sp.id = e.supplier_id
  where e.workspace_id = p_ws and e.id = p_expense_id;
$fn$;

create or replace function public.budget_order_form_json(p_ws uuid, p_expense_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_versions jsonb;
  v_latest record;
  v_returned boolean := false;
  v_final text[] := public.budget_order_form_blockers(p_ws, p_expense_id, true);
  v_preview text[] := public.budget_order_form_blockers(p_ws, p_expense_id, false);
  v_state text;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'versionNo', o.version_no, 'documentVersionId', o.document_version_id,
      'templateKey', o.template_key, 'supplierSignatureRequired', o.supplier_signature_required,
      'sentAt', o.sent_at, 'sentByName', o.sent_by_name, 'sentNote', o.sent_note,
      'createdByName', o.created_by_name, 'createdAt', o.created_at,
      'returns', coalesce((select jsonb_agg(jsonb_build_object(
          'versionId', v.id, 'versionNo', v.version_no, 'fileName', v.file_name, 'mimeType', v.mime_type,
          'createdByName', v.created_by_name, 'createdAt', v.created_at) order by v.version_no)
        from public.budget_document_versions v
        where v.workspace_id = p_ws and v.order_form_version_id = o.id), '[]'::jsonb))
    order by o.version_no desc), '[]'::jsonb)
  into v_versions
  from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.expense_id = p_expense_id;

  select o.id, o.sent_at into v_latest
  from public.budget_order_form_versions o
  where o.workspace_id = p_ws and o.expense_id = p_expense_id
  order by o.version_no desc limit 1;
  if v_latest.id is not null then
    v_returned := exists (select 1 from public.budget_document_versions v
                          where v.workspace_id = p_ws and v.order_form_version_id = v_latest.id);
  end if;

  v_state := case
    when 'ORDER_FORM_NOT_APPLICABLE' = any (v_preview) then 'not_applicable'
    when v_latest.id is null and cardinality(v_final) = 0 then 'ready'
    when v_latest.id is null then 'draft'
    when v_returned then 'returned'
    when v_latest.sent_at is not null then 'sent'
    else 'generated' end;

  return jsonb_build_object(
    'state', v_state,
    'versions', v_versions,
    'canPreview', cardinality(v_preview) = 0,
    'canGenerate', cardinality(v_final) = 0,
    'generateBlockers', to_jsonb(v_final));
end;
$fn$;

-- ===========================================================================
-- READ operations.
-- ===========================================================================

-- The types a user may pick when uploading: active, and not owned by the
-- order-form workflow.
create or replace function public.budget_uploadable_types_json(p_ws uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'key', t.key, 'name', t.name) order by t.sort_order, t.name), '[]'::jsonb)
  from public.budget_document_types t
  where t.workspace_id = p_ws and t.is_active and not public.budget_is_workflow_type(t.key);
$fn$;

create or replace function public.budget_op_get_expense_documents(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'expenseId', true);
  e public.budget_expenses;
begin
  select * into e from public.budget_expenses x where x.workspace_id = p_ws and x.id = v_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;
  return jsonb_build_object(
    'expenseId', e.id,
    'expenseStatus', e.status,
    'requirements', public.budget_expense_requirements(p_ws, e.id),
    'documents', public.budget_documents_json(p_ws, e.id, null),
    'supplierDocuments', case when e.supplier_id is null then '[]'::jsonb
                              else public.budget_documents_json(p_ws, null, e.supplier_id) end,
    'orderForm', public.budget_order_form_json(p_ws, e.id),
    'flags', coalesce((select jsonb_agg(f.document_type_id order by f.document_type_id)
                       from public.budget_expense_document_flags f
                       where f.workspace_id = p_ws and f.expense_id = e.id), '[]'::jsonb),
    'manualTypes', coalesce((select jsonb_agg(distinct jsonb_build_object('documentTypeId', t.id, 'key', t.key, 'name', t.name))
                             from public.budget_document_rules r
                             join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
                             where r.workspace_id = p_ws and r.condition = 'manual' and r.is_active and t.is_active), '[]'::jsonb),
    'documentTypes', public.budget_uploadable_types_json(p_ws));
end;
$fn$;

-- The supplier file: the supplier, its own documents, its expenses (with the
-- document readiness of each) and the documents filed on those expenses.
create or replace function public.budget_op_get_supplier_file(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'supplierId', true);
  v_supplier jsonb := public.budget_supplier_json(p_ws, v_id);
begin
  if v_supplier is null then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  return jsonb_build_object(
    'supplier', v_supplier,
    'documentTypes', public.budget_uploadable_types_json(p_ws),
    'documents', public.budget_documents_json(p_ws, null, v_id),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'referenceNo', e.reference_no, 'description', e.description, 'status', e.status,
        'total', e.total_agorot, 'expenseDate', e.expense_date,
        'documentsReady', (r.req ->> 'ready')::boolean, 'missing', r.req -> 'missing',
        'documents', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', d.id, 'typeName', t.name, 'status', d.status,
            'currentVersion', (select jsonb_build_object('id', v.id, 'versionNo', v.version_no, 'fileName', v.file_name)
                               from public.budget_document_versions v
                               where v.workspace_id = p_ws and v.document_id = d.id
                               order by v.version_no desc limit 1)) order by t.sort_order, d.created_at), '[]'::jsonb)
          from public.budget_documents d
          join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
          where d.workspace_id = p_ws and d.expense_id = e.id))
        order by e.expense_date desc nulls last, e.reference_no desc)
      from public.budget_expenses e
      cross join lateral (select public.budget_expense_requirements(p_ws, e.id) as req) r
      where e.workspace_id = p_ws and e.supplier_id = v_id), '[]'::jsonb));
end;
$fn$;

-- Handler-internal: where a version's bytes live (for a 60-second signed link).
create or replace function public.budget_op_document_version_locate(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v record;
begin
  select dv.storage_path, dv.file_name, dv.mime_type into v
  from public.budget_document_versions dv
  where dv.workspace_id = p_ws and dv.id = public.budget_arg_uuid(p_args, 'versionId', true);
  if not found then
    raise exception 'NOT_FOUND' using detail = 'version';
  end if;
  return jsonb_build_object('storagePath', v.storage_path, 'fileName', v.file_name, 'mimeType', v.mime_type);
end;
$fn$;

-- ===========================================================================
-- UPLOAD operations: start (client) -> the browser PUTs to a signed Storage
-- URL -> the handler verifies the stored bytes -> finalize / reject (internal).
-- ===========================================================================
create or replace function public.budget_op_document_upload_start(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_purpose text := public.budget_arg_text(p_args, 'purpose', 20, true);
  v_mime text := public.budget_arg_text(p_args, 'mimeType', 40, true);
  v_size bigint := public.budget_arg_amount(p_args, 'sizeBytes', true, 1, 1000000000000);
  v_raw_name text := public.budget_arg_text(p_args, 'fileName', 255, true);
  v_title text := public.budget_arg_text(p_args, 'title', 200, false);
  v_notes text := public.budget_arg_text(p_args, 'notes', 1000, false);
  v_valid date := public.budget_arg_date(p_args, 'validUntil', false);
  v_doc_id uuid := public.budget_arg_uuid(p_args, 'documentId', false);
  v_type_id uuid := public.budget_arg_uuid(p_args, 'documentTypeId', false);
  v_expense uuid;
  v_supplier uuid;
  v_of uuid;
  v_doc public.budget_documents;
  v_type public.budget_document_types;
  v_status text;
  v_id uuid;
  v_path text := p_ws::text || '/' || gen_random_uuid()::text;
  v_expires timestamptz := now() + interval '15 minutes';
begin
  if v_purpose not in ('expense', 'supplier', 'order_form_return') then
    raise exception 'INVALID_INPUT' using detail = 'purpose';
  end if;
  if not public.budget_is_allowed_mime(v_mime) then
    raise exception 'UNSUPPORTED_FILE_TYPE';
  end if;
  if v_size > 10485760 then
    raise exception 'FILE_TOO_LARGE';
  end if;
  -- Upload-abuse bound: a handful of open intents per person at a time.
  if (select count(*) from public.budget_document_uploads u
      where u.workspace_id = p_ws and u.created_by_id = (p_actor ->> 'id')::uuid
        and u.state = 'pending' and u.expires_at > now()) >= 10 then
    raise exception 'TOO_MANY_PENDING_UPLOADS';
  end if;

  if v_purpose = 'order_form_return' then
    select o.id, o.expense_id into v_of, v_expense
    from public.budget_order_form_versions o
    where o.workspace_id = p_ws and o.id = public.budget_arg_uuid(p_args, 'orderFormVersionId', true);
    if v_of is null then
      raise exception 'NOT_FOUND' using detail = 'orderform';
    end if;
    select t.* into v_type from public.budget_document_types t
    where t.workspace_id = p_ws and t.key = 'order_form_signed';
    v_doc_id := null;
    v_valid := null;
  elsif v_doc_id is not null then
    -- Replacement: the next version of an existing, active document.
    select * into v_doc from public.budget_documents d where d.workspace_id = p_ws and d.id = v_doc_id;
    if not found then
      raise exception 'NOT_FOUND' using detail = 'document';
    end if;
    if v_doc.status <> 'active' then
      raise exception 'DOCUMENT_ARCHIVED';
    end if;
    select t.* into v_type from public.budget_document_types t
    where t.workspace_id = p_ws and t.id = v_doc.document_type_id;
    v_expense := v_doc.expense_id;
    v_supplier := v_doc.supplier_id;
    if (v_purpose = 'expense') <> (v_expense is not null) then
      raise exception 'INVALID_INPUT' using detail = 'documentId';
    end if;
  else
    select t.* into v_type from public.budget_document_types t where t.workspace_id = p_ws and t.id = v_type_id;
    if v_type.id is null then
      raise exception 'NOT_FOUND' using detail = 'type';
    end if;
    if v_purpose = 'expense' then
      v_expense := public.budget_arg_uuid(p_args, 'expenseId', true);
    else
      v_supplier := public.budget_arg_uuid(p_args, 'supplierId', true);
    end if;
  end if;

  if v_purpose <> 'order_form_return' then
    if not v_type.is_active then
      raise exception 'INVALID_INPUT' using detail = 'documentTypeId';
    end if;
    if public.budget_is_workflow_type(v_type.key) then
      raise exception 'DOCUMENT_TYPE_MANAGED';
    end if;
  end if;

  if v_expense is not null then
    select e.status into v_status from public.budget_expenses e where e.workspace_id = p_ws and e.id = v_expense;
    if v_status is null then
      raise exception 'NOT_FOUND' using detail = 'expense';
    end if;
    perform public.budget_require_open_expense(v_status);
    if v_valid is not null then
      raise exception 'INVALID_INPUT' using detail = 'validUntil';
    end if;
  else
    if not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = v_supplier) then
      raise exception 'NOT_FOUND' using detail = 'supplier';
    end if;
  end if;
  perform public.budget_require_document_authority(p_actor, v_purpose, p_ws, v_expense);

  insert into public.budget_document_uploads (workspace_id, purpose, expense_id, supplier_id, document_id,
    document_type_id, order_form_version_id, file_name, mime_type, size_bytes, storage_path, title, notes,
    valid_until, created_by_type, created_by_id, created_by_name, expires_at)
  values (p_ws, v_purpose, v_expense, v_supplier, v_doc_id, v_type.id, v_of,
    public.budget_sanitize_file_name(v_raw_name, v_mime), v_mime, v_size, v_path, v_title, v_notes, v_valid,
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name', v_expires)
  returning id into v_id;

  return jsonb_build_object('uploadId', v_id, 'storagePath', v_path, 'expiresAt', v_expires, 'maxBytes', 10485760);
end;
$fn$;

-- The upload row, for its OWN creator only (a foreign id is simply not found).
create or replace function public.budget_upload_for_actor(p_ws uuid, p_actor jsonb, p_upload_id uuid, p_lock boolean)
returns public.budget_document_uploads language plpgsql security definer set search_path = '' as $fn$
declare
  u public.budget_document_uploads;
begin
  if p_lock then
    select * into u from public.budget_document_uploads x where x.workspace_id = p_ws and x.id = p_upload_id for update;
  else
    select * into u from public.budget_document_uploads x where x.workspace_id = p_ws and x.id = p_upload_id;
  end if;
  if u.id is null or u.created_by_id <> (p_actor ->> 'id')::uuid or u.created_by_type <> p_actor ->> 'type' then
    raise exception 'NOT_FOUND' using detail = 'upload';
  end if;
  return u;
end;
$fn$;

create or replace function public.budget_op_document_upload_lookup(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  u public.budget_document_uploads := public.budget_upload_for_actor(p_ws, p_actor,
    public.budget_arg_uuid(p_args, 'uploadId', true), false);
begin
  return jsonb_build_object('uploadId', u.id, 'purpose', u.purpose, 'storagePath', u.storage_path,
    'mimeType', u.mime_type, 'sizeBytes', u.size_bytes, 'state', u.state, 'expired', u.expires_at <= now());
end;
$fn$;

create or replace function public.budget_op_document_upload_reject(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  u public.budget_document_uploads := public.budget_upload_for_actor(p_ws, p_actor,
    public.budget_arg_uuid(p_args, 'uploadId', true), true);
  v_reason text := public.budget_arg_text(p_args, 'reason', 40, true);
begin
  if v_reason not in ('type_mismatch', 'size_mismatch', 'too_large', 'missing_object', 'expired') then
    raise exception 'INVALID_INPUT' using detail = 'reason';
  end if;
  if u.state <> 'pending' then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.budget_document_uploads x
  set state = 'rejected', reject_reason = v_reason, completed_at = now()
  where x.workspace_id = p_ws and x.id = u.id;
  return jsonb_build_object('ok', true);
end;
$fn$;

-- Get-or-create the ONE workflow document (order_form / order_form_signed)
-- of an expense. The caller holds the expense row lock.
create or replace function public.budget_workflow_document(p_ws uuid, p_expense_id uuid, p_key text)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
  v_id uuid;
begin
  select d.id into v_id
  from public.budget_documents d
  join public.budget_document_types t on t.workspace_id = d.workspace_id and t.id = d.document_type_id
  where d.workspace_id = p_ws and d.expense_id = p_expense_id and t.key = p_key and d.status = 'active'
  order by d.created_at, d.id
  limit 1;
  if v_id is null then
    insert into public.budget_documents (workspace_id, expense_id, document_type_id)
    select p_ws, p_expense_id, t.id from public.budget_document_types t where t.workspace_id = p_ws and t.key = p_key
    returning id into v_id;
  end if;
  return v_id;
end;
$fn$;

-- Appends the next version of a document. Locks the document row first, so
-- two concurrent finalizes of the same document number 1, 2, never 1, 1.
create or replace function public.budget_append_version(p_ws uuid, p_actor jsonb, p_document_id uuid,
  p_path text, p_file_name text, p_mime text, p_size bigint, p_sha text, p_origin text, p_of uuid, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
  v_next integer;
  v_id uuid;
begin
  perform 1 from public.budget_documents d where d.workspace_id = p_ws and d.id = p_document_id for update;
  select coalesce(max(v.version_no), 0) + 1 into v_next
  from public.budget_document_versions v where v.workspace_id = p_ws and v.document_id = p_document_id;
  insert into public.budget_document_versions (workspace_id, document_id, version_no, storage_path, file_name,
    mime_type, size_bytes, sha256, origin, order_form_version_id, note, created_by_type, created_by_id, created_by_name)
  values (p_ws, p_document_id, v_next, p_path, p_file_name, p_mime, p_size, p_sha, p_origin, p_of, p_note,
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name')
  returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.budget_op_document_upload_finalize(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  u public.budget_document_uploads := public.budget_upload_for_actor(p_ws, p_actor,
    public.budget_arg_uuid(p_args, 'uploadId', true), true);
  v_sha text := public.budget_arg_text(p_args, 'sha256', 64, true);
  v_size bigint := public.budget_arg_amount(p_args, 'sizeBytes', true, 1, 10485760);
  v_mime text := public.budget_arg_text(p_args, 'mimeType', 40, true);
  v_doc public.budget_documents;
  v_doc_id uuid;
  v_version uuid;
begin
  -- A replayed finalize (e.g. the response was lost) answers the same result.
  if u.state = 'completed' then
    if u.purpose = 'supplier' then
      return jsonb_build_object('supplierId', u.supplier_id);
    end if;
    return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', u.expense_id));
  end if;
  if u.state <> 'pending' then
    raise exception 'INVALID_TRANSITION';
  end if;
  if u.expires_at <= now() then
    raise exception 'UPLOAD_EXPIRED';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using detail = 'sha256';
  end if;
  if v_size <> u.size_bytes or v_mime <> u.mime_type then
    raise exception 'INVALID_INPUT' using detail = 'sizeBytes';
  end if;

  -- Re-authorize at finalize time: the role may have changed since start.
  if u.expense_id is not null then
    perform public.budget_require_open_expense((public.budget_expense_for_update(p_ws, u.expense_id)).status);
  elsif not exists (select 1 from public.budget_suppliers s where s.workspace_id = p_ws and s.id = u.supplier_id) then
    raise exception 'NOT_FOUND' using detail = 'supplier';
  end if;
  perform public.budget_require_document_authority(p_actor, u.purpose, p_ws, u.expense_id);

  if u.purpose = 'order_form_return' then
    v_doc_id := public.budget_workflow_document(p_ws, u.expense_id, 'order_form_signed');
  elsif u.document_id is not null then
    select * into v_doc from public.budget_documents d where d.workspace_id = p_ws and d.id = u.document_id for update;
    if v_doc.status <> 'active' then
      raise exception 'DOCUMENT_ARCHIVED';
    end if;
    v_doc_id := v_doc.id;
    -- A replacement may refresh the display metadata / validity.
    if u.title is not null or u.notes is not null or u.valid_until is not null then
      update public.budget_documents d set
        title = coalesce(u.title, d.title), notes = coalesce(u.notes, d.notes),
        valid_until = coalesce(u.valid_until, d.valid_until)
      where d.workspace_id = p_ws and d.id = v_doc_id;
    end if;
  else
    insert into public.budget_documents (workspace_id, expense_id, supplier_id, document_type_id, title, notes, valid_until)
    values (p_ws, u.expense_id, u.supplier_id, u.document_type_id, u.title, u.notes, u.valid_until)
    returning id into v_doc_id;
  end if;

  v_version := public.budget_append_version(p_ws, p_actor, v_doc_id, u.storage_path, u.file_name, u.mime_type,
    u.size_bytes, v_sha, 'upload', u.order_form_version_id,
    case when u.purpose = 'order_form_return' then u.notes end);
  update public.budget_document_uploads x
  set state = 'completed', version_id = v_version, completed_at = now()
  where x.workspace_id = p_ws and x.id = u.id;

  if u.purpose = 'supplier' then
    return jsonb_build_object('supplierId', u.supplier_id);
  end if;
  return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', u.expense_id));
end;
$fn$;

-- ===========================================================================
-- Archive / restore (the only "delete-like" action; every version stays).
-- ===========================================================================
create or replace function public.budget_document_for_change(p_ws uuid, p_actor jsonb, p_document_id uuid)
returns public.budget_documents language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_documents;
  v_key text;
begin
  select * into v from public.budget_documents d where d.workspace_id = p_ws and d.id = p_document_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'document';
  end if;
  select t.key into v_key from public.budget_document_types t where t.workspace_id = p_ws and t.id = v.document_type_id;
  if public.budget_is_workflow_type(v_key) then
    raise exception 'DOCUMENT_TYPE_MANAGED';
  end if;
  if v.expense_id is not null then
    perform public.budget_require_open_expense((public.budget_expense_for_update(p_ws, v.expense_id)).status);
    perform public.budget_require_document_authority(p_actor, 'expense', p_ws, v.expense_id);
  else
    perform public.budget_require_document_authority(p_actor, 'supplier', p_ws, null);
  end if;
  select * into v from public.budget_documents d where d.workspace_id = p_ws and d.id = p_document_id for update;
  return v;
end;
$fn$;

create or replace function public.budget_document_change_result(p_ws uuid, p_actor jsonb, p_doc public.budget_documents)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if p_doc.expense_id is not null then
    return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', p_doc.expense_id));
  end if;
  return jsonb_build_object('supplierId', p_doc.supplier_id);
end;
$fn$;

create or replace function public.budget_op_archive_document(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_reason text := public.budget_arg_text(p_args, 'reason', 500, true);
  v public.budget_documents := public.budget_document_for_change(p_ws, p_actor, public.budget_arg_uuid(p_args, 'documentId', true));
begin
  perform public.budget_check_version(p_args, v.row_version, false);
  if v.status <> 'active' then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.budget_documents d set status = 'archived', archived_at = now(), archive_reason = v_reason
  where d.workspace_id = p_ws and d.id = v.id;
  return public.budget_document_change_result(p_ws, p_actor, v);
end;
$fn$;

create or replace function public.budget_op_restore_document(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_documents := public.budget_document_for_change(p_ws, p_actor, public.budget_arg_uuid(p_args, 'documentId', true));
begin
  perform public.budget_check_version(p_args, v.row_version, false);
  if v.status <> 'archived' then
    raise exception 'INVALID_TRANSITION';
  end if;
  update public.budget_documents d set status = 'active', archived_at = null, archive_reason = null
  where d.workspace_id = p_ws and d.id = v.id;
  return public.budget_document_change_result(p_ws, p_actor, v);
end;
$fn$;

-- ===========================================================================
-- Per-expense requirement override (e.g. "photo required for this expense").
-- Only for a type that has an ACTIVE 'manual' rule.
-- ===========================================================================
create or replace function public.budget_op_set_expense_document_flag(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_type uuid := public.budget_arg_uuid(p_args, 'documentTypeId', true);
  v_required boolean := public.budget_arg_bool(p_args, 'required');
begin
  perform public.budget_require_open_expense(v.status);
  if v_required is null then
    raise exception 'INVALID_INPUT' using detail = 'required';
  end if;
  if not exists (
    select 1 from public.budget_document_rules r
    join public.budget_document_types t on t.workspace_id = r.workspace_id and t.id = r.document_type_id
    where r.workspace_id = p_ws and r.document_type_id = v_type and r.condition = 'manual' and r.is_active and t.is_active)
  then
    raise exception 'INVALID_INPUT' using detail = 'documentTypeId';
  end if;
  if v_required then
    insert into public.budget_expense_document_flags (workspace_id, expense_id, document_type_id, created_by_name)
    values (p_ws, v.id, v_type, p_actor ->> 'name')
    on conflict do nothing;
  else
    delete from public.budget_expense_document_flags f
    where f.workspace_id = p_ws and f.expense_id = v.id and f.document_type_id = v_type;
  end if;
  return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', v.id));
end;
$fn$;

-- ===========================================================================
-- ORDER FORM: data (internal) -> the handler renders the PDF server-side and
-- stores it -> record (internal). Sent is a user confirmation only.
-- ===========================================================================
create or replace function public.budget_op_order_form_data(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_id uuid := public.budget_arg_uuid(p_args, 'expenseId', true);
  v_final boolean := coalesce(public.budget_arg_bool(p_args, 'final'), false);
  e public.budget_expenses;
  v_blockers text[];
  v_next integer;
begin
  select * into e from public.budget_expenses x where x.workspace_id = p_ws and x.id = v_id;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'expense';
  end if;
  v_blockers := public.budget_order_form_blockers(p_ws, e.id, v_final);
  if cardinality(v_blockers) > 0 then
    raise exception '%', v_blockers[1];
  end if;
  select coalesce(max(o.version_no), 0) + 1 into v_next
  from public.budget_order_form_versions o where o.workspace_id = p_ws and o.expense_id = e.id;
  return jsonb_build_object(
    'snapshot', public.budget_order_form_snapshot(p_ws, e.id),
    'expenseVersion', e.row_version,
    'versionNo', v_next,
    'storagePath', case when v_final then p_ws::text || '/' || gen_random_uuid()::text end,
    'fileName', 'טופס-הזמנה-' || e.reference_no || case when v_final then '-v' || v_next else '-טיוטה' end || '.pdf');
end;
$fn$;

create or replace function public.budget_op_order_form_record(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  e public.budget_expenses := public.budget_expense_for_update(p_ws, public.budget_arg_uuid(p_args, 'expenseId', true));
  v_expected integer := public.budget_arg_int(p_args, 'expenseVersion', true, 1, 2147483647);
  v_version_no integer := public.budget_arg_int(p_args, 'versionNo', true, 1, 10000);
  v_path text := public.budget_arg_text(p_args, 'storagePath', 80, true);
  v_sha text := public.budget_arg_text(p_args, 'sha256', 64, true);
  v_size bigint := public.budget_arg_amount(p_args, 'sizeBytes', true, 1, 10485760);
  v_name text := public.budget_arg_text(p_args, 'fileName', 150, true);
  v_snapshot jsonb := p_args -> 'snapshot';
  v_blockers text[];
  v_doc uuid;
  v_doc_version uuid;
begin
  -- Nothing about the expense may have changed between rendering and here:
  -- the stored snapshot is exactly what the PDF shows.
  if e.row_version <> v_expected then
    raise exception 'STALE_VERSION';
  end if;
  v_blockers := public.budget_order_form_blockers(p_ws, e.id, true);
  if cardinality(v_blockers) > 0 then
    raise exception '%', v_blockers[1];
  end if;
  if v_snapshot is null or jsonb_typeof(v_snapshot) <> 'object'
     or v_snapshot is distinct from public.budget_order_form_snapshot(p_ws, e.id) then
    raise exception 'STALE_VERSION';
  end if;
  if v_version_no <> (select coalesce(max(o.version_no), 0) + 1 from public.budget_order_form_versions o
                      where o.workspace_id = p_ws and o.expense_id = e.id) then
    raise exception 'STALE_VERSION';
  end if;
  if split_part(v_path, '/', 1) <> p_ws::text or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using detail = 'storagePath';
  end if;

  v_doc := public.budget_workflow_document(p_ws, e.id, 'order_form');
  v_doc_version := public.budget_append_version(p_ws, p_actor, v_doc, v_path,
    public.budget_sanitize_file_name(v_name, 'application/pdf'), 'application/pdf', v_size, v_sha, 'generated', null, null);
  insert into public.budget_order_form_versions (workspace_id, expense_id, version_no, document_version_id,
    template_key, snapshot, supplier_signature_required, created_by_type, created_by_id, created_by_name)
  values (p_ws, e.id, v_version_no, v_doc_version, v_snapshot ->> 'template', v_snapshot,
    coalesce((v_snapshot ->> 'supplierSignatureRequired')::boolean, false),
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return public.budget_op_get_expense_documents(p_ws, p_actor, jsonb_build_object('expenseId', e.id));
end;
$fn$;

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
-- SETTINGS: custom document types ("custom / other"). System types keep
-- driving the rules and are not renamed or deactivated here.
-- ===========================================================================
create or replace function public.budget_op_create_document_type(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_name text := public.budget_arg_text(p_args, 'name', 100, true);
begin
  if exists (select 1 from public.budget_document_types t where t.workspace_id = p_ws and t.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  insert into public.budget_document_types (workspace_id, key, name, is_system, sort_order)
  values (p_ws, 'custom_' || left(replace(gen_random_uuid()::text, '-', ''), 12), v_name, false,
          coalesce((select max(t.sort_order) + 1 from public.budget_document_types t where t.workspace_id = p_ws), 1));
  return public.budget_op_get_settings(p_ws, p_actor, '{}'::jsonb);
end;
$fn$;

create or replace function public.budget_op_update_document_type(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v public.budget_document_types;
  v_name text := public.budget_arg_text(p_args, 'name', 100, false);
begin
  select * into v from public.budget_document_types t
  where t.workspace_id = p_ws and t.id = public.budget_arg_uuid(p_args, 'documentTypeId', true) for update;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'type';
  end if;
  if v.is_system then
    raise exception 'DOCUMENT_TYPE_SYSTEM';
  end if;
  perform public.budget_check_version(p_args, v.row_version, false);
  if v_name is not null and v_name <> v.name and exists (
    select 1 from public.budget_document_types t where t.workspace_id = p_ws and t.name = v_name) then
    raise exception 'DUPLICATE_NAME';
  end if;
  update public.budget_document_types t
  set name = coalesce(v_name, t.name), is_active = coalesce(public.budget_arg_bool(p_args, 'isActive'), t.is_active)
  where t.workspace_id = p_ws and t.id = v.id;
  return public.budget_op_get_settings(p_ws, p_actor, '{}'::jsonb);
end;
$fn$;

-- ===========================================================================
-- Stage 3 functions extended for Stage 4.
-- ===========================================================================

-- The close guard: Stage 3's financial conditions + (Stage 4) the required
-- documents and the order-form flow, from the ONE requirement engine.
create or replace function public.budget_close_blockers(p_ws uuid, p_expense_id uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_out text[] := '{}';
  f record;
  v_missing jsonb;
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
  v_missing := public.budget_document_requirements_live(p_ws, p_expense_id) -> 'missing';
  if exists (select 1 from jsonb_array_elements_text(v_missing) m where m in ('order_form', 'order_form_signed')) then
    v_out := array_append(v_out, 'ORDER_FORM_INCOMPLETE');
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_missing) m where m not in ('order_form', 'order_form_signed')) then
    v_out := array_append(v_out, 'REQUIRED_DOCUMENTS_MISSING');
  end if;
  return v_out;
end;
$fn$;

-- Identical to Stage 3 except: closing records the requirement snapshot in
-- the same transaction.
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
    -- Stage 4: freeze the requirements that applied at close.
    insert into public.budget_expense_requirement_snapshots
      (workspace_id, expense_id, snapshot, created_by_type, created_by_id, created_by_name)
    values (p_ws, v.id,
      public.budget_document_requirements_live(p_ws, v.id)
        || jsonb_build_object('mode', 'snapshot', 'capturedAt', now()),
      p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  end if;

  update public.budget_expenses e set
    status = v_to,
    status_reason = v_reason,
    closed_at = case when v_to = 'closed' then now() else null end
  where e.workspace_id = p_ws and e.id = v.id;
  return public.budget_expense_json(p_ws, v.id);
end;
$fn$;

-- Stage 3's history + the document rows (documents, versions, order forms,
-- uploads, flags, snapshots) of the expense / supplier.
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
               where a.workspace_id = p_ws and a.expense_id = v_id)
          or (ev.entity_type = 'budget_document_versions'
              and (coalesce(ev.after_data, ev.before_data) ->> 'document_id') in (
               select d.id::text from public.budget_documents d
               where d.workspace_id = p_ws and d.expense_id = v_id)))), '[]'::jsonb);
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
        and ((ev.entity_type in ('budget_suppliers', 'budget_supplier_bank_details', 'supplier')
              and ev.entity_id = v_id::text)
          or (ev.entity_type in ('budget_documents', 'budget_document_uploads')
              and coalesce(ev.after_data, ev.before_data) ->> 'supplier_id' = v_id::text)
          or (ev.entity_type = 'budget_document_versions'
              and (coalesce(ev.after_data, ev.before_data) ->> 'document_id') in (
               select d.id::text from public.budget_documents d
               where d.workspace_id = p_ws and d.supplier_id = v_id)))), '[]'::jsonb);
  else
    raise exception 'INVALID_INPUT' using detail = 'entityType';
  end if;
end;
$fn$;

-- The op -> permission map: Stage 3's entries unchanged + the Stage 4 ops.
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
