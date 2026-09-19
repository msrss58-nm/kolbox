-- ===========================================================================
-- KOLBOX Auth / IdP origin - the cross-origin handoff.
--
-- A dedicated auth origin owns the single credential form. It authenticates
-- once, resolves the realm server-side, and hands the browser to the target
-- origin, which mints its OWN session. No cookie or storage can span the
-- origins (`__Host-` forbids Domain; *.vercel.app is on the Public Suffix
-- List), so the handoff below is the only transfer mechanism.
--
-- TWO LEGS, and the session is gated on BOTH:
--   leg 1  auth_handoff_consume  - the one-time code, consumed atomically by
--                                  the target origin, which then writes its
--                                  OWN transaction state onto the same row.
--   leg 2  auth_handoff_complete - the target-origin HttpOnly __Host- cookie.
--                                  This is the ONLY call that authorizes
--                                  minting a session.
--
-- The auth origin can never manufacture leg-2 state: txn_hash is written only
-- by the target origin, after it consumed a valid code. That is what defeats
-- login CSRF / session swapping, which TTL, single-use and origin binding do
-- NOT address on their own (an attacker planting their OWN valid code).
--
-- No raw secret is ever stored: only sha256 digests of the code and of the
-- transaction value. Display fields are pre-masked by the caller so the
-- confirmation screen needs no further lookup and no id is ever exposed.
-- ===========================================================================

create table public.auth_handoff_codes (
  id              uuid primary key default gen_random_uuid(),
  code_hash       bytea not null,
  realm           text  not null check (realm in
                    ('worker','election_owner','platform_owner','multi_entity_owner')),
  target_origin   text  not null,
  -- Subject. Exactly one shape per realm, enforced below.
  auth_user_id    uuid references auth.users(id) on delete cascade,
  actor_id        uuid references public.election_day_permission_users(id) on delete cascade,
  workspace_id    uuid references public.election_workspaces(id) on delete cascade,
  -- Confirmation-screen copy, already safe to render (emails arrive masked).
  display_name    text not null,
  display_context text,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  -- Leg 2: written ONLY by the target origin, only after consuming the code.
  txn_hash        bytea,
  txn_expires_at  timestamptz,
  txn_consumed_at timestamptz,
  constraint auth_handoff_subject_shape check (
    (realm = 'worker'
       and actor_id is not null and workspace_id is not null and auth_user_id is null)
    or
    (realm <> 'worker'
       and auth_user_id is not null and actor_id is null and workspace_id is null)
  )
);

comment on table public.auth_handoff_codes is
  'KOLBOX Auth origin handoff. One row per sign-in attempt that reached realm resolution. Holds identifiers and pre-masked display copy only - never a password, session token, access token or any bearer secret. Both the code and the target-origin transaction value are stored as sha256 digests; the raw values exist only in flight (the code in a cross-origin form POST body, the transaction value in a target-origin HttpOnly cookie) and never in a URL.';

comment on column public.auth_handoff_codes.txn_hash is
  'sha256 of the target origin''s __Host- HttpOnly transaction cookie. Written by the TARGET origin during leg 1 and matched during leg 2. The auth origin can never set this, which is what binds the handoff to the browser that actually received leg 1.';

create unique index auth_handoff_codes_code_hash_key
  on public.auth_handoff_codes (code_hash);
create unique index auth_handoff_codes_txn_hash_key
  on public.auth_handoff_codes (txn_hash) where txn_hash is not null;
-- Supports the bounded opportunistic sweep in auth_handoff_issue.
create index auth_handoff_codes_expires_at_idx
  on public.auth_handoff_codes (expires_at);

-- RLS on, zero policies - same precedent as election_day_reauth_proofs. The
-- only access path is the SECURITY DEFINER RPCs below; the table itself is
-- never granted to any role.
alter table public.auth_handoff_codes enable row level security;

-- ===========================================================================
-- 1. auth_handoff_issue - called by the BROKER on the auth origin only.
-- ===========================================================================
create or replace function public.auth_handoff_issue(
  p_code_hash       bytea,
  p_realm           text,
  p_target_origin   text,
  p_auth_user_id    uuid,
  p_actor_id        uuid,
  p_workspace_id    uuid,
  p_display_name    text,
  p_display_context text,
  p_ttl_seconds     integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id uuid;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 300 then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Opportunistic, BOUNDED cleanup (see this migration's header and the
  -- architecture's cleanup section). Runs BEFORE the insert so a failure
  -- aborts issuance and the sign-in fails closed rather than silently
  -- skipping hygiene. `limit` keeps one unlucky sign-in from paying for a
  -- long sweep, unlike the unbounded delete in
  -- election_day_register_login_attempt. Rows are never a security
  -- dependency: every read below re-checks expiry, so a stale row is inert.
  delete from public.auth_handoff_codes
  where ctid in (
    select c.ctid from public.auth_handoff_codes c
    where c.expires_at < now() - interval '1 hour'
       or (c.txn_expires_at is not null and c.txn_expires_at < now() - interval '1 hour')
    limit 500
  );

  insert into public.auth_handoff_codes (
    code_hash, realm, target_origin,
    auth_user_id, actor_id, workspace_id,
    display_name, display_context, expires_at
  )
  values (
    p_code_hash, p_realm, p_target_origin,
    p_auth_user_id, p_actor_id, p_workspace_id,
    p_display_name, p_display_context, now() + make_interval(secs => p_ttl_seconds)
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.auth_handoff_issue(bytea,text,text,uuid,uuid,uuid,text,text,integer) is
  'Issues a one-time cross-origin handoff. Called only by the auth-origin broker, after it has authenticated the principal and resolved the realm. Performs bounded opportunistic cleanup of long-expired rows first, so a cleanup failure fails the sign-in closed. service_role only.';

revoke all on function public.auth_handoff_issue(bytea,text,text,uuid,uuid,uuid,text,text,integer) from public;
revoke all on function public.auth_handoff_issue(bytea,text,text,uuid,uuid,uuid,text,text,integer) from anon;
revoke all on function public.auth_handoff_issue(bytea,text,text,uuid,uuid,uuid,text,text,integer) from authenticated;
grant execute on function public.auth_handoff_issue(bytea,text,text,uuid,uuid,uuid,text,text,integer) to service_role;

-- ===========================================================================
-- 2. auth_handoff_consume - LEG 1. The target origin consumes the code and
--    writes its own transaction state in the SAME transaction. Mints nothing.
-- ===========================================================================
create or replace function public.auth_handoff_consume(
  p_code_hash       bytea,
  p_txn_hash        bytea,
  p_txn_ttl_seconds integer,
  p_expected_realm  text[],
  p_expected_origin text
)
returns table (
  realm           text,
  auth_user_id    uuid,
  actor_id        uuid,
  workspace_id    uuid,
  display_name    text,
  display_context text
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.auth_handoff_codes%rowtype;
begin
  if p_txn_ttl_seconds is null or p_txn_ttl_seconds < 1 or p_txn_ttl_seconds > 600
     or p_txn_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select * into v_row
  from public.auth_handoff_codes h
  where h.code_hash = p_code_hash
  for update;

  -- ONE error for every cause: unknown, already used, expired, wrong realm,
  -- wrong origin. Nothing distinguishes them to the caller.
  if not found
     or v_row.consumed_at is not null
     or v_row.expires_at <= now()
     or not (v_row.realm = any (p_expected_realm))
     or v_row.target_origin <> p_expected_origin
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Consume BEFORE anything is issued. A crash after this point fails closed.
  update public.auth_handoff_codes h
     set consumed_at    = now(),
         txn_hash       = p_txn_hash,
         txn_expires_at = now() + make_interval(secs => p_txn_ttl_seconds)
   where h.id = v_row.id;

  return query select v_row.realm, v_row.auth_user_id, v_row.actor_id,
                      v_row.workspace_id, v_row.display_name, v_row.display_context;
end;
$fn$;

comment on function public.auth_handoff_consume(bytea,bytea,integer,text[],text) is
  'Leg 1 of the handoff: atomically consumes the one-time code and records the TARGET origin''s transaction hash on the same row. Mints nothing - a session is authorized only by auth_handoff_complete. Raises one generic UNAUTHORIZED for every failure cause. service_role only.';

revoke all on function public.auth_handoff_consume(bytea,bytea,integer,text[],text) from public;
revoke all on function public.auth_handoff_consume(bytea,bytea,integer,text[],text) from anon;
revoke all on function public.auth_handoff_consume(bytea,bytea,integer,text[],text) from authenticated;
grant execute on function public.auth_handoff_consume(bytea,bytea,integer,text[],text) to service_role;

-- ===========================================================================
-- 3. auth_handoff_txn_info - read-only lookup for the confirmation screen.
--    Returns pre-masked display copy ONLY. Consumes nothing, exposes no id.
-- ===========================================================================
create or replace function public.auth_handoff_txn_info(
  p_txn_hash        bytea,
  p_expected_realm  text[],
  p_expected_origin text
)
returns table (realm text, display_name text, display_context text)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_row public.auth_handoff_codes%rowtype;
begin
  select * into v_row
  from public.auth_handoff_codes h
  where h.txn_hash = p_txn_hash;

  if not found
     or v_row.txn_consumed_at is not null
     or v_row.txn_expires_at is null
     or v_row.txn_expires_at <= now()
     or not (v_row.realm = any (p_expected_realm))
     or v_row.target_origin <> p_expected_origin
  then
    raise exception 'UNAUTHORIZED';
  end if;

  return query select v_row.realm, v_row.display_name, v_row.display_context;
end;
$fn$;

comment on function public.auth_handoff_txn_info(bytea,text[],text) is
  'Read-only: the identity summary shown on the target origin''s confirmation screen. Returns pre-masked display copy only - never an email, id, token or handoff code. Does not consume the transaction. service_role only.';

revoke all on function public.auth_handoff_txn_info(bytea,text[],text) from public;
revoke all on function public.auth_handoff_txn_info(bytea,text[],text) from anon;
revoke all on function public.auth_handoff_txn_info(bytea,text[],text) from authenticated;
grant execute on function public.auth_handoff_txn_info(bytea,text[],text) to service_role;

-- ===========================================================================
-- 4. auth_handoff_complete - LEG 2. The ONLY call that authorizes minting a
--    session. Also used by Cancel, which consumes the transaction and mints
--    nothing, so a cancelled transaction can never be resumed.
-- ===========================================================================
create or replace function public.auth_handoff_complete(
  p_txn_hash        bytea,
  p_expected_realm  text[],
  p_expected_origin text
)
returns table (
  realm        text,
  auth_user_id uuid,
  actor_id     uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.auth_handoff_codes%rowtype;
begin
  if p_txn_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select * into v_row
  from public.auth_handoff_codes h
  where h.txn_hash = p_txn_hash
  for update;

  if not found
     or v_row.txn_consumed_at is not null
     or v_row.txn_expires_at is null
     or v_row.txn_expires_at <= now()
     or not (v_row.realm = any (p_expected_realm))
     or v_row.target_origin <> p_expected_origin
  then
    raise exception 'UNAUTHORIZED';
  end if;

  update public.auth_handoff_codes h
     set txn_consumed_at = now()
   where h.id = v_row.id;

  return query select v_row.realm, v_row.auth_user_id, v_row.actor_id, v_row.workspace_id;
end;
$fn$;

comment on function public.auth_handoff_complete(bytea,text[],text) is
  'Leg 2 of the handoff: validates the target origin''s own HttpOnly transaction cookie and consumes it, authorizing exactly one session mint. Cancel calls this too and mints nothing, which is what makes a cancelled transaction unresumable. Raises one generic UNAUTHORIZED for every failure cause. service_role only.';

revoke all on function public.auth_handoff_complete(bytea,text[],text) from public;
revoke all on function public.auth_handoff_complete(bytea,text[],text) from anon;
revoke all on function public.auth_handoff_complete(bytea,text[],text) from authenticated;
grant execute on function public.auth_handoff_complete(bytea,text[],text) to service_role;
