/**
 * Shared reconciliation-snapshot reader for Production, used by both the
 * production runner (reconciling inline after an observed RPC error) and
 * the recovery tool (reconciling a receipt's `authUserId` after a process
 * death). Written once so the query text and UUID validation can't drift
 * between the two callers.
 */
import type { ReconciliationSnapshot } from "./historicalBackfillOrchestration";
import type { SqlQueryOne } from "./backfillPreflight";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeReconciliationSnapshotReader(sqlQueryOne: SqlQueryOne) {
  return async function readReconciliationSnapshot(
    authUserId: string,
  ): Promise<ReconciliationSnapshot> {
    if (!UUID_RE.test(authUserId)) {
      throw new Error(
        `readReconciliationSnapshot: refusing a non-UUID-shaped authUserId "${authUserId}"`,
      );
    }
    const row = await sqlQueryOne<{
      snapshot: {
        workspaceCount: number;
        electionOwnerLinked: boolean;
        electionOwnerWorkspaceName: string | null;
        electionOwnerWorkspaceElectionEndAtRaw: string | null;
        pendingOwnerAccessLinked: boolean;
        platformOwnerLinked: boolean;
        multiEntityOwnerLinked: boolean;
      };
    }>(`
      select jsonb_build_object(
        'workspaceCount', (select count(*) from election_workspaces),
        'electionOwnerLinked', exists(select 1 from election_owners where auth_user_id = '${authUserId}'),
        'electionOwnerWorkspaceName', (select ew.name from election_owners eo join election_workspaces ew on ew.id = eo.workspace_id where eo.auth_user_id = '${authUserId}'),
        'electionOwnerWorkspaceElectionEndAtRaw', (select ew.election_end_at::text from election_owners eo join election_workspaces ew on ew.id = eo.workspace_id where eo.auth_user_id = '${authUserId}'),
        'pendingOwnerAccessLinked', exists(select 1 from election_workspace_pending_owner_access where auth_user_id = '${authUserId}'),
        'platformOwnerLinked', exists(select 1 from platform_owners where auth_user_id = '${authUserId}'),
        'multiEntityOwnerLinked', exists(select 1 from multi_entity_owner where auth_user_id = '${authUserId}')
      ) as snapshot
    `);
    const s = row.snapshot;
    return {
      workspaceCount: s.workspaceCount,
      electionOwnerLinked: s.electionOwnerLinked,
      electionOwnerWorkspaceName: s.electionOwnerWorkspaceName,
      electionOwnerWorkspaceElectionEndAtIso: s.electionOwnerWorkspaceElectionEndAtRaw
        ? new Date(s.electionOwnerWorkspaceElectionEndAtRaw).toISOString()
        : null,
      pendingOwnerAccessLinked: s.pendingOwnerAccessLinked,
      platformOwnerLinked: s.platformOwnerLinked,
      multiEntityOwnerLinked: s.multiEntityOwnerLinked,
    };
  };
}
