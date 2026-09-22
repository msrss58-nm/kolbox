import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { moduleLabel } from "../../constants/labels";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  PLATFORM_OWNER_TEXT,
  platformApproveOwnerError,
} from "./platform-owner.constants";
import { OneTimeLinkBox } from "./OneTimeLinkBox";
import { OwnerLoginDetailsActions } from "./OwnerLoginDetailsActions";
import { isValidIsraeliPhone, normalizeIsraeliPhone } from "../../lib/phone";
import {
  createOwnerAccess,
  type CreatedOwnerAccess,
  type ModuleCatalogEntry,
} from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.approveOwner;
const C = PLATFORM_OWNER_TEXT.console;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Stage 3B approval, as a dialog opened from the Owners section.
 *
 * The activation link is a one-time credential: it lives in this component's
 * state only while the success panel is on screen. The dialog is mounted only
 * while open, so closing it discards the link - it is never persisted, cached
 * or sent anywhere else. `onChanged` refetches the approvals list after every
 * outcome that may have changed the server's state.
 *
 * Stage 9: the Platform Owner must choose the new workspace's modules
 * explicitly - nothing is pre-selected, at least one is required, and the
 * server validates the choice against its own catalog (`catalog`).
 */
export function OwnerApprovalDialog({
  onChanged,
  onClose,
  catalog,
  catalogError,
}: {
  onChanged: () => void;
  onClose: () => void;
  catalog: ModuleCatalogEntry[];
  catalogError: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [usernameSuggestion, setUsernameSuggestion] = useState<string | null>(null);
  const [modules, setModules] = useState<Set<string>>(() => new Set());
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOwnerAccess | null>(null);
  /** Exactly what was APPROVED, captured at success. The form inputs are
   * still on screen behind this panel and could be edited; the message must
   * describe the approval that actually happened, not whatever is currently
   * typed. Component memory only - never persisted or logged. */
  const [approved, setApproved] = useState<{
    name: string;
    email: string;
    phone: string;
    username: string;
  } | null>(null);

  const reset = () => {
    setCreated(null);
    setApproved(null);
    setName("");
    setEmail("");
    setPhone("");
    setModules(new Set());
    setError(null);
  };

  const toggleModule = (key: string) => {
    setModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (approving) return;
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !EMAIL_RE.test(trimmedEmail)) {
      setError(text.missingFields);
      return;
    }
    // REQUIRED now: the login details are handed over by WhatsApp, and there
    // is nowhere to send them without a number. Normalized first, so the
    // value that is validated is the value that gets stored and dialled.
    const normalizedPhone = normalizeIsraeliPhone(phone);
    if (!isValidIsraeliPhone(normalizedPhone)) {
      setError(text.missingPhone);
      return;
    }
    if (modules.size === 0) {
      setError(text.modulesRequired);
      return;
    }
    // Checked AFTER modules so the pre-existing validation precedence is
    // unchanged for every caller that predates the login username.
    if (username.trim() === "") {
      setError(C.approvalUsernameRequired);
      return;
    }

    setApproving(true);
    try {
      const { data } = await platformOwnerAuthClient.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setError(platformApproveOwnerError("UNAUTHORIZED"));
        return;
      }
      const result = await createOwnerAccess(accessToken, {
        name: trimmedName,
        email: trimmedEmail,
        phone: normalizedPhone,
        modules: [...modules],
        username: username.trim(),
      });
      if (result.status !== "ok") {
        // A taken login username is a decision, not a dead end: offer the
        // next free name inline instead of a generic approval failure.
        if (result.code === "USERNAME_TAKEN") {
          setError(C.approvalUsernameTaken);
          setUsernameSuggestion(result.suggestion ?? null);
          return;
        }
        const base = platformApproveOwnerError(result.code);
        setError(
          result.orphanedAuthUserId
            ? `${base} ${text.orphanWarning(result.orphanedAuthUserId)}`
            : base,
        );
        onChanged();
        return;
      }
      setApproved({
        name: trimmedName,
        email: trimmedEmail,
        phone: normalizedPhone,
        username: username.trim(),
      });
      setCreated(result.access);
      onChanged();
    } finally {
      setApproving(false);
    }
  };

  return (
    <Modal open wide title={text.title} onClose={approving ? () => {} : onClose}>
      {!created && (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p className="text-sm text-slate-600">{text.subtitle}</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={text.nameLabel}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                autoComplete="off"
                required
                autoFocus
              />
            </Field>

            <Field label={text.emailLabel}>
              <Input
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
                autoComplete="off"
                required
              />
            </Field>
          </div>

          <Field label={C.approvalUsernameLabel}>
            <Input
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameSuggestion(null);
              }}
              name="owner-approval-username"
              autoComplete="off"
              aria-describedby="kb-approval-username-hint"
            />
            <p id="kb-approval-username-hint" className="mt-1 text-xs text-slate-400">
              {C.approvalUsernameHint}
            </p>
            {usernameSuggestion && (
              <div className="mt-2 space-y-2">
                <p className="text-xs text-slate-600">
                  {C.approvalUsernameSuggestion(usernameSuggestion)}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setUsername(usernameSuggestion);
                    setUsernameSuggestion(null);
                    setError(null);
                  }}
                >
                  {C.approvalUsernameUseSuggestion}
                </Button>
              </div>
            )}
          </Field>

          <Field label={text.phoneLabel}>
            <Input
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              autoComplete="off"
              name="approve-owner-phone"
              required
              aria-describedby="kb-approve-phone-hint"
            />
            <p id="kb-approve-phone-hint" className="mt-1 text-xs text-slate-400">
              {text.phoneHint}
            </p>
          </Field>

          <fieldset className="space-y-2" data-testid="approval-modules">
            <legend className="text-sm font-semibold text-slate-700">
              {text.modulesLabel}
            </legend>
            <p className="text-xs text-slate-500">{text.modulesHint}</p>
            {catalogError ? (
              <p role="alert" className="text-sm text-opponent">
                {text.modulesLoadError}
              </p>
            ) : catalog.length === 0 ? (
              <p className="text-sm text-slate-500">{text.modulesLoading}</p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-3">
                {catalog.map((m) => (
                  <label
                    key={m.key}
                    className="flex min-h-11 items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200"
                  >
                    <input
                      type="checkbox"
                      checked={modules.has(m.key)}
                      onChange={() => toggleModule(m.key)}
                      className="size-4 shrink-0 accent-primary-600"
                    />
                    <span>
                      {moduleLabel(m.key)}
                      {!m.available && (
                        <span className="block text-xs text-slate-400">
                          {text.moduleUnavailable}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-opponent">
              {error}
            </p>
          )}

          <Button type="submit" loading={approving} className="w-full">
            {approving ? text.submitting : text.submit}
          </Button>
        </form>
      )}

      {created && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-slate-800">{text.successTitle}</p>
          {created.alreadyExisted && (
            <p className="text-sm text-slate-600">{text.alreadyExisted}</p>
          )}
          {created.expiresAt && (
            <p className="text-xs text-slate-500">{text.expiresAt(created.expiresAt)}</p>
          )}

          {created.activationLink ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">{text.linkLabel}</p>
              <OneTimeLinkBox link={created.activationLink} />
              <p className="text-xs text-slate-500">{text.linkHint}</p>
              {approved && (
                <OwnerLoginDetailsActions
                  details={{
                    name: approved.name,
                    username: approved.username,
                    activationLink: created.activationLink,
                    expiresAt: created.expiresAt,
                  }}
                  phone={approved.phone}
                  email={approved.email}
                />
              )}
            </div>
          ) : (
            <p role="alert" className="text-sm text-opponent">
              {text.linkMissing}
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={reset}>
              {text.another}
            </Button>
            <Button type="button" size="sm" onClick={onClose}>
              {text.done}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
