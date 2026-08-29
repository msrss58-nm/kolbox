-- Legacy Role Mutation CONTRACT: revoke anon/authenticated EXECUTE from the
-- 4 legacy election_day_*_role_v2 RPCs (create/update/delete/clone), now
-- confirmed to have ZERO live callers anywhere in the deployed application -
-- the frontend Owner Bridge + Owner-only Role Management cutover
-- (commit 8c2fe235, already live in Production) replaced every reachable
-- caller with the Owner-only v3 mutation path (election_day_*_role_owner_v3,
-- 20260828070000), and a direct grep of the deployed browser bundle
-- confirmed the 4 legacy RPC name strings survive only inside
-- SupabaseElectionDayApi's now-unreachable createRole/updateRole/deleteRole/
-- cloneRole methods - useRoleManagement(), their sole caller, has zero call
-- sites anywhere in the app.
--
-- ============================================================================
-- SCOPE: GRANTS-ONLY CONTRACT, not a retirement of the functions themselves.
-- ============================================================================
-- This migration does NOT drop, replace, or alter the body/signature of any
-- of the 4 functions below - they remain fully defined, unchanged, and
-- reachable by postgres/service_role exactly as before. Only anon's and
-- authenticated's EXECUTE privilege is revoked - the same access-narrowing
-- pattern already used for election_day_list_permission_users/_list_roles's
-- own CONTRACT migrations (20260828010000/20260828050000), applied here to
-- the 4 Role MUTATION RPCs specifically. A future, separate, explicitly-
-- approved workstream may DROP these functions outright once this grants-
-- only step has been live in Production for a confirmed observation window -
-- that decision is out of scope for this migration.
--
-- Exact live signatures verified directly against Production immediately
-- before writing this migration (pg_get_function_identity_arguments, not
-- assumed from source):
--   election_day_create_role_v2(p_reauth_proof text, p_name text, p_description text, p_permissions text[], p_scope_type text)
--   election_day_update_role_v2(p_reauth_proof text, p_role_id uuid, p_name text, p_description text, p_permissions text[], p_scope_type text)
--   election_day_delete_role_v2(p_reauth_proof text, p_role_id uuid)
--   election_day_clone_role_v2(p_reauth_proof text, p_role_id uuid, p_new_name text)
--
-- Verified before writing this migration (see the task's own pre-contract
-- gate): zero LIVE frontend callers (useRoleManagement(), the sole caller of
-- api.createRole/updateRole/deleteRole/cloneRole, has zero call sites
-- anywhere in src/); zero Vercel server route (api/election-day/*.ts) calls
-- any of these 4 RPCs; zero other database function's body references any
-- of these 4 by name (a full pg_get_functiondef scan across every function
-- in schema public found none) - a plain EXECUTE revoke is safe with no
-- dependency to break. Owner-only v3 replacements for all 4 mutations are
-- already live and unaffected by this migration. Coordinator/Allocation and
-- Import legacy RPCs, and the shared PermissionUser legacy reauth/verifier
-- infrastructure, are completely untouched by this migration - none of them
-- are named here.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol batching, not an implicit transaction.
begin;

revoke execute on function public.election_day_create_role_v2(text, text, text, text[], text) from anon;
revoke execute on function public.election_day_create_role_v2(text, text, text, text[], text) from authenticated;

revoke execute on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) from anon;
revoke execute on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) from authenticated;

revoke execute on function public.election_day_delete_role_v2(text, uuid) from anon;
revoke execute on function public.election_day_delete_role_v2(text, uuid) from authenticated;

revoke execute on function public.election_day_clone_role_v2(text, uuid, text) from anon;
revoke execute on function public.election_day_clone_role_v2(text, uuid, text) from authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"). Restores the exact pre-CONTRACT grants (anon/authenticated
-- EXECUTE), using the same verified signatures above:
--
--   begin;
--   grant execute on function public.election_day_create_role_v2(text, text, text, text[], text) to anon;
--   grant execute on function public.election_day_create_role_v2(text, text, text, text[], text) to authenticated;
--   grant execute on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) to anon;
--   grant execute on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) to authenticated;
--   grant execute on function public.election_day_delete_role_v2(text, uuid) to anon;
--   grant execute on function public.election_day_delete_role_v2(text, uuid) to authenticated;
--   grant execute on function public.election_day_clone_role_v2(text, uuid, text) to anon;
--   grant execute on function public.election_day_clone_role_v2(text, uuid, text) to authenticated;
--   commit;
-- ============================================================================
