import { useEffect, useState, type FormEvent } from "react";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { ownerAuthClient } from "../../services/supabase/ownerAuthClient";
import { OWNER_PROVISIONING_TEXT } from "./ownerProvisioning.constants";
import {
  clearCapturedOwnerRecovery,
  getCapturedOwnerRecoveryLinkError,
  getCapturedOwnerRecoveryOtp,
  getCapturedOwnerRecoveryTokens,
  hadOwnerRecoveryLink,
} from "./electionDayOwnerRecoveryUrl";

const text = OWNER_PROVISIONING_TEXT.setPassword;
const MIN_PASSWORD_LENGTH = 8;

type Phase = "checking" | "ready" | "invalid" | "success";

/**
 * Stage 3B - where a newly approved Election Owner sets their OWN password.
 *
 * Mirrors PlatformOwnerSetPasswordScreen's proven structure deliberately: the
 * activation link is redeemed against the SERVER before the form is shown, and
 * arriving without link material is rejected outright rather than trusted.
 *
 * The link is the only proof. Without hadOwnerRecoveryLink(), simply typing
 * this URL while a stale Owner session sat in localStorage would open the form
 * and permit a password change with neither the old password nor a link - so
 * that check gates the whole screen, not just the redemption.
 *
 * Everything here runs against ownerAuthClient (storageKey
 * `kb-owner-auth-token`) and never the campaign client or the Platform Owner
 * client. The three identities must not be able to write each other's session.
 */
let screenGeneration = 0;

function isNetworkFailure(err: unknown): boolean {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message).toLowerCase()
      : String(err ?? "").toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed")
  );
}

export function OwnerSetPasswordScreen() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const generation = ++screenGeneration;
    const settle = (next: Phase) => {
      if (generation === screenGeneration) setPhase(next);
    };

    void (async () => {
      // Arriving with no link material at all is never valid, whatever may be
      // sitting in storage.
      if (!hadOwnerRecoveryLink() || getCapturedOwnerRecoveryLinkError()) {
        settle("invalid");
        return;
      }

      const otp = getCapturedOwnerRecoveryOtp();
      const tokens = getCapturedOwnerRecoveryTokens();

      try {
        if (otp) {
          const { error: otpError } = await ownerAuthClient.auth.verifyOtp({
            token_hash: otp.tokenHash,
            type: otp.type,
          });
          if (otpError) {
            settle("invalid");
            return;
          }
        } else if (tokens) {
          const { error: sessionError } = await ownerAuthClient.auth.setSession({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          });
          if (sessionError) {
            settle("invalid");
            return;
          }
        } else {
          settle("invalid");
          return;
        }

        // Redemption is not enough on its own - confirm the server agrees a
        // real user is now attached to this client before showing the form.
        const { data, error: userError } = await ownerAuthClient.auth.getUser();
        if (userError || !data?.user?.id) {
          settle("invalid");
          return;
        }

        clearCapturedOwnerRecovery();
        settle("ready");
      } catch {
        settle("invalid");
      }
    })();

    return () => {
      screenGeneration += 1;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(text.tooShort);
      return;
    }
    if (password !== confirm) {
      setError(text.mismatch);
      return;
    }

    setSaving(true);
    try {
      const { error: updateError } = await ownerAuthClient.auth.updateUser({
        password,
      });
      if (updateError) {
        setError(text.genericError);
        return;
      }
      // Sign straight back out: the activation session exists only to set the
      // password. The Owner then signs in normally, which is what puts them
      // through the provisioning-state resolution in ownerSession.ts.
      await ownerAuthClient.auth.signOut();
      setPhase("success");
    } catch (err) {
      setError(isNetworkFailure(err) ? text.networkError : text.genericError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 md:p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark />
          <h1 className="text-xl font-semibold text-slate-900">{text.title}</h1>
        </div>

        {phase === "checking" && (
          <p className="text-center text-sm text-slate-500">{text.checking}</p>
        )}

        {phase === "invalid" && (
          <div className="space-y-4 text-center">
            <h2 className="text-base font-semibold text-slate-900">
              {text.invalidTitle}
            </h2>
            <p className="text-sm text-slate-600">{text.invalidBody}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void navigate(ROUTES.electionDayOwnerLogin)}
            >
              {text.goToLogin}
            </Button>
          </div>
        )}

        {phase === "success" && (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" aria-hidden />
            <h2 className="text-base font-semibold text-slate-900">
              {text.successTitle}
            </h2>
            <p className="text-sm text-slate-600">{text.successBody}</p>
            <Button
              type="button"
              onClick={() =>
                void navigate(ROUTES.electionDayOwnerLogin, { replace: true })
              }
            >
              {text.goToLogin}
            </Button>
          </div>
        )}

        {phase === "ready" && (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-slate-600">{text.subtitle}</p>

            <Field label={text.passwordLabel}>
              <div className="relative">
                <Input
                  id="owner-new-password"
                  name="owner-new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? text.hidePassword : text.showPassword}
                  className="absolute inset-y-0 end-2 flex items-center px-2 text-slate-400"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>
            </Field>

            <Field label={text.confirmLabel}>
              <Input
                id="owner-confirm-password"
                name="owner-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </Field>

            {error && (
              <p role="alert" className="text-sm text-rose-600">
                {error}
              </p>
            )}

            <Button type="submit" disabled={saving} className="w-full">
              {saving ? text.saving : text.submit}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
