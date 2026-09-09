import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { clearLegacySession, useElectionDaySession } from "./electionDaySession";

const text = ELECTION_DAY_TEXT.session;
const passwordText = ELECTION_DAY_TEXT.permissionsManager;

/** Username+password gate for `/election-day` only - checks against the
 * server-verified roster (`useElectionDaySession`, Phase 3B), not the rest
 * of the app's auth. This route is standalone (not nested under
 * `ElectionDayGuard`), so it runs its own one-time legacy-localStorage
 * cleanup on mount rather than relying on the Guard's `bootstrap()` to
 * always run first - a user who lands here directly and never submits
 * would otherwise never hit that cleanup at all. */
export function ElectionDayLoginScreen() {
  const login = useElectionDaySession((s) => s.login);
  const navigate = useNavigate();

  useEffect(() => {
    clearLegacySession();
  }, []);

  const [searchParams] = useSearchParams();
  // Tenant-Safe Login: the workspace code may arrive in the URL
  // (`/election-day/login?w=<code>`), which is the normal path - the Owner
  // hands out that link. It is DERIVED from the URL rather than copied into
  // state, so there is no state to keep in sync (and no `setState` inside an
  // effect, which this codebase avoids - see CLAUDE.md). `manualCode` is only
  // ever used when the link carried no code at all.
  const codeFromLink = (searchParams.get("w") ?? "").trim();
  const isCodeFromLink = codeFromLink.length > 0;

  const [manualCode, setManualCode] = useState("");
  const workspaceCode = isCodeFromLink ? codeFromLink : manualCode;

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // CONTRACT: the workspace code is mandatory. The submit button below is
    // disabled without one, and the server rejects a blank code with the same
    // generic UNAUTHORIZED as a wrong one - there is no code-less path left.
    const result = await login(name, password, workspaceCode);
    if (result.status === "ignored") {
      // A duplicate submit was suppressed at the store boundary - a real
      // attempt is already in flight and owns this form's pending state; it
      // will resolve it (re-enable/error/navigate) on its own turn. Taking
      // no action here is what prevents a suppressed duplicate from ever
      // navigating away before the real attempt has actually resolved.
      return;
    }
    setSubmitting(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    void navigate(ROUTES.electionDay, { replace: true });
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-extrabold text-slate-800">{text.title}</h2>
            <p className="text-sm text-slate-500">{text.subtitle}</p>
          </div>

          {/* Tenant-Safe Login: selects WHICH election system the credentials
              below are checked against. A selector, never a secret - it is
              shown in plain text and is expected to travel in a link. */}
          <Field label={text.workspaceCodeLabel}>
            <Input
              value={workspaceCode}
              onChange={(e) => setManualCode(e.target.value)}
              readOnly={isCodeFromLink}
              // Codes are ASCII-only, so LTR even though the page is RTL.
              dir="ltr"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              name="election-day-workspace-code"
              spellCheck={false}
              maxLength={16}
              aria-describedby="kb-ws-code-hint"
              required
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

          {/* This IS a real login identifier, so it keeps the standards
              `username` token - unlike the create-user form, where the name
              field describes a NEW account and is correctly `off`. What it
              gains here is an explicit, distinct field NAME.
              `/platform/login` and this screen share one origin, and Chrome
              scopes saved credentials by origin, so the Platform Owner's
              saved email/password is a candidate here. Both forms previously
              carried NO `name` and NO `autocomplete` on their credential
              fields, leaving Chrome nothing but positional heuristics and
              making the two form signatures maximally similar. Naming this
              form's fields distinctly, and stating what they are, is the
              standards-compatible way to tell the browser these are two
              different login forms. See this file's sibling comment on the
              password field for the honest limit of that. */}
          <Field label={text.nameLabel}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="username"
              name="election-day-username"
              // Focus the first field the user actually has to fill in: when
              // the link supplied the code, that is the username.
              autoFocus
              required
            />
          </Field>
          <Field label={text.passwordLabel} error={error ?? undefined}>
            <div className="flex gap-2">
              {/* `current-password`, NOT `new-password`: this authenticates
                  an existing PermissionUser, and mislabelling it would stop
                  the browser ever offering to save or fill that account's
                  own password - trading one usability bug for a worse one.
                  `autocomplete="off"` is likewise not used here: Chrome
                  deliberately ignores it on login password fields.

                  HONEST LIMIT OF THIS FIX: Chrome scopes saved credentials
                  by ORIGIN, and `/platform/login` shares this origin. No
                  in-page attribute exists that means "do not offer this
                  origin's saved credentials on this particular form" - that
                  is deliberate browser behaviour, not an oversight we can
                  attribute our way out of. Correct tokens plus distinct
                  field names give Chrome a materially different form
                  signature and are the right and complete standards-level
                  answer; they are not a guarantee the Platform Owner
                  credential is never offered. The robust structural fix is
                  origin separation (serving the platform console from its
                  own subdomain), which is infrastructure work and out of
                  scope here. */}
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                invalid={!!error}
                className="flex-1"
                autoComplete="current-password"
                name="election-day-current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={
                  showPassword
                    ? passwordText.hidePasswordAriaLabel
                    : passwordText.showPasswordAriaLabel
                }
                className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                {showPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
          </Field>

          <Button
            type="submit"
            size="lg"
            loading={submitting}
            className="w-full"
            disabled={!workspaceCode.trim() || !name.trim() || !password}
          >
            {text.submit}
          </Button>

          {/* Phase 3C Roles Mutations: entry point into the separate
              Election Owner login bridge (a real Supabase Auth account, not
              a PermissionUser roster entry) - see ownerSession.ts's own doc
              comment for why these two identities are kept independent. */}
          <div className="text-center">
            <button
              type="button"
              onClick={() => void navigate(ROUTES.electionDayOwnerLogin)}
              className="text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              {ELECTION_DAY_TEXT.owner.entryLinkLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
