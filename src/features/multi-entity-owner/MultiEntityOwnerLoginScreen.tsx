import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

const text = MULTI_ENTITY_OWNER_TEXT.login;

/**
 * Platform Stage 5: email+password sign-in for the Multi-Entity Owner on the
 * ISOLATED `multiEntityOwnerAuthClient`. A successful sign-in is only aal1 and
 * grants nothing - control passes to `MultiEntityOwnerAuthGuard`, which forces
 * MFA and then the server's own 200/401 verdict.
 */
export function MultiEntityOwnerLoginScreen() {
  const login = useMultiEntityOwnerSession((s) => s.login);
  const bootstrap = useMultiEntityOwnerSession((s) => s.bootstrap);
  const status = useMultiEntityOwnerSession((s) => s.status);
  const bootstrapped = useMultiEntityOwnerSession((s) => s.bootstrapped);
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
    // One-shot on mount - `bootstrap` is a stable store action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any resolved state other than "signed out" belongs to the guard.
  const hasSession = bootstrapped && status !== "signed_out" && status !== "checking";

  useEffect(() => {
    if (hasSession) {
      void navigate(ROUTES.multiEntityHome, { replace: true });
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
    void navigate(ROUTES.multiEntityHome, { replace: true });
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
