-- Budget Stage 7A - release readiness: the workspace delete guard, the
-- deletion export, download audit and the Storage orphan cleanup.
--
-- 1. WORKSPACE DELETE GUARD (the approved Stage 2 rule): a workspace holding
--    Budget data can be deleted permanently only with a fresh, VERIFIED
--    deletion export. A BEFORE DELETE trigger on election_workspaces checks it
--    atomically with the delete - the DELETE holds the workspace row lock, and
--    every Budget dispatcher call needs that row FOR SHARE, so no Budget write
--    can interleave - then purges the Budget rows in dependency order and
--    records the deletion in an append-only log that outlives the workspace.
--    Without a fresh verified export the delete is refused
--    (BUDGET_EXPORT_REQUIRED / BUDGET_EXPORT_STALE). There is still no product
--    path that deletes a workspace; this guards every path (a future Platform
--    flow, an operator's SQL). The stored files become unreferenced and are
--    removed by the Storage cleanup (4).
-- 2. DELETION EXPORT (Election Owner only): every Budget data table in parts of
--    200 rows, each part one JSON text with its sha256; a manifest with row
--    counts, part checksums and a content FINGERPRINT; the stored documents one
--    at a time through 60-second signed links; and a verification step that
--    requires every part and every document to have been served by this export
--    AND confirmed by the client with the expected checksum, the content being
--    still unchanged. FRESHNESS = the fingerprint over every Budget data table,
--    the append-only audit log included, so ANY Budget mutation after the
--    export changes it. Document downloads (the access log) are reads and do
--    not. Bank account numbers are exported masked (last 4), as in the audit.
-- 3. DOWNLOAD AUDIT: each authorized signed-link issuance is logged once in the
--    append-only budget_document_access_log (purpose download / export).
-- 4. STORAGE CLEANUP: budget_storage_orphans lists objects of the private
--    bucket that no document version references and no open upload intent
--    protects, older than one hour; the Budget endpoint removes them in bounded
--    batches (GET + CRON_SECRET, no new function) and records every run.
--
-- The purge bypass of the immutability triggers is the transaction-local
-- setting kolbox.budget_purge = <workspace id>. Only budget_purge_workspace_data
-- sets it (granted to no role, called only by the delete guard), and the
-- triggers honour it only for DELETEs of rows of that one workspace.
--
-- MANUAL ROLLBACK (no export / deletion / access rows may be needed):
--   drop trigger election_workspaces_budget_delete_guard on public.election_workspaces;
--   re-create budget_refuse_mutation, budget_payments_guard,
--   budget_order_form_versions_guard, budget_audit_row,
--   budget_op_document_version_locate and budget_op_permissions from their
--   previous migrations; drop the functions and the five tables created here.

begin;

-- ===========================================================================
-- Tables.
-- ===========================================================================

-- Download audit (append-only).
create table public.budget_document_access_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.election_workspaces (id) on delete cascade,
  version_id    uuid not null,
  purpose       text not null check (purpose in ('download', 'export')),
  export_id     uuid,
  actor_type    text not null check (actor_type in ('worker', 'owner')),
  actor_id      uuid not null,
  actor_name    text not null,
  issued_at     timestamptz not null default now(),
  constraint budget_document_access_log_version_fkey foreign key (workspace_id, version_id)
    references public.budget_document_versions (workspace_id, id) on delete restrict
);
create index budget_document_access_log_version_idx
  on public.budget_document_access_log (workspace_id, version_id, issued_at desc);

comment on table public.budget_document_access_log is
  'Budget Stage 7A: one row per authorized signed-link issuance (download or deletion export) - the link itself is never logged. Append-only. A read, so it is not part of the deletion-export freshness fingerprint.';

-- Deletion exports (bookkeeping - not Budget data, not audited, not exported).
create table public.budget_data_exports (
  id                 uuid primary key,
  workspace_id       uuid not null references public.election_workspaces (id) on delete cascade,
  format             text not null check (format = 'kolbox-budget-export-v1'),
  state              text not null default 'open' check (state in ('open', 'verified')),
  part_rows          integer not null check (part_rows between 1 and 1000),
  access_high_water  bigint not null check (access_high_water >= 0),
  manifest           jsonb not null,
  manifest_sha256    text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  fingerprint        text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  created_by_type    text not null check (created_by_type in ('worker', 'owner')),
  created_by_id      uuid not null,
  created_by_name    text not null,
  created_at         timestamptz not null default now(),
  verified_at        timestamptz,
  constraint budget_data_exports_workspace_id_id_key unique (workspace_id, id),
  constraint budget_data_exports_verified_check check ((state = 'verified') = (verified_at is not null))
);
create index budget_data_exports_workspace_idx on public.budget_data_exports (workspace_id, created_at desc);

comment on table public.budget_data_exports is
  'Budget Stage 7A: deletion exports. fingerprint = sha256 over every Budget data table''s content (audit log included, access log excluded) when the export started. A workspace holding Budget data can be deleted only with a VERIFIED export whose fingerprint equals the current one.';

create table public.budget_data_export_serves (
  workspace_id  uuid not null,
  export_id     uuid not null,
  item          text not null check (item ~ '^(part:budget_[a-z_]{1,60}:[0-9]{1,6}|doc:[0-9a-f-]{36})$'),
  served_at     timestamptz not null default now(),
  primary key (export_id, item),
  constraint budget_data_export_serves_export_fkey foreign key (workspace_id, export_id)
    references public.budget_data_exports (workspace_id, id) on delete cascade
);

-- The deletion record - no foreign key on purpose: it outlives the workspace.
create table public.budget_workspace_deletions (
  id                      bigint generated always as identity primary key,
  workspace_id            uuid not null,
  workspace_name          text not null,
  export_id               uuid not null,
  export_manifest_sha256  text not null,
  fingerprint             text not null,
  row_counts              jsonb not null,
  document_objects        integer not null,
  deleted_by              text not null default session_user,
  deleted_at              timestamptz not null default now()
);

comment on table public.budget_workspace_deletions is
  'Budget Stage 7A: append-only record of every permanent deletion of a workspace that held Budget data (the export it relied on, its checksums, the purged row counts). Kept after the workspace is gone.';

create table public.budget_storage_cleanup_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  candidates  integer not null check (candidates between 0 and 200),
  removed     integer not null check (removed >= 0),
  failed      integer not null check (failed >= 0),
  objects     jsonb not null
);

comment on table public.budget_storage_cleanup_runs is
  'Budget Stage 7A: append-only record of each Storage orphan cleanup run (the removed object names).';

-- ===========================================================================
-- Immutability, with the ONE purge exception.
-- ===========================================================================
create or replace function public.budget_purge_active(p_ws uuid)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select p_ws is not null and coalesce(current_setting('kolbox.budget_purge', true), '') = p_ws::text;
$fn$;

create or replace function public.budget_refuse_mutation()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- The one exception: the workspace-deletion purge removing rows of the
  -- workspace being deleted (budget_purge_workspace_data).
  if tg_level = 'ROW' and tg_op = 'DELETE' then
    if public.budget_purge_active(old.workspace_id) then
      return old;
    end if;
  end if;
  raise exception 'BUDGET_APPEND_ONLY: % on %', tg_op, tg_table_name;
end;
$fn$;

-- Strictly append-only (the deletion record and the cleanup runs): no exception.
create or replace function public.budget_refuse_always()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'BUDGET_APPEND_ONLY: % on %', tg_op, tg_table_name;
end;
$fn$;

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
    if public.budget_purge_active(old.workspace_id) then
      return old;
    end if;
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

create or replace function public.budget_order_form_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    if public.budget_purge_active(old.workspace_id) then
      return old;
    end if;
    raise exception 'BUDGET_APPEND_ONLY: DELETE on budget_order_form_versions';
  end if;
  if old.sent_at is not null
     or new.sent_at is null
     or (to_jsonb(new) - array['sent_at', 'sent_by_name', 'sent_note', 'row_version', 'updated_at'])
        is distinct from (to_jsonb(old) - array['sent_at', 'sent_by_name', 'sent_note', 'row_version', 'updated_at'])
  then
    raise exception 'BUDGET_APPEND_ONLY: UPDATE on budget_order_form_versions';
  end if;
  return new;
end;
$fn$;

-- Row-change audit: unchanged, except that the purge's DELETEs of the
-- workspace being deleted are not audited (its audit rows are purged last).
create or replace function public.budget_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_ws uuid := (v_row ->> 'workspace_id')::uuid;
  v_actor jsonb;
  v_entity text;
begin
  if tg_op = 'DELETE' and public.budget_purge_active(v_ws) then
    return old;
  end if;
  v_actor := public.budget_actor_context();
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

create trigger budget_document_access_log_append_only before update or delete on public.budget_document_access_log
  for each row execute function public.budget_refuse_mutation();
create trigger budget_document_access_log_no_truncate before truncate on public.budget_document_access_log
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_workspace_deletions_append_only before update or delete on public.budget_workspace_deletions
  for each row execute function public.budget_refuse_always();
create trigger budget_workspace_deletions_no_truncate before truncate on public.budget_workspace_deletions
  for each statement execute function public.budget_refuse_always();
create trigger budget_storage_cleanup_runs_append_only before update or delete on public.budget_storage_cleanup_runs
  for each row execute function public.budget_refuse_always();
create trigger budget_storage_cleanup_runs_no_truncate before truncate on public.budget_storage_cleanup_runs
  for each statement execute function public.budget_refuse_always();

do $$
declare
  t text;
begin
  foreach t in array array['budget_document_access_log', 'budget_data_exports', 'budget_data_export_serves',
                           'budget_workspace_deletions', 'budget_storage_cleanup_runs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('revoke all on table public.%I from service_role', t);
  end loop;
end $$;

revoke all on sequence public.budget_document_access_log_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.budget_workspace_deletions_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.budget_storage_cleanup_runs_id_seq from public, anon, authenticated, service_role;

-- ===========================================================================
-- The export content: every Budget data table, canonical row form and order.
-- ===========================================================================
create or replace function public.budget_export_tables()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    'budget_settings', 'budget_categories', 'budget_category_plans', 'budget_plan_adjustments',
    'budget_funding_sources', 'budget_funding_source_adjustments', 'budget_suppliers',
    'budget_supplier_bank_details', 'budget_document_types', 'budget_document_rules',
    'budget_document_rule_categories', 'budget_expenses', 'budget_expense_allocations',
    'budget_party_preapprovals', 'budget_party_submissions', 'budget_party_submission_events',
    'budget_party_payment_references', 'budget_supplier_payments', 'budget_documents',
    'budget_document_versions', 'budget_order_form_versions', 'budget_document_uploads',
    'budget_expense_document_flags', 'budget_expense_requirement_snapshots',
    'budget_audit_events', 'budget_document_access_log']::text[];
$fn$;

-- A unique, stable order per table (its primary key).
create or replace function public.budget_export_order(p_table text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case p_table
    when 'budget_settings' then 't.workspace_id'
    when 'budget_category_plans' then 't.category_id'
    when 'budget_document_rule_categories' then 't.rule_id, t.category_id'
    when 'budget_expense_document_flags' then 't.expense_id, t.document_type_id'
    when 'budget_supplier_bank_details' then 't.supplier_id'
    when 'budget_party_preapprovals' then 't.allocation_id'
    when 'budget_party_submissions' then 't.allocation_id'
    when 'budget_party_payment_references' then 't.allocation_id'
    else 't.id'
  end;
$fn$;

-- The row set of one table: to_jsonb(row) (callers fix TimeZone = UTC, so the
-- text is deterministic), bank account numbers masked to the last 4 digits,
-- the access log frozen at the export's high-water mark ($2).
create or replace function public.budget_export_rows_sql(p_table text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_row text := case when p_table = 'budget_supplier_bank_details'
    then 'to_jsonb(t) || jsonb_build_object(''account_number'', ''****'' || right(t.account_number, 4))'
    else 'to_jsonb(t)' end;
begin
  if p_table is null or not (p_table = any(public.budget_export_tables())) then
    raise exception 'INVALID_INPUT' using detail = 'table';
  end if;
  return format(
    'select %s as j, row_number() over (order by %s) as rn from public.%I t where t.workspace_id = $1%s',
    v_row, public.budget_export_order(p_table), p_table,
    case when p_table = 'budget_document_access_log' then ' and t.id <= $2' else '' end);
end;
$fn$;

-- Part checksums of one table: part n = rows n*200+1 .. (n+1)*200 in order,
-- its text = jsonb_agg of those rows, checksum = sha256 of that UTF-8 text.
create or replace function public.budget_export_table_parts(p_ws uuid, p_table text, p_hw bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  v jsonb;
begin
  execute format(
    'with r as (%s), g as (
       select ((rn - 1) / 200)::integer as part, count(*)::integer as n, jsonb_agg(j order by rn)::text as body
       from r group by 1)
     select coalesce(jsonb_agg(jsonb_build_object(''part'', part, ''rows'', n,
       ''sha256'', encode(sha256(convert_to(body, ''UTF8'')), ''hex'')) order by part), ''[]''::jsonb)
     from g', public.budget_export_rows_sql(p_table))
  into v using p_ws, p_hw;
  return v;
end;
$fn$;

-- The exact text of one part (identical to what budget_export_table_parts hashed).
create or replace function public.budget_export_part_text(p_ws uuid, p_table text, p_part integer, p_hw bigint)
returns text
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  v text;
begin
  execute format(
    'with r as (%s) select jsonb_agg(j order by rn)::text from r where rn > $3::bigint * 200 and rn <= ($3::bigint + 1) * 200',
    public.budget_export_rows_sql(p_table))
  into v using p_ws, p_hw, p_part;
  return v;
end;
$fn$;

create or replace function public.budget_export_manifest_tables(p_ws uuid, p_hw bigint, p_with_access boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  t text;
  v_parts jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  foreach t in array public.budget_export_tables() loop
    continue when t = 'budget_document_access_log' and not p_with_access;
    v_parts := public.budget_export_table_parts(p_ws, t, p_hw);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'name', t,
      'rows', (select coalesce(sum((x ->> 'rows')::integer), 0) from jsonb_array_elements(v_parts) x),
      'parts', v_parts,
      'sha256', encode(sha256(convert_to(coalesce(
        (select string_agg(x ->> 'sha256', '' order by (x ->> 'part')::integer) from jsonb_array_elements(v_parts) x),
        ''), 'UTF8')), 'hex')));
  end loop;
  return v_out;
end;
$fn$;

-- Freshness fingerprint: every data table except the access log (reads).
create or replace function public.budget_export_fingerprint_of(p_tables jsonb)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select encode(sha256(convert_to(coalesce(
    string_agg((e.x ->> 'name') || ':' || (e.x ->> 'rows') || ':' || (e.x ->> 'sha256'), '|' order by e.o), ''), 'UTF8')), 'hex')
  from jsonb_array_elements(p_tables) with ordinality as e(x, o)
  where e.x ->> 'name' <> 'budget_document_access_log';
$fn$;

create or replace function public.budget_export_fingerprint(p_ws uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
begin
  return public.budget_export_fingerprint_of(public.budget_export_manifest_tables(p_ws, 0, false));
end;
$fn$;

-- "Holds Budget data" = any row in any Budget data table (conservative: the
-- lazily created default settings count too).
create or replace function public.budget_workspace_has_data(p_ws uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  t text;
  v boolean;
begin
  foreach t in array public.budget_export_tables() loop
    execute format('select exists (select 1 from public.%I x where x.workspace_id = $1)', t) into v using p_ws;
    if v then
      return true;
    end if;
  end loop;
  return false;
end;
$fn$;

create or replace function public.budget_require_owner(p_actor jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  if coalesce(p_actor ->> 'type', '') <> 'owner' then
    raise exception 'FORBIDDEN';
  end if;
end;
$fn$;

create or replace function public.budget_export_summary_json(e public.budget_data_exports, p_current_fp text)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'id', e.id, 'state', e.state, 'createdAt', e.created_at, 'verifiedAt', e.verified_at,
    'createdByName', e.created_by_name, 'fresh', e.fingerprint = p_current_fp,
    'tables', e.manifest -> 'totals' -> 'tables', 'rows', e.manifest -> 'totals' -> 'rows',
    'parts', e.manifest -> 'totals' -> 'parts', 'documents', e.manifest -> 'documents');
$fn$;

-- ===========================================================================
-- Export ops (Election Owner only).
-- ===========================================================================
create or replace function public.budget_op_export_status(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_has boolean;
  v_fp text;
  e public.budget_data_exports;
begin
  perform public.budget_require_owner(p_actor);
  v_has := public.budget_workspace_has_data(p_ws);
  v_fp := public.budget_export_fingerprint(p_ws);
  select * into e from public.budget_data_exports x
  where x.workspace_id = p_ws order by x.created_at desc, x.id desc limit 1;
  return jsonb_build_object(
    'hasBudgetData', v_has,
    'deletionAllowed', not v_has or exists (
      select 1 from public.budget_data_exports x
      where x.workspace_id = p_ws and x.state = 'verified' and x.fingerprint = v_fp),
    'latest', case when e.id is null then null else public.budget_export_summary_json(e, v_fp) end);
end;
$fn$;

create or replace function public.budget_op_export_start(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  v_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_hw bigint;
  v_tables jsonb;
  v_fp text;
  v_docs jsonb;
  v_manifest jsonb;
begin
  perform public.budget_require_owner(p_actor);
  if p_args <> '{}'::jsonb then
    raise exception 'INVALID_INPUT';
  end if;
  -- Every Budget write holds the workspace row FOR SHARE until it commits:
  -- this waits for those in flight and holds new ones off while the manifest
  -- is taken, so it describes ONE consistent state. (NO KEY UPDATE: plain
  -- foreign-key checks from the other modules are not blocked.)
  perform 1 from public.election_workspaces w where w.id = p_ws for no key update;
  -- One open (unverified) export at a time.
  delete from public.budget_data_exports x where x.workspace_id = p_ws and x.state = 'open';

  select coalesce(max(l.id), 0) into v_hw from public.budget_document_access_log l where l.workspace_id = p_ws;
  v_tables := public.budget_export_manifest_tables(p_ws, v_hw, true);
  v_fp := public.budget_export_fingerprint_of(v_tables);
  select jsonb_build_object('count', count(*), 'bytes', coalesce(sum(v.size_bytes), 0)) into v_docs
  from public.budget_document_versions v where v.workspace_id = p_ws;

  v_manifest := jsonb_build_object(
    'format', 'kolbox-budget-export-v1',
    'exportId', v_id,
    'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.election_workspaces w where w.id = p_ws),
    'createdAt', v_now,
    'createdBy', p_actor ->> 'name',
    'partRows', 200,
    'rowEncoding', 'each part is one JSON array of to_jsonb(row) in primary-key order, timestamps in UTC; sha256 is over the UTF-8 bytes of that exact text',
    'bankAccountNumbers', 'masked_last4',
    'tables', v_tables,
    'totals', jsonb_build_object(
      'tables', jsonb_array_length(v_tables),
      'rows', (select coalesce(sum((x ->> 'rows')::bigint), 0) from jsonb_array_elements(v_tables) x),
      'parts', (select coalesce(sum(jsonb_array_length(x -> 'parts')), 0) from jsonb_array_elements(v_tables) x)),
    'documents', v_docs,
    'fingerprint', v_fp);

  insert into public.budget_data_exports (id, workspace_id, format, part_rows, access_high_water, manifest,
    manifest_sha256, fingerprint, created_by_type, created_by_id, created_by_name, created_at)
  values (v_id, p_ws, 'kolbox-budget-export-v1', 200, v_hw, v_manifest,
    encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex'), v_fp,
    p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name', v_now);
  return v_manifest;
end;
$fn$;

create or replace function public.budget_op_export_part(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  v_export uuid := public.budget_arg_uuid(p_args, 'exportId', true);
  v_table text := public.budget_arg_text(p_args, 'table', 63, true);
  v_part integer := public.budget_arg_amount(p_args, 'part', true, 0, 100000)::integer;
  e public.budget_data_exports;
  v_entry jsonb;
  v_text text;
  v_sha text;
begin
  perform public.budget_require_owner(p_actor);
  select * into e from public.budget_data_exports x where x.workspace_id = p_ws and x.id = v_export;
  if e.id is null then
    raise exception 'NOT_FOUND' using detail = 'export';
  end if;
  if not (v_table = any(public.budget_export_tables())) then
    raise exception 'INVALID_INPUT' using detail = 'table';
  end if;
  select p into v_entry
  from jsonb_array_elements(e.manifest -> 'tables') t, jsonb_array_elements(t -> 'parts') p
  where t ->> 'name' = v_table and (p ->> 'part')::integer = v_part;
  if v_entry is null then
    raise exception 'NOT_FOUND' using detail = 'part';
  end if;
  v_text := public.budget_export_part_text(p_ws, v_table, v_part, e.access_high_water);
  v_sha := encode(sha256(convert_to(coalesce(v_text, ''), 'UTF8')), 'hex');
  -- The data changed since the manifest was taken: this export can never verify.
  if v_sha <> v_entry ->> 'sha256' then
    raise exception 'EXPORT_STALE';
  end if;
  insert into public.budget_data_export_serves (workspace_id, export_id, item)
  values (p_ws, e.id, 'part:' || v_table || ':' || v_part)
  on conflict do nothing;
  return jsonb_build_object('table', v_table, 'part', v_part, 'rows', (v_entry ->> 'rows')::integer,
    'sha256', v_sha, 'rowsJson', v_text);
end;
$fn$;

-- Handler-internal: where one stored version lives, for the export's signed link.
create or replace function public.budget_op_export_document_locate(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_export uuid := public.budget_arg_uuid(p_args, 'exportId', true);
  v_version uuid := public.budget_arg_uuid(p_args, 'versionId', true);
  v record;
begin
  perform public.budget_require_owner(p_actor);
  if not exists (select 1 from public.budget_data_exports x where x.workspace_id = p_ws and x.id = v_export) then
    raise exception 'NOT_FOUND' using detail = 'export';
  end if;
  select dv.id, dv.storage_path, dv.file_name, dv.mime_type, dv.sha256, dv.size_bytes into v
  from public.budget_document_versions dv where dv.workspace_id = p_ws and dv.id = v_version;
  if not found then
    raise exception 'NOT_FOUND' using detail = 'version';
  end if;
  insert into public.budget_data_export_serves (workspace_id, export_id, item)
  values (p_ws, v_export, 'doc:' || v.id)
  on conflict do nothing;
  insert into public.budget_document_access_log (workspace_id, version_id, purpose, export_id, actor_type, actor_id, actor_name)
  values (p_ws, v.id, 'export', v_export, p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return jsonb_build_object('storagePath', v.storage_path, 'fileName', v.file_name, 'mimeType', v.mime_type,
    'sha256', v.sha256, 'sizeBytes', v.size_bytes);
end;
$fn$;

-- Verification: every manifest part and every stored document was served by
-- THIS export and confirmed by the client with the expected checksum, and the
-- content is still exactly what was exported.
create or replace function public.budget_op_export_verify(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $fn$
declare
  v_export uuid := public.budget_arg_uuid(p_args, 'exportId', true);
  v_parts jsonb := p_args -> 'parts';
  v_docs jsonb := p_args -> 'documents';
  e public.budget_data_exports;
  v_missing bigint;
  v_missing_docs bigint;
begin
  perform public.budget_require_owner(p_actor);
  if exists (select 1 from jsonb_object_keys(p_args) k where k not in ('exportId', 'parts', 'documents')) then
    raise exception 'INVALID_INPUT';
  end if;
  if jsonb_typeof(v_parts) is distinct from 'array' or jsonb_typeof(v_docs) is distinct from 'array'
     or jsonb_array_length(v_parts) > 100000 or jsonb_array_length(v_docs) > 100000 then
    raise exception 'INVALID_INPUT' using detail = 'receipt';
  end if;
  select * into e from public.budget_data_exports x where x.workspace_id = p_ws and x.id = v_export for update;
  if e.id is null then
    raise exception 'NOT_FOUND' using detail = 'export';
  end if;

  with m as (
    select t ->> 'name' as tbl, p ->> 'part' as part, p ->> 'sha256' as sha
    from jsonb_array_elements(e.manifest -> 'tables') t, jsonb_array_elements(t -> 'parts') p
  ), r as (
    select distinct x ->> 'table' as tbl, x ->> 'part' as part, x ->> 'sha256' as sha
    from jsonb_array_elements(v_parts) x
  )
  select count(*) into v_missing
  from m
  left join r on r.tbl = m.tbl and r.part = m.part and r.sha = m.sha
  left join public.budget_data_export_serves s on s.export_id = e.id and s.item = 'part:' || m.tbl || ':' || m.part
  where r.tbl is null or s.item is null;

  with r as (
    select distinct x ->> 'versionId' as vid, x ->> 'sha256' as sha from jsonb_array_elements(v_docs) x
  )
  select count(*) into v_missing_docs
  from public.budget_document_versions dv
  left join r on r.vid = dv.id::text and r.sha = dv.sha256
  left join public.budget_data_export_serves s on s.export_id = e.id and s.item = 'doc:' || dv.id
  where dv.workspace_id = p_ws and (r.vid is null or s.item is null);

  if v_missing + v_missing_docs > 0 then
    raise exception 'EXPORT_INCOMPLETE';
  end if;
  if public.budget_export_fingerprint(p_ws) <> e.fingerprint then
    raise exception 'EXPORT_STALE';
  end if;
  update public.budget_data_exports x set state = 'verified', verified_at = coalesce(x.verified_at, now())
  where x.workspace_id = p_ws and x.id = e.id;
  return public.budget_op_export_status(p_ws, p_actor, '{}'::jsonb);
end;
$fn$;

-- ===========================================================================
-- The workspace delete guard + the purge.
-- ===========================================================================
create or replace function public.budget_purge_workspace_data(p_ws uuid, p_export uuid, p_name text, p_fingerprint text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  t text;
  n bigint;
  v_counts jsonb := '{}'::jsonb;
  v_objects integer;
  v_manifest_sha text;
begin
  foreach t in array public.budget_export_tables() loop
    execute format('select count(*) from public.%I x where x.workspace_id = $1', t) into n using p_ws;
    v_counts := v_counts || jsonb_build_object(t, n);
  end loop;
  select count(*) into v_objects from public.budget_document_versions v where v.workspace_id = p_ws;
  select e.manifest_sha256 into v_manifest_sha from public.budget_data_exports e where e.id = p_export;

  perform pg_catalog.set_config('kolbox.budget_purge', p_ws::text, true);
  -- Children first (composite foreign keys are ON DELETE RESTRICT). Document
  -- versions and order-form versions reference each other: the supplier-signed
  -- returns go first, then the order forms, then the remaining versions.
  delete from public.budget_document_access_log x where x.workspace_id = p_ws;
  delete from public.budget_document_uploads x where x.workspace_id = p_ws;
  delete from public.budget_expense_document_flags x where x.workspace_id = p_ws;
  delete from public.budget_expense_requirement_snapshots x where x.workspace_id = p_ws;
  delete from public.budget_party_submission_events x where x.workspace_id = p_ws;
  delete from public.budget_document_versions x where x.workspace_id = p_ws and x.order_form_version_id is not null;
  delete from public.budget_order_form_versions x where x.workspace_id = p_ws;
  delete from public.budget_document_versions x where x.workspace_id = p_ws;
  delete from public.budget_documents x where x.workspace_id = p_ws;
  delete from public.budget_supplier_payments x where x.workspace_id = p_ws;
  delete from public.budget_party_payment_references x where x.workspace_id = p_ws;
  delete from public.budget_party_submissions x where x.workspace_id = p_ws;
  delete from public.budget_party_preapprovals x where x.workspace_id = p_ws;
  delete from public.budget_expense_allocations x where x.workspace_id = p_ws;
  delete from public.budget_expenses x where x.workspace_id = p_ws;
  delete from public.budget_document_rule_categories x where x.workspace_id = p_ws;
  delete from public.budget_document_rules x where x.workspace_id = p_ws;
  delete from public.budget_document_types x where x.workspace_id = p_ws;
  delete from public.budget_supplier_bank_details x where x.workspace_id = p_ws;
  delete from public.budget_suppliers x where x.workspace_id = p_ws;
  delete from public.budget_funding_source_adjustments x where x.workspace_id = p_ws;
  delete from public.budget_funding_sources x where x.workspace_id = p_ws;
  delete from public.budget_plan_adjustments x where x.workspace_id = p_ws;
  delete from public.budget_category_plans x where x.workspace_id = p_ws;
  delete from public.budget_categories x where x.workspace_id = p_ws;
  delete from public.budget_settings x where x.workspace_id = p_ws;
  delete from public.budget_audit_events x where x.workspace_id = p_ws;
  perform pg_catalog.set_config('kolbox.budget_purge', '', true);

  if public.budget_workspace_has_data(p_ws) then
    raise exception 'BUDGET_PURGE_INCOMPLETE';
  end if;
  insert into public.budget_workspace_deletions (workspace_id, workspace_name, export_id, export_manifest_sha256,
    fingerprint, row_counts, document_objects)
  values (p_ws, p_name, p_export, coalesce(v_manifest_sha, ''), p_fingerprint, v_counts, v_objects);
end;
$fn$;

create or replace function public.budget_workspace_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fp text;
  v_export uuid;
begin
  if not public.budget_workspace_has_data(old.id) then
    return old;
  end if;
  v_fp := public.budget_export_fingerprint(old.id);
  select e.id into v_export
  from public.budget_data_exports e
  where e.workspace_id = old.id and e.state = 'verified' and e.fingerprint = v_fp
  order by e.verified_at desc, e.id
  limit 1;
  if v_export is null then
    if exists (select 1 from public.budget_data_exports e where e.workspace_id = old.id and e.state = 'verified') then
      raise exception 'BUDGET_EXPORT_STALE'
        using detail = 'the Budget data changed after the last verified export - a new export is required';
    end if;
    raise exception 'BUDGET_EXPORT_REQUIRED'
      using detail = 'this workspace holds Budget data - a fresh verified Budget export is required before deletion';
  end if;
  perform public.budget_purge_workspace_data(old.id, v_export, old.name, v_fp);
  return old;
end;
$fn$;

create trigger election_workspaces_budget_delete_guard before delete on public.election_workspaces
  for each row execute function public.budget_workspace_delete_guard();

-- ===========================================================================
-- Storage orphan cleanup (the Budget endpoint calls these as service_role).
-- ===========================================================================
-- Objects of the private bucket that nothing can ever reference again:
-- no document version points at them, no upload intent that could still be
-- finalized protects them (finalize refuses an expired intent; 30 minutes of
-- margin), and they are older than one hour (an order form is stored a moment
-- before its version row is written). A purged workspace's files qualify too.
create or replace function public.budget_storage_orphans(p_limit integer)
returns table (object_name text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;
  return query execute
    'select o.name::text
     from storage.objects o
     where o.bucket_id = ''budget-documents''
       and o.created_at < now() - interval ''1 hour''
       and not exists (select 1 from public.budget_document_versions v where v.storage_path = o.name)
       and not exists (select 1 from public.budget_document_uploads u
                       where u.storage_path = o.name and u.state = ''pending''
                         and u.expires_at > now() - interval ''30 minutes'')
     order by o.created_at, o.name
     limit $1'
  using least(greatest(coalesce(p_limit, 0), 1), 200);
end;
$fn$;

create or replace function public.budget_storage_cleanup_record(p_candidates integer, p_removed text[], p_failed integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id bigint;
begin
  if p_candidates is null or p_candidates < 0 or p_candidates > 200 or p_failed is null or p_failed < 0
     or coalesce(cardinality(p_removed), 0) > p_candidates then
    raise exception 'INVALID_INPUT';
  end if;
  insert into public.budget_storage_cleanup_runs (candidates, removed, failed, objects)
  values (p_candidates, coalesce(cardinality(p_removed), 0), p_failed, to_jsonb(coalesce(p_removed, '{}'::text[])))
  returning id into v_id;
  return v_id;
end;
$fn$;

-- ===========================================================================
-- Download audit: the signed-link locate op now logs the issuance.
-- ===========================================================================
create or replace function public.budget_op_document_version_locate(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v record;
begin
  select dv.id, dv.storage_path, dv.file_name, dv.mime_type into v
  from public.budget_document_versions dv
  where dv.workspace_id = p_ws and dv.id = public.budget_arg_uuid(p_args, 'versionId', true);
  if not found then
    raise exception 'NOT_FOUND' using detail = 'version';
  end if;
  insert into public.budget_document_access_log (workspace_id, version_id, purpose, actor_type, actor_id, actor_name)
  values (p_ws, v.id, 'download', p_actor ->> 'type', (p_actor ->> 'id')::uuid, p_actor ->> 'name');
  return jsonb_build_object('storagePath', v.storage_path, 'fileName', v.file_name, 'mimeType', v.mime_type);
end;
$fn$;

-- ===========================================================================
-- Supplier list performance (found by the Stage 7A volume test): the Stage 3
-- budget_supplier_json evaluated the whole-workspace budget_expense_facts five
-- times PER SUPPLIER, so list_suppliers cost O(suppliers x expenses) - 4.3 s
-- for 50 suppliers x 1,000 expenses. The same object is now built from ONE
-- facts pass for all suppliers (identical output, verified md5-equal for every
-- supplier and every list of the scratch data); the single-supplier JSON reads
-- the same function, so there is still one definition.
-- ===========================================================================
create or replace function public.budget_supplier_list_json(p_ws uuid, p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set plan_cache_mode = force_custom_plan
as $fn$
declare
  v jsonb;
begin
  with f as materialized (
    select * from public.budget_expense_facts(p_ws)
  ), agg as (
    select f.supplier_id,
      sum(f.total) filter (where f.status in ('committed', 'incurred', 'closed')) as total_amount,
      sum(f.outstanding) as outstanding,
      sum(f.party_outstanding) as party_outstanding,
      sum(f.campaign_outstanding) as campaign_outstanding,
      sum(f.unfunded) filter (where f.status in ('committed', 'incurred')) as unfunded_outstanding
    from f
    where f.supplier_id is not null
    group by f.supplier_id
  ), cnt as (
    select e.supplier_id, count(*) as n
    from public.budget_expenses e
    where e.workspace_id = p_ws and e.status <> 'cancelled' and e.supplier_id is not null
    group by e.supplier_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'businessName', s.business_name, 'contactName', s.contact_name, 'phone', s.phone,
    'taxId', s.tax_id, 'address', s.address, 'notes', s.notes, 'isActive', s.is_active,
    'version', s.row_version,
    'bank', case when b.supplier_id is null then null
                 else jsonb_build_object('accountLast4', right(b.account_number, 4)) end,
    'expenseCount', coalesce(cnt.n, 0),
    'totalAmount', coalesce(agg.total_amount, 0),
    'outstanding', coalesce(agg.outstanding, 0),
    'partyOutstanding', coalesce(agg.party_outstanding, 0),
    'campaignOutstanding', coalesce(agg.campaign_outstanding, 0),
    'unfundedOutstanding', coalesce(agg.unfunded_outstanding, 0)) order by s.business_name), '[]'::jsonb)
  into v
  from public.budget_suppliers s
  left join public.budget_supplier_bank_details b on b.workspace_id = s.workspace_id and b.supplier_id = s.id
  left join agg on agg.supplier_id = s.id
  left join cnt on cnt.supplier_id = s.id
  where s.workspace_id = p_ws and (p_supplier_id is null or s.id = p_supplier_id);
  return v;
end;
$fn$;

create or replace function public.budget_supplier_json(p_ws uuid, p_supplier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when p_supplier_id is null then null else public.budget_supplier_list_json(p_ws, p_supplier_id) -> 0 end;
$fn$;

create or replace function public.budget_op_list_suppliers(p_ws uuid, p_actor jsonb, p_args jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.budget_supplier_list_json(p_ws, null);
$fn$;

-- ===========================================================================
-- The op -> permission map: Stages 3-6 unchanged + the Stage 7A export ops.
-- '{owner}' is not a permission any role can hold (the DB allowlist has no such
-- value), so a PermissionUser is always FORBIDDEN; each op also re-checks the
-- actor type itself (budget_require_owner).
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
    when 'mark_submission_ready'     then '{budget.manageFunderSubmissions}'
    when 'get_dashboard'             then '{}'
    when 'report_expenses'           then '{budget.viewReports}'
    when 'report_categories'         then '{budget.viewReports}'
    when 'report_sources'            then '{budget.viewReports}'
    when 'report_suppliers'          then '{budget.viewReports}'
    when 'report_party'              then '{budget.viewReports}'
    when 'report_plan'               then '{budget.viewReports}'
    when 'report_payments'           then '{budget.viewReports}'
    -- Stage 7A: the deletion export - the Election Owner only.
    when 'export_status'             then '{owner}'
    when 'export_start'              then '{owner}'
    when 'export_part'               then '{owner}'
    when 'export_document_locate'    then '{owner}'
    when 'export_verify'             then '{owner}'
    else null
  end;
end;
$fn$;

-- ===========================================================================
-- ACL: re-assert the posture over EVERY budget_* function (the new ones
-- included): granted to no role, except the two dispatchers, the worker
-- step-up mint and the two Storage cleanup functions (service_role only).
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
grant execute on function public.budget_storage_orphans(integer) to service_role;
grant execute on function public.budget_storage_cleanup_record(integer, text[], integer) to service_role;

commit;
