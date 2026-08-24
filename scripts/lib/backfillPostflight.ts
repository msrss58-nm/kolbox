/**
 * Multi-Tenant Phase 2 - historical Backfill post-flight verification.
 *
 * Entirely read-only SQL via the same `SqlQueryOne` contract as
 * backfillPreflight.ts - including "does the Auth user exist", checked
 * directly against `auth.users` rather than the Admin API, so this module
 * (and the CLI wrapper built on it) needs no service_role key / JS client
 * at all. Compares every count against the RECEIPT's own fresh pre-flight
 * baseline for this exact run - never a figure from any other run or any
 * prior planning document.
 */
import type { RpcAclFacts, SqlQueryOne } from "./backfillPreflight";

export interface PostflightExpectation {
  workspaceName: string;
  electionEndAtIso: string;
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string;
  authUserId: string;
  tableBaseline: Record<string, number>;
  expectedRpcAcl: RpcAclFacts;
}

export interface PostflightResult {
  ok: boolean;
  problems: string[];
}

const RPC_FUNCTION_NAME = "election_day_backfill_historical_workspace";

export async function runPostflightVerification(
  sqlQueryOne: SqlQueryOne,
  expectation: PostflightExpectation,
): Promise<PostflightResult> {
  const problems: string[] = [];

  const workspace = await sqlQueryOne<{
    snapshot: {
      count: number;
      id: string | null;
      name: string | null;
      electionEndAtRaw: string | null;
    };
  }>(`
    select jsonb_build_object(
      'count', (select count(*) from election_workspaces),
      'id', (select id::text from election_workspaces limit 1),
      'name', (select name from election_workspaces limit 1),
      'electionEndAtRaw', (select election_end_at::text from election_workspaces limit 1)
    ) as snapshot
  `).then((r) => r.snapshot);

  if (workspace.count !== 1) {
    problems.push(
      `Expected exactly 1 election_workspaces row, found ${workspace.count}.`,
    );
  } else {
    if (workspace.name !== expectation.workspaceName)
      problems.push(
        `Workspace name mismatch: expected "${expectation.workspaceName}", found "${workspace.name}".`,
      );
    const actualIso = workspace.electionEndAtRaw
      ? new Date(workspace.electionEndAtRaw).toISOString()
      : null;
    if (actualIso !== expectation.electionEndAtIso)
      problems.push(
        `election_end_at mismatch: expected "${expectation.electionEndAtIso}", found "${actualIso}".`,
      );
  }
  const workspaceId = workspace.id;

  const owner = await sqlQueryOne<{
    snapshot: {
      count: number;
      name: string | null;
      phone: string | null;
      email: string | null;
      authUserId: string | null;
    };
  }>(`
    select jsonb_build_object(
      'count', (select count(*) from election_owners),
      'name', (select name from election_owners limit 1),
      'phone', (select phone from election_owners limit 1),
      'email', (select email from election_owners limit 1),
      'authUserId', (select auth_user_id::text from election_owners limit 1)
    ) as snapshot
  `).then((r) => r.snapshot);

  if (owner.count !== 1) {
    problems.push(`Expected exactly 1 election_owners row, found ${owner.count}.`);
  } else {
    if (owner.name !== expectation.ownerName)
      problems.push(
        `Owner name mismatch: expected "${expectation.ownerName}", found "${owner.name}".`,
      );
    if (owner.phone !== expectation.ownerPhone)
      problems.push(
        `Owner phone mismatch: expected "${expectation.ownerPhone}", found "${owner.phone}".`,
      );
    if (owner.email !== expectation.ownerEmail)
      problems.push(
        `Owner email mismatch: expected "${expectation.ownerEmail}", found "${owner.email}".`,
      );
    if (owner.authUserId !== expectation.authUserId)
      problems.push(
        `Owner auth_user_id mismatch: expected "${expectation.authUserId}", found "${owner.authUserId}" (receipt).`,
      );
  }

  const authUser = await sqlQueryOne<{ snapshot: number }>(
    `select (select count(*) from auth.users where id = '${expectation.authUserId}') as snapshot`,
  ).then((r) => r.snapshot);
  if (authUser !== 1)
    problems.push(
      `Expected the receipt's authUserId to exist exactly once in auth.users, found ${authUser}.`,
    );

  for (const [table, expectedTotal] of Object.entries(expectation.tableBaseline)) {
    const row = await sqlQueryOne<{
      snapshot: { total: number; nonNull: number; wrongWorkspace: number };
    }>(`
      select jsonb_build_object(
        'total', count(*),
        'nonNull', count(*) filter (where workspace_id is not null),
        'wrongWorkspace', count(*) filter (where workspace_id is not null and workspace_id <> '${workspaceId}')
      ) as snapshot from ${table}
    `).then((r) => r.snapshot);
    if (row.total !== expectedTotal)
      problems.push(
        `${table}: row count changed - receipt baseline ${expectedTotal}, now ${row.total}.`,
      );
    if (row.nonNull !== row.total)
      problems.push(
        `${table}: ${row.total - row.nonNull} row(s) still have workspace_id IS NULL.`,
      );
    if (row.wrongWorkspace !== 0)
      problems.push(
        `${table}: ${row.wrongWorkspace} row(s) point at a workspace other than the one historical workspace.`,
      );
  }

  const settings = await sqlQueryOne<{
    snapshot: { rowCount: number; idTrue: number; workspaceId: string | null };
  }>(`
    select jsonb_build_object(
      'rowCount', (select count(*) from election_day_settings),
      'idTrue', (select count(*) from election_day_settings where id = true),
      'workspaceId', (select workspace_id::text from election_day_settings limit 1)
    ) as snapshot
  `).then((r) => r.snapshot);
  if (settings.rowCount !== 1 || settings.idTrue !== 1)
    problems.push(
      `election_day_settings structure changed unexpectedly (rowCount=${settings.rowCount}, idTrue=${settings.idTrue}).`,
    );
  if (settings.workspaceId !== workspaceId)
    problems.push(
      `election_day_settings.workspace_id ("${settings.workspaceId}") does not match the created workspace ("${workspaceId}").`,
    );

  const rpcAcl = await sqlQueryOne<{
    snapshot: {
      overloadCount: number;
      securityDefiner: boolean | null;
      searchPathEmpty: boolean | null;
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
      'proacl', (select proacl::text from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'serviceRoleExecute', (select has_function_privilege('service_role', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'anonExecute', (select has_function_privilege('anon', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1),
      'authenticatedExecute', (select has_function_privilege('authenticated', oid, 'EXECUTE') from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1)
    ) as snapshot
  `).then((r) => r.snapshot);
  if (rpcAcl.overloadCount !== expectation.expectedRpcAcl.overloadCount)
    problems.push(
      `RPC overload count changed since pre-flight: ${expectation.expectedRpcAcl.overloadCount} -> ${rpcAcl.overloadCount}.`,
    );
  if ((rpcAcl.securityDefiner === true) !== expectation.expectedRpcAcl.securityDefiner)
    problems.push(`RPC SECURITY DEFINER state changed since pre-flight.`);
  if ((rpcAcl.searchPathEmpty === true) !== expectation.expectedRpcAcl.searchPathEmpty)
    problems.push(`RPC search_path state changed since pre-flight.`);
  if (rpcAcl.proacl !== expectation.expectedRpcAcl.proacl)
    problems.push(
      `RPC proacl changed since pre-flight: "${expectation.expectedRpcAcl.proacl}" -> "${rpcAcl.proacl}".`,
    );
  if (
    (rpcAcl.serviceRoleExecute === true) !==
    expectation.expectedRpcAcl.serviceRoleExecute
  )
    problems.push(`RPC service_role EXECUTE state changed since pre-flight.`);
  if (rpcAcl.anonExecute === true)
    problems.push(
      `RPC anon EXECUTE is true - PRIVILEGE ESCALATION, regardless of pre-flight state.`,
    );
  if (rpcAcl.authenticatedExecute === true)
    problems.push(
      `RPC authenticated EXECUTE is true - PRIVILEGE ESCALATION, regardless of pre-flight state.`,
    );

  const ownerColumns = await sqlQueryOne<{ snapshot: string[] }>(`
    select jsonb_agg(column_name) as snapshot from information_schema.columns where table_schema = 'public' and table_name = 'election_owners'
  `).then((r) => r.snapshot);
  if (ownerColumns.some((c) => /password/i.test(c)))
    problems.push(
      `election_owners has a password-shaped column: ${ownerColumns.filter((c) => /password/i.test(c)).join(", ")}.`,
    );

  return { ok: problems.length === 0, problems };
}
