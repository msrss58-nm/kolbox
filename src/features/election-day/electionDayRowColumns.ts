import type { Permission } from "../../permissions/types";

export type ElectionDayColumnKey =
  | "masad"
  | "name"
  | "street"
  | "houseNumber"
  | "city"
  | "phone"
  | "coordinator"
  | "notes"
  | "status";

export interface ElectionDayColumnDef {
  key: ElectionDayColumnKey;
  permission: Permission;
  /** Desktop grid-template-columns track width for this column. */
  width: string;
}

/** Single source of truth for which columns exist in the contact list/row,
 * which permission gates each one, and how wide it is on desktop - shared
 * by `ElectionDayList`'s header and `ElectionDayRow`'s desktop grid (and
 * consulted field-by-field for the mobile card) so the two never drift out
 * of sync. A role's visible columns are `ELECTION_DAY_ROW_COLUMNS.filter(c
 * => can(c.permission))` - a real structural projection (fewer grid
 * tracks), not a CSS visibility trick. */
export const ELECTION_DAY_ROW_COLUMNS: readonly ElectionDayColumnDef[] = [
  { key: "masad", permission: "voter.viewMasad", width: "0.5fr" },
  { key: "name", permission: "voter.viewName", width: "1.1fr" },
  { key: "street", permission: "voter.viewAddress", width: "0.8fr" },
  { key: "houseNumber", permission: "voter.viewAddress", width: "0.5fr" },
  { key: "city", permission: "voter.viewAddress", width: "0.7fr" },
  { key: "phone", permission: "voter.viewPhone", width: "0.9fr" },
  { key: "coordinator", permission: "voter.viewCoordinator", width: "0.8fr" },
  { key: "notes", permission: "voter.viewNotes", width: "1fr" },
  { key: "status", permission: "voter.viewVotedStatus", width: "7rem" },
];
