/** Israeli national ID (ת"ז) checksum - standard Luhn-variant with 1,2,1,2… weights. */

export function israeliIdCheckDigit(first8: string): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let d = Number(first8[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidIsraeliId(id: string): boolean {
  const padded = id.trim().padStart(9, "0");
  if (!/^\d{9}$/.test(padded)) return false;
  return israeliIdCheckDigit(padded.slice(0, 8)) === Number(padded[8]);
}
