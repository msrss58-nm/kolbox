import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { multiEntityOwnerAuthClient } from "../../services/supabase/multiEntityOwnerAuthClient";
import { validatePlatformOwnerPassword } from "../platform-owner/platformOwnerPasswordPolicy";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import {
  clearCapturedMultiEntityRecovery,
  getCapturedMultiEntityRecoveryLinkError,
  getCapturedMultiEntityRecoveryOtp,
  hadMultiEntityRecoveryLink,
} from "./multiEntityOwnerRecoveryUrl";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

const text = MULTI_ENTITY_OWNER_TEXT.setPassword;

type Phase = "checking" | "ready" | "invalid" | "success";

/** Generation guard for this screen's async work (StrictMode double mount,
 * navigation mid-save) - same idiom as the Platform Owner screen. */
let screenGeneration = 0;

function isNetworkFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
}

/** Single-flight redemption: a token_hash is ONE-TIME, and StrictMode starts
 * the second mount pass before the first finishes. Both passes (and any later
 * remount) await the same promise. Resolves `false` when there is no token to
 * redeem - unlike the Platform screen there is no fragment fallback, so "no
 * token" can never be treated as "already redeemed". */
let redemption: Promise<boolean> | null = null;

function redeemLink(): Promise<boolean> {
  redemption ??= (async () => {
    const otp = getCapturedMultiEntityRecoveryOtp();
    if (!otp) return false;
    const { error } = await multiEntityOwnerAuthClient.auth.verifyOtp({
      token_hash: otp.tokenHash,
      type: otp.type,
    });
    clearCapturedMultiEntityRecovery();
    return !error;
  })();
  return redemption;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Platform Stage 5: the landing screen for the Multi-Entity Owner's one-time
 * set-password link (minted by the Platform Owner console, Stage 4B).
 *
 * SECURITY MODEL - this screen grants NOTHING:
 *   - A TOP-LEVEL route, never under `MultiEntityOwnerAuthGuard` (which would
 *     divert the aal1 recovery session into MFA and hide the form).
 *   - A link must have arrived in THIS page load; a session in localStorage is
 *     never evidence of a recovery.
 *   - The URL is only a candidate: the token is redeemed with `verifyOtp()`
 *     and a real `getUser()` round trip must succeed before the form renders.
 *     Every other outcome falls closed into "invalid link".
 *   - On success the recovery session is signed out (globally) and the owner
 *     is sent to login - the full aal1 -> aal2 -> server-200 chain still
 *     applies afterwards.
 *   - No self-service reset exists on this surface (Stage 5 decision): a lost
 *     password or device is recovered by the Platform Owner replacing the
 *     seat. The password is never logged, persisted, or rendered.
 */
export function MultiEntityOwnerSetPasswordScreen() {
  const logout = useMultiEntityOwnerSession((s) => s.logout);
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++screenGeneration;
    const apply = (next: Phase) => {
      if (generation !== screenGeneration) return;
      setPhase(next);
    };

    void (async () => {
      try {
        if (getCapturedMultiEntityRecoveryLinkError()) {
          clearCapturedMultiEntityRecovery();
          apply("invalid");
          return;
        }
        if (!hadMultiEntityRecoveryLink()) {
          apply("invalid");
          return;
        }
        if (!(await redeemLink())) {
          apply("invalid");
          return;
        }
        const { data: sessionData } = await multiEntityOwnerAuthClient.auth.getSession();
        if (!sessionData.session) {
          apply("invalid");
          return;
        }
        // The authoritative check - a real server call, not local storage.
        const { data: userData, error: userError } =
          await multiEntityOwnerAuthClient.auth.getUser();
        if (userError || !userData.user) {
          apply("invalid");
          return;
        }
        apply("ready");
      } catch {
        apply("invalid");
      }
    })();

    return () => {
      screenGeneration += 1;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;

    const violation = validatePlatformOwnerPassword(password, confirmation);
    if (violation) {
      setError(text.errors[violation]);
      return;
    }

    const generation = screenGeneration;
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await multiEntityOwnerAuthClient.auth.updateUser({
        password,
      });
      if (!updateError) {
        // Security side effect - runs even if this mount was superseded, so an
        // aal1 recovery session is never left behind in storage.
        await logout();
      }
      if (generation !== screenGeneration) return;
      if (updateError) {
        const code = updateError.code ?? "";
        if (code === "same_password") setError(text.errors.sameAsOld);
        else if (code === "weak_password") setError(text.errors.weak);
        else if (code === "reauthentication_needed") setError(text.errors.reauthNeeded);
        else if (code === "validation_failed") setError(text.errors.tooLong);
        else if (code === "insufficient_aal") setError(text.errors.insufficientAal);
        else if (isNetworkFailure(updateError)) setError(text.errors.network);
        else setError(text.errors.generic);
        return;
      }
      setPassword("");
      setConfirmation("");
      setPhase("success");
    } catch (err) {
      if (generation !== screenGeneration) return;
      setError(isNetworkFailure(err) ? text.errors.network : text.errors.generic);
    } finally {
      if (generation === screenGeneration) setSaving(false);
    }
  };

  if (phase === "checking") {
    return (
      <Shell>
        <p className="text-center text-sm text-slate-500">{text.checking}</p>
      </Shell>
    );
  }

  if (phase === "invalid") {
    return (
      <Shell>
        <div className="space-y-4 text-center animate-fade-in">
          <div className="space-y-2">
            <h2 className="text-xl font-extrabold text-slate-800">
              {text.invalid.title}
            </h2>
            <p className="text-sm text-slate-500">{text.invalid.body}</p>
          </div>
          <Link
            to={ROUTES.multiEntityLogin}
            replace
            className="inline-block text-sm font-semibold text-primary-600 underline underline-offset-4 hover:text-primary-700"
          >
            {text.invalid.backToLogin}
          </Link>
        </div>
      </Shell>
    );
  }

  if (phase === "success") {
    return (
      <Shell>
        <div className="space-y-5 text-center animate-fade-in">
          <div className="flex justify-center">
            <CheckCircle2 className="size-10 text-supporter" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-extrabold text-slate-800">
              {text.success.title}
            </h2>
            <p className="text-sm text-slate-500">{text.success.body}</p>
          </div>
          <Button
            size="lg"
            className="w-full"
            onClick={() => void navigate(ROUTES.multiEntityLogin, { replace: true })}
          >
            {text.success.continue}
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{text.title}</h2>
          <p className="text-sm text-slate-500">{text.subtitle}</p>
        </div>

        <Field label={text.passwordLabel}>
          <div className="flex gap-2">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              dir="ltr"
              invalid={!!error}
              className="flex-1"
              autoComplete="new-password"
              autoFocus
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

        <Field label={text.confirmLabel} error={error ?? undefined}>
          <Input
            type={showPassword ? "text" : "password"}
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            dir="ltr"
            invalid={!!error}
            autoComplete="new-password"
            required
          />
        </Field>

        <div className="space-y-1.5 rounded-xl bg-slate-50 px-3.5 py-3 ring-1 ring-slate-200">
          <span className="block text-xs font-semibold text-slate-600">
            {text.rulesTitle}
          </span>
          <ul className="list-disc space-y-1 ps-4 text-xs text-slate-500">
            {text.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>

        <Button
          type="submit"
          size="lg"
          loading={saving}
          className="w-full"
          disabled={!password || !confirmation}
        >
          {text.submit}
        </Button>
      </form>
    </Shell>
  );
}
