/**
 * Stage 4B: pure date presentation.
 *
 * Deliberately a .ts module with no component export - the LTR value renderer
 * lives in MultiEntityLtrValue.tsx instead, so neither file mixes a component
 * with a shared helper (react-refresh/only-export-components).
 */

/** `he-IL` date/time, or an em dash when the server sent null. Never throws on
 * an unparseable value - it falls back to the raw string rather than crashing
 * a destructive-action card. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("he-IL");
}
