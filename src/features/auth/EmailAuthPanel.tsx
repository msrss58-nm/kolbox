import { useState, type FormEvent } from "react";
import { ArrowRight, Send } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { AUTH_TEXT, DEV_BYPASS_EMAIL } from "./auth.constants";
import { useAuth } from "./authStore";

const CODE_LENGTH = 6;

/**
 * The only sign-in surface in the app: email → 6-digit code → session.
 * No password, no self-signup - accounts only ever get created from the
 * manager's team page (or the one-time bootstrap), so an unrecognized
 * email fails here with a clear error instead of silently registering.
 */
export function EmailAuthPanel() {
  const requestCode = useAuth((s) => s.requestCode);
  const verifyCode = useAuth((s) => s.verifyCode);
  const devBypassLogin = useAuth((s) => s.devBypassLogin);

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    setError(null);

    if (import.meta.env.DEV && email.trim() === DEV_BYPASS_EMAIL) {
      devBypassLogin();
      return;
    }

    setSubmitting(true);
    const err = await requestCode(email.trim());
    setSubmitting(false);
    if (err) {
      setError(
        err === "over_email_send_rate_limit"
          ? AUTH_TEXT.errors.rateLimited
          : AUTH_TEXT.errors.emailNotFound,
      );
      return;
    }
    setStep("code");
  };

  const confirmCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const err = await verifyCode(email.trim(), code.trim());
    setSubmitting(false);
    if (err) {
      setError(AUTH_TEXT.errors.invalidCode);
      return;
    }
    // authStore.user populates via onAuthStateChange; LoginPage redirects.
  };

  if (step === "code") {
    return (
      <form onSubmit={(e) => void confirmCode(e)} className="space-y-5 animate-fade-in">
        <div className="space-y-1 text-center lg:text-start">
          <h2 className="text-2xl font-extrabold text-slate-800">
            {AUTH_TEXT.codeStep.title}
          </h2>
          <p className="text-sm text-slate-500">{AUTH_TEXT.codeStep.subtitle(email)}</p>
        </div>

        <Field label={AUTH_TEXT.codeStep.codeLabel} error={error ?? undefined}>
          <Input
            value={code}
            onChange={(e) =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
            }
            inputMode="numeric"
            dir="ltr"
            className="text-center text-lg tracking-[0.5em]"
            maxLength={CODE_LENGTH}
            invalid={!!error}
            autoFocus
            required
          />
        </Field>

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          className="w-full"
          disabled={code.length !== CODE_LENGTH}
        >
          {AUTH_TEXT.codeStep.submit}
        </Button>

        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
            className="flex items-center gap-1 font-semibold text-primary-600 hover:underline"
          >
            <ArrowRight className="size-3.5" />
            {AUTH_TEXT.codeStep.back}
          </button>
          <button
            type="button"
            onClick={() => void sendCode()}
            className="font-semibold text-primary-600 hover:underline"
          >
            {AUTH_TEXT.codeStep.resend}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void sendCode();
      }}
      className="space-y-5 animate-fade-in"
    >
      <div className="space-y-1 text-center lg:text-start">
        <h2 className="text-2xl font-extrabold text-slate-800">
          {AUTH_TEXT.emailStep.title}
        </h2>
        <p className="text-sm text-slate-500">{AUTH_TEXT.emailStep.subtitle}</p>
      </div>

      <Field label={AUTH_TEXT.emailStep.emailLabel} error={error ?? undefined}>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          dir="ltr"
          invalid={!!error}
          autoFocus
          required
        />
      </Field>

      <Button
        type="submit"
        size="lg"
        loading={submitting}
        className="w-full"
        disabled={!email.trim()}
      >
        <Send className="size-4" />
        {AUTH_TEXT.emailStep.submit}
      </Button>
    </form>
  );
}
