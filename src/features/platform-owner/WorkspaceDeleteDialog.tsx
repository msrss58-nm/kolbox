import { useState, type FormEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  PLATFORM_OWNER_TEXT,
  platformDeleteWorkspaceError,
} from "./platform-owner.constants";
import { deleteWorkspace } from "./platformOwnerClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.deleteWorkspace;

/** Whitespace-insensitive only: internal runs collapse and the ends are
 * trimmed. Exactly what the DATABASE does, so a name this dialog accepts is a
 * name the server accepts - and nothing looser than that. */
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");

function WarningList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-bold text-slate-500">{title}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm text-slate-600">
            <span aria-hidden="true" className="text-slate-300">
              •
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Permanent deletion of one election system.
 *
 * Deliberately its own dialog rather than a shared confirm: this is the only
 * irreversible action in the console, and it has to say - in full - what goes
 * and what survives, then make the operator type the system's own name. The
 * button stays disabled until they do, so there is no single click anywhere
 * that deletes a live election system.
 *
 * The typed name is NOT the security boundary; it is the deliberate-intent
 * boundary. The real one is `platform_delete_election_workspace`, which
 * compares the same name server-side, re-resolves the Platform Owner in the
 * deleting transaction, and refuses outright when the Budget delete guard says
 * the system still needs a verified export. This component never sees or sends
 * an Owner id, a module, or anything but the workspace id and that name.
 *
 * `onDeleted` is called only after the server confirmed the deletion. The
 * workspace is gone by then, which is why the failure branch below never
 * renders "try again" for anything but a refusal that left it intact.
 */
export function WorkspaceDeleteDialog({
  workspaceId,
  workspaceName,
  onClose,
  onDeleted,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  /** Reports the server's own outcome so the caller can reload and say what
   * happened - including the one partial case, where the system is deleted but
   * the Owner's Auth account could not be confirmed removed. */
  onDeleted: (result: { name: string; authCleanupIncomplete: boolean }) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = normalize(typed) === normalize(workspaceName);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !matches) return;
    setError(null);
    setBusy(true);
    try {
      const { data: s } = await platformOwnerAuthClient.auth.getSession();
      const token = s.session?.access_token;
      if (!token) {
        void usePlatformOwnerSession.getState().refreshStatus();
        return;
      }
      // The workspace's OWN name is sent, not the typed string: the operator
      // proved intent, and a collapsed-whitespace variant of the real name is
      // not what should end up in an immutable deletion record.
      const res = await deleteWorkspace(token, workspaceId, workspaceName);
      if (res.status === "unauthorized") {
        void usePlatformOwnerSession.getState().refreshStatus();
        return;
      }
      if (res.status === "error") {
        setError(platformDeleteWorkspaceError(res.code));
        return;
      }
      onDeleted({
        name: res.data.name,
        authCleanupIncomplete: res.data.authCleanupIncomplete,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={text.title(workspaceName)}>
      <form className="space-y-4" onSubmit={submit} data-testid="delete-workspace-form">
        <div className="flex gap-2 rounded-lg bg-opponent-soft p-3 text-opponent">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-sm font-bold">{text.warningTitle}</p>
        </div>

        <WarningList title={text.advancedHint} items={text.warningItems} />
        <WarningList title={text.keptTitle} items={text.keptItems} />

        <Field label={text.confirmLabel(workspaceName)}>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={text.confirmPlaceholder}
            autoComplete="off"
            data-testid="delete-workspace-confirm"
          />
        </Field>
        {/* Only once they have started typing: an untouched field is not a
            mistake to point out. */}
        {typed !== "" && !matches && (
          <p className="text-xs text-opponent">{text.confirmMismatch}</p>
        )}
        {error && (
          <p className="text-sm text-opponent" data-testid="delete-workspace-error">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="submit"
            variant="danger"
            className="sm:flex-1"
            disabled={!matches || busy}
            loading={busy}
            data-testid="delete-workspace-submit"
          >
            {busy ? text.submitting : text.submit}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {text.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
