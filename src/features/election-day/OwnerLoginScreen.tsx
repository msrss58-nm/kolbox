import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useOwnerSession } from "./ownerSession";

const text = ELECTION_DAY_TEXT.owner.login;

/**
 * Phase 3C Roles Mutations: email+password login for an Election Owner - a
 * real Supabase Auth account, verified against the live `election_owners`
 * table via `useOwnerSession.login()`. Deliberately mirrors
 * `ElectionDayLoginScreen.tsx`'s visual pattern exactly (same layout/inputs/
 * show-password toggle), but authenticates a structurally different identity
 * (see `ownerSession.ts`'s own doc comment) - a completely separate route,
 * never nested under `ElectionDayGuard` or `AuthGuard`.
 */
export function OwnerLoginScreen() {
  const login = useOwnerSession((s) => s.login);
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(result.message);
      return;
    }
    void navigate(ROUTES.electionDayOwnerRoles, { replace: true });
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
                aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
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

          <div className="text-center">
            <button
              type="button"
              onClick={() => void navigate(ROUTES.electionDayLogin)}
              className="text-sm font-semibold text-slate-500 hover:text-slate-700"
            >
              {text.backToElectionDayLogin}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
