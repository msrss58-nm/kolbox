-- Make `voter_management` available in the Platform Owner's module catalog.
--
-- WHAT CHANGES: exactly one value - public.platform_modules.available for the
-- key 'voter_management', false -> true. Nothing else.
--
-- WHY A MIGRATION AND NOT THE CONSOLE: the audited product path
-- (platform_set_module_availability, Gate 4) refuses this module with
-- MODULE_AVAILABILITY_FIXED, because platform_modules.availability_switchable
-- is false for it. There is therefore no product path to this value at all, and
-- a migration is the only way to set it - exactly as it was seeded in
-- 20260916000000.
--
-- WHY availability_switchable IS NOT CHANGED HERE - and why that is a real open
-- question rather than a settled one. Gate 4's rule is that only a module whose
-- runtime actually honours the flag is switchable, and it recorded
-- voter_management as fixed on the grounds that a switch 'would change nothing
-- at runtime'. That reasoning is now out of date: the ELECTION OWNER's session
-- does honour the flag (see the principal section below), so a switch here
-- would change that surface in both directions. By that rule the module now
-- qualifies. It is still left fixed by this migration, deliberately, for two
-- reasons: it is beyond the one value this change needs, and flipping it would
-- invalidate the retained assertions that voter_management answers
-- MODULE_AVAILABILITY_FIXED (scripts/platform/api-module-availability.mjs B5,
-- ui-module-availability.mjs P5), which is a decision of its own and not a side
-- effect to slip in here. The consequence to accept knowingly: while
-- availability_switchable stays false, the ONLY way to undo this value is
-- another migration and a deploy - there is no console kill switch for it. The
-- follow-up stage that gives Voter Management a server-side runtime should add
-- its voter_management_workspace_entitled(uuid) predicate (available AND
-- entitlement, mirroring budget_workspace_entitled), report the key from
-- election_day_workspace_worker_modules, and set availability_switchable then.
--
-- WHAT IT DOES CHANGE FOR A PRINCIPAL - READ THIS BEFORE APPLYING. This flag
-- is NOT cosmetic, because the two principals compute their effective modules
-- from different places:
--   * WORKER (PermissionUser): unaffected. Its module list comes from
--     election_day_workspace_worker_modules, which is untouched here and still
--     reports only 'election_day' and 'budget'. No worker session can carry
--     'voter_management', so VoterManagementGuard keeps failing closed for it.
--   * ELECTION OWNER: AFFECTED. resolveOwnerSessionUser (electionDaySession.ts)
--     builds the Owner's modules as `enabled && available` over the rows of
--     election_day_list_workspace_modules_owner_v3, which selects pm.available
--     straight from this catalog. So for every workspace that
--     ALREADY holds a voter_management entitlement row, this migration makes
--     the key appear in that Owner's session the moment it is applied -
--     VoterManagementGuard then passes, and ElectionDayShell / BudgetShell
--     render the Voter Management nav group. AT THE TIME OF WRITING BOTH
--     PRODUCTION WORKSPACES HOLD THAT ROW, so applying this to Production
--     opens '/', '/voters', '/activists' and '/import' to both Election
--     Owners. Those screens are still per-browser MockApi/localStorage with no
--     server surface to authorize - nothing shared leaks, but an unfinished
--     module becomes reachable. This is the intended product step; it is
--     recorded here so it can never be mistaken for a display-only change.
--
-- WHAT THIS DOES NOT DO:
--   * It does not create, change or remove a single election_workspace_modules
--     row. No workspace gains or loses an entitlement, and no workspace is
--     granted voter_management by this migration.
--   * It does not touch election_day_workspace_worker_modules, any route, any
--     screen, any permission or any business logic.
--   * It does not write platform_module_availability_audit. That table records
--     what platform_set_module_availability did, and this is not that function;
--     inventing a row there would name an acting Platform Owner who took no
--     action. The migration itself is the record, as it was for the seed.
--   * It changes no function, grant, policy, trigger or permission.
--
-- WHAT IT AFFECTS, PRECISELY: platform_modules.available is read in exactly
-- four places - budget_workspace_entitled (keyed to 'budget'),
-- platform_list_workspace_modules (the Platform Owner's own read),
-- platform_set_module_availability (the previous value) and
-- election_day_list_workspace_modules_owner_v3 (the Election Owner's read,
-- which is the one with a behavioural consequence above). Assignment never
-- consulted it: election_day_normalize_modules validates a chosen module only
-- against the catalog's keys, so voter_management was already assignable at
-- approval and in the entitlement editor - this flag never gated assignment and
-- does not begin to now. What changes is what the flag itself reports: the
-- Platform Owner's module management stops labelling voter_management "not yet
-- available", and every Election Owner already holding the entitlement row
-- starts being offered it.
--
-- MANUAL ROLLBACK:
--   begin;
--   update public.platform_modules set available = false where key = 'voter_management';
--   commit;

begin;

update public.platform_modules
set available = true
where key = 'voter_management';

-- A silent no-op here would leave the catalog unchanged while the migration
-- reported success (a renamed or missing key), so prove the row was hit.
do $$
begin
  if not exists (
    select 1 from public.platform_modules
    where key = 'voter_management' and available
  ) then
    raise exception 'VOTER_MANAGEMENT_CATALOG_ROW_MISSING';
  end if;
end;
$$;

-- The table comment defined only what available=false means, which implied
-- that true meant "is a workspace-scoped server module". voter_management is
-- now the documented case where it does not.
comment on table public.platform_modules is
  'Stage 9: the product-module catalog. available is the platform-wide offer flag: false = the module is recorded and assignable but not offered; true = the platform offers it wherever it is entitled. It is read by platform_list_workspace_modules, by platform_set_module_availability, by a module''s own entitlement predicate where it has one (budget_workspace_entitled) and by election_day_list_workspace_modules_owner_v3 - so for an ELECTION OWNER, available AND the entitlement row already decide which module surfaces they are offered. A WORKER''s access needs more than this flag: the module must also be reported by election_day_workspace_worker_modules, which today names only election_day and budget - so voter_management is available and Owner-reachable while still having no worker runtime. Assignability never depended on this flag (election_day_normalize_modules validates keys only). Adding a module is one INSERT here.';

commit;
