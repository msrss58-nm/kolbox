import { normalizeIsraeliPhone } from "../../lib/phone";
import type { NewElectionDayVoter } from "../../services/api";
import type { ParsedSheet } from "../../services/excel/excel";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

type FieldKey =
  | "masad"
  | "firstName"
  | "lastName"
  | "street"
  | "houseNumber"
  | "city"
  | "phone"
  | "coordinator";

const AUTO_DETECT: Record<FieldKey, RegExp> = {
  masad: /מסד|קלפי|registration|polling/i,
  firstName: /שם\s*פרטי|first/i,
  lastName: /שם\s*משפחה|last/i,
  street: /רחוב|street/i,
  houseNumber: /מס['׳]?\s*בית|house/i,
  city: /עיר|ישוב|יישוב|city/i,
  phone: /טלפון|נייד|פלאפון|phone|mobile/i,
  coordinator: /אחראי|coordinator/i,
};

function detectColumn(headers: string[], key: FieldKey): number | undefined {
  const idx = headers.findIndex((h) => AUTO_DETECT[key].test(h));
  return idx === -1 ? undefined : idx;
}

function cell(row: (string | number | null)[], col: number | undefined): string {
  if (col === undefined) return "";
  const v = row[col];
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Auto-detects the שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי columns and
 * converts every row into a `NewElectionDayVoter`. Throws with a user-facing
 * message if a required column can't be found or the sheet has no usable
 * rows. Street/house number/city are optional - the row can still be useful
 * for a phone call even without a full address. */
export function parseElectionDaySheet(sheet: ParsedSheet): NewElectionDayVoter[] {
  const cols = {
    masad: detectColumn(sheet.headers, "masad"),
    firstName: detectColumn(sheet.headers, "firstName"),
    lastName: detectColumn(sheet.headers, "lastName"),
    street: detectColumn(sheet.headers, "street"),
    houseNumber: detectColumn(sheet.headers, "houseNumber"),
    city: detectColumn(sheet.headers, "city"),
    phone: detectColumn(sheet.headers, "phone"),
    coordinator: detectColumn(sheet.headers, "coordinator"),
  };

  if (
    cols.firstName === undefined ||
    cols.lastName === undefined ||
    cols.phone === undefined ||
    cols.coordinator === undefined
  ) {
    throw new Error(ELECTION_DAY_TEXT.import.toast.missingColumns);
  }

  const rows: NewElectionDayVoter[] = [];
  for (const row of sheet.rows) {
    const firstName = cell(row, cols.firstName);
    const lastName = cell(row, cols.lastName);
    const phone = normalizeIsraeliPhone(cell(row, cols.phone));
    const coordinator = cell(row, cols.coordinator);
    if (!firstName || !lastName || !phone || !coordinator) continue;
    rows.push({
      masad: cell(row, cols.masad),
      firstName,
      lastName,
      phone,
      coordinator,
      street: cell(row, cols.street),
      houseNumber: Number(cell(row, cols.houseNumber)) || 0,
      city: cell(row, cols.city),
    });
  }
  if (rows.length === 0) throw new Error(ELECTION_DAY_TEXT.import.toast.empty);
  return rows;
}
