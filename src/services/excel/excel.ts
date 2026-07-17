import * as XLSX from "xlsx";
import { CLASSIFICATION_LABELS } from "../../constants/labels";
import type { ElectionDayVoter, Voter } from "../../types";

export interface ParsedSheet {
  headers: string[];
  rows: (string | number | null)[][];
}

/** Fields a spreadsheet column can map to. */
export const IMPORT_FIELDS = [
  { key: "nationalId", label: "תעודת זהות", required: true },
  { key: "firstName", label: "שם פרטי", required: true },
  { key: "lastName", label: "שם משפחה", required: true },
  { key: "city", label: "עיר", required: false },
  { key: "street", label: "רחוב", required: false },
  { key: "houseNumber", label: "מס' בית", required: false },
  { key: "phone", label: "טלפון", required: false },
  { key: "birthYear", label: "שנת לידה", required: false },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]["key"];

/** Header-name patterns for auto-detecting the column mapping. */
const AUTO_DETECT: Record<ImportFieldKey, RegExp> = {
  nationalId: /ת["״'.]?ז|תעודת|זהות|national|^id$/i,
  firstName: /פרטי|first/i,
  lastName: /משפחה|last/i,
  city: /עיר|ישוב|יישוב|city/i,
  street: /רחוב|כתובת|street|address/i,
  houseNumber: /בית|מספר בית|house/i,
  phone: /טלפון|נייד|פלאפון|phone|mobile/i,
  birthYear: /לידה|שנת|birth|year/i,
};

export function autoDetectMapping(
  headers: string[],
): Partial<Record<ImportFieldKey, number>> {
  const mapping: Partial<Record<ImportFieldKey, number>> = {};
  for (const { key } of IMPORT_FIELDS) {
    const idx = headers.findIndex((h) => AUTO_DETECT[key].test(h));
    if (idx !== -1 && !Object.values(mapping).includes(idx)) mapping[key] = idx;
  }
  return mapping;
}

/** Parse the first sheet of an .xlsx/.csv file into headers + rows. */
export async function parseSpreadsheet(file: File): Promise<ParsedSheet> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("הקובץ ריק - לא נמצא גיליון");
  const matrix = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: null,
  });
  const [headerRow, ...rows] = matrix;
  if (!headerRow?.length) throw new Error("לא נמצאה שורת כותרות בגיליון");
  return {
    headers: headerRow.map((h) => String(h ?? "")),
    rows: rows.filter((r) => r.some((c) => c !== null && String(c).trim() !== "")),
  };
}

/** Parse a JSON file: array of objects → headers from keys. */
export async function parseJsonFile(file: File): Promise<ParsedSheet> {
  const text = await file.text();
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "object")
    throw new Error("קובץ ה-JSON חייב להכיל מערך של רשומות");
  const records = data as Record<string, unknown>[];
  const headers = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return {
    headers,
    rows: records.map((r) =>
      headers.map((h) => {
        const v = r[h];
        return v === undefined || v === null ? null : ((v as string | number) ?? null);
      }),
    ),
  };
}

/** Download the current registry as an .xlsx file. */
export function exportVotersToExcel(voters: Voter[]) {
  const data = voters.map((v) => ({
    'ת"ז': v.nationalId,
    "שם פרטי": v.firstName,
    "שם משפחה": v.lastName,
    עיר: v.city,
    רחוב: v.street,
    "מס' בית": v.houseNumber,
    טלפון: v.phone ?? "",
    "שנת לידה": v.birthYear,
    סיווג: CLASSIFICATION_LABELS[v.classification],
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "פנקס בוחרים");
  XLSX.writeFile(wb, "kolbox-voters.xlsx");
}

/** Download the election-day ride-coordination list as a voting report. */
export function exportElectionDayVotersToExcel(contacts: ElectionDayVoter[]) {
  const data = contacts.map((c) => ({
    מסד: c.masad,
    "שם פרטי": c.firstName,
    "שם משפחה": c.lastName,
    עיר: c.city,
    רחוב: c.street,
    "מס' בית": c.houseNumber,
    טלפון: c.phone,
    אחראי: c.coordinator,
    הערות: c.notes,
    "הסעה תואמה": c.rideArranged ? "כן" : "לא",
    הצביע: c.voted ? "כן" : "לא",
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "דוח הצבעות");
  XLSX.writeFile(wb, "kolbox-voting-report.xlsx");
}

/** Download an empty import template with the expected headers. */
export function downloadTemplate() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['ת"ז', "שם פרטי", "שם משפחה", "עיר", "רחוב", "מס' בית", "טלפון", "שנת לידה"],
    ["123456782", "ישראל", "ישראלי", "אשקלון", "הרצל", 12, "050-1234567", 1985],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "תבנית");
  XLSX.writeFile(wb, "kolbox-template.xlsx");
}
