-- Budget Stage 4 (A/2) - documents, versions, order forms, requirement
-- snapshots and the private storage bucket.
--
-- Same protections as the Stage 3 schema (20260917010000):
--   * ISOLATION: workspace_id on every row, COMPOSITE (workspace_id, x_id)
--     foreign keys, so a document can never hang off another workspace's
--     expense / supplier / type / order form.
--   * ACCESS: RLS on, zero policies, every table privilege revoked from
--     PUBLIC/anon/authenticated AND service_role; only the SECURITY DEFINER
--     functions of migration B read or write.
--   * HISTORY: the Stage 3 actor-context audit trigger on every table.
--     Document versions, requirement snapshots and generated order-form
--     versions are IMMUTABLE: a file is never overwritten - a replacement is
--     the next version, the old one stays readable forever.
--
-- Files live in the PRIVATE Storage bucket "budget-documents" at
-- <workspace_id>/<uuid> (a server-generated path; the user's file name is
-- display metadata only and never part of the path). No public URL exists:
-- the Budget endpoint hands out 60-second signed links after authorizing the
-- caller. A RESTRICTIVE policy denies anon/authenticated on this bucket even
-- if some other permissive storage policy exists.
--
-- MANUAL ROLLBACK (only with zero Stage 4 data; revert migration B first):
--   begin;
--   alter table public.budget_document_versions drop constraint if exists budget_document_versions_order_form_fkey;
--   drop table if exists public.budget_expense_requirement_snapshots, public.budget_expense_document_flags,
--     public.budget_document_uploads, public.budget_order_form_versions, public.budget_document_versions,
--     public.budget_documents cascade;
--   drop function if exists public.budget_order_form_versions_guard();
--   drop policy if exists budget_documents_bucket_deny on storage.objects;
--   -- the bucket itself: delete its objects through the Storage API first, then
--   -- delete from storage.buckets where id = 'budget-documents';
--   commit;

begin;

-- ===========================================================================
-- Documents: one logical document (a "slot") on an expense OR a supplier.
-- ===========================================================================
create table public.budget_documents (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.election_workspaces (id) on delete cascade,
  expense_id        uuid,
  supplier_id       uuid,
  document_type_id  uuid not null,
  title             text check (title is null or (btrim(title) <> '' and length(title) <= 200)),
  notes             text check (notes is null or length(notes) <= 1000),
  valid_until       date,
  status            text not null default 'active' check (status in ('active', 'archived')),
  archived_at       timestamptz,
  archive_reason    text check (archive_reason is null or (btrim(archive_reason) <> '' and length(archive_reason) <= 500)),
  row_version       integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint budget_documents_workspace_id_id_key unique (workspace_id, id),
  constraint budget_documents_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict,
  constraint budget_documents_supplier_fkey foreign key (workspace_id, supplier_id)
    references public.budget_suppliers (workspace_id, id) on delete restrict,
  constraint budget_documents_type_fkey foreign key (workspace_id, document_type_id)
    references public.budget_document_types (workspace_id, id) on delete restrict,
  -- Exactly one owner: an expense document or a supplier document.
  constraint budget_documents_owner_check check (num_nonnulls(expense_id, supplier_id) = 1),
  -- Only a supplier document (e.g. a bank-account confirmation) has a validity date.
  constraint budget_documents_valid_until_check check (valid_until is null or supplier_id is not null),
  constraint budget_documents_archive_check check (
    (status = 'archived') = (archived_at is not null) and (status = 'archived') = (archive_reason is not null))
);
create index budget_documents_expense_idx on public.budget_documents (workspace_id, expense_id) where expense_id is not null;
create index budget_documents_supplier_idx on public.budget_documents (workspace_id, supplier_id) where supplier_id is not null;

comment on table public.budget_documents is
  'Budget Stage 4: a logical document on an expense or a supplier. Its files are budget_document_versions (immutable); "archive" hides it from requirement checks but keeps every version. Never deleted.';

-- ===========================================================================
-- Versions: one stored file each, IMMUTABLE.
-- ===========================================================================
create table public.budget_document_versions (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  document_id            uuid not null,
  version_no             integer not null check (version_no between 1 and 10000),
  storage_path           text not null check (
    storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  file_name              text not null check (btrim(file_name) <> '' and length(file_name) <= 150),
  mime_type              text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  size_bytes             bigint not null check (size_bytes between 1 and 10485760),
  sha256                 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  origin                 text not null check (origin in ('upload', 'generated')),
  -- A supplier-returned signed order form: the generated version it answers.
  order_form_version_id  uuid,
  note                   text check (note is null or length(note) <= 500),
  created_by_type        text not null check (created_by_type in ('worker', 'owner')),
  created_by_id          uuid not null,
  created_by_name        text not null,
  created_at             timestamptz not null default now(),
  constraint budget_document_versions_workspace_id_id_key unique (workspace_id, id),
  constraint budget_document_versions_document_version_key unique (workspace_id, document_id, version_no),
  constraint budget_document_versions_storage_path_key unique (storage_path),
  -- The object path always lives under the row's own workspace prefix.
  constraint budget_document_versions_path_workspace_check check (split_part(storage_path, '/', 1) = workspace_id::text),
  constraint budget_document_versions_document_fkey foreign key (workspace_id, document_id)
    references public.budget_documents (workspace_id, id) on delete restrict
);
create index budget_document_versions_order_form_idx
  on public.budget_document_versions (workspace_id, order_form_version_id) where order_form_version_id is not null;

comment on table public.budget_document_versions is
  'Budget Stage 4: one stored file (private bucket budget-documents, path <workspace_id>/<uuid>). Append-only: UPDATE/DELETE/TRUNCATE refused, so a historical version can never be overwritten. sha256/size/mime are verified server-side from the stored bytes (magic bytes) before the row is written.';

-- ===========================================================================
-- Generated order forms (the party funder form, one row per PDF version).
-- ===========================================================================
create table public.budget_order_form_versions (
  id                           uuid primary key default gen_random_uuid(),
  workspace_id                 uuid not null,
  expense_id                   uuid not null,
  version_no                   integer not null check (version_no between 1 and 10000),
  document_version_id          uuid not null,
  template_key                 text not null check (template_key ~ '^[a-z0-9_.-]{1,40}$'),
  snapshot                     jsonb not null,
  supplier_signature_required  boolean not null,
  sent_at                      timestamptz,
  sent_by_name                 text,
  sent_note                    text check (sent_note is null or length(sent_note) <= 500),
  created_by_type              text not null check (created_by_type in ('worker', 'owner')),
  created_by_id                uuid not null,
  created_by_name              text not null,
  created_at                   timestamptz not null default now(),
  row_version                  integer not null default 1,
  updated_at                   timestamptz not null default now(),
  constraint budget_order_form_versions_workspace_id_id_key unique (workspace_id, id),
  constraint budget_order_form_versions_expense_version_key unique (workspace_id, expense_id, version_no),
  constraint budget_order_form_versions_document_version_key unique (workspace_id, document_version_id),
  constraint budget_order_form_versions_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict,
  constraint budget_order_form_versions_document_version_fkey foreign key (workspace_id, document_version_id)
    references public.budget_document_versions (workspace_id, id) on delete restrict,
  constraint budget_order_form_versions_sent_check check ((sent_at is null) = (sent_by_name is null))
);

alter table public.budget_document_versions
  add constraint budget_document_versions_order_form_fkey foreign key (workspace_id, order_form_version_id)
    references public.budget_order_form_versions (workspace_id, id) on delete restrict;

comment on table public.budget_order_form_versions is
  'Budget Stage 4: each generated order-form PDF (version N of the expense''s order form). The content columns are immutable; the only change ever allowed is the one-way "user confirmed sent" mark. A regeneration is version N+1; N is never overwritten. "Returned" = a budget_document_versions row whose order_form_version_id points here.';

-- Content is immutable; "sent" is set once, never cleared or changed.
create or replace function public.budget_order_form_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
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

revoke all on function public.budget_order_form_versions_guard() from public;
revoke all on function public.budget_order_form_versions_guard() from anon;
revoke all on function public.budget_order_form_versions_guard() from authenticated;
revoke all on function public.budget_order_form_versions_guard() from service_role;

-- ===========================================================================
-- Upload intents (server-side record of a signed direct-to-Storage upload,
-- finalized only after the stored bytes are verified).
-- ===========================================================================
create table public.budget_document_uploads (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  purpose                text not null check (purpose in ('expense', 'supplier', 'order_form_return')),
  expense_id             uuid,
  supplier_id            uuid,
  document_id            uuid,
  document_type_id       uuid not null,
  order_form_version_id  uuid,
  file_name              text not null check (btrim(file_name) <> '' and length(file_name) <= 150),
  mime_type              text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  size_bytes             bigint not null check (size_bytes between 1 and 10485760),
  storage_path           text not null,
  title                  text check (title is null or length(title) <= 200),
  notes                  text check (notes is null or length(notes) <= 1000),
  valid_until            date,
  state                  text not null default 'pending' check (state in ('pending', 'completed', 'rejected')),
  reject_reason          text check (reject_reason is null or reject_reason ~ '^[a-z_]{1,40}$'),
  version_id             uuid,
  created_by_type        text not null check (created_by_type in ('worker', 'owner')),
  created_by_id          uuid not null,
  created_by_name        text not null,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz not null,
  completed_at           timestamptz,
  row_version            integer not null default 1,
  updated_at             timestamptz not null default now(),
  constraint budget_document_uploads_workspace_id_id_key unique (workspace_id, id),
  constraint budget_document_uploads_storage_path_key unique (storage_path),
  constraint budget_document_uploads_path_workspace_check check (split_part(storage_path, '/', 1) = workspace_id::text),
  constraint budget_document_uploads_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_supplier_fkey foreign key (workspace_id, supplier_id)
    references public.budget_suppliers (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_document_fkey foreign key (workspace_id, document_id)
    references public.budget_documents (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_type_fkey foreign key (workspace_id, document_type_id)
    references public.budget_document_types (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_order_form_fkey foreign key (workspace_id, order_form_version_id)
    references public.budget_order_form_versions (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_version_fkey foreign key (workspace_id, version_id)
    references public.budget_document_versions (workspace_id, id) on delete restrict,
  constraint budget_document_uploads_owner_check check (
    (purpose = 'supplier') = (supplier_id is not null) and (purpose <> 'supplier') = (expense_id is not null)),
  constraint budget_document_uploads_state_consistency_check check (
    (state = 'completed') = (version_id is not null) and (state = 'rejected') = (reject_reason is not null)
    and (state = 'pending') = (completed_at is null))
);
create index budget_document_uploads_pending_idx
  on public.budget_document_uploads (workspace_id, created_by_id) where state = 'pending';

-- ===========================================================================
-- Per-expense manual requirement ("photo required for THIS expense").
-- Only counts while the workspace has an active 'manual' rule for the type.
-- ===========================================================================
create table public.budget_expense_document_flags (
  workspace_id      uuid not null,
  expense_id        uuid not null,
  document_type_id  uuid not null,
  created_by_name   text not null,
  created_at        timestamptz not null default now(),
  primary key (workspace_id, expense_id, document_type_id),
  constraint budget_expense_document_flags_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict,
  constraint budget_expense_document_flags_type_fkey foreign key (workspace_id, document_type_id)
    references public.budget_document_types (workspace_id, id) on delete restrict
);

-- ===========================================================================
-- Requirement snapshot taken when an expense closes (append-only). A closed
-- expense shows THIS, so later rule / threshold changes never rewrite its
-- historical compliance state. A reopen evaluates live again; a re-close
-- takes a new snapshot.
-- ===========================================================================
create table public.budget_expense_requirement_snapshots (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  expense_id       uuid not null,
  snapshot         jsonb not null,
  created_by_type  text not null check (created_by_type in ('worker', 'owner')),
  created_by_id    uuid not null,
  created_by_name  text not null,
  created_at       timestamptz not null default now(),
  constraint budget_expense_requirement_snapshots_expense_fkey foreign key (workspace_id, expense_id)
    references public.budget_expenses (workspace_id, id) on delete restrict
);
create index budget_expense_requirement_snapshots_expense_idx
  on public.budget_expense_requirement_snapshots (workspace_id, expense_id, created_at desc);

-- ===========================================================================
-- Immutability triggers.
-- ===========================================================================
create trigger budget_document_versions_append_only before update or delete on public.budget_document_versions
  for each row execute function public.budget_refuse_mutation();
create trigger budget_document_versions_no_truncate before truncate on public.budget_document_versions
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_expense_requirement_snapshots_append_only before update or delete on public.budget_expense_requirement_snapshots
  for each row execute function public.budget_refuse_mutation();
create trigger budget_expense_requirement_snapshots_no_truncate before truncate on public.budget_expense_requirement_snapshots
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_order_form_versions_guard before update or delete on public.budget_order_form_versions
  for each row execute function public.budget_order_form_versions_guard();
create trigger budget_order_form_versions_no_truncate before truncate on public.budget_order_form_versions
  for each statement execute function public.budget_refuse_mutation();
create trigger budget_documents_no_delete before delete on public.budget_documents
  for each row execute function public.budget_refuse_mutation();
create trigger budget_documents_no_truncate before truncate on public.budget_documents
  for each statement execute function public.budget_refuse_mutation();

-- row_version / updated_at bookkeeping (the Stage 3 function).
create trigger budget_documents_touch before update on public.budget_documents
  for each row execute function public.budget_touch_row();
create trigger budget_document_uploads_touch before update on public.budget_document_uploads
  for each row execute function public.budget_touch_row();
create trigger budget_order_form_versions_touch before update on public.budget_order_form_versions
  for each row execute function public.budget_touch_row();

-- ===========================================================================
-- Access lock-down + the Stage 3 audit trigger on every new table.
-- ===========================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'budget_documents', 'budget_document_versions', 'budget_order_form_versions',
    'budget_document_uploads', 'budget_expense_document_flags', 'budget_expense_requirement_snapshots']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('revoke all on table public.%I from service_role', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.budget_audit_row()',
      t || '_audit', t);
  end loop;
end $$;

-- ===========================================================================
-- The private Storage bucket. Guarded: an isolated test stack started without
-- Storage has no storage schema (every non-document suite runs that way); a
-- hosted project always has it.
-- ===========================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent - bucket budget-documents not created';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('budget-documents', 'budget-documents', false, 10485760,
          array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  -- Defence in depth: whatever permissive storage policy may exist, anon and
  -- authenticated can never read, list, write or delete in this bucket. Only
  -- the service role (the Budget endpoint) and short-lived signed links reach it.
  execute 'drop policy if exists budget_documents_bucket_deny on storage.objects';
  execute $p$create policy budget_documents_bucket_deny on storage.objects
    as restrictive for all to anon, authenticated
    using (bucket_id <> 'budget-documents')
    with check (bucket_id <> 'budget-documents')$p$;
end $$;

commit;
