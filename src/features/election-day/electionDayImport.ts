import * as XLSX from "xlsx";
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

/** A house number like "53/3" (entrance/apartment suffix) or "10א" (a
 * building-letter suffix) is a real, common Israeli address format - a
 * blind `Number()` cast turns both into `NaN` and silently zeroes out a
 * real address. Extracts the leading digit run instead, so these still
 * resolve to their real number (53, 10). A source cell Excel itself
 * auto-formatted as a date (a spreadsheet data-entry artifact, not a
 * parsing bug - the original number isn't recoverable from it) is left at
 * 0, same as before this fix. */
function parseHouseNumber(raw: string): number {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return 0;
  const match = raw.match(/\d+/);
  return match ? Number(match[0]) : 0;
}

/** Why a row didn't make it into the imported list. Deliberately does NOT
 * include a "missing phone" or "missing coordinator" reason - a voter
 * without a phone, or without a coordinator (assignment happens afterwards
 * via Coordinator Allocation Management, not at import time), is still a
 * legitimate record and is always imported, never rejected. */
export type ElectionDayImportRejectionReason = "missingName" | "duplicate";

export interface ElectionDayImportRejectedRow {
  row: number; // 1-indexed among the sheet's data rows (header excluded)
  reason: ElectionDayImportRejectionReason;
  firstName: string;
  lastName: string;
  phone: string;
  coordinator: string | null;
}

export interface ElectionDayImportResult {
  totalRows: number;
  imported: NewElectionDayVoter[];
  rejected: ElectionDayImportRejectedRow[];
}

/** Auto-detects the שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי columns and
 * converts every row into a `NewElectionDayVoter`, or records exactly why it
 * was rejected instead. Throws with a user-facing message only if a required
 * column can't be found at all, or the sheet has no data rows whatsoever -
 * a row-level rejection (missing name, or a duplicate) never throws, it's
 * recorded in `rejected` so the caller can report/export it.
 * Street/house number/city/phone/coordinator are optional - the row is still
 * useful (and importable) even without them; a coordinator-less voter is
 * assigned afterwards via Coordinator Allocation Management, not at import
 * time. */
export function parseElectionDaySheet(sheet: ParsedSheet): ElectionDayImportResult {
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

  if (cols.firstName === undefined || cols.lastName === undefined) {
    throw new Error(ELECTION_DAY_TEXT.import.toast.missingColumns);
  }
  if (sheet.rows.length === 0) throw new Error(ELECTION_DAY_TEXT.import.toast.empty);

  const imported: NewElectionDayVoter[] = [];
  const rejected: ElectionDayImportRejectedRow[] = [];
  // Within-batch duplicate detection only - this is a wholesale-replace
  // import (see importElectionDayVoters), not a merge against existing DB
  // rows, so a duplicate can only mean "this exact file lists the same
  // person twice." Keyed on name+phone so two different people who happen
  // to share a name are never treated as duplicates of each other; a row
  // with no phone is never deduped against anything - there's no reliable
  // signal that two same-named, phoneless rows are the same person, and
  // silently dropping a real voter is worse than keeping a rare true dup.
  const seenKeys = new Set<string>();

  sheet.rows.forEach((row, i) => {
    const rowNumber = i + 1;
    const firstName = cell(row, cols.firstName);
    const lastName = cell(row, cols.lastName);
    // Blank cell, or the column doesn't exist in this file at all - both
    // resolve to a real `null`, never an empty string or the literal text
    // "null" (see NewElectionDayVoter.coordinator).
    const coordinator = cell(row, cols.coordinator) || null;
    const phoneDigits = normalizeIsraeliPhone(cell(row, cols.phone));

    if (!firstName || !lastName) {
      rejected.push({
        row: rowNumber,
        reason: "missingName",
        firstName,
        lastName,
        phone: phoneDigits,
        coordinator,
      });
      return;
    }
    if (phoneDigits) {
      const key = `${firstName}|${lastName}|${phoneDigits}`;
      if (seenKeys.has(key)) {
        rejected.push({
          row: rowNumber,
          reason: "duplicate",
          firstName,
          lastName,
          phone: phoneDigits,
          coordinator,
        });
        return;
      }
      seenKeys.add(key);
    }

    imported.push({
      masad: cell(row, cols.masad),
      firstName,
      lastName,
      phone: phoneDigits || null,
      coordinator,
      street: cell(row, cols.street),
      houseNumber: parseHouseNumber(cell(row, cols.houseNumber)),
      city: cell(row, cols.city),
    });
  });

  return { totalRows: sheet.rows.length, imported, rejected };
}

/** Downloads the last import's rejected rows as an .xlsx file, so a manager
 * can see exactly which rows didn't make it in and why, without KolBox
 * needing a whole in-app table/modal for it. */
export function exportRejectedElectionDayRowsToExcel(
  rejected: ElectionDayImportRejectedRow[],
) {
  const reasons = ELECTION_DAY_TEXT.import.summary.reasons;
  const data = rejected.map((r) => ({
    שורה: r.row,
    "שם פרטי": r.firstName,
    "שם משפחה": r.lastName,
    טלפון: r.phone,
    אחראי: r.coordinator,
    "סיבת דחייה": reasons[r.reason],
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "רשומות שנדחו");
  XLSX.writeFile(wb, "kolbox-election-day-rejected.xlsx");
}
