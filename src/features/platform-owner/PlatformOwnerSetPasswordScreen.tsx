import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { validatePlatformOwnerPassword } from "./platformOwnerPasswordPolicy";
import {
  clearCapturedPlatformRecovery,
  getCapturedPlatformRecoveryLinkError,
  getCapturedPlatformRecoveryOtp,
  getCapturedPlatformRecoveryTokens,
  hadPlatformRecoveryLink,
} from "./platformOwnerRecoveryUrl";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.setPassword;

type Phase = "checking" | "ready" | "invalid" | "success";

/**
 * Monotonic generation counter for this screen's async work, mirroring
 * `platformOwnerSession.ts`'s own guard. Both the mount-time recovery
 * resolution and the save can outlive the render that started them (React
 * StrictMode double-invokes the effect; a user can navigate away mid-save),
 * and a late result must never write state on behalf of a superseded run.
 * Incremented on every mount AND on every unmount, so a stale run's state
 * write is a silent no-op instead of a last-writer-wins transition.
 */
let screenGeneration = 0;

/** `TypeError: Failed to fetch` reaches us as a plain `Error` whose message is
 * the stringified original (supabase-js re-throws), so an `instanceof` check
 * would miss it - match on message content, the same way `useAsyncAction.ts`
 * does for the rest of the app. */
function isNetworkFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
}

/**
 * Single-flight cache for the link redemption.
 *
 * A `token_hash` is a ONE-TIME token: redeeming it twice fails the second
 * time. React StrictMode invokes the mount effect twice, and the second pass
 * starts before the first has finished (so a plain "read and clear" would
 * still not prevent a double redemption, and clearing synchronously would
 * instead make the second pass see no session yet and fail closed on a link
 * that is perfectly valid). Caching the promise makes both passes - and any
 * later remount - await the exact same redemption.
 */
let redemption: Promise<boolean> | null = null;

/** Resolves `true` when this page load's recovery link was redeemed (or when
 * there was no link to redeem, which is the legitimate "refresh after an
 * earlier redemption" case - the caller still has to prove a live session).
 * Resolves `false` only when a link was present and Supabase rejected it. */
function redeemRecoveryLink(): Promise<boolean> {
  redemption ??= (async () => {
    // PREFERRED PATH - a `?token_hash=...&type=recovery` link points straight
    // at this route, so nothing in supabase-js auto-consumes it and the
    // redemption is fully deterministic. `verifyOtp` is itself a server round
    // trip: a forged, expired or already-used token fails here, before any
    // form is rendered.
    const otp = getCapturedPlatformRecoveryOtp();
    if (otp) {
      const { error } = await platformOwnerAuthClient.auth.verifyOtp({
        token_hash: otp.tokenHash,
        type: otp.type,
      });
      clearCapturedPlatformRecovery();
      return !error;
    }

    // FALLBACK PATH - the legacy implicit fragment, redeemed explicitly rather
    // than via `detectSessionInUrl` (see `platformOwnerRecoveryUrl.ts`).
    const tokens = getCapturedPlatformRecoveryTokens();
    if (tokens) {
      const { error } = await platformOwnerAuthClient.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      clearCapturedPlatformRecovery();
      return !error;
    }

    return true;
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
 * Platform Stage 2 (password set/recovery): the landing screen for a Supabase
 * recovery/invite link addressed to the Platform Owner account.
 *
 * SECURITY MODEL - this screen grants NOTHING:
 *   - It is a TOP-LEVEL route, never nested under `PlatformOwnerAuthGuard`
 *     (that guard would divert an `aal1` recovery session straight into MFA
 *     enrollment, making the form unreachable) and never under
 *     `AppLayout`/`AuthGuard`/`ElectionDayGuard`/`OwnerAuthGuard`.
 *   - A recovery link must have arrived in THIS page load
 *     (`hadPlatformRecoveryLink()`). A session sitting in localStorage is
 *     NOT evidence of a recovery: without this gate an abandoned aal1 login
 *     on a shared browser would open the form and let anyone change the
 *     Platform Owner password without the old password and without MFA.
 *   - The URL fragment is NEVER treated as proof. Tokens captured by
 *     `platformOwnerRecoveryUrl.ts` are only a candidate: they are handed to
 *     `setSession()`, and the screen then demands a real server round trip
 *     (`getUser()`) before it will render the form. Every other outcome - no
 *     tokens, a rejected `setSession`, a missing session, a failing
 *     `getUser()`, an unexpected throw - falls closed into "invalid link".
 *   - On success the recovery session is SIGNED OUT and the owner is sent
 *     back to `/platform/login`. The normal
 *     aal1 -> aal2 -> `GET /api/platform/session` chain still applies in full
 *     afterwards; nothing here bypasses MFA or the server's verdict.
 *   - The password is never logged, persisted, or rendered, and no auth
 *     object is ever passed to `console`.
 *
 * No `onAuthStateChange` listener is added, matching this feature's existing
 * design (see `platformOwnerSession.ts`): every state transition below is the
 * result of one explicit, awaited call, so there is exactly one place that can
 * decide the form is reachable. That is also the only CORRECT choice here -
 * supabase-js emits `PASSWORD_RECOVERY` from a `setTimeout(..., 0)` macrotask
 * that is not replayed for late subscribers, so a component mounting after it
 * would never see the event. `verifyOtp()`/`getSession()`/`getUser()` cannot
 * be missed that way.
 */
export function PlatformOwnerSetPasswordScreen() {
  const logout = usePlatformOwnerSession((s) => s.logout);
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
        // An expired/consumed link arrives as an error param, never as
        // tokens - reject it before touching the auth client at all.
        if (getCapturedPlatformRecoveryLinkError()) {
          clearCapturedPlatformRecovery();
          apply("invalid");
          return;
        }

        // A recovery link must have arrived in THIS page load. Without this
        // gate, a stale platform session left in localStorage (an abandoned
        // aal1 login on a shared browser) would satisfy the session checks
        // below and open the form - allowing a password change on the most
        // privileged identity in the system with neither the old password nor
        // MFA. Storage is not evidence of a recovery.
        if (!hadPlatformRecoveryLink()) {
          apply("invalid");
          return;
        }

        // Redeem the link (single-flight - see `redeemRecoveryLink`).
        if (!(await redeemRecoveryLink())) {
          apply("invalid");
          return;
        }

        const { data: sessionData } = await platformOwnerAuthClient.auth.getSession();
        if (!sessionData.session) {
          apply("invalid");
          return;
        }

        // The authoritative check: a real server call. `getSession()` only
        // reads local storage and would happily hand back a revoked or expired
        // token, so it can never be the last word here.
        const { data: userData, error: userError } =
          await platformOwnerAuthClient.auth.getUser();
        if (userError || !userData.user) {
          apply("invalid");
          return;
        }

        apply("ready");
      } catch {
        // Fail closed - an unexpected throw never reveals the form.
        apply("invalid");
      }
    })();

    return () => {
      // Supersede any in-flight resolution so it cannot write state after this
      // mount is gone (and so StrictMode's discarded first pass stays silent).
      screenGeneration += 1;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // In-flight guard, same idiom as the store's `loggingIn`/`verifying`
    // flags - the disabled button is the UI half, this is the real one.
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
      const { error: updateError } = await platformOwnerAuthClient.auth.updateUser({
        password,
      });
      if (!updateError) {
        // SECURITY SIDE EFFECT, not a state write - so it runs BEFORE the
        // generation guard. If this mount was superseded mid-save (the user
        // navigated away or hit Back on a slow connection) the password has
        // still been changed server-side, and leaving the aal1 recovery
        // session behind in localStorage would hand the next person on that
        // browser a session they could self-enrol MFA against.
        await logout();
      }
      if (generation !== screenGeneration) return;
      if (updateError) {
        const code = updateError.code ?? "";
        if (code === "same_password") {
          setError(text.errors.sameAsOld);
        } else if (code === "weak_password") {
          setError(text.errors.weak);
        } else if (code === "reauthentication_needed") {
          // The project has "Secure password change" enabled, so GoTrue wants
          // a fresh reauthentication nonce. Surfaced explicitly - otherwise
          // the owner retries the generic message forever with no way out.
          setError(text.errors.reauthNeeded);
        } else if (code === "validation_failed") {
          // Most commonly bcrypt is 72-byte ceiling on the password. The
          // policy rejects this before the round trip, but a server-side
          // policy difference must not collapse into "try again".
          setError(text.errors.tooLong);
        } else if (code === "insufficient_aal") {
          // A recovery session is always aal1. If the account already has a
          // verified TOTP factor, the server may require aal2 before a
          // password change. Reported plainly - deliberately NOT worked
          // around by unenrolling the factor from here.
          setError(text.errors.insufficientAal);
        } else if (isNetworkFailure(updateError)) {
          setError(text.errors.network);
        } else {
          setError(text.errors.generic);
        }
        return;
      }

      // Already signed out above, before the generation guard.
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
            to={ROUTES.platformLogin}
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
            onClick={() => void navigate(ROUTES.platformLogin, { replace: true })}
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
