import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate } from "react-router";
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

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(name, password);
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

          <Field label={text.nameLabel}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <Field label={text.passwordLabel} error={error ?? undefined}>
            <div className="flex gap-2">
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                invalid={!!error}
                className="flex-1"
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
            disabled={!name.trim() || !password}
          >
            {text.submit}
          </Button>
        </form>
      </div>
    </div>
  );
}
