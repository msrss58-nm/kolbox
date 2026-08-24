/**
 * Multi-Tenant Phase 2 - complete historical Backfill pre-flight.
 *
 * Shared between the production runner (via `supabase db query --linked`)
 * and the disposable functional test (via direct `docker exec psql`) - both
 * environments implement the same `SqlQueryOne` contract, so this module
 * itself never touches a DB driver, a connection string, or a credential.
 *
 * Checks, all read-only:
 *  - target-email identity absence across all 5 identity tables
 *  - election_workspaces count == 0
 *  - election_owners total count == 0
 *  - all 12 Phase-1 tables: fresh total row count (the baseline post-flight
 *    later compares against) + non-null workspace_id count == 0
 *  - election_day_settings: exactly one row, id = true, workspace_id IS NULL
 *  - the Backfill RPC's exact ACL/security state (single overload,
 *    SECURITY DEFINER, search_path = '', owner, proacl, service_role/anon/
 *    authenticated EXECUTE)
 *  - migration local/remote sync, if `checkMigrations` is supplied (the
 *    disposable local project has no "linked remote" concept at all, so the
 *    functional test omits it - `migrationsInSync` is `null`, not `false`,
 *    to distinguish "not applicable here" from "checked and found drifted")
 */
export type SqlQueryOne = <T>(sql: string) => Promise<T>;

export interface RpcAclFacts {
  overloadCount: number;
  securityDefiner: boolean;
  searchPathEmpty: boolean;
  owner: string;
  proacl: string;
  serviceRoleExecute: boolean;
  anonExecute: boolean;
  authenticatedExecute: boolean;
}

export interface FullPreflightResult {
  ok: boolean;
  problems: string[];
  tableBaseline: Record<string, number>;
  settingsOk: boolean;
  rpcAcl: RpcAclFacts;
  migrationsInSync: boolean | null;
}

const RPC_FUNCTION_NAME = "election_day_backfill_historical_workspace";
const EXPECTED_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

async function checkRpcAcl(sqlQueryOne: SqlQueryOne): Promise<RpcAclFacts> {
  const row = await sqlQueryOne<{
    snapshot: {
      overloadCount: number;
      securityDefiner: boolean | null;
      searchPathEmpty: boolean | null;
      owner: string | null;
      proacl: string | null;
      serviceRoleExecute: boolean | null;
      anonExecute: boolean | null;
      authenticatedExecute: boolean | null;
    };
  }>(`
    select jsonb_build_object(
      'overloadCount', (select count(*) from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace),
      'securityDefiner', (select prosecdef from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'searchPathEmpty', (select 'search_path=""' = any(coalesce(proconfig, array[]::text[])) from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'owner', (select pg_get_userbyid(proowner) from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'proacl', (select proacl::text from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'serviceRoleExecute', (select has_function_privilege('service_role', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'anonExecute', (select has_function_privilege('anon', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'authenticatedExecute', (select has_function_privilege('authenticated', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1)
    ) as snapshot
  `);
  const s = row.snapshot;
  return {
    overloadCount: s.overloadCount,
    securityDefiner: s.securityDefiner === true,
    searchPathEmpty: s.searchPathEmpty === true,
    owner: s.owner ?? "",
    proacl: s.proacl ?? "",
    serviceRoleExecute: s.serviceRoleExecute === true,
    anonExecute: s.anonExecute === true,
    authenticatedExecute: s.authenticatedExecute === true,
  };
}

export async function runFullPreflight(params: {
  sqlQueryOne: SqlQueryOne;
  ownerEmail: string;
  tables: readonly string[];
  checkMigrations?: () => Promise<boolean | null>;
}): Promise<FullPreflightResult> {
  const { sqlQueryOne, ownerEmail, tables } = params;
  const problems: string[] = [];

  const identity = await sqlQueryOne<{
    snapshot: {
      authUsers: number;
      electionOwners: number;
      pendingOwnerAccess: number;
      platformOwners: number;
      multiEntityOwner: number;
      electionOwnersTotal: number;
    };
  }>(`
    select jsonb_build_object(
      'authUsers', (select count(*) from auth.users where lower(email) = lower('${ownerEmail}')),
      'electionOwners', (select count(*) from election_owners where lower(email) = lower('${ownerEmail}')),
      'pendingOwnerAccess', (select count(*) from election_workspace_pending_owner_access where lower(email) = lower('${ownerEmail}')),
      'platformOwners', (select count(*) from platform_owners where lower(email) = lower('${ownerEmail}')),
      'multiEntityOwner', (select count(*) from multi_entity_owner where lower(email) = lower('${ownerEmail}')),
      'electionOwnersTotal', (select count(*) from election_owners)
    ) as snapshot
  `).then((r) => r.snapshot);

  if (identity.authUsers !== 0)
    problems.push(
      `auth.users already has ${identity.authUsers} row(s) for ${ownerEmail} - target identity is not clean.`,
    );
  if (identity.electionOwners !== 0)
    problems.push(
      `election_owners already has ${identity.electionOwners} row(s) for ${ownerEmail}.`,
    );
  if (identity.pendingOwnerAccess !== 0)
    problems.push(
      `election_workspace_pending_owner_access already has ${identity.pendingOwnerAccess} row(s) for ${ownerEmail} - unexpected for a historical Backfill, requires human clarification before proceeding.`,
    );
  if (identity.platformOwners !== 0)
    problems.push(
      `platform_owners already has ${identity.platformOwners} row(s) for ${ownerEmail}.`,
    );
  if (identity.multiEntityOwner !== 0)
    problems.push(
      `multi_entity_owner already has ${identity.multiEntityOwner} row(s) for ${ownerEmail}.`,
    );
  if (identity.electionOwnersTotal !== 0)
    problems.push(
      `election_owners has ${identity.electionOwnersTotal} row(s) total (expected 0, not just 0 for the target email).`,
    );

  const workspaceCount = await sqlQueryOne<{ snapshot: number }>(
    `select (select count(*) from election_workspaces) as snapshot`,
  ).then((r) => r.snapshot);
  if (workspaceCount !== 0)
    problems.push(
      `election_workspaces already has ${workspaceCount} row(s) - this one-time operation has already run.`,
    );

  const tableBaseline: Record<string, number> = {};
  for (const t of tables) {
    const row = await sqlQueryOne<{ snapshot: { total: number; nonNull: number } }>(`
      select jsonb_build_object('total', count(*), 'nonNull', count(*) filter (where workspace_id is not null)) as snapshot from ${t}
    `).then((r) => r.snapshot);
    tableBaseline[t] = row.total;
    if (row.nonNull !== 0)
      problems.push(
        `${t} already has ${row.nonNull} row(s) with a non-null workspace_id.`,
      );
  }

  const settings = await sqlQueryOne<{
    snapshot: { rowCount: number; idTrue: number; workspaceIdNull: number };
  }>(`
    select jsonb_build_object(
      'rowCount', (select count(*) from election_day_settings),
      'idTrue', (select count(*) from election_day_settings where id = true),
      'workspaceIdNull', (select count(*) from election_day_settings where workspace_id is null)
    ) as snapshot
  `).then((r) => r.snapshot);
  const settingsOk =
    settings.rowCount === 1 && settings.idTrue === 1 && settings.workspaceIdNull === 1;
  if (!settingsOk)
    problems.push(
      `election_day_settings is not in the expected shape (rowCount=${settings.rowCount}, idTrue=${settings.idTrue}, workspaceIdNull=${settings.workspaceIdNull}, expected 1/1/1).`,
    );

  const rpcAcl = await checkRpcAcl(sqlQueryOne);
  if (rpcAcl.overloadCount !== 1)
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected exactly 1 overload, found ${rpcAcl.overloadCount}.`,
    );
  if (!rpcAcl.securityDefiner)
    problems.push(`RPC ${RPC_FUNCTION_NAME}: expected SECURITY DEFINER, is not.`);
  if (!rpcAcl.searchPathEmpty)
    problems.push(`RPC ${RPC_FUNCTION_NAME}: expected search_path = '', is not.`);
  if (rpcAcl.owner !== "postgres")
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected owner "postgres", found "${rpcAcl.owner}".`,
    );
  if (rpcAcl.proacl !== EXPECTED_PROACL)
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected proacl "${EXPECTED_PROACL}", found "${rpcAcl.proacl}".`,
    );
  if (!rpcAcl.serviceRoleExecute)
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected service_role EXECUTE = true, is false.`,
    );
  if (rpcAcl.anonExecute)
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected anon EXECUTE = false, is true - PRIVILEGE ESCALATION RISK.`,
    );
  if (rpcAcl.authenticatedExecute)
    problems.push(
      `RPC ${RPC_FUNCTION_NAME}: expected authenticated EXECUTE = false, is true - PRIVILEGE ESCALATION RISK.`,
    );

  let migrationsInSync: boolean | null = null;
  if (params.checkMigrations) {
    migrationsInSync = await params.checkMigrations();
    if (migrationsInSync === false)
      problems.push("Migration local/remote state is not in sync.");
  }

  return {
    ok: problems.length === 0,
    problems,
    tableBaseline,
    settingsOk,
    rpcAcl,
    migrationsInSync,
  };
}
