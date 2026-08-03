import { useCallback, useState } from "react";
import { toast } from "../components/ui/Toast";
import { COMMON_TEXT } from "../constants/common-text";

interface UseAsyncActionOptions<Args extends unknown[], R> {
  /** Shown via toast on success - a string, or built from the result/args. */
  successMessage?: string | ((result: R, ...args: Args) => string);
  /** Fallback toast text when the thrown error has no message. */
  errorMessage?: string;
}

export interface UseAsyncActionResult<Args extends unknown[], R> {
  run: (...args: Args) => Promise<R | undefined>;
  busy: boolean;
}

const DEFAULT_ERROR_MESSAGE = COMMON_TEXT.genericError;

/** A failed `fetch()` (offline, DNS failure, connection dropped mid-request)
 * throws a raw, English, browser-internal message ("Failed to fetch" in
 * Chromium, "NetworkError when attempting to fetch resource" in Firefox).
 * Supabase-js doesn't preserve this as a real `TypeError` by the time it
 * reaches here - it re-throws a plain `Error` whose `.message` is the
 * *stringified* original error (literally `"TypeError: Failed to fetch"` as
 * text), so this matches on message content rather than the error's actual
 * class. Showing that raw text verbatim to a Hebrew-speaking user isn't a
 * clear error message, so it's swapped for a friendly one. */
function isNetworkFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|load failed/i.test(message);
}

/**
 * Wraps an async mutation (classify, save, import…) with a `busy` flag and
 * automatic success/error toasts - replaces the repeated
 * `setBusy(true) → try/catch/finally → toast` block in every form/action.
 *
 * @example
 * const { run: classify, busy } = useAsyncAction(
 *   (voterId: string, c: Classification) => api.classifyVoter(voterId, c, activistId),
 *   { successMessage: "הסיווג נשמר" },
 * );
 */
export function useAsyncAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R>,
  options: UseAsyncActionOptions<Args, R> = {},
): UseAsyncActionResult<Args, R> {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (...args: Args): Promise<R | undefined> => {
      setBusy(true);
      try {
        const result = await action(...args);
        if (options.successMessage) {
          toast.success(
            typeof options.successMessage === "function"
              ? options.successMessage(result, ...args)
              : options.successMessage,
          );
        }
        return result;
      } catch (err) {
        if (isNetworkFailure(err)) {
          toast.error(COMMON_TEXT.networkError);
        } else if (err instanceof Error && err.message) {
          toast.error(err.message);
        } else {
          toast.error(options.errorMessage ?? DEFAULT_ERROR_MESSAGE);
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    // options is typically an inline literal; only `action`'s identity matters for correctness
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action],
  );

  return { run, busy };
}
