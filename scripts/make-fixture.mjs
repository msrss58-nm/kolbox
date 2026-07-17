// Generates scripts/fixtures/import-test.xlsx - 6 valid rows, 2 invalid.
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import { mkdirSync } from "node:fs";

XLSX.set_fs(fs);

function checkDigit(first8) {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(first8[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
const validId = (n) => {
  const first8 = String(n).padStart(8, "0");
  return first8 + checkDigit(first8);
};

const rows = [
  ["תעודת זהות", "שם פרטי", "שם משפחה", "עיר", "רחוב", "מס' בית", "טלפון", "שנת לידה"],
  [validId(71000001), "עדן", "לוינסון", "אשקלון", "הרצל", 5, "050-1112233", 1990],
  [validId(71000002), "אורן", "לוינסון", "אשקלון", "הרצל", 5, "052-2223344", 1988],
  [validId(71000003), "שקד", "בר-און", "חיפה", "ביאליק", 12, "053-3334455", 1995],
  [validId(71000004), "נועה", "בר-און", "חיפה", "ביאליק", 12, "", 1997],
  [validId(71000005), "אריאל", "פישמן", "ירושלים", "הנשיא", 3, "054-5556677", 1972],
  [validId(71000006), "תבור", "פישמן", "ירושלים", "הנשיא", 3, "058-6667788", 1975],
  ["123456789", "פסול", "צ'קסאם", "אשדוד", "", 1, "", 2000], // bad checksum
  [validId(71000007), "", "בלי-שם", "אשדוד", "", 1, "", 2000], // missing first name
];

mkdirSync("scripts/fixtures", { recursive: true });
const ws = XLSX.utils.aoa_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "בוחרים");
XLSX.writeFile(wb, "scripts/fixtures/import-test.xlsx");
console.log("fixture written: scripts/fixtures/import-test.xlsx (6 valid, 2 invalid)");
