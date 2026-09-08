import { useState, type FormEvent } from "react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.mfa;

/**
 * Platform Stage 2: the TOTP challenge - the ONLY screen reachable while the
 * platform session is at `aal1` WITH an already-verified factor. Rendered
 * directly by `PlatformOwnerAuthGuard`, so no URL can bypass it.
 *
 * Uses `mfa.challenge()` + `mfa.verify()` (via the store's shared
 * `verifyMfa`) against the factor id that `refreshStatus()` resolved from
 * `listFactors()` - this screen never enrolls anything.
 */
export function PlatformOwnerMfaChallengeScreen() {
  const mfaState = usePlatformOwnerSession((s) => s.mfaState);
  const verifyMfa = usePlatformOwnerSession((s) => s.verifyMfa);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);

  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
          <div className="space-y-1 text-center">
            <h2 className="text-2xl font-extrabold text-slate-800">
              {text.challenge.title}
            </h2>
            <p className="text-sm text-slate-500">{text.challenge.subtitle}</p>
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

          <div className="text-center">
            <button
              type="button"
              onClick={() => void logout()}
              disabled={loggingOut}
              className="touch-target text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50"
            >
              {PLATFORM_OWNER_TEXT.forbidden.logout}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
