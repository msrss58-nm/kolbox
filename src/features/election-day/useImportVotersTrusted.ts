import { useCallback, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import { parseSpreadsheet, parseJsonFile } from "../../services/excel/excel";
import { parseElectionDaySheet, type ElectionDayImportResult } from "./electionDayImport";
import type { ElectionDayReauthDialogProps } from "./useElectionDayReauth";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  importVotersTrusted,
  reauthForImportVoters,
  type TrustedImportResult,
  type TrustedReauthResult,
} from "./electionDayTrustedVoterFileClient";

const errors = ELECTION_DAY_TEXT.reauth.trustedVoterFileErrors;

export interface ImportVotersSummary extends ElectionDayImportResult {
  count: number;
}

interface PendingImport {
  file: File;
  resolve: (value: ImportVotersSummary | undefined) => void;
}

function reauthErrorMessage(
  status: Exclude<TrustedReauthResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.wrongPassword;
    case "rate_limited":
      return errors.rateLimited;
    default:
      return errors.generic;
  }
}

function importErrorMessage(
  status: Exclude<TrustedImportResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.sessionExpired;
    case "forbidden":
      return errors.forbidden;
    case "allocation_activity_started":
      return errors.allocationActivityStarted;
    default:
      return errors.generic;
  }
}

/**
 * Phase 3 Import/Clear frontend cutover: dedicated trusted import-voters
 * flow, cut over from the legacy general-purpose reauth-proof gate
 * (`useElectionDayReauth.ts`) to the trusted, session-derived, one-time-
 * consumed v3 path (`electionDayTrustedVoterFileClient.ts`). Deliberately
 * independent of `useElectionDayReauth`/`electionDayReauthProof.ts` - its
 * own `pending`/`busy` state, its own dialog instance - so the v3 proof
 * this flow mints can never enter the legacy 15-minute cache shared by the
 * remaining `_v2` reauth-gated actions. Mirrors
 * `useCreatePermissionUserTrusted.ts`'s pattern exactly.
 *
 * File parsing (`parseSpreadsheet`/`parseJsonFile`/`parseElectionDaySheet`)
 * is completely unchanged from the legacy flow - same functions, same
 * rejected-row/total-row computation - only the destination the parsed
 * `imported` array is POSTed to, and the proof that authorizes the call,
 * have changed.
 *
 * The raw v3 proof exists only as a local `const` inside `onConfirm`'s one
 * continuous async flow (mint -> immediately consume -> function returns) -
 * never stored in any `useState`/`useRef`/store/persistence layer, never
 * logged. Nothing to clean up on logout: it cannot outlive one in-flight
 * call.
 */
export function useImportVotersTrusted() {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const hasPendingRef = useRef(false);

  /** Opens the dedicated password dialog for `file` and resolves once the
   * whole flow concludes: the import summary on success, `undefined` on
   * cancel or on a failure the user doesn't retry. A second call while a
   * flow is already open is a safe no-op. */
  const importVoters = useCallback(
    (file: File): Promise<ImportVotersSummary | undefined> => {
      if (hasPendingRef.current) {
        return Promise.resolve(undefined);
      }
      hasPendingRef.current = true;
      return new Promise((resolve) => {
        setPending({ file, resolve });
      });
    },
    [],
  );

  const onConfirm = useCallback(
    async (password: string): Promise<unknown> => {
      if (!pending || inFlightRef.current) return undefined;
      inFlightRef.current = true;
      setBusy(true);
      try {
        const reauthResult = await reauthForImportVoters(password);
        if (reauthResult.status !== "ok") {
          toast.error(reauthErrorMessage(reauthResult.status));
          return undefined;
        }
        // Local variable only, for this one call - see this hook's own
        // doc comment.
        const proof = reauthResult.proof;

        let parsed: ElectionDayImportResult;
        try {
          const sheet = pending.file.name.toLowerCase().endsWith(".json")
            ? await parseJsonFile(pending.file)
            : await parseSpreadsheet(pending.file);
          parsed = parseElectionDaySheet(sheet);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          return undefined;
        }

        const importResult = await importVotersTrusted(parsed.imported, proof);
        if (importResult.status !== "ok") {
          toast.error(importErrorMessage(importResult.status));
          return undefined;
        }
        toast.success(
          ELECTION_DAY_TEXT.import.toast.loaded(
            importResult.count,
            parsed.totalRows,
            parsed.rejected.length,
          ),
        );
        const summary: ImportVotersSummary = { ...parsed, count: importResult.count };
        pending.resolve(summary);
        setPending(null);
        hasPendingRef.current = false;
        return summary;
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [pending],
  );

  /** Once a reauth/import request has actually started (`inFlightRef`),
   * Cancel is a safe no-op rather than resolving the caller as "cancelled" -
   * see `useCreatePermissionUserTrusted.ts`'s own onCancel doc comment for
   * the exact failure mode this prevents (identical reasoning). */
  const onCancel = useCallback(() => {
    if (inFlightRef.current) return;
    if (pending) pending.resolve(undefined);
    setPending(null);
    hasPendingRef.current = false;
  }, [pending]);

  const reauthDialog: ElectionDayReauthDialogProps | null = pending
    ? {
        open: true,
        title: ELECTION_DAY_TEXT.reauth.dialogTitle,
        summary: ELECTION_DAY_TEXT.reauth.dialogs.importVoters,
        confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { importVoters, reauthDialog, busy };
}
