import { cn } from "../../lib/utils";

/**
 * A machine value (UUID, email, one-time URL, login code) pinned to LTR inside
 * this RTL document.
 *
 * Without the explicit direction an LTR run gets its punctuation reordered and
 * becomes unreadable - and a mis-rendered UUID is exactly the thing an
 * operator is about to confirm a permanent deletion against. `break-all` stops
 * a 36-character id or a long link from forcing a horizontal scrollbar at
 * 360px, and `select-all` makes manual copying one click, which is the
 * fallback whenever the clipboard API is unavailable.
 */
export function LtrValue({
  value,
  className,
  mono = true,
}: {
  value: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      dir="ltr"
      className={cn(
        "block text-start break-all select-all",
        mono && "font-mono",
        className,
      )}
    >
      {value}
    </span>
  );
}
