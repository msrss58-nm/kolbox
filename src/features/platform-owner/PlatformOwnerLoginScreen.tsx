import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.login;

/**
 * Platform Stage 2: email+password sign-in for the Platform Owner - a real
 * Supabase Auth account on the ISOLATED `platformOwnerAuthClient`, so signing
 * in here never touches the campaign session, the Election Day cookie
 * session, or the Election Owner session.
 *
 * A successful sign-in only produces an `aal1` session and grants NOTHING by
 * itself - this screen just hands control to `PlatformOwnerAuthGuard`, which
 * forces MFA and then the server's own 200/401 verdict. Deliberately a
 * standalone top-level route (never nested under any other guard), mirroring
 * `OwnerLoginScreen.tsx`'s visual pattern.
 */
export function PlatformOwnerLoginScreen() {
  const login = usePlatformOwnerSession((s) => s.login);
  const bootstrap = usePlatformOwnerSession((s) => s.bootstrap);
  const status = usePlatformOwnerSession((s) => s.status);
  const bootstrapped = usePlatformOwnerSession((s) => s.bootstrapped);
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
    // Runs once on mount - resolves an already-persisted platform session so
    // a returning owner isn't asked to sign in again. `bootstrap` is a stable
    // store action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any resolved state other than "signed out" belongs to the guard, which is
  // the sole authority on what an existing session may reach (MFA, the
  // not-authorized screen, or the console).
  const hasSession = bootstrapped && status !== "signed_out" && status !== "checking";

  useEffect(() => {
    if (hasSession) {
      void navigate(ROUTES.platformConsole, { replace: true });
    }
  }, [hasSession, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(email, password);
    if (result.status === "ignored") {
      return;
    }
    setSubmitting(false);
    if (result.status === "error") {
      setError(
        result.code === "network" ? text.errors.network : text.errors.invalidCredentials,
      );
      return;
    }
    void navigate(ROUTES.platformConsole, { replace: true });
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

          <Field label={text.emailLabel}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              dir="ltr"
              autoComplete="username"
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
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? text.hidePassword : text.showPassword}
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
            disabled={!email.trim() || !password}
          >
            {text.submit}
          </Button>
        </form>
      </div>
    </div>
  );
}
