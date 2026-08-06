-- Dynamic Non-Voting Reasons: adds `requires_follow_up`, the boolean the
-- upcoming coordinator worklist reads to decide whether a not-yet-voted
-- contact still needs a call ("remaining") or the case is closed
-- ("closed") - see `src/features/election-day/followUpStatus.ts`. Driven
-- ONLY by this column, never inferred from a reason's `name` at runtime;
-- the one-time backfill below matches by name only because it is seeding
-- known existing production rows, not a runtime name-inference rule.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project - the Supabase CLI's migration runner pipelines
-- a file's statements, it does not implicitly wrap them in a transaction.
begin;

alter table public.election_day_not_voting_reasons
  add column requires_follow_up boolean not null default true;

comment on column public.election_day_not_voting_reasons.requires_follow_up is
  'Whether a not-yet-voted contact assigned this reason still needs coordinator follow-up (true, e.g. "לא עונה") or the case is closed (false, e.g. "נפטר"/"עבר עיר"/"בחו''ל"/"מספר טלפון שגוי"/"אמר שלא יגיע"). Fail-safe defaults to true (still needs attention) - only an explicit false closes a case, since silently dropping a voter who still needs a call out of the active worklist is a worse failure than a closed voter staying visible a bit longer. Never inferred from name at runtime - this column is the single source of truth.';

-- One-time backfill of the 6 rows seeded by
-- 20260806160000_election_day_not_voting_reasons_table.sql - matching by
-- name here is safe and correct ONLY because this is a single seed-data
-- migration acting on known existing production rows, not a general rule;
-- no application code may ever infer requires_follow_up from a reason's
-- name. "לא עונה" needs no explicit update - it stays at the column
-- default (true).
update public.election_day_not_voting_reasons
set requires_follow_up = false
where name in ('אמר שלא יגיע', 'מספר טלפון שגוי', 'בחו"ל', 'נפטר', 'עבר עיר');

-- ============================================================================
-- election_day_list_non_voting_reasons - same body as before, plus
-- requires_follow_up in the select list and returns table signature. Postgres
-- rejects `create or replace` when the OUT-parameter row type changes (even
-- with identical arguments), so this needs the same drop+recreate as the
-- create/update RPCs below - not a plain `create or replace`.
-- ============================================================================
drop function if exists public.election_day_list_non_voting_reasons();

create function public.election_day_list_non_voting_reasons()
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer,
  requires_follow_up boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  select r.id, r.name, r.description, r.is_active, r.sort_order, r.requires_follow_up
  from public.election_day_not_voting_reasons r
  order by r.sort_order asc, r.created_at asc;
$$;

comment on function public.election_day_list_non_voting_reasons() is
  'Dynamic Non-Voting Reasons: lists the full catalog (active and inactive) ordered by sort_order, including requires_follow_up.';

revoke all on function public.election_day_list_non_voting_reasons() from public;
grant execute on function public.election_day_list_non_voting_reasons() to anon, authenticated;

-- ============================================================================
-- election_day_create_non_voting_reason - Postgres identifies functions by
-- name+arg-types, so adding a parameter requires dropping the old 2-arg
-- signature before creating the new 3-arg one.
-- ============================================================================
drop function if exists public.election_day_create_non_voting_reason(text, text);

create function public.election_day_create_non_voting_reason(
  p_name text, p_description text, p_requires_follow_up boolean default true
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer,
  requires_follow_up boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_next_sort integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);
  perform public.election_day_validate_non_voting_reason_input(p_name);

  select coalesce(max(r.sort_order), -1) + 1 into v_next_sort
  from public.election_day_not_voting_reasons r;

  insert into public.election_day_not_voting_reasons (name, description, sort_order, requires_follow_up)
  values (btrim(p_name), coalesce(p_description, ''), v_next_sort, coalesce(p_requires_follow_up, true))
  returning public.election_day_not_voting_reasons.id into v_id;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order, r.requires_follow_up
    from public.election_day_not_voting_reasons r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_non_voting_reason(text, text, boolean) is
  'Dynamic Non-Voting Reasons: creates a new reason, appended to the end of the sort order, with an explicit requires_follow_up (defaults to true - the fail-safe direction).';

revoke all on function public.election_day_create_non_voting_reason(text, text, boolean) from public;
grant execute on function public.election_day_create_non_voting_reason(text, text, boolean) to anon, authenticated;

-- ============================================================================
-- election_day_update_non_voting_reason - same drop+recreate pattern.
-- is_active/sort_order remain never writable through this RPC.
-- ============================================================================
drop function if exists public.election_day_update_non_voting_reason(uuid, text, text);

create function public.election_day_update_non_voting_reason(
  p_id uuid, p_name text, p_description text, p_requires_follow_up boolean
)
returns table (
  id uuid, name text, description text, is_active boolean, sort_order integer,
  requires_follow_up boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);

  if not exists (select 1 from public.election_day_not_voting_reasons r where r.id = p_id) then
    raise exception 'REASON_NOT_FOUND';
  end if;
  perform public.election_day_validate_non_voting_reason_input(p_name);

  update public.election_day_not_voting_reasons as r
  set name = btrim(p_name),
      description = coalesce(p_description, ''),
      requires_follow_up = coalesce(p_requires_follow_up, true)
  where r.id = p_id;

  return query
    select r.id, r.name, r.description, r.is_active, r.sort_order, r.requires_follow_up
    from public.election_day_not_voting_reasons r
    where r.id = p_id;
end;
$$;

comment on function public.election_day_update_non_voting_reason(uuid, text, text, boolean) is
  'Dynamic Non-Voting Reasons: edits an existing reason''s name/description/requires_follow_up. is_active/sort_order are never writable through this RPC.';

revoke all on function public.election_day_update_non_voting_reason(uuid, text, text, boolean) from public;
grant execute on function public.election_day_update_non_voting_reason(uuid, text, text, boolean) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_update_non_voting_reason(uuid, text, text, boolean);
--   drop function if exists public.election_day_create_non_voting_reason(text, text, boolean);
--   drop function if exists public.election_day_list_non_voting_reasons();
--
--   create function public.election_day_update_non_voting_reason(
--     p_id uuid, p_name text, p_description text
--   )
--   returns table (
--     id uuid, name text, description text, is_active boolean, sort_order integer
--   )
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   begin
--     perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);
--     if not exists (select 1 from public.election_day_not_voting_reasons r where r.id = p_id) then
--       raise exception 'REASON_NOT_FOUND';
--     end if;
--     perform public.election_day_validate_non_voting_reason_input(p_name);
--     update public.election_day_not_voting_reasons as r
--     set name = btrim(p_name), description = coalesce(p_description, '')
--     where r.id = p_id;
--     return query
--       select r.id, r.name, r.description, r.is_active, r.sort_order
--       from public.election_day_not_voting_reasons r
--       where r.id = p_id;
--   end;
--   $$;
--   revoke all on function public.election_day_update_non_voting_reason(uuid, text, text) from public;
--   grant execute on function public.election_day_update_non_voting_reason(uuid, text, text) to anon, authenticated;
--
--   create function public.election_day_create_non_voting_reason(
--     p_name text, p_description text
--   )
--   returns table (
--     id uuid, name text, description text, is_active boolean, sort_order integer
--   )
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     v_id uuid;
--     v_next_sort integer;
--   begin
--     perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint);
--     perform public.election_day_validate_non_voting_reason_input(p_name);
--     select coalesce(max(r.sort_order), -1) + 1 into v_next_sort
--     from public.election_day_not_voting_reasons r;
--     insert into public.election_day_not_voting_reasons (name, description, sort_order)
--     values (btrim(p_name), coalesce(p_description, ''), v_next_sort)
--     returning public.election_day_not_voting_reasons.id into v_id;
--     return query
--       select r.id, r.name, r.description, r.is_active, r.sort_order
--       from public.election_day_not_voting_reasons r
--       where r.id = v_id;
--   end;
--   $$;
--   revoke all on function public.election_day_create_non_voting_reason(text, text) from public;
--   grant execute on function public.election_day_create_non_voting_reason(text, text) to anon, authenticated;
--
--   create function public.election_day_list_non_voting_reasons()
--   returns table (
--     id uuid, name text, description text, is_active boolean, sort_order integer
--   )
--   language sql
--   security definer
--   set search_path = ''
--   stable
--   as $$
--     select r.id, r.name, r.description, r.is_active, r.sort_order
--     from public.election_day_not_voting_reasons r
--     order by r.sort_order asc, r.created_at asc;
--   $$;
--   revoke all on function public.election_day_list_non_voting_reasons() from public;
--   grant execute on function public.election_day_list_non_voting_reasons() to anon, authenticated;
--
--   alter table public.election_day_not_voting_reasons drop column requires_follow_up;
--   commit;
-- ============================================================================
