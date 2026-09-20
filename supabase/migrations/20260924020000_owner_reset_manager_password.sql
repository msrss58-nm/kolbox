-- ===========================================================================
-- KOLBOX unified identity - the Owner may reset ANY of their users' passwords,
-- Manager roles included.
--
-- WHY THIS REVERSES A STAGE 9 DECISION, DELIBERATELY.
-- Stage 9 (20260916000000) added election_day_roles.is_manager and made
-- election_day_reset_permission_user_password_owner_v3 refuse a target whose
-- role carries it (CANNOT_RESET_MANAGER), documenting "delete and recreate
-- instead" as the sanctioned workaround.
--
-- The unified identity model requires the opposite: a Manager /
-- PermissionUser has a username and a password and NO e-mail, so their Owner
-- is the only party who can ever restore their access. Under the old rule a
-- locked-out Manager could only be recovered by DELETING the account and
-- building a new one - which destroys the user's identity, their directory
-- username and their audit continuity, to avoid a reset the Owner was
-- already fully entitled to perform.
--
-- The refusal also bought no security. The same Owner, holding the same
-- Owner JWT and the same one-time Owner proof, can already call
-- election_day_delete_permission_user_owner_v3 on that Manager and recreate
-- them with a password of the Owner's choosing. The restriction therefore
-- blocked nothing an Owner could not already achieve by a strictly MORE
-- destructive route, and the Election Owner is unconditionally superior to
-- every worker role in their workspace, so there is no privilege escalation
-- to prevent.
--
-- WHAT IS NOT CHANGED. is_manager itself stays - it is still the flag the
-- role editor sets and still means "this is a Manager role". Only the reset
-- refusal is removed. Every other guarantee of the function is untouched:
-- the Owner proof is still verified and consumed, the target is still
-- re-resolved live and treated as nonexistent outside the Owner's own
-- workspace (same-workspace only), the row is still locked, and the target's
-- outstanding sessions and reauth proofs are still destroyed by the reset.
-- ===========================================================================

-- ROLLBACK: re-apply the Stage 9 body of
-- election_day_reset_permission_user_password_owner_v3 from
-- 20260916000000_platform_stage9_owner_admin_entitlements.sql, which restores
-- the CANNOT_RESET_MANAGER refusal. Nothing else here changes, and is_manager
-- is untouched by this migration either way.

begin;

create or replace function public.election_day_reset_permission_user_password_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner_id uuid;
  v_workspace_id uuid;
  v_target_workspace_id uuid;
  v_owner_name text;
begin
  select v.owner_id, v.workspace_id into v_owner_id, v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'reset_permission_user_password'
  ) v;

  -- The row is still locked. The role join and its share lock are gone with
  -- the Manager decision they existed to make race-free.
  select u.workspace_id
    into v_target_workspace_id
  from public.election_day_permission_users u
  where u.id = p_target_user_id
  for update;

  -- Same-workspace only: a target outside the Owner's workspace is treated as
  -- nonexistent, never as "forbidden", so this is not a cross-tenant probe.
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_workspace_id
  then
    raise exception 'USER_NOT_FOUND';
  end if;

  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  select o.name into v_owner_name from public.election_owners o where o.id = v_owner_id;

  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_owner_name
  where public.election_day_permission_users.id = p_target_user_id;

  -- Unchanged: no outstanding proof or session of the target outlives a reset.
  delete from public.election_day_reauth_proofs where actor_id = p_target_user_id;
  delete from public.election_day_sessions where permission_user_id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$fn$;

comment on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) is
  'Election Owner password reset for any PermissionUser in their OWN workspace, Manager roles included. The Stage 9 CANNOT_RESET_MANAGER refusal was removed deliberately: a Manager has no e-mail and no self-service recovery, so their Owner is the only possible recovery path, and the same Owner could already delete and recreate that Manager - a strictly more destructive route to the same authority. Owner proof still verified and consumed; target still same-workspace only; target sessions and proofs still destroyed.';

revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from public;
revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from anon;
revoke all on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) from authenticated;
grant execute on function public.election_day_reset_permission_user_password_owner_v3(uuid, bytea, uuid, text) to service_role;

commit;
