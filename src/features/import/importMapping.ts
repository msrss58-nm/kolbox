import { APP_CONFIG } from "../../constants/config";
import { isValidIsraeliId } from "../../lib/israeliId";
import type { ImportRow } from "../../services/api";
import {
  IMPORT_FIELDS,
  type ImportFieldKey,
  type ParsedSheet,
} from "../../services/excel/excel";

export type ColumnMapping = Partial<Record<ImportFieldKey, number>>;

/** Reads one mapped cell as a trimmed string, or `undefined` if unmapped/empty. */
export function readCell(
  row: (string | number | null)[],
  columnIndex: number | undefined,
): string | undefined {
  if (columnIndex === undefined) return undefined;
  const value = row[columnIndex];
  return value === null || value === undefined ? undefined : String(value).trim();
}

export interface MappingPreview {
  valid: number;
  invalid: number;
  sample: (string | number | null)[][];
}

/** Counts how many rows would import cleanly under the current mapping. */
export function previewMapping(
  sheet: ParsedSheet,
  mapping: ColumnMapping,
): MappingPreview {
  let valid = 0;
  let invalid = 0;
  for (const row of sheet.rows) {
    const id = readCell(row, mapping.nationalId)?.padStart(9, "0") ?? "";
    const first = readCell(row, mapping.firstName);
    const last = readCell(row, mapping.lastName);
    if (isValidIsraeliId(id) && first && last) valid++;
    else invalid++;
  }
  return {
    valid,
    invalid,
    sample: sheet.rows.slice(0, APP_CONFIG.importPreviewRowCount),
  };
}

export function isRequiredMapped(mapping: ColumnMapping): boolean {
  return IMPORT_FIELDS.filter((f) => f.required).every(
    (f) => mapping[f.key] !== undefined,
  );
}

/** Converts every sheet row into an `ImportRow` per the current column mapping. */
export function buildImportRows(sheet: ParsedSheet, mapping: ColumnMapping): ImportRow[] {
  return sheet.rows.map((row) => ({
    nationalId: readCell(row, mapping.nationalId) ?? "",
    firstName: readCell(row, mapping.firstName) ?? "",
    lastName: readCell(row, mapping.lastName) ?? "",
    city: readCell(row, mapping.city),
    street: readCell(row, mapping.street),
    houseNumber: Number(readCell(row, mapping.houseNumber)) || undefined,
    phone: readCell(row, mapping.phone),
    birthYear: Number(readCell(row, mapping.birthYear)) || undefined,
  }));
}
