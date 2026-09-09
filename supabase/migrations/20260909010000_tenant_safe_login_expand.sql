-- Tenant-Safe PermissionUser Login - EXPAND phase.
--
-- ============================================================================
-- SCOPE - strictly additive. v2 IS DELIBERATELY LEFT UNTOUCHED.
-- ============================================================================
-- Adds exactly four things:
--   1. public.election_workspaces.login_code - the authoritative, system-
--      generated tenant selector, backfilled for every existing workspace,
--      then made UNIQUE and NOT NULL;
--   2. public.election_day_generate_workspace_login_code() - the sole code
--      generator, with bounded, fail-closed collision handling;
--   3. public.election_day_login_v3(text, text, text, bytea) - tenant-safe
--      login;
--   4. the ACLs for both new functions.
--
-- It does NOT modify or drop election_day_login_v2 (which MUST keep working
-- through the whole EXPAND phase as the no-code fallback), does NOT touch
-- election_day_login (already retired), does NOT change election_day_sessions
-- or election_day_resolve_session (both are already tenant-safe - see below),
-- does NOT change any PermissionUser row or password, does NOT change any
-- workspace's name or election_end_at, and creates no workspace.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- Stage 3A (20260909000000) correctly re-scoped
-- election_day_permission_users.name from a global UNIQUE(name) to
-- UNIQUE(workspace_id, name). election_day_login_v2 still resolves a user with:
--
--   select u.id, ... into v_user_id, ...
--   from public.election_day_permission_users u
--   where u.name = btrim(p_name);
--
-- PL/pgSQL's SELECT ... INTO *without* STRICT does not raise on multiple
-- matching rows - it silently keeps an arbitrary one. While exactly one
-- workspace exists these are equivalent, but the moment two workspaces hold
-- the same user name that login becomes non-deterministic: because the
-- password is verified AFTER the row is chosen, a user with the correct
-- password can be rejected (the other workspace's row was picked), and with
-- a colliding password could be authenticated into the WRONG workspace.
--
-- v3 removes the ambiguity structurally: it resolves the workspace FIRST from
-- an explicit code, then looks the user up by (workspace_id, name) - a pair
-- the database itself guarantees is unique - so at most one row can ever
-- match, and the password never participates in choosing the tenant.
--
-- ============================================================================
-- THE CODE IS A SELECTOR, NOT A SECRET
-- ============================================================================
-- login_code identifies WHICH workspace a login attempt is aimed at, exactly
-- like a subdomain would. It is expected to appear in URLs, bookmarks and
-- printed instructions, and it is guessable by design. It confers NOTHING on
-- its own: authority still comes only from the username+password pair
-- verified inside this function. Two consequences are deliberate:
--   * a wrong code, an unknown user and a wrong password all raise the SAME
--     generic UNAUTHORIZED - the caller can never use this RPC to learn
--     whether a workspace or a username exists;
--   * the modulo-bias rejection sampling in the generator below is for
--     uniform distribution, NOT for cryptographic unpredictability, and must
--     not be read as a claim that the code is secret.
--
-- ============================================================================
-- WHAT IS NOT CHANGED, AND WHY THAT IS CORRECT
-- ============================================================================
-- election_day_sessions already carries workspace_id NOT NULL plus the
-- composite FK (workspace_id, permission_user_id) ->
-- election_day_permission_users (workspace_id, id) (20260826000000), and
-- election_day_resolve_session already joins on BOTH columns. A session that
-- points at one workspace's row while claiming another is therefore
-- structurally impossible. Once login picks the workspace unambiguously the
-- session layer is already correct, so this migration deliberately leaves the
-- entire session architecture alone.
--
-- election_end_at is deliberately NOT consulted here. The only existing
-- workspace's election_end_at has already passed, and today's login does not
-- check it; adding such a check in this migration would lock every existing
-- Production account out immediately. Expired-election behaviour is a
-- separate product decision and is intentionally unchanged.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- This project's hosted Production carries a project-level pg_default_acl
-- entry that auto-grants EXECUTE to anon and authenticated on EVERY newly
-- created function in schema public. `revoke ... from public` alone does NOT
-- undo an individually-named-role default privilege. Both functions below
-- therefore revoke EXECUTE from PUBLIC, anon and authenticated BY EXACT
-- SIGNATURE. After applying this migration to Production, verify
-- pg_proc.proacl there directly rather than trusting a local result.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction.
begin;

-- ============================================================================
-- PRE-GATES - abort the whole migration rather than half-apply it.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'election_workspaces'
  ) then
    raise exception 'EXPAND_GATE_FAILED: public.election_workspaces does not exist';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'election_workspaces'
      and column_name = 'login_code'
  ) then
    raise exception
      'EXPAND_GATE_FAILED: public.election_workspaces.login_code already exists - migration may already be applied';
  end if;

  -- Stage 3A must already be in place: v3 looks users up by (workspace_id,
  -- name) and relies on that pair being unique. Without Stage 3A's constraint
  -- the lookup could still match two rows.
  if not exists (
    select 1 from pg_constraint
    where conname = 'election_day_permission_users_workspace_id_name_key'
      and contype = 'u'
  ) then
    raise exception
      'EXPAND_GATE_FAILED: Stage 3A constraint election_day_permission_users_workspace_id_name_key is missing - v3 requires (workspace_id, name) to be unique';
  end if;
end;
$$;

-- ============================================================================
-- 1. login_code column - nullable first, so the backfill has somewhere to go.
-- ============================================================================
alter table public.election_workspaces
  add column login_code text;

-- Charset/shape rule. Exactly 8 characters from a 31-symbol alphabet that
-- excludes every visually ambiguous glyph: the digits 0 and 1 and the letters
-- I, L and O. Uppercase-only is what makes the plain UNIQUE constraint added
-- further down equivalent to a case-INSENSITIVE uniqueness rule: the stored
-- domain contains no lowercase value that could collide with an uppercase one.
-- A NULL passes this CHECK, which is what allows the column to be added and
-- backfilled before NOT NULL is set.
alter table public.election_workspaces
  add constraint election_workspaces_login_code_format_check
    check (login_code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$');

comment on column public.election_workspaces.login_code is
  'System-generated tenant SELECTOR used by election_day_login_v3 to pick which workspace a PermissionUser login attempt is aimed at. NOT a secret and NOT a credential - it is expected to appear in URLs (/election-day/login?w=<code>), bookmarks and printed instructions, and it is guessable by design; authority comes only from the username+password verified inside that function. Exactly 8 characters from [23456789ABCDEFGHJKMNPQRSTUVWXYZ] - the ambiguous glyphs 0/1/I/L/O are excluded so a code can be read aloud and typed without error. Uppercase-only by CHECK, which is what makes election_workspaces_login_code_key a case-insensitive uniqueness rule in practice. Generated exclusively by election_day_generate_workspace_login_code(); never chosen by an Owner in this phase.';

-- ============================================================================
-- 2. The generator. Bounded and fail-closed: it never returns a colliding or
-- malformed code, and it never loops forever.
-- ============================================================================
create or replace function public.election_day_generate_workspace_login_code()
returns text
language plpgsql
security definer
set search_path = ''
volatile
as $$
declare
  -- 31 symbols: digits 2-9 and A-Z minus I, L, O.
  c_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  c_len      constant integer := 8;
  -- 256 is not a multiple of 31 (256 = 8*31 + 8), so naively taking byte % 31
  -- would make the first 8 symbols slightly more likely. Every byte at or
  -- above this limit is rejected and redrawn instead, which removes the bias
  -- completely. This is about even distribution, NOT secrecy - see the header.
  c_byte_limit constant integer := 248;
  c_max_attempts constant integer := 20;
  v_candidate text;
  v_byte integer;
  v_attempt integer := 0;
begin
  while v_attempt < c_max_attempts loop
    v_attempt := v_attempt + 1;
    v_candidate := '';

    while pg_catalog.length(v_candidate) < c_len loop
      -- One byte at a time so a rejected draw costs one byte, not a restart.
      v_byte := pg_catalog.get_byte(extensions.gen_random_bytes(1), 0);
      if v_byte < c_byte_limit then
        v_candidate := v_candidate
          || pg_catalog.substr(c_alphabet, (v_byte % 31) + 1, 1);
      end if;
    end loop;

    -- Uniqueness is ultimately enforced by election_workspaces_login_code_key;
    -- this check just avoids relying on a constraint violation for ordinary
    -- control flow, and lets the caller get a usable code on the next attempt.
    if not exists (
      select 1 from public.election_workspaces w where w.login_code = v_candidate
    ) then
      return v_candidate;
    end if;
  end loop;

  -- Fail closed. With a 31^8 (~8.5e11) space this is effectively unreachable;
  -- if it ever fires, something is badly wrong and inventing a code anyway
  -- would be the worse outcome.
  raise exception
    'LOGIN_CODE_GENERATION_FAILED: no unique code found after % attempts', c_max_attempts;
end;
$$;

comment on function public.election_day_generate_workspace_login_code() is
  'Returns one unused public.election_workspaces.login_code: 8 characters drawn uniformly (via rejection sampling that discards bytes >= 248 to remove modulo bias) from the 31-symbol unambiguous alphabet [23456789ABCDEFGHJKMNPQRSTUVWXYZ]. Retries at most 20 times against the live table and then RAISES rather than returning a colliding or malformed value - bounded and fail-closed. The result is a tenant SELECTOR, not a secret: the rejection sampling is for even distribution only and must never be read as a claim of unpredictability. Granted to NO role at all - callable only from inside another SECURITY DEFINER function owned by postgres (the future Stage 3B provisioning RPC) or by a superuser during a migration, matching election_day_verify_and_consume_owner_proof''s internal-helper precedent.';

revoke all on function public.election_day_generate_workspace_login_code() from public;
revoke all on function public.election_day_generate_workspace_login_code() from anon;
revoke all on function public.election_day_generate_workspace_login_code() from authenticated;
revoke all on function public.election_day_generate_workspace_login_code() from service_role;

-- ============================================================================
-- 3. Backfill every existing workspace, one row at a time so each row gets its
-- own independently-generated, collision-checked code.
-- ============================================================================
do $$
declare
  v_id uuid;
  v_code text;
begin
  for v_id in
    select w.id from public.election_workspaces w where w.login_code is null
  loop
    v_code := public.election_day_generate_workspace_login_code();
    update public.election_workspaces
      set login_code = v_code
      where id = v_id;
  end loop;
end;
$$;

-- Post-backfill gate: no NULL may survive into the NOT NULL step below.
do $$
declare
  v_nulls bigint;
begin
  select count(*) into v_nulls
  from public.election_workspaces where login_code is null;

  if v_nulls > 0 then
    raise exception
      'EXPAND_GATE_FAILED: % workspace row(s) still have a NULL login_code after backfill', v_nulls;
  end if;
end;
$$;

-- ============================================================================
-- 4. Uniqueness + NOT NULL, now that every row carries a valid code.
--
-- A plain UNIQUE constraint (not a `unique index on upper(login_code)`) is
-- correct here BECAUSE of election_workspaces_login_code_format_check above:
-- the stored domain is uppercase-only, so two values that differ solely by
-- case cannot both exist, which makes this constraint case-insensitive in
-- effect. Expressed as a CONSTRAINT rather than an index for the same reason
-- given in the Stage 1 migration (20260907000000): no partial predicate is
-- needed, so the rule belongs in pg_constraint where a violation names it.
-- ============================================================================
alter table public.election_workspaces
  add constraint election_workspaces_login_code_key unique (login_code);

alter table public.election_workspaces
  alter column login_code set not null;

comment on constraint election_workspaces_login_code_key on public.election_workspaces is
  'One workspace per login code. Combined with election_workspaces_login_code_format_check (which restricts the stored domain to uppercase-only), this plain UNIQUE is equivalent to a case-insensitive uniqueness rule, and its backing btree is exactly the index election_day_login_v3''s `where login_code = <normalized code>` lookup needs.';

-- ============================================================================
-- 5. election_day_login_v3 - tenant-safe login. Runs ALONGSIDE v2 for the
-- whole EXPAND phase; v2 is not modified, revoked or dropped here.
-- ============================================================================
create or replace function public.election_day_login_v3(
  p_workspace_code text,
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
  v_code text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_user_name text;
  v_password_hash text;
  v_role_id uuid;
  v_expires_at timestamptz;
begin
  if p_workspace_code is null or btrim(p_workspace_code) = ''
     or p_name is null or btrim(p_name) = ''
     or p_password is null or p_password = ''
     or p_session_hash is null
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Deterministic normalization, and the ONLY normalization performed: trim
  -- surrounding whitespace, uppercase. Matches the stored domain exactly (see
  -- election_workspaces_login_code_format_check), so a code typed in lowercase
  -- or pasted with a trailing space still resolves, while nothing else about
  -- the input is silently "corrected".
  v_code := upper(btrim(p_workspace_code));

  -- STEP 1 - resolve the workspace FIRST, before any user or password work.
  -- login_code is UNIQUE, so this can match at most one row.
  select w.id into v_workspace_id
  from public.election_workspaces w
  where w.login_code = v_code;

  if v_workspace_id is null then
    -- Same generic error as an unknown user or a wrong password: this RPC is
    -- never an oracle for whether a workspace code exists.
    raise exception 'UNAUTHORIZED';
  end if;

  -- STEP 2 - resolve the user WITHIN that workspace. (workspace_id, name) is
  -- unique (Stage 3A, election_day_permission_users_workspace_id_name_key), so
  -- at most one row can match - the arbitrary-row hazard that v2 carries
  -- cannot arise here even in principle.
  select u.id, u.name, u.password_hash, u.role_id
    into v_user_id, v_user_name, v_password_hash, v_role_id
  from public.election_day_permission_users u
  where u.workspace_id = v_workspace_id
    and u.name = btrim(p_name);

  -- STEP 3 - only now is the password verified. Because the tenant was
  -- already fixed in step 1, the password plays no part in choosing WHICH
  -- account is being authenticated: two workspaces holding the same username
  -- AND the same password still resolve strictly to the code's workspace.
  if v_user_id is null
     or v_password_hash is null
     or extensions.crypt(p_password, v_password_hash) <> v_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Deliberately NO election_end_at check - see this migration's header.

  -- Opportunistic cleanup of this user's own expired sessions, matching
  -- election_day_login_v2's established behaviour exactly.
  delete from public.election_day_sessions s
  where s.permission_user_id = v_user_id and s.expires_at < now();

  v_expires_at := now() + interval '24 hours';

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (v_user_id, v_workspace_id, p_session_hash, v_expires_at);

  return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
end;
$$;

comment on function public.election_day_login_v3(text, text, text, bytea) is
  'Tenant-safe successor to election_day_login_v2. Resolves the workspace FIRST from a normalized login_code (upper(btrim(...)), matching the uppercase-only stored domain), then resolves the PermissionUser by (workspace_id, name) - unique since Stage 3A - and only THEN bcrypt-verifies the password, so the password never participates in selecting the tenant and the same username+password in two workspaces still authenticates strictly to the workspace named by the code. An unknown code, an unknown username and a wrong password all raise the SAME generic UNAUTHORIZED: never an enumeration oracle for workspaces or users. p_session_hash is sha256(raw token) computed by the caller in Node - the raw token never reaches Postgres. Fixed 24-hour absolute expiry with no sliding extension, and the session row is created in the same transaction as successful authentication, both matching v2. Does NOT perform rate limiting (the Vercel Server Function calls election_day_register_login_attempt separately, first) and deliberately does NOT check election_end_at. service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever. v2 remains fully functional alongside this function for the whole EXPAND phase and must only be retired in the later CONTRACT step - which must happen BEFORE any second workspace is provisioned.';

revoke all on function public.election_day_login_v3(text, text, text, bytea) from public;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from anon;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from authenticated;
grant execute on function public.election_day_login_v3(text, text, text, bytea) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"). Clean and fully reversible: every object below is created by this
-- migration and nothing pre-existing is modified, so dropping them restores
-- the previous state exactly. election_day_login_v2 is untouched throughout
-- and keeps working before, during and after:
--
--   begin;
--   drop function if exists public.election_day_login_v3(text, text, text, bytea);
--   alter table public.election_workspaces
--     drop constraint if exists election_workspaces_login_code_key;
--   alter table public.election_workspaces
--     drop constraint if exists election_workspaces_login_code_format_check;
--   alter table public.election_workspaces drop column if exists login_code;
--   drop function if exists public.election_day_generate_workspace_login_code();
--   commit;
--
-- NOTE: dropping login_code discards the generated codes. Any login link or
-- printed instruction carrying `?w=<code>` becomes invalid, and re-running
-- this migration afterwards generates DIFFERENT codes - it is not idempotent
-- in the value it produces, only in the shape. Re-issue the links if you roll
-- back after distributing them.
-- ============================================================================
