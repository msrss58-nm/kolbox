const TAG_SEPARATOR = " | ";

function parseTags(notes: string): string[] {
  return notes
    .split(TAG_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Appends a short status tag (e.g. "נדרש הסעה") to the free-text notes
 * field without disturbing whatever the user already typed there - mirrors
 * how the reference app appended reminder notes with " | ". A no-op if the
 * tag is already present, so re-triggering the same action doesn't duplicate it. */
export function addNoteTag(notes: string, tag: string): string {
  const parts = parseTags(notes);
  if (parts.includes(tag)) return notes;
  return [...parts, tag].join(TAG_SEPARATOR);
}

/** Removes a previously-added tag, leaving the rest of the notes intact
 * regardless of where the tag sits among them. */
export function removeNoteTag(notes: string, tag: string): string {
  return parseTags(notes)
    .filter((part) => part !== tag)
    .join(TAG_SEPARATOR);
}

/** Whether a given tag was previously added to the notes field. */
export function hasNoteTag(notes: string, tag: string): boolean {
  return parseTags(notes).includes(tag);
}
