/**
 * Budget money helpers. Every Budget amount is an integer number of agorot
 * (1 ILS = 100 agorot) - on the wire, in state and in the database. These
 * helpers are the only place a shekel string is turned into agorot, and they
 * do it with string arithmetic, never floating-point multiplication, so
 * "0.29" is exactly 29 agorot.
 */

const MAX_AGOROT = 1_000_000_000_000; // the database's per-row cap

const formatter = new Intl.NumberFormat("he-IL", {
  style: "currency",
  currency: "ILS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** 150000 -> "‏1,500 ₪" (agorot shown only when non-zero). */
export function formatAgorot(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined) return "—";
  const whole = Math.trunc(agorot / 100);
  const frac = Math.abs(agorot % 100);
  // Build the decimal string from integers, then let Intl format it.
  return formatter.format(Number(`${whole}.${String(frac).padStart(2, "0")}`));
}

/** User input ("1,500", "1500.5", "₪ 1,500.25") -> agorot, or null if the
 * value is not a non-negative amount with at most two decimal places. */
export function parseShekelInput(raw: string): number | null {
  const s = raw.replace(/[\s,₪]/g, "");
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const agorot = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return agorot <= MAX_AGOROT ? agorot : null;
}

/** Signed variant for adjustments ("-500", "+1,200.50"). */
export function parseSignedShekelInput(raw: string): number | null {
  const s = raw.trim();
  const negative = s.startsWith("-");
  const value = parseShekelInput(s.replace(/^[+-]/, ""));
  if (value === null) return null;
  return negative ? -value : value;
}

/** agorot -> a plain editable string ("1500" / "1500.25"). */
export function agorotToInput(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined) return "";
  const whole = Math.trunc(agorot / 100);
  const frac = Math.abs(agorot % 100);
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}
