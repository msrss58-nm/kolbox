-- Multi-Tenant Phase 3A - Session/Auth foundation RPCs. Companion to
-- 20260826000000_multi_tenant_phase3a_expand_sessions_foundation.sql (the
-- schema-only EXPAND migration, already applied to Production). WRITTEN
-- ONLY as of this migration's authoring - a separate, explicit approval is
-- required before `supabase db push` (local, then only later `--linked`)
-- runs it.
--
-- Implements the durable server-side Session + action-bound Reauth v3
-- architecture approved for the trusted-workspace-context design:
--   Browser -> __Host-kb_ed_session HttpOnly cookie -> Vercel Server
--   Function -> hash credential in Node -> service_role-only transactional
--   RPC -> DB derives actor + workspace + role -> DB verifies permission/
--   reauth -> mutation.
--
-- The browser must never be authoritative for workspace_id/actor_id/
-- role_id - every function below derives all three SERVER-SIDE, either
-- from a verified session row or from a verified name+password pair. No
-- function in this migration accepts a client-supplied actor_id or
-- workspace_id as a trusted input.
--
-- ACL, uniform across every function in this migration (per CLAUDE.md's
-- Permanent Engineering Guardrail - a bare `revoke ... from public` alone
-- does not undo this Production project's own confirmed per-role default
-- EXECUTE grant on new functions, see 20260824020000's incident record):
-- every function explicitly REVOKEs EXECUTE from PUBLIC, anon, and
-- authenticated by name. Functions meant to be called directly by the
-- future Vercel Server Function (which holds the service_role key, never
-- exposed to the browser) additionally GRANT EXECUTE to service_role only
-- - the browser's own anon key can never call any of them, unlike every
-- legacy v1/v2 roster RPC (election_day_login, _v2 admin RPCs, etc., all
-- still anon/authenticated-reachable, unchanged, untouched by this
-- migration). One function (election_day_verify_reauth_proof_v3) is an
-- internal-only helper (no grant to any role at all, including
-- service_role) - callable only from inside another SECURITY DEFINER
-- function's body in this same migration, which executes nested calls as
-- the shared owner role, matching this project's existing election_day_
-- verify_reauth_proof precedent exactly. election_day_register_login_
-- attempt was originally designed the same internal-only way but is now
-- service_role-granted directly - see its own comment below for why (a
-- same-transaction rate-limit increment cannot survive the exception it
-- exists to catch, found by local runtime testing).
--
-- No existing table, RLS policy, or v1/v2/legacy function is touched by
-- this migration. election_day_login, election_day_reauth,
-- election_day_verify_reauth_proof, election_day_revoke_reauth_proof, and
-- every _v2 admin RPC remain fully functional, unchanged, at their
-- existing signatures - this is a strictly additive, parallel path.
--
-- Explicitly OUT of scope for this migration (later, separate, not yet
-- authorized work): any business-mutation RPC cutover
-- (import_voters_v3/set_voted_v3/reminder-and-call RPC families/settings
-- cutover), RLS retirement, v1/v2 RPC retirement, Phase 3b NOT NULL/
-- composite-FK enforcement, the actual Vercel /api/election-day/session
-- endpoint (implemented in application code, not SQL, in this same local
-- turn but tracked separately), and any frontend login cutover (the
-- existing frontend continues to call election_day_login/election_day_
-- reauth exactly as before - nothing here is wired to the UI yet).
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner
-- pipelines a file's statements via wire-protocol batching, not an
-- implicit transaction.
begin;

-- ============================================================================
-- 1. election_day_resolve_session - internal/session-resolution helper,
-- service_role-only (per the task's explicit instruction: "No PUBLIC/anon/
-- authenticated EXECUTE"). Takes only a session-hash (bytea - the caller,
-- a Vercel Server Function, computes sha256(raw token) in Node BEFORE this
-- function is ever called; the raw token itself never reaches Postgres,
-- mirroring election_day_sessions.token_hash's own design intent). Resolves
-- the session row, requires expires_at > now(), and joins LIVE to
-- election_day_permission_users on the exact composite pair the schema's
-- own FK already enforces (workspace_id, permission_user_id) - this join
-- condition is redundant with that FK by construction (ON UPDATE RESTRICT
-- makes it structurally impossible for a live session to ever point at a
-- mismatched pair), kept anyway as defense-in-depth, the same reasoning
-- election_day_verify_reauth_proof already uses for its own redundant
-- actor-existence re-check. Fails closed: raises the single generic
-- UNAUTHORIZED for every failure mode (missing hash, no matching row,
-- expired row) - never a distinguishing message, so a caller cannot probe
-- "does this hash exist but is expired" vs "does this hash not exist at
-- all". Role/workspace are read live from election_day_permission_users on
-- every call, never cached in the session row itself beyond the FK-bound
-- workspace_id, so a role change (or a NULL-workspace edge case that
-- cannot actually occur given the FK, but is defended against anyway)
-- takes effect immediately.
-- ============================================================================
create or replace function public.election_day_resolve_session(
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select u.id, u.name, u.role_id, s.workspace_id
    from public.election_day_sessions s
    join public.election_day_permission_users u
      on u.id = s.permission_user_id
     and u.workspace_id = s.workspace_id
    where s.token_hash = p_session_hash
      and s.expires_at > now();

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$$;

comment on function public.election_day_resolve_session(bytea) is
  'Phase 3A: resolves a trusted {actor_id, actor_name, role_id, workspace_id} from a session token hash alone. Requires expires_at > now(). The join on (workspace_id, permission_user_id) is redundant with election_day_sessions'' own composite FK (ON UPDATE RESTRICT makes a mismatched live session structurally impossible) - kept as defense-in-depth, matching election_day_verify_reauth_proof''s own precedent. Generic UNAUTHORIZED on every failure mode - never distinguishes "not found" from "expired". service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever - only a trusted Vercel Server Function holding the service_role key may call this.';

revoke all on function public.election_day_resolve_session(bytea) from public;
revoke all on function public.election_day_resolve_session(bytea) from anon;
revoke all on function public.election_day_resolve_session(bytea) from authenticated;
grant execute on function public.election_day_resolve_session(bytea) to service_role;

-- ============================================================================
-- 2. election_day_register_login_attempt - service_role-only rate-limit
-- registration RPC.
--
-- CORRECTED DESIGN (found by local runtime testing, not the original
-- design): this was originally written as an internal-only helper called
-- FROM INSIDE election_day_login_v2's own body, registering the attempt
-- before verifying credentials. That does not work - when login_v2 later
-- raises UNAUTHORIZED for a wrong password (or any other failure), Postgres
-- rolls back EVERY write made earlier in that same function invocation,
-- including the attempt-count increment that just happened - so a failed
-- login (exactly the case rate limiting exists to catch) never actually
-- persisted its own count. A local test of 14 consecutive wrong-password
-- attempts against the original design never triggered RATE_LIMITED even
-- once, which is how this was caught before it ever reached Production.
--
-- The fix: this is now its own standalone, directly-callable, service_
-- role-granted RPC - a separate top-level call/transaction from
-- election_day_login_v2, meant to be invoked by the Vercel Server Function
-- BEFORE it calls election_day_login_v2 at all. Because it is a genuinely
-- separate statement, its increment commits immediately and independently
-- of whether the subsequent login attempt (a separate RPC call) later
-- succeeds or fails - this is what makes the count durable across a failed
-- login, which is the whole point.
--
-- Fixed 15-minute window, bucketed deterministically from wall-clock time
-- (floor to the nearest 900-second boundary) so that concurrent calls
-- within the same window land on the same (bucket_key, window_start) row.
-- The INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING statement is a
-- single atomic operation - Postgres row-level locking during the upsert
-- makes this safe under real concurrent callers with no separate advisory
-- lock needed (unlike the coordinator-allocation mutation lock elsewhere in
-- this schema, which guards a multi-statement read-then-write sequence;
-- this is a single statement).
--
-- Self-resetting, no permanent lockout: once wall-clock time crosses into a
-- new 900-second window, a fresh row is created starting at attempt_count =
-- 1 - there is no persistent "banned" state of any kind, by design.
--
-- Opportunistic cleanup (no pg_cron dependency, same pattern as election_
-- day_reauth's own expired-proof cleanup): deletes rows more than 1 hour
-- old (several windows back) on every call - cheap, bounded, always
-- available.
-- ============================================================================
create or replace function public.election_day_register_login_attempt(
  p_bucket_key text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  delete from public.election_day_login_attempts
  where window_start < now() - interval '1 hour';

  v_window_start := to_timestamp(floor(extract(epoch from now()) / 900) * 900);

  insert into public.election_day_login_attempts (bucket_key, window_start, attempt_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
    do update set attempt_count = public.election_day_login_attempts.attempt_count + 1
  returning attempt_count into v_count;

  return v_count;
end;
$$;

comment on function public.election_day_register_login_attempt(text) is
  'Phase 3A: service_role-only rate-limit registration - atomically increments (or creates) the attempt counter for a fixed 900-second (15-minute) window bucketed deterministically from wall-clock time, and returns the resulting count. Self-resetting (a new window is a new row starting at 1 - no permanent lockout). Opportunistically deletes rows older than 1 hour on every call - no pg_cron dependency. MUST be called by the Vercel Server Function as its own separate, standalone RPC call BEFORE calling election_day_login_v2 - it was originally nested inside login_v2''s own body, which local testing proved does not durably persist the count across a failed (wrong-password) login, since Postgres rolls back a function''s earlier writes along with its own later raised exception. As a standalone top-level call it commits independently of whatever login_v2 does next.';

revoke all on function public.election_day_register_login_attempt(text) from public;
revoke all on function public.election_day_register_login_attempt(text) from anon;
revoke all on function public.election_day_register_login_attempt(text) from authenticated;
grant execute on function public.election_day_register_login_attempt(text) to service_role;

-- ============================================================================
-- 3. election_day_login_v2 - service_role-only. Authenticates a
-- PermissionUser by name+password (identical bcrypt-compare pattern to the
-- legacy election_day_login), requires a non-null workspace_id on the
-- resolved user (a hard requirement - see this migration's header and the
-- Phase 3A EXPAND migration's own "legacy-create-user NULL-workspace risk"
-- note), and creates the session row inside the SAME transaction as
-- successful authentication - there is no window where a caller could
-- observe "authenticated but no session yet" or vice versa.
--
-- p_session_hash is bytea, computed by the caller (Vercel, in Node) BEFORE
-- this function is ever invoked - this function never sees or generates a
-- raw session token, only receives its hash to store.
--
-- Rate limiting is NOT performed inside this function - see election_day_
-- register_login_attempt's own header comment for why (a same-transaction
-- increment cannot survive this function's own later UNAUTHORIZED on a
-- failed attempt, which local testing proved). The Vercel Server Function
-- MUST call election_day_register_login_attempt (for a name bucket and,
-- if available, an IP bucket) as its own separate call BEFORE calling this
-- function at all, and must short-circuit with RATE_LIMITED itself if
-- either bucket's returned count exceeds the threshold - this function has
-- no way to enforce that on its own and does not attempt to.
--
-- Generic failure everywhere: null/blank input, missing session hash,
-- unknown name, wrong password, and a NULL workspace_id on an otherwise-
-- correct name+password pair all raise the exact same UNAUTHORIZED message
-- - deliberately not distinguished, both to avoid username enumeration and
-- because a NULL-workspace legacy account genuinely cannot use this v2
-- login path at all until backfilled (a distinct, explicit design choice,
-- not an oversight).
--
-- The cleanup DELETE below aliases the table as `s` and qualifies every
-- column through it (s.permission_user_id, s.expires_at) rather than
-- writing bare column names - this function's own RETURNS TABLE declares
-- an OUT parameter also named expires_at, and a bare `expires_at` in the
-- WHERE clause is genuinely ambiguous between that OUT parameter and the
-- table column (PL/pgSQL raised exactly this 42702 error during local
-- testing). This is the same bug class already fixed once before in this
-- project (see 20260806210000_election_day_reset_permission_user_password_
-- fix.sql's own id-ambiguity fix) - every function below that returns a
-- table follows the same alias-everything discipline for this reason.
-- ============================================================================
create or replace function public.election_day_login_v2(
  p_name text,
  p_password text,
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_user_name text;
  v_password_hash text;
  v_role_id uuid;
  v_workspace_id uuid;
  v_expires_at timestamptz;
begin
  if p_name is null or btrim(p_name) = ''
     or p_password is null or p_password = ''
     or p_session_hash is null
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select u.id, u.name, u.password_hash, u.role_id, u.workspace_id
    into v_user_id, v_user_name, v_password_hash, v_role_id, v_workspace_id
  from public.election_day_permission_users u
  where u.name = btrim(p_name);

  if v_user_id is null
     or v_password_hash is null
     or extensions.crypt(p_password, v_password_hash) <> v_password_hash
     or v_workspace_id is null
  then
    raise exception 'UNAUTHORIZED';
  end if;

  delete from public.election_day_sessions s
  where s.permission_user_id = v_user_id and s.expires_at < now();

  v_expires_at := now() + interval '24 hours';

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (v_user_id, v_workspace_id, p_session_hash, v_expires_at);

  return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
end;
$$;

comment on function public.election_day_login_v2(text, text, bytea) is
  'Phase 3A: service_role-only login. bcrypt-verifies name+password (same pattern as the legacy election_day_login), requires a non-null workspace_id on the resolved user (a NULL-workspace legacy account cannot log in via this path - generic UNAUTHORIZED, not a distinguishing error), and creates the session row in the SAME transaction as successful authentication. p_session_hash is sha256(raw token) computed by the caller in Node BEFORE this call - the raw token never reaches Postgres. Does NOT perform rate limiting itself - the caller (Vercel) must call election_day_register_login_attempt separately, first, and enforce the threshold before ever calling this function; see that function''s own comment for why a same-transaction attempt was tried and found not to work. Opportunistically deletes this user''s own already-expired sessions before inserting the new one, matching election_day_reauth''s own expired-proof cleanup precedent. Fixed 24-hour absolute expiry, no sliding extension. service_role-only: no PUBLIC/anon/authenticated EXECUTE - the browser''s anon key can never call this directly, unlike the still-fully-functional, unchanged legacy election_day_login.';

revoke all on function public.election_day_login_v2(text, text, bytea) from public;
revoke all on function public.election_day_login_v2(text, text, bytea) from anon;
revoke all on function public.election_day_login_v2(text, text, bytea) from authenticated;
grant execute on function public.election_day_login_v2(text, text, bytea) to service_role;

-- ============================================================================
-- 4. election_day_logout_v2 - service_role-only session revocation by hash.
-- The hash itself is the credential authorizing deletion of that exact row
-- (never a bare actor_id - matches election_day_revoke_reauth_proof's own
-- "the proof is the credential" reasoning exactly). Idempotent: a missing/
-- already-expired/unknown hash is a silent no-op, never an error, so
-- client-side logout never fails regardless of prior state. Deleting a
-- PermissionUser already cascades all of that user''s sessions via the
-- schema''s own ON DELETE CASCADE - no separate disable/deactivation logic
-- exists or is invented here, since no such field exists on
-- election_day_permission_users today.
-- ============================================================================
create or replace function public.election_day_logout_v2(
  p_session_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_session_hash is null then
    return;
  end if;

  delete from public.election_day_sessions where token_hash = p_session_hash;
end;
$$;

comment on function public.election_day_logout_v2(bytea) is
  'Phase 3A: service_role-only logout - deletes exactly the session row matching p_session_hash (the hash itself is the credential authorizing this delete, never a bare actor_id). Idempotent: a missing/unknown hash is a silent no-op, never an error. Deleting a PermissionUser already cascades their sessions via the schema''s own FK - no separate disable/deactivation concept exists and none is invented here. service_role-only: no PUBLIC/anon/authenticated EXECUTE.';

revoke all on function public.election_day_logout_v2(bytea) from public;
revoke all on function public.election_day_logout_v2(bytea) from anon;
revoke all on function public.election_day_logout_v2(bytea) from authenticated;
grant execute on function public.election_day_logout_v2(bytea) to service_role;

-- ============================================================================
-- 5. election_day_reauth_v3 - service_role-only, action-bound step-up
-- re-authentication. Unlike the legacy election_day_reauth (which takes a
-- raw actor_id + password and issues a general-purpose 15-minute proof
-- reusable across every privileged mutation), this version derives the
-- actor/workspace SERVER-SIDE from a verified session (never a
-- client-supplied actor_id), still requires the actor''s own password
-- (step-up: proving recent password knowledge, not just holding a valid
-- session), and binds the resulting proof to exactly one named p_action -
-- the whole point being that a proof issued for one specific privileged
-- operation cannot be replayed against a different one.
--
-- p_proof_hash is bytea, computed by the caller (Vercel, in Node) from a
-- raw proof it generates itself, BEFORE calling this function - the raw
-- proof value never reaches Postgres, mirroring p_session_hash''s own
-- design and election_day_reauth_proofs.proof_hash''s existing column
-- convention (already bytea from its original migration).
--
-- Short expiry (5 minutes, intentionally shorter than the legacy general-
-- purpose proof''s 15 minutes): this proof is meant to be minted
-- immediately before, and consumed immediately by, one specific mutation
-- call - not carried around as a general step-up credential for a whole
-- admin session the way the legacy proof is used today.
-- ============================================================================
create or replace function public.election_day_reauth_v3(
  p_session_hash bytea,
  p_password text,
  p_action text,
  p_proof_hash bytea
)
returns table (
  actor_id uuid,
  workspace_id uuid,
  action text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_role_id uuid;
  v_workspace_id uuid;
  v_password_hash text;
  v_expires_at timestamptz;
begin
  if p_session_hash is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
     or p_password is null or p_password = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select r.actor_id, r.role_id, r.workspace_id
    into v_actor_id, v_role_id, v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  select u.password_hash into v_password_hash
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_password_hash is null
     or extensions.crypt(p_password, v_password_hash) <> v_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Aliased and column-qualified for the same reason as election_day_
  -- login_v2's cleanup DELETE above: this function's RETURNS TABLE
  -- declares actor_id/action/expires_at as OUT parameters, each of which
  -- would otherwise be ambiguous against this table's identically-named
  -- columns.
  delete from public.election_day_reauth_proofs p
  where p.actor_id = v_actor_id and p.action = p_action and p.expires_at < now();

  v_expires_at := now() + interval '5 minutes';

  insert into public.election_day_reauth_proofs (actor_id, workspace_id, action, proof_hash, expires_at)
  values (v_actor_id, v_workspace_id, p_action, p_proof_hash, v_expires_at);

  return query select v_actor_id, v_workspace_id, p_action, v_expires_at;
end;
$$;

comment on function public.election_day_reauth_v3(bytea, text, text, bytea) is
  'Phase 3A: service_role-only, action-bound step-up reauth. Actor/workspace are derived SERVER-SIDE from p_session_hash via election_day_resolve_session (never a client-supplied actor_id) - resolve_session itself raises UNAUTHORIZED for an invalid/expired session, which propagates through this function unchanged. Still requires the actor''s own current password (bcrypt-verified) - a valid session alone is not sufficient for a step-up proof, matching the legacy election_day_reauth''s own step-up intent. p_proof_hash is sha256(raw proof) computed by the caller in Node BEFORE this call; the raw proof never reaches Postgres. The issued proof is bound to exactly one p_action and expires in 5 minutes (shorter than the legacy general-purpose proof''s 15 minutes, since this is meant for immediate one-shot consumption by election_day_verify_reauth_proof_v3, not carried as a session-long credential). Opportunistically deletes this actor''s own already-expired same-action proofs before inserting, matching election_day_reauth''s own cleanup precedent. service_role-only: no PUBLIC/anon/authenticated EXECUTE.';

revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from public;
revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from anon;
revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from authenticated;
grant execute on function public.election_day_reauth_v3(bytea, text, text, bytea) to service_role;

-- ============================================================================
-- 6. election_day_verify_reauth_proof_v3 - internal-only helper, intended
-- to be called from inside FUTURE privileged mutation RPCs (none exist yet
-- - see this migration's header "explicitly OUT of scope"). NOT granted to
-- any role, including service_role - same internal-helper precedent as
-- election_day_verify_reauth_proof and election_day_register_login_attempt
-- above.
--
-- Requires BOTH a currently-valid session (re-derives actor/workspace/role
-- from it, exactly like election_day_reauth_v3 does at issuance) AND a
-- matching, non-expired, same-actor, same-workspace, same-p_action proof.
-- A proof issued for a different action fails (the WHERE clause''s
-- p.action = p_action condition never matches a differently-actioned row).
-- A proof whose actor/workspace does not match the CURRENT session''s
-- resolved actor/workspace fails explicitly (guards against, for example,
-- a proof from a prior session outliving a workspace change that the
-- ON UPDATE RESTRICT FK would otherwise make structurally impossible
-- anyway - defense in depth, same reasoning as election_day_resolve_
-- session''s own redundant join above). An expired proof fails via the
-- WHERE clause''s expires_at > now() condition.
-- ============================================================================
create or replace function public.election_day_verify_reauth_proof_v3(
  p_session_hash bytea,
  p_proof_hash bytea,
  p_action text
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
  v_role_id uuid;
  v_workspace_id uuid;
  v_proof_actor_id uuid;
  v_proof_workspace_id uuid;
begin
  if p_session_hash is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select r.actor_id, r.actor_name, r.role_id, r.workspace_id
    into v_actor_id, v_actor_name, v_role_id, v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  select p.actor_id, p.workspace_id into v_proof_actor_id, v_proof_workspace_id
  from public.election_day_reauth_proofs p
  where p.proof_hash = p_proof_hash
    and p.action = p_action
    and p.expires_at > now();

  if v_proof_actor_id is null
     or v_proof_actor_id <> v_actor_id
     or v_proof_workspace_id is distinct from v_workspace_id
  then
    raise exception 'UNAUTHORIZED';
  end if;

  return query select v_actor_id, v_actor_name, v_role_id, v_workspace_id;
end;
$$;

comment on function public.election_day_verify_reauth_proof_v3(bytea, bytea, text) is
  'Phase 3A: internal-only helper - verifies a session AND an action-bound proof together, returning the SERVER-DERIVED {actor_id, actor_name, role_id, workspace_id} only if all of: the session is currently valid, a proof exists matching p_proof_hash + p_action + not expired, and that proof''s actor_id/workspace_id match the session''s CURRENTLY-resolved actor/workspace exactly. A proof for a different action, a proof belonging to a different actor, or an expired proof all raise the same generic UNAUTHORIZED - never a distinguishing message. Not granted to any role, including service_role - callable only from inside a future privileged mutation RPC''s own SECURITY DEFINER body (none exist yet), matching election_day_verify_reauth_proof''s existing internal-helper precedent exactly.';

revoke all on function public.election_day_verify_reauth_proof_v3(bytea, bytea, text) from public;
revoke all on function public.election_day_verify_reauth_proof_v3(bytea, bytea, text) from anon;
revoke all on function public.election_day_verify_reauth_proof_v3(bytea, bytea, text) from authenticated;

-- ============================================================================
-- 7. election_day_create_permission_user_v3 - service_role-only. Closes
-- the "legacy-create-user NULL-workspace risk" noted in the Phase 3A EXPAND
-- migration: unlike election_day_create_permission_user_v2 (which never
-- writes workspace_id at all, leaving every newly-created user with
-- workspace_id = NULL until a separate backfill), this function writes the
-- ACTING CALLER''S OWN workspace_id (resolved server-side from the session
-- + action-bound proof, never a client-supplied value) onto the new row -
-- a manager creates users only within their own already-established
-- workspace, by construction, never an arbitrary one.
--
-- Auth: requires BOTH a valid session AND a matching action-bound reauth
-- proof for the 'create_permission_user' action (via election_day_verify_
-- reauth_proof_v3 - the same "session + action-bound proof" pairing every
-- future privileged mutation in this architecture will use), then checks
-- the resolved actor''s CURRENT role for electionDay.manageUsers - same
-- permission name and same "read live, never cached" pattern as election_
-- day_create_permission_user_v2.
--
-- Business logic (name/password required, p_role_id must exist) copied
-- verbatim from election_day_create_permission_user_v2 - this function
-- adds a new auth mechanism (session + action-bound proof, vs. v2''s
-- legacy general-purpose proof) and the new workspace_id-on-insert
-- behavior; it does not change any existing validation rule EXCEPT one:
-- the p_role_id existence check is workspace-scoped here, not bare -
-- see that check''s own inline comment for why v2''s unscoped version
-- (copied verbatim in an earlier draft of this function) was rejected as
-- unsafe once election_day_roles carries its own workspace_id. Roles are
-- workspace-scoped operational data (approved architectural decision, no
-- global/shared-role model) - a role belonging to a different workspace,
-- or one with workspace_id IS NULL, is rejected exactly like a
-- nonexistent role, with the same ROLE_NOT_FOUND message, so this never
-- leaks whether the requested role exists in another workspace.
--
-- election_day_create_permission_user_v2 is NOT touched, NOT retired, and
-- remains the frontend''s only creation path until a separate, later,
-- explicit frontend cutover decision - this function exists so that path
-- is ready in the database ahead of that cutover, per this task''s explicit
-- "you may implement the RPC locally; do NOT change the frontend" scope.
-- ============================================================================
create or replace function public.election_day_create_permission_user_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_name text,
  p_password text,
  p_role_id uuid
)
returns table (
  id uuid,
  name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_id uuid;
begin
  select v.role_id, v.workspace_id
    into v_actor_role_id, v_actor_workspace_id
  from public.election_day_verify_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'create_permission_user'
  ) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;
  -- Workspace-scoped, not a bare existence check: roles are workspace-scoped
  -- operational data (per the approved architectural decision), so a role
  -- belonging to a DIFFERENT workspace - or one with a NULL workspace_id -
  -- must be rejected exactly like a role that doesn't exist at all. Deliberately
  -- no `or r.workspace_id is null` clause - there is no global/shared-role
  -- model in this architecture, so a NULL-workspace role (which can currently
  -- still exist under this schema, since election_day_roles.workspace_id
  -- remains nullable pending its own separate Phase 2 backfill decision) is
  -- correctly treated as belonging to no workspace the caller could ever be
  -- in, not as implicitly available to everyone. Fails with the SAME
  -- ROLE_NOT_FOUND used for a genuinely nonexistent id - never a distinct
  -- message - so this never leaks whether the role exists in another
  -- workspace, only that it isn't usable by this caller.
  if not exists (
    select 1 from public.election_day_roles r
    where r.id = p_role_id and r.workspace_id = v_actor_workspace_id
  ) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values (
    btrim(p_name),
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    p_role_id,
    v_actor_workspace_id
  )
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role_id, u.workspace_id
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) is
  'Phase 3A: service_role-only user creation - the workspace-safe successor to election_day_create_permission_user_v2 (which never writes workspace_id, leaving every new user NULL until a separate backfill). Writes the ACTING CALLER''S OWN workspace_id, resolved server-side via election_day_verify_reauth_proof_v3(session + action-bound proof for the ''create_permission_user'' action) - never a client-supplied workspace_id. Requires electionDay.manageUsers on the resolved actor''s CURRENT role, read live. p_role_id must belong to that SAME workspace (r.workspace_id = v_actor_workspace_id, never r.workspace_id IS NULL - roles are workspace-scoped operational data, no global/shared-role model) - a role in a different workspace, or one with a NULL workspace_id, is rejected with the same ROLE_NOT_FOUND as a nonexistent role, never a distinguishing message. Other business validation (name/password required) copied verbatim from election_day_create_permission_user_v2, which is NOT touched or retired by this migration and remains the frontend''s only creation path until a separate, later, explicit cutover decision - this RPC exists ahead of that cutover per this task''s explicit local-only, no-frontend-change scope.';

revoke all on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) from public;
revoke all on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) from anon;
revoke all on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) from authenticated;
grant execute on function public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   begin;
--   drop function if exists public.election_day_create_permission_user_v3(bytea, bytea, text, text, uuid);
--   drop function if exists public.election_day_verify_reauth_proof_v3(bytea, bytea, text);
--   drop function if exists public.election_day_reauth_v3(bytea, text, text, bytea);
--   drop function if exists public.election_day_logout_v2(bytea);
--   drop function if exists public.election_day_login_v2(text, text, bytea);
--   drop function if exists public.election_day_register_login_attempt(text);
--   drop function if exists public.election_day_resolve_session(bytea);
--   commit;
-- ============================================================================
