import type { ElectionDayVoter } from "../../types";

/** trim + lowercase + collapse repeated whitespace - the shared normalization
 * for both a contact's searchable text and the user's query, so the two
 * sides compare on equal footing regardless of stray/doubled spaces. */
function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** One space-joined blob of every field a voter should be findable by.
 * Phone is included twice - as typed (so a query with the same dashes/spaces
 * still matches) and digits-only (so a query without them still matches a
 * differently-formatted stored number). */
function buildContactSearchableText(contact: ElectionDayVoter): string {
  const phone = contact.phone ?? "";
  return normalizeSearchValue(
    [
      contact.firstName,
      contact.lastName,
      contact.city,
      contact.street,
      String(contact.houseNumber),
      contact.coordinator,
      contact.masad,
      phone,
      phone.replace(/\D/g, ""),
    ].join(" "),
  );
}

/** Splits a normalized query into its individual word tokens. */
function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchValue(query);
  return normalized ? normalized.split(" ") : [];
}

/** Order-independent, multi-field, substring "AND" search: every word the
 * user typed must appear somewhere in the contact's combined searchable
 * text, regardless of which field it came from or what order the words were
 * typed in - "נחום משה" and "משה נחום" both match a contact named
 * "משה נחום", and a single word like "מש" matches as a prefix/substring. */
export function matchesElectionDaySearch(
  contact: ElectionDayVoter,
  query: string,
): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;
  const searchableText = buildContactSearchableText(contact);
  return tokens.every((token) => searchableText.includes(token));
}
