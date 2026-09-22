import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";
import { AuthBrandLayout } from "../components/AuthBrandLayout";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { ROUTES } from "../constants/routes";
import { ELECTION_DAY_TEXT } from "../features/election-day/election-day.constants";
import {
  clearLegacySession,
  useElectionDaySession,
} from "../features/election-day/electionDaySession";
import { ENTRY_TEXT } from "./appShell.constants";
import { KOLBOX_ORIGIN_URLS } from "./origins";

const text = ELECTION_DAY_TEXT.session;
const passwordText = ELECTION_DAY_TEXT.permissionsManager;

/**
 * THE unified KOLBOX application entry. Served at `/` (via the guards'
 * redirect), at `/login`, and at `/election-day/login` - one screen, so a user
 * never needs to know a principal-specific URL.
 *
 * WHY THE OWNER REALMS ARE LINKS, NOT EXTRA FIELDS ON THIS FORM. Two separate
 * facts, both verified in this repository, not preferences:
 *
 *  1. ORIGIN SEPARATION. `VITE_APP_SURFACE` constant-folds the router at build
 *     time, so `PlatformOwnerLoginScreen` and `MultiEntityOwnerLoginScreen`
 *     are ABSENT from this bundle. That is the deliberate fix for Chrome
 *     scoping saved credentials by origin (see `./origins`). Rendering their
 *     credential fields here would undo that control to save a click.
 *
 *  2. THE REALM OF AN EMAIL CANNOT BE RESOLVED BEFORE AUTHENTICATION. Platform
 *     Owner, Election Owner and Multi-Entity Owner all sign in with
 *     email+password. Deciding which realm an address belongs to would need an
 *     unauthenticated lookup - i.e. a cross-privilege account-enumeration
 *     oracle. So the realm is chosen by the person who already knows it, and
 *     no password is ever typed before the realm is fixed: a credential can
 *     never be posted to the wrong realm's handler.
 *
 * The worker form is rendered inline and first because it is by far the most
 * common sign-in; the owner realms are a secondary block, not four equal
 * buttons. Each realm keeps its own authentication implementation, store and
 * server contract - this screen unifies the ENTRY only.
 */
export function EntryScreen() {
  const login = useElectionDaySession((s) => s.login);
  const navigate = useNavigate();

  // This route is standalone (never under `ElectionDayGuard`), so it runs the
  // one-time legacy-localStorage cleanup itself - a user who lands here and
  // never submits would otherwise never hit it.
  useEffect(() => {
    clearLegacySession();
  }, []);

  const [searchParams] = useSearchParams();
  // Tenant-Safe Login: the workspace code may arrive as `?w=<code>` - the
  // normal path, since the Owner hands out that link. DERIVED from the URL
  // rather than copied into state, so there is nothing to keep in sync.
  // Preserved exactly so every existing `/election-day/login?w=` link keeps
  // working now that this screen also answers at `/` and `/login`.
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
    // CONTRACT unchanged: the workspace code is mandatory and authoritative
    // server-side. The button is disabled without one, and the server rejects
    // a blank code with the same generic UNAUTHORIZED as a wrong one.
    const result = await login(name, password, workspaceCode);
    if (result.status === "ignored") {
      // A duplicate submit was suppressed at the store boundary - the real
      // in-flight attempt owns this form's pending state and will resolve it.
      return;
    }
    setSubmitting(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    // Post-login routing for this realm, unchanged: a workspace entitled to
    // Budget but not Election Day lands in Budget. Navigation only - both
    // modules re-authorize every request server-side.
    const budgetOnly =
      result.modules !== undefined &&
      !result.modules.includes("election_day") &&
      result.modules.includes("budget");
    void navigate(budgetOnly ? ROUTES.budget : ROUTES.electionDay, { replace: true });
  };

  return (
    // The same branded shell the Auth origin serves, so the per-origin
    // fallback entry is not a visually different product from the central one.
    <AuthBrandLayout>
      <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{ENTRY_TEXT.title}</h2>
          <p className="text-sm text-slate-500">{ENTRY_TEXT.subtitle}</p>
        </div>

        {/* Tenant-Safe Login: selects WHICH election system the credentials
              below are checked against. A selector, never a secret - shown in
              plain text and expected to travel in a link. */}
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

        {/* Distinct field NAMES and correct autocomplete tokens are the
              standards-level way to tell the browser this is a different login
              form from the owner realms'. See `./origins` for the honest limit
              of that and why origin separation is the structural answer. */}
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
            {/* `current-password`, NOT `new-password`: this authenticates an
                  existing PermissionUser, and mislabelling it would stop the
                  browser ever offering to save or fill that account's own
                  password. `autocomplete="off"` is likewise not used - Chrome
                  deliberately ignores it on login password fields. */}
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
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
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
      </form>

      {/* The owner realms. Each keeps its own authentication implementation;
            only the entry point is shared. The two cross-origin destinations
            are hard-coded keys from `./origins` - nothing from the address bar
            can influence them. */}
      <div
        className="space-y-2 border-t border-slate-200 pt-4"
        data-testid="entry-realms"
      >
        <p className="text-center text-xs font-bold uppercase tracking-wide text-slate-400">
          {ENTRY_TEXT.ownersLabel}
        </p>
        <div className="flex flex-col gap-1.5">
          {/* The Election Owner signs in on the SHARED screen, like every
              other principal except the Platform Owner - it is the only one
              that resolves a username. It used to point at a per-origin
              e-mail form, which is the odd one out this removes. */}
          <a
            href={KOLBOX_ORIGIN_URLS.sharedLogin}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            {ENTRY_TEXT.electionOwner}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
          <a
            href={KOLBOX_ORIGIN_URLS.login}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            {ENTRY_TEXT.platformOwner}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
          <a
            href={KOLBOX_ORIGIN_URLS.sharedLogin}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
          >
            {ENTRY_TEXT.multiEntityOwner}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          </a>
        </div>
        <p className="text-center text-xs text-slate-400">{ENTRY_TEXT.otherOriginHint}</p>
      </div>
    </AuthBrandLayout>
  );
}
