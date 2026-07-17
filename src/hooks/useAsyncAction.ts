import { useCallback, useState } from "react";
import { toast } from "../components/ui/Toast";

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

const DEFAULT_ERROR_MESSAGE = "אירעה שגיאה, נסו שוב";

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
        toast.error(err instanceof Error ? err.message : DEFAULT_ERROR_MESSAGE);
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
