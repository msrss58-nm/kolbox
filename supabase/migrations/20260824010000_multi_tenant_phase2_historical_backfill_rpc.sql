-- Multi-Tenant Phase 2 (Backfill step, ONE-TIME historical exception only):
-- a single atomic RPC, election_day_backfill_historical_workspace, that
-- creates the one historical Election Workspace, links the first Election
-- Owner, and backfills workspace_id onto every existing legacy row across
-- all 12 Phase-1 tables (including the settings singleton).
--
-- This RPC implements the approved one-time historical exception ONLY - the
-- normal future Owner-onboarding flow (Pending Access -> Owner first login
-- -> Owner confirms workspace name/end -> atomic workspace creation, see
-- election_workspace_pending_owner_access's own comment in the Phase 0
-- migration) is untouched by this migration and remains the path for every
-- future customer workspace. This function is not a general-purpose
-- "create workspace" primitive - it is guarded to run at most once, ever
-- (see the idempotency guard below), and is not reachable by anon/
-- authenticated at all (see grants below) - only trusted Vercel server-side
-- code, calling with the service_role key after already creating the Owner
-- in Supabase Auth via the Admin API, may invoke it. This function never
-- touches auth.* itself - p_auth_user_id must already exist, created
-- out-of-band by that trusted server code; deleting/compensating that Auth
-- user on failure is also the caller's responsibility, not this function's.
--
-- Design notes:
--
-- 1. Idempotency / duplicate-prevention: this RPC exists to create exactly
--    ONE historical workspace, ever. If one already exists (a prior
--    successful run, including one whose HTTP response never reached the
--    caller) or the supplied auth_user_id is already linked to an Owner,
--    the function raises rather than creating a second workspace/Owner -
--    the caller treats this exactly like any other DB-transaction failure
--    and compensates by deleting the just-created (now-redundant) Auth
--    user. A fixed-key advisory lock (matching this project's own
--    established pg_advisory_xact_lock idiom for allocation-mutation RPCs)
--    serializes concurrent/retried invocations so the existence check and
--    the insert are atomic with respect to each other.
--
-- 2. Settings: election_day_settings stays the existing global-singleton
--    table (`id boolean primary key default true`) - restructuring that PK
--    into a true per-workspace key is explicitly out of this phase's scope,
--    since it would change SupabaseElectionDayApi.getElectionDayDeadline/
--    setElectionDayDeadline's `.eq("id", true)` contract, a frontend/RPC
--    behavior change Phase 2 must not make (verified against the live
--    source before writing this migration). "Conversion to the
--    workspace-scoped model" for this one historical workspace means: the
--    one existing settings row is claimed by (gets workspace_id set to)
--    the historical workspace, exactly like every other legacy row below -
--    no data loss, no structural/PK change, no frontend/RPC behavior
--    change. A real per-workspace settings table (supporting more than one
--    workspace each with its own row) is a separate, later, dedicated
--    migration once a second workspace is actually approved.
--
-- 3. Grants: unlike every other Election Day RPC in this project (all
--    granted to anon/authenticated, since the app calls them directly from
--    the browser), this function is REVOKEd from PUBLIC and GRANTed only
--    to service_role. It creates a platform-level workspace and links an
--    Owner - there is no legitimate reason for an anon/authenticated caller
--    to ever invoke it, and doing so would be a severe new attack surface
--    (arbitrary workspace/Owner creation by anyone holding the anon key).
--    This is the first service_role-only RPC in the project - a narrowly
--    necessary, explicitly justified new pattern, not a broad RPC/RLS
--    cutover.
--
-- 4. workspace_id stays nullable at schema level on every one of the 12
--    tables - this migration performs no NOT NULL conversion (that is a
--    separate, later Phase 3, not started here).
--
-- 5. SECURITY DEFINER, not INVOKER: verified directly against a live
--    disposable database before finalizing this migration that
--    service_role holds only REFERENCES/TRIGGER/TRUNCATE on
--    election_workspaces (and, by the same Phase 0/1 pattern, every other
--    table this function touches) - NOT SELECT/INSERT/UPDATE. Only the
--    table owner (postgres, who applies migrations) has those privileges.
--    An initial SECURITY INVOKER draft of this function was tested and
--    failed with 42501 permission denied the moment it tried to touch
--    election_day_settings, confirming service_role bypassing RLS does
--    NOT imply it holds base table grants. SECURITY DEFINER (matching this
--    project's own established pattern for RPCs that must write to
--    zero-grant tables, e.g. election_day_import_voters_v2) makes the
--    function body run with its owner's privileges regardless of the
--    caller's own grants - required here since even the sole approved
--    caller (service_role) does not otherwise have direct table access.
--
-- 6. `set search_path = ''` (not `= public`): current Supabase/Postgres
--    guidance for SECURITY DEFINER functions - an empty search_path means
--    NOTHING is resolved implicitly except pg_catalog, which Postgres
--    always searches first regardless of the configured search_path (this
--    is documented core Postgres behavior, not a Supabase-specific rule),
--    so built-in types/functions/operators still work with zero
--    qualification needed for those. Every table this function touches was
--    already schema-qualified (public.xxx) before this change and remains
--    so - an empty search_path makes that the ONLY way any of them could
--    resolve, closing off even the theoretical possibility of a caller's
--    session state redirecting an unqualified reference to a same-named
--    object in another schema. Built-in function calls (hashtext,
--    jsonb_build_object, length) are now explicitly pg_catalog-qualified
--    too, purely for auditability - not because they were actually
--    exploitable (pg_catalog is always implicit-first either way) but
--    because doing so leaves nothing in this function body relying on
--    implicit resolution of any kind. `trim(...)` is the one deliberate
--    exception, verified live: it is SQL-standard TRIM(...) parser syntax,
--    not an ordinary function call - there is no real pg_catalog.trim/1
--    function (only btrim/1,2), so `pg_catalog.trim(...)` fails with
--    "function does not exist" (caught by testing this migration against a
--    disposable database, not assumed). Plain `trim(...)` is left
--    unqualified because it is inherently immune to search_path
--    manipulation in the first place - the parser rewrites it to `btrim`
--    before any name resolution happens, so there is nothing to hijack.
--    Built-in operators (=, <>, ||) and PL/pgSQL language keywords are
--    likewise left as-is - qualifying an operator requires the unusual
--    OPERATOR(pg_catalog.=) syntax and buys no real safety margin here, so
--    doing so would be noise, not hardening.
create or replace function public.election_day_backfill_historical_workspace(
  p_auth_user_id     uuid,
  p_workspace_name   text,
  p_election_end_at  timestamptz,
  p_owner_name       text,
  p_owner_phone      text,
  p_owner_email      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_owner_id     uuid;
  v_counts       jsonb := '{}'::jsonb;
  v_n            bigint;
begin
  if p_auth_user_id is null then
    raise exception 'MISSING_AUTH_USER_ID';
  end if;
  if p_workspace_name is null or pg_catalog.length(trim(p_workspace_name)) = 0 then
    raise exception 'MISSING_WORKSPACE_NAME';
  end if;
  if p_election_end_at is null then
    raise exception 'MISSING_ELECTION_END_AT';
  end if;
  if p_owner_name is null or pg_catalog.length(trim(p_owner_name)) = 0 then
    raise exception 'MISSING_OWNER_NAME';
  end if;
  if p_owner_email is null or pg_catalog.length(trim(p_owner_email)) = 0 then
    raise exception 'MISSING_OWNER_EMAIL';
  end if;

  -- Serialize concurrent/retried invocations of this one-time operation -
  -- same fixed-key pg_advisory_xact_lock idiom already used by every other
  -- allocation-mutation RPC in this project (see e.g.
  -- election_day_import_voters_v2).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('election_day_historical_backfill')::bigint);

  if exists (select 1 from public.election_workspaces) then
    raise exception 'HISTORICAL_WORKSPACE_ALREADY_EXISTS';
  end if;

  if exists (select 1 from public.election_owners where auth_user_id = p_auth_user_id) then
    raise exception 'OWNER_AUTH_USER_ALREADY_LINKED';
  end if;

  insert into public.election_workspaces (name, election_end_at)
  values (p_workspace_name, p_election_end_at)
  returning id into v_workspace_id;

  insert into public.election_owners (workspace_id, auth_user_id, name, phone, email)
  values (v_workspace_id, p_auth_user_id, p_owner_name, p_owner_phone, p_owner_email)
  returning id into v_owner_id;

  update public.election_day_settings
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_settings', v_n);

  update public.election_day_voters
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_voters', v_n);

  update public.election_day_ride_status_events
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_ride_status_events', v_n);

  update public.election_day_ride_coordinators
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_ride_coordinators', v_n);

  update public.election_day_permission_users
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_permission_users', v_n);

  update public.election_day_coordinators
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_coordinators', v_n);

  update public.election_day_coordinator_operations
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_coordinator_operations', v_n);

  update public.election_day_coordinator_operation_items
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_coordinator_operation_items', v_n);

  update public.election_day_roles
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_roles', v_n);

  update public.election_day_not_voting_reasons
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_not_voting_reasons', v_n);

  update public.election_day_reminder_events
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_reminder_events', v_n);

  update public.election_day_reauth_proofs
    set workspace_id = v_workspace_id
    where workspace_id is null;
  get diagnostics v_n = row_count;
  v_counts := v_counts || pg_catalog.jsonb_build_object('election_day_reauth_proofs', v_n);

  return pg_catalog.jsonb_build_object(
    'workspace_id', v_workspace_id,
    'owner_id', v_owner_id,
    'row_counts', v_counts
  );
end;
$$;

revoke all on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) from public;
grant execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) to service_role;

comment on function public.election_day_backfill_historical_workspace is
  'Multi-Tenant Phase 2: one-time historical Backfill RPC. Creates exactly one election_workspaces row, links the first election_owners row to an Auth identity already created by trusted server-side code, and backfills workspace_id onto every pre-existing legacy row across all 12 Phase-1 tables (settings included, PK structure unchanged). Idempotency-guarded via an existence check under a fixed advisory lock - raises HISTORICAL_WORKSPACE_ALREADY_EXISTS / OWNER_AUTH_USER_ALREADY_LINKED rather than ever creating a second workspace/Owner. REVOKEd from PUBLIC, granted only to service_role - not reachable by anon/authenticated, unlike every other Election Day RPC in this project. SECURITY DEFINER (verified live that service_role itself holds no direct table grants on these tables - only REFERENCES/TRIGGER/TRUNCATE - so the function must run as its owner, postgres). set search_path = '' with every table reference schema-qualified (public.xxx) and every ordinary built-in function call pg_catalog-qualified, except plain trim(...) - SQL-standard TRIM syntax, not a real pg_catalog.trim function, verified inherently immune to search_path resolution - current Supabase/Postgres SECURITY DEFINER hardening guidance, verified live that anon/authenticated calls are denied over real HTTP. Never touches auth.* directly. workspace_id remains nullable on every table (no Phase 3 tightening here).';

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this migration
-- needs to be reversed; Supabase CLI migrations have no automatic "down".
-- Note: this only drops the function - it does NOT undo any workspace/Owner/
-- backfill data this function may have already written; that requires a
-- separate, explicit data-cleanup step, not part of this rollback):
--
--   drop function if exists public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text);
-- ============================================================================
