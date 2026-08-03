/** Excel/CSV often stores a phone-looking column as a number, silently
 * dropping the leading 0 the Israeli dialing convention requires (e.g.
 * "0501234567" round-trips through a spreadsheet as 501234567), or keeps it
 * formatted with dashes/spaces/parens (e.g. "050-123-4567"). Always returns a
 * clean, digits-only number - restoring the leading zero when the digit
 * count matches a 9-digit mobile/landline number missing exactly that. */
export function normalizeIsraeliPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 9 && !digits.startsWith("0") ? `0${digits}` : digits;
}

/** Digits-only tel: href - keeps a leading `+` if present, strips everything else. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/(?!^\+)[^\d]/g, "")}`;
}

/** Converts a local Israeli phone number (e.g. "050-1234567") to the E.164
 * digits wa.me expects (e.g. "972501234567"). Leaves already-international
 * numbers (no leading 0) untouched. */
export function toWhatsAppDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? `972${digits.slice(1)}` : digits;
}

export function whatsAppHref(phone: string, message: string): string {
  return `https://wa.me/${toWhatsAppDigits(phone)}?text=${encodeURIComponent(message)}`;
}

/** Opens WhatsApp with a pre-filled message but no target contact - the user
 * picks who to send it to from within WhatsApp itself (e.g. choosing a
 * driver by name from their own contacts/chats). */
export function whatsAppShareHref(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}
