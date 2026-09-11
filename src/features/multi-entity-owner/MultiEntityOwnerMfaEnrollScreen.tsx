import { useEffect, useState, type FormEvent } from "react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

const text = MULTI_ENTITY_OWNER_TEXT.mfa;

/**
 * Platform Stage 5: TOTP enrollment - the ONLY screen reachable while the
 * Multi-Entity session is at aal1 with no verified factor. Rendered directly
 * by `MultiEntityOwnerAuthGuard`, so no URL can bypass it. Enrollment is
 * idempotent (an existing verified factor is reused, never duplicated).
 */
export function MultiEntityOwnerMfaEnrollScreen() {
  const mfaState = useMultiEntityOwnerSession((s) => s.mfaState);
  const enrollMfa = useMultiEntityOwnerSession((s) => s.enrollMfa);
  const verifyMfa = useMultiEntityOwnerSession((s) => s.verifyMfa);
  const logout = useMultiEntityOwnerSession((s) => s.logout);
  const loggingOut = useMultiEntityOwnerSession((s) => s.loggingOut);

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void enrollMfa();
    // One-shot per mount - `enrollMfa` is a stable store action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const result = await verifyMfa(code);
    if (result.status === "success" || result.status === "ignored") return;
    if (result.status === "invalid_code") {
      setError(text.errors.invalidCode);
      setCode("");
      return;
    }
    setError(result.status === "no_factor" ? text.errors.noFactor : text.errors.generic);
  };

  const ready = !!mfaState.qrCode && !!mfaState.secret;

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>

        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{text.enroll.title}</h2>
          <p className="text-sm text-slate-500">{text.enroll.subtitle}</p>
        </div>

        {!ready && !mfaState.enrollFailed && (
          <p className="text-center text-sm text-slate-500">{text.enroll.loading}</p>
        )}

        {mfaState.enrollFailed && (
          <div className="space-y-3 text-center">
            <p className="text-sm font-medium text-opponent">{text.enroll.enrollError}</p>
            <Button
              variant="secondary"
              className="w-full"
              loading={mfaState.enrolling}
              onClick={() => void enrollMfa()}
            >
              {text.enroll.retry}
            </Button>
          </div>
        )}

        {ready && (
          <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
            <div className="flex justify-center">
              <img
                src={mfaState.qrCode ?? ""}
                alt={text.enroll.qrAlt}
                className="size-44 rounded-2xl bg-white p-2 ring-1 ring-slate-200"
              />
            </div>

            <div className="space-y-1.5 text-center">
              <span className="block text-xs font-semibold text-slate-500">
                {text.enroll.manualLabel}
              </span>
              <code
                dir="ltr"
                data-testid="mfa-secret"
                className="block break-all rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold tracking-wider text-slate-700 ring-1 ring-slate-200"
              >
                {mfaState.secret}
              </code>
            </div>

            <Field label={text.codeLabel} error={error ?? undefined}>
              <Input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                dir="ltr"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                invalid={!!error}
                className="text-center text-lg tracking-[0.4em]"
                autoFocus
                required
              />
            </Field>

            <Button
              type="submit"
              size="lg"
              loading={mfaState.verifying}
              className="w-full"
              disabled={code.length !== 6}
            >
              {text.submit}
            </Button>
          </form>
        )}

        <div className="text-center">
          <button
            type="button"
            onClick={() => void logout()}
            disabled={loggingOut}
            className="touch-target text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
          >
            {MULTI_ENTITY_OWNER_TEXT.forbidden.logout}
          </button>
        </div>
      </div>
    </div>
  );
}
