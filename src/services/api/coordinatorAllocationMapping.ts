import type { AllocationAssignment, CoordinatorAction } from "./types";

/** Coordinator Allocation Management Phase 3: the 4 allocation RPCs
 * (election_day_manage_coordinators / apply_initial_allocation /
 * rebalance_assignments / end_coordinator_activity) raise the same kind of
 * small, stable English error codes as the role/reason RPCs - translated
 * here, once, mirroring `mapRoleRpcErrorMessage` exactly. UNAUTHORIZED/
 * FORBIDDEN come from these RPCs' own real server-side actor
 * re-authentication + permission check (same shape as
 * `election_day_reset_permission_user_password`), never a UI-level guard
 * alone. Every code here is copied verbatim from the committed migrations
 * (`20260813100000_election_day_manage_coordinators_rpc.sql`,
 * `20260813100100_election_day_coordinator_allocation_rpcs.sql`) - never
 * invented. An unrecognized code falls through to the raw message, same
 * fail-safe as every other mapper in this codebase.
 *
 * Deliberately extracted into its own dependency-free module (this file
 * imports nothing but this API layer's own plain domain types) rather than
 * living inline in `supabaseElectionDayApi.ts` - that file transitively
 * imports the real Supabase client (`../supabase/client`), which reads
 * `import.meta.env` and crashes when bundled for plain Node execution, so a
 * function defined inline there could never be imported directly by a Node
 * smoke test (only re-implemented/pinned there, which risks silently
 * drifting from the real logic). This module has no such dependency, so
 * `scripts/smoke-coordinator-allocation.ts` imports these exact functions -
 * the real implementation, not a copy. */
export function mapCoordinatorAllocationRpcErrorMessage(message: string): string {
  if (message.includes("UNAUTHORIZED")) {
    return "הסיסמה שהזנת אינה נכונה";
  }
  if (message.includes("FORBIDDEN")) {
    return "אין לך הרשאה לבצע פעולה זו";
  }
  if (message.includes("NO_ACTIONS")) {
    return "לא נשלחו פעולות לביצוע";
  }
  if (message.includes("INVALID_COORDINATOR_NAME")) {
    return "יש להזין שם תקין לרכז";
  }
  if (message.includes("COORDINATOR_NOT_FOUND")) {
    return "הרכז לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("DISPLAY_NAME_LOCKED")) {
    return "לא ניתן לשנות את שם הרכז לאחר שהחלה פעילות הקצאות";
  }
  if (message.includes("ASSIGNMENT_ALREADY_LINKED")) {
    return "המחרוזת המקושרת כבר משויכת לרכז אחר";
  }
  if (message.includes("COORDINATOR_LOCKED")) {
    return "לא ניתן לבצע פעולה זו על רכז שכבר השתתף בפעילות הקצאות";
  }
  if (message.includes("COORDINATOR_NAME_COLLISION")) {
    return "השם מתנגש עם רכז אחר קיים";
  }
  if (message.includes("INVALID_LINK")) {
    return "נתוני הקישור אינם תקינים";
  }
  if (message.includes("INVALID_ACTION")) {
    return "פעולה לא מוכרת";
  }
  if (message.includes("INVALID_ASSIGNMENT_SHAPE")) {
    return "נתוני ההקצאה אינם תקינים";
  }
  if (message.includes("NEGATIVE_QUANTITY")) {
    return "לא ניתן להזין כמות שלילית";
  }
  if (message.includes("NON_POSITIVE_QUANTITY")) {
    return "יש להזין כמות גדולה מאפס";
  }
  if (
    message.includes("DUPLICATE_COORDINATOR_IN_ASSIGNMENTS") ||
    message.includes("DUPLICATE_COORDINATOR_IN_SOURCES") ||
    message.includes("DUPLICATE_COORDINATOR_IN_DESTINATIONS")
  ) {
    return "לא ניתן לבחור אותו רכז יותר מפעם אחת";
  }
  if (message.includes("NO_MEANINGFUL_ASSIGNMENT")) {
    return "יש להזין הקצאה בפועל לפחות לרכז אחד";
  }
  if (message.includes("COORDINATOR_NOT_ACTIVE")) {
    return "לא ניתן להקצות לרכז שאינו פעיל";
  }
  if (message.includes("NO_UNASSIGNED_VOTERS")) {
    return "אין בוחרים לא-מוקצים כרגע";
  }
  if (message.includes("ALLOCATION_COUNT_MISMATCH")) {
    return "כמות ההקצאה אינה תואמת את מספר הבוחרים הלא-מוקצים בפועל - רעננו ונסו שוב";
  }
  if (message.includes("SOURCE_DESTINATION_OVERLAP")) {
    return "לא ניתן לבחור אותו רכז גם כמקור וגם כיעד";
  }
  if (message.includes("REBALANCE_SUM_MISMATCH")) {
    return "סכום הכמויות במקור וביעד אינו תואם";
  }
  if (message.includes("REBALANCE_SOURCE_INSUFFICIENT")) {
    return "אין מספיק בוחרים זמינים אצל הרכז המקור - רעננו ונסו שוב";
  }
  if (message.includes("INVALID_MODE")) {
    return "סוג הפעולה אינו תקין";
  }
  if (message.includes("INVALID_TARGET")) {
    return "יש לבחור רכז יעד תקין, שאינו הרכז המסיים עצמו";
  }
  if (message.includes("TARGET_NOT_FOUND")) {
    return "רכז היעד לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("TARGET_NOT_ACTIVE")) {
    return "רכז היעד אינו פעיל";
  }
  if (message.includes("LAST_ACTIVE_COORDINATOR")) {
    return "לא ניתן לסיים את פעילות הרכז האחרון הפעיל כל עוד יש לו בוחרים שנותרו לטיפול";
  }
  return message;
}

/** Exact camelCase -> snake_case/jsonb shape `election_day_manage_coordinators`
 * expects for one element of its `p_actions` array. `undefined` fields
 * become explicit `null` (never omitted) - the RPC's own `nullif(x->>'…',
 * '')` handling treats a present-but-empty/absent key uniformly either way,
 * but sending an explicit `null` is the clearer, deliberate contract here. */
export function toCoordinatorActionPayload(a: CoordinatorAction): {
  action: string;
  coordinator_id: string | null;
  display_name: string | null;
  linked_assignment_name: string | null;
} {
  return {
    action: a.action,
    coordinator_id: a.coordinatorId ?? null,
    display_name: a.displayName ?? null,
    linked_assignment_name: a.linkedAssignmentName ?? null,
  };
}

/** Exact camelCase -> snake_case shape for one `{coordinator, quantity}`
 * pair - shared by `election_day_apply_initial_allocation`'s
 * `p_assignments` and `election_day_rebalance_assignments`'
 * `p_sources`/`p_destinations`. */
export function toAllocationAssignmentPayload(a: AllocationAssignment): {
  coordinator_id: string;
  quantity: number;
} {
  return { coordinator_id: a.coordinatorId, quantity: a.quantity };
}
