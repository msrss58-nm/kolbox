import { useMemo, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useSearchParams } from "react-router";
import { AuthBrandLayout } from "../../components/AuthBrandLayout";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { looksLikeEmail, resolveEntryRealm } from "../../app/entryRealm";
import { AUTH_ENTRY_TEXT } from "./authEntry.constants";
import { brokerLogin } from "./authBrokerClient";
import { AuthContinueForm, type PendingHandoff } from "./AuthContinueScreen";

const text = AUTH_ENTRY_TEXT;

/**
 * THE single KOLBOX credential form, served only by the dedicated auth origin.
 *
 * Credentials are entered exactly ONCE here, for every principal. The realm
 * CLASS is resolved from the user's own input with zero network calls
 * (`resolveEntryRealm`); which of the three owner realms an email belongs to
 * is decided by the server AFTER authentication, using no password - never
 * before, because a pre-authentication lookup would be an account-enumeration
 * oracle.
 *
 * On success the broker returns a one-time handoff code, held HERE in React
 * state only - never in the URL, storage, or a cookie - and submitted by a
 * cross-origin form POST (`AuthContinueForm`), so no secret ever touches an
 * address bar, history entry or access log.
 */
export function AuthEntryScreen() {
  const [searchParams] = useSearchParams();
  // A workspace link (`?w=CODE`) supplies the code before the identifier is
  // typed, so the worker rule fires first and the email heuristic is never
  // consulted for that path.
  const codeFromLink = (searchParams.get("w") ?? "").trim();
  const isCodeFromLink = codeFromLink.length > 0;

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [staffMode, setStaffMode] = useState(isCodeFromLink);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingHandoff | null>(null);

  const workspaceCode = isCodeFromLink ? codeFromLink : manualCode;
  const realm = useMemo(
    () => resolveEntryRealm({ identifier, workspaceCode, staffMode }),
    [identifier, workspaceCode, staffMode],
  );

  // The code field is shown when a link supplied one, when the user asked for
  // staff entry, or when what they typed is not email-shaped (so a worker is
  // never stranded). Hiding it also clears it, so a stale code can never
  // re-route a later submit.
  const showCodeField =
    isCodeFromLink || staffMode || (identifier !== "" && !looksLikeEmail(identifier));

  const toggleStaff = () => {
    setStaffMode((on) => {
      if (on) setManualCode("");
      return !on;
    });
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Unreachable while the button is disabled - kept as the last guard so a
    // programmatic submit still sends nothing.
    if (realm === "incomplete") return;
    setError(null);
    setSubmitting(true);
    // EXACTLY ONE credential-bearing request, to EXACTLY ONE realm. A failure
    // is reported, never retried against the other realm.
    const result = await brokerLogin({
      identifier,
      password,
      workspaceCode: realm === "worker" ? workspaceCode : "",
    });
    setSubmitting(false);
    if (result.status === "network") {
      setError(text.networkFailure);
      return;
    }
    if (result.status === "failed") {
      setError(text.genericFailure);
      return;
    }
    // Held in memory only, then posted cross-origin as a form field.
    setPending({ code: result.code, targetOrigin: result.targetOrigin });
  };

  if (pending) return <AuthContinueForm handoff={pending} />;

  return (
    <AuthBrandLayout>
      <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{text.title}</h2>
          <p className="text-sm text-slate-500">{text.subtitle}</p>
        </div>

        <Field label={text.identifierLabel}>
          <Input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            name="kb-identifier"
            autoComplete="username"
            dir="ltr"
            autoFocus
            required
          />
        </Field>

        {showCodeField && (
          <Field label={text.workspaceCodeLabel}>
            <Input
              value={workspaceCode}
              onChange={(e) => setManualCode(e.target.value)}
              readOnly={isCodeFromLink}
              dir="ltr"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              name="kb-workspace-code"
              spellCheck={false}
              maxLength={16}
              aria-describedby="kb-ws-code-hint"
              className={
                isCodeFromLink
                  ? "bg-slate-50 uppercase tracking-widest text-slate-600"
                  : "uppercase tracking-widest"
              }
            />
            <p id="kb-ws-code-hint" className="mt-1 text-xs text-slate-400">
              {isCodeFromLink ? text.workspaceCodeFromLinkHint : text.workspaceCodeHint}
            </p>
          </Field>
        )}

        <Field label={text.passwordLabel} error={error ?? undefined}>
          <div className="flex gap-2">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
              invalid={!!error}
              className="flex-1"
              autoComplete="current-password"
              name="kb-current-password"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? text.hidePassword : text.showPassword}
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          className="w-full"
          disabled={realm === "incomplete" || !password}
        >
          {text.submit}
        </Button>

        {!isCodeFromLink && (
          <div className="text-center">
            <button
              type="button"
              onClick={toggleStaff}
              className="text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              {staffMode ? text.staffToggleOff : text.staffToggle}
            </button>
          </div>
        )}
      </form>
    </AuthBrandLayout>
  );
}
