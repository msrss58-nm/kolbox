-- Platform Stage 8D - security remediation for the three HIGH findings from the
-- Stage 8C adversarial acceptance lab. Scope is EXACTLY these three, nothing else.
--
--   H-1  Legacy non-voting-reason DEFINER RPCs are anon/authenticated-executable
--        and act across ALL workspaces. The Phase 4B Contract (20260901000000)
--        revoked 10 sibling functions but missed these 4. The live app routes
--        reason ops through the trusted workspace-scoped _v3/_core path
--        (src/services/api/index.ts:146-157); these 4 survive only in dead code
--        (src/services/api/supabaseElectionDayApi.ts). Revoke = zero behaviour
--        change to the live application.
--
--   H-2  The vestigial pre-multi-tenant singleton public.election_day_settings
--        carries permissive RLS (election_day_settings_all, ALL, anon+authenticated)
--        AND a DEFINER "AFTER UPDATE OF deadline" sync trigger, so anon can write
--        any workspace's deadline into election_day_workspace_settings. The reverse
--        mirror (election_day_sync_workspace_to_settings, DEFINER, search_path='')
--        keeps the singleton current for rollback safety by running in the trusted
--        write's definer chain as postgres - RLS/grant-exempt - so revoking anon/
--        authenticated table privileges and dropping the permissive policy closes
--        the bridge WITHOUT breaking the mirror and WITHOUT dropping the singleton
--        or any trigger. The live deadline path is trusted-only (index.ts:92-95);
--        the only .from("election_day_settings") refs are dead code.
--
--   H-3  A re-issued Election Owner recovery link survives provisioning and can
--        later take over the live Owner account + reset its password.
--        election_day_provision_workspace consumes the approval but never
--        invalidates the account's outstanding recovery token, and
--        handleReissueOwnerAccess mints then never re-checks the approval state.
--        Empirically verified on the pinned GoTrue: recovery links live in
--        auth.one_time_tokens (token_type='recovery_token', one per (user_id,type))
--        AND auth.users.recovery_token; postgres has DELETE/UPDATE on both, and
--        after deleting them the outstanding link no longer verifies (otp_expired).
--        Fix: invalidate the recovery token in the SAME transaction that consumes
--        the approval (covers a link minted before provisioning commits), plus a
--        post-mint finalize the handler calls to invalidate a link minted AFTER
--        provisioning committed (the reissue-after-consume race) and return 409.
--
-- MANUAL ROLLBACK (revert the application first where relevant):
--   -- H-1
--   grant execute on function public.election_day_list_non_voting_reasons() to anon, authenticated;
--   grant execute on function public.election_day_set_non_voting_reason_active(uuid, boolean) to anon, authenticated;
--   grant execute on function public.election_day_delete_non_voting_reason(uuid) to anon, authenticated;
--   grant execute on function public.election_day_reorder_non_voting_reasons(uuid[]) to anon, authenticated;
--   -- H-2
--   grant all on table public.election_day_settings to anon, authenticated;
--   create policy election_day_settings_all on public.election_day_settings for all to anon, authenticated using (true) with check (true);
--   -- H-3
--   drop function if exists public.platform_reissue_finalize(uuid, uuid);
--   drop function if exists public.election_day_invalidate_owner_recovery(uuid);
--   -- and CREATE OR REPLACE election_day_provision_workspace with its 20260910000000 body (without the perform call).

-- ===========================================================================
-- H-1  Revoke anon/authenticated EXECUTE on the 4 missed legacy reason RPCs.
-- ===========================================================================
revoke execute on function public.election_day_list_non_voting_reasons() from anon, authenticated;
revoke execute on function public.election_day_set_non_voting_reason_active(uuid, boolean) from anon, authenticated;
revoke execute on function public.election_day_delete_non_voting_reason(uuid) from anon, authenticated;
revoke execute on function public.election_day_reorder_non_voting_reasons(uuid[]) from anon, authenticated;

-- ===========================================================================
-- H-2  Close the anon deadline bridge: revoke table privileges + drop the
--      permissive policy on the legacy singleton. RLS stays enabled (deny-all
--      for anon/authenticated via PostgREST). The DEFINER reverse-sync trigger
--      still mirrors trusted writes into the singleton as postgres.
-- ===========================================================================
revoke all on table public.election_day_settings from anon, authenticated;
drop policy if exists election_day_settings_all on public.election_day_settings;

-- ===========================================================================
-- H-3  Recovery-token invalidation.
-- ===========================================================================

-- Shared invalidator: deletes the account's outstanding recovery one-time token
-- and clears the legacy users.recovery_token, so any outstanding recovery link
-- for that account stops verifying. Owned by postgres (has the auth-schema
-- privileges), DEFINER, empty search_path. Idempotent and safe to call when
-- there is nothing to invalidate (a legitimately redeemed link left no row).
create or replace function public.election_day_invalidate_owner_recovery(
  p_auth_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_auth_user_id is null then
    return;
  end if;
  delete from auth.one_time_tokens
  where user_id = p_auth_user_id
    and token_type = 'recovery_token';
  update auth.users
  set recovery_token = '',
      recovery_sent_at = null
  where id = p_auth_user_id;
end;
$fn$;

comment on function public.election_day_invalidate_owner_recovery(uuid) is
  'Stage 8D (H-3): invalidates an Election Owner account''s outstanding recovery link by deleting its auth.one_time_tokens recovery row and clearing auth.users.recovery_token. Idempotent; no-op when nothing is outstanding. Called in-transaction by election_day_provision_workspace at approval consumption, and by platform_reissue_finalize when a reissue raced a provisioning. service_role-only (+ internal DEFINER callers).';

revoke all on function public.election_day_invalidate_owner_recovery(uuid) from public;
revoke all on function public.election_day_invalidate_owner_recovery(uuid) from anon;
revoke all on function public.election_day_invalidate_owner_recovery(uuid) from authenticated;
grant execute on function public.election_day_invalidate_owner_recovery(uuid) to service_role;

-- Provisioning: identical to the 20260910000000 body EXCEPT the single added
-- `perform election_day_invalidate_owner_recovery(...)` immediately after the
-- pending row is marked consumed, in the same transaction. Signature, grants,
-- concurrency model and return shape are unchanged.
create or replace function public.election_day_provision_workspace(
  p_auth_user_id uuid,
  p_workspace_name text,
  p_election_end_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
volatile
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_pending_id uuid;
  v_pending_name text;
  v_pending_email text;
  v_pending_phone text;
  v_pending_status text;
  v_pending_expires timestamptz;
  v_login_code text;
  v_name text;
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_workspace_name is null or btrim(p_workspace_name) = '' then
    raise exception 'MISSING_WORKSPACE_NAME';
  end if;
  if p_election_end_at is null then
    raise exception 'MISSING_ELECTION_END_AT';
  end if;

  v_name := btrim(p_workspace_name);
  if pg_catalog.length(v_name) > 120 then
    raise exception 'WORKSPACE_NAME_TOO_LONG';
  end if;

  -- Per-Owner lock. Two concurrent first-logins by the same Owner serialize
  -- here, and the existing-owner check below then runs INSIDE the lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('election_day_provision_workspace_' || p_auth_user_id::text)::bigint
  );

  -- Idempotent success: an Owner who retries after a completed provisioning
  -- (a lost response, a double submit) gets their existing context back rather
  -- than a second workspace or a confusing error.
  select o.id, o.workspace_id into v_owner_id, v_workspace_id
  from public.election_owners o
  where o.auth_user_id = p_auth_user_id;

  if v_owner_id is not null then
    return (
      select pg_catalog.jsonb_build_object(
        'workspace_id', w.id,
        'owner_id', v_owner_id,
        'workspace_name', w.name,
        'election_end_at', w.election_end_at,
        'login_code', w.login_code,
        'already_provisioned', true
      )
      from public.election_workspaces w
      where w.id = v_workspace_id
    );
  end if;

  select pa.id, pa.name, pa.email, pa.phone, pa.status, pa.expires_at
    into v_pending_id, v_pending_name, v_pending_email, v_pending_phone,
         v_pending_status, v_pending_expires
  from public.election_workspace_pending_owner_access pa
  where pa.auth_user_id = p_auth_user_id
  for update;

  if v_pending_id is null then
    raise exception 'PENDING_ACCESS_NOT_FOUND';
  end if;

  if v_pending_status = 'consumed' then
    raise exception 'PENDING_ACCESS_ALREADY_CONSUMED';
  end if;

  -- As in platform_create_pending_owner_access: no status='expired' write is
  -- attempted before raising, because the raise would roll it back. expires_at
  -- is authoritative; election_day_resolve_owner_provisioning_state already
  -- reports 'expired' from it regardless of what status says.
  if v_pending_expires <= pg_catalog.now() then
    raise exception 'PENDING_ACCESS_EXPIRED';
  end if;

  -- Bounded and fail-closed: the generator raises rather than returning a
  -- colliding or malformed code after 20 attempts.
  v_login_code := public.election_day_generate_workspace_login_code();

  insert into public.election_workspaces (name, election_end_at, login_code)
  values (v_name, p_election_end_at, v_login_code)
  returning public.election_workspaces.id into v_workspace_id;

  insert into public.election_owners (workspace_id, auth_user_id, name, phone, email)
  values (
    v_workspace_id,
    p_auth_user_id,
    v_pending_name,
    v_pending_phone,
    v_pending_email
  )
  returning public.election_owners.id into v_owner_id;

  perform public.election_day_seed_new_workspace(v_workspace_id);

  update public.election_workspace_pending_owner_access
  set status = 'consumed',
      consumed_at = pg_catalog.now()
  where id = v_pending_id;

  -- Stage 8D (H-3): the approval is now consumed; invalidate any outstanding
  -- recovery link for this account IN THE SAME TRANSACTION, so a re-issued (or
  -- original, un-redeemed) recovery link minted before this commit can never
  -- later establish an Owner session or change the Owner password. The
  -- reissue-AFTER-consume race is closed by platform_reissue_finalize.
  perform public.election_day_invalidate_owner_recovery(p_auth_user_id);

  return pg_catalog.jsonb_build_object(
    'workspace_id', v_workspace_id,
    'owner_id', v_owner_id,
    'workspace_name', v_name,
    'election_end_at', p_election_end_at,
    'login_code', v_login_code,
    'already_provisioned', false
  );
end;
$fn$;

comment on function public.election_day_provision_workspace(uuid, text, timestamptz) is
  'Stage 3B (+ Stage 8D H-3): atomically provisions one workspace for an approved, authenticated Election Owner - workspace row, unique login_code, election_owners row, built-in role and non-voting-reason seeds, consumption of the pending-access row, AND invalidation of the account''s outstanding recovery token - in a single transaction. All-or-nothing. Concurrency-safe via a per-Owner pg_advisory_xact_lock + SELECT ... FOR UPDATE on the pending row. Idempotent: a retry after success returns the existing context. service_role-only.';

revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from public;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from anon;
revoke all on function public.election_day_provision_workspace(uuid, text, timestamptz) from authenticated;
grant execute on function public.election_day_provision_workspace(uuid, text, timestamptz) to service_role;

-- Post-mint reissue finalize: called by handleReissueOwnerAccess AFTER it mints
-- the link. Re-resolves the singleton platform_owners row (fail closed), reads
-- the approval, and - if it is now consumed (a provisioning committed during the
-- mint) - invalidates the just-minted recovery token and reports consumed=true so
-- the handler returns 409 instead of a usable post-consumption link. When still
-- unconsumed it reports consumed=false and the handler returns the link normally.
create or replace function public.platform_reissue_finalize(
  p_platform_owner_auth_user_id uuid,
  p_pending_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_auth uuid;
  v_consumed timestamptz;
begin
  if p_platform_owner_auth_user_id is null or not exists (
    select 1 from public.platform_owners po
    where po.auth_user_id = p_platform_owner_auth_user_id
  ) then
    raise exception 'UNAUTHORIZED';
  end if;

  if p_pending_id is null then
    raise exception 'INVALID_PENDING_ID';
  end if;

  select pa.auth_user_id, pa.consumed_at
    into v_auth, v_consumed
  from public.election_workspace_pending_owner_access pa
  where pa.id = p_pending_id;

  if v_auth is null then
    raise exception 'PENDING_ACCESS_NOT_FOUND';
  end if;

  if v_consumed is not null then
    perform public.election_day_invalidate_owner_recovery(v_auth);
    return pg_catalog.jsonb_build_object('consumed', true);
  end if;

  return pg_catalog.jsonb_build_object('consumed', false);
end;
$fn$;

comment on function public.platform_reissue_finalize(uuid, uuid) is
  'Stage 8D (H-3): called by the reissue handler AFTER minting the link. Platform-Owner-only. If the approval was consumed by a racing provisioning during the mint, invalidates the just-minted recovery token and returns {consumed:true} so the handler answers 409 rather than hand back a usable post-consumption link; otherwise {consumed:false}. service_role-only.';

revoke all on function public.platform_reissue_finalize(uuid, uuid) from public;
revoke all on function public.platform_reissue_finalize(uuid, uuid) from anon;
revoke all on function public.platform_reissue_finalize(uuid, uuid) from authenticated;
grant execute on function public.platform_reissue_finalize(uuid, uuid) to service_role;
