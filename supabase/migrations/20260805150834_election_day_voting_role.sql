-- Stage 4: promotes "voting" from a logical-only EffectiveRole (see
-- src/permissions/types.ts) to a real, creatable election_day_permission_users
-- role. Purely additive - existing 'user'/'manager' rows and behavior are
-- completely unaffected; this only widens what's allowed, nothing is removed
-- or renamed.

-- Explicit transaction wrapper: the Supabase CLI's migration runner (as of
-- the installed 2.111.0) sends a migration file's statements as one
-- pipelined pgconn.Batch - that is wire-protocol pipelining for round-trip
-- efficiency, NOT an implicit BEGIN/COMMIT. Without this wrapper, a failure
-- between the DROP CONSTRAINT below and the ADD CONSTRAINT that follows it
-- would leave the table with no CHECK constraint on `role` at all until a
-- retry completes. Every statement below is ordinary transactional DDL (no
-- CREATE INDEX CONCURRENTLY / VACUUM / ALTER SYSTEM - the only statement
-- types Postgres cannot run inside a transaction block), so wrapping the
-- whole file is safe. The CLI's own post-migration bookkeeping INSERT into
-- the migration history table is appended by the tool as a separate
-- statement in the same pipelined batch, after this file's COMMIT - if
-- anything between BEGIN and COMMIT fails, Postgres aborts the rest of the
-- pipeline (including that bookkeeping INSERT), so the migration correctly
-- is NOT recorded as applied on failure either.
begin;

-- The original CHECK constraint (20260803174731_election_day_permission_users.sql)
-- was declared inline without an explicit name, so Postgres auto-generated one.
-- Rather than assume the default naming convention, look it up by inspecting
-- pg_constraint directly and drop it by its actual name. Matched by actual
-- catalog column reference (conkey -> pg_attribute.attname = 'role'), NOT by
-- text-searching the rendered constraint definition - a text search could
-- false-positive on an unrelated future constraint whose definition merely
-- mentions the word "role". Zero matches is tolerated (nothing to drop -
-- keeps this block safe to re-run, e.g. after a crash between this step and
-- the ADD CONSTRAINT below). More than one match aborts the whole migration
-- instead of guessing which constraint to drop.
do $$
declare
  v_constraint_names text[];
begin
  select array_agg(con.conname) into v_constraint_names
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'election_day_permission_users'
    and con.contype = 'c'
    and exists (
      select 1
      from pg_attribute att
      where att.attrelid = con.conrelid
        and att.attnum = any(con.conkey)
        and att.attname = 'role'
    );

  if v_constraint_names is null then
    null; -- no existing CHECK constraint references role - nothing to drop
  elsif array_length(v_constraint_names, 1) > 1 then
    raise exception
      'election_day_voting_role migration: found % CHECK constraints referencing "role" (%), expected at most 1 - aborting instead of guessing which to drop',
      array_length(v_constraint_names, 1), v_constraint_names;
  else
    execute format(
      'alter table public.election_day_permission_users drop constraint %I',
      v_constraint_names[1]
    );
  end if;
end $$;

alter table public.election_day_permission_users
  add constraint election_day_permission_users_role_check
  check (role in ('user', 'manager', 'voting'));

-- election_day_create_permission_user's role validation - the only one of
-- the four permission-roster RPCs that checks role at all (election_day_login,
-- election_day_list_permission_users, election_day_delete_permission_user are
-- role-agnostic and need no change). `create or replace` is idempotent; the
-- function body is otherwise byte-for-byte identical to
-- 20260803174740_election_day_permission_rpc.sql.
create or replace function public.election_day_create_permission_user(
  p_name text,
  p_password text,
  p_role text
)
returns table (id uuid, name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_role not in ('user', 'manager', 'voting') then
    raise exception 'invalid role: %', p_role;
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user(text, text, text) is
  'Creates a new PermissionUser, hashing the password server-side (pgcrypto bcrypt) before storage. Plaintext password never lands in any column. Accepts user/manager/voting as of the Stage 4 voting-role migration.';

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   -- Only safe while no 'voting' rows exist in election_day_permission_users -
--   -- if any do, delete or reassign them first, or this drop/re-add will
--   -- either fail (constraint violation) or leave the table in a state that
--   -- violates the reverted, stricter constraint. Wrapped in begin/commit for
--   -- the same reason as the forward migration - see the comment at the top.
--   begin;
--   alter table public.election_day_permission_users
--     drop constraint if exists election_day_permission_users_role_check;
--   alter table public.election_day_permission_users
--     add constraint election_day_permission_users_role_check
--     check (role in ('user', 'manager'));
--
--   -- Revert the RPC to its pre-Stage-4 validation (see
--   -- 20260803174740_election_day_permission_rpc.sql for the exact prior body):
--   create or replace function public.election_day_create_permission_user(
--     p_name text, p_password text, p_role text
--   ) returns table (id uuid, name text, role text)
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare v_id uuid;
--   begin
--     if p_role not in ('user', 'manager') then
--       raise exception 'invalid role: %', p_role;
--     end if;
--     if p_name is null or btrim(p_name) = '' then
--       raise exception 'name is required';
--     end if;
--     if p_password is null or btrim(p_password) = '' then
--       raise exception 'password is required';
--     end if;
--     insert into public.election_day_permission_users (name, password_hash, role)
--     values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role)
--     returning public.election_day_permission_users.id into v_id;
--     return query
--       select u.id, u.name, u.role
--       from public.election_day_permission_users u
--       where u.id = v_id;
--   end;
--   $$;
--   commit;
-- ============================================================================
