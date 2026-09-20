import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { AuthBrandLayout } from "../../components/AuthBrandLayout";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import {
  AUTH_ENTRY_TEXT,
  AUTH_REALM_SCREENS,
  type AuthRealmKey,
} from "./authEntry.constants";
import { brokerLogin } from "./authBrokerClient";
import { AuthContinueForm, type PendingHandoff } from "./AuthContinueScreen";

const text = AUTH_ENTRY_TEXT;

/**
 * THE one KOLBOX login implementation, rendered by all four dedicated login
 * routes (Platform Owner, Election Owner, Multi-Entity Owner, Manager/User).
 *
 * WHY ONE COMPONENT. The approved split-screen design must be identical on
 * every surface. A previous regression shipped precisely because a second
 * implementation drifted from the approved one and nothing asserted the
 * design. Sharing one component makes "identical" structural: only the title
 * is parameterized.
 *
 * THE REALM COMES FROM THE ROUTE, not from the user. There is no realm
 * selector, no workspace selector, no system code and no e-mail field on any
 * of the four screens - every one takes exactly a username and a password. A
 * username belonging to a different realm simply fails here, with the same
 * generic message as a wrong password.
 */
export function AuthLoginScreen({ realmKey }: { realmKey: AuthRealmKey }) {
  const screen = AUTH_REALM_SCREENS[realmKey];

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingHandoff | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // EXACTLY ONE credential-bearing request, to EXACTLY ONE realm's endpoint.
    // A failure is reported, never retried against another endpoint.
    const result = await brokerLogin({
      endpoint: screen.endpoint,
      username,
      password,
    });
    setSubmitting(false);

    if (result.status === "network") {
      setError(text.networkFailure);
      return;
    }
    if (result.status === "failed") {
      setError(text.genericFailure);
      return;
    }
    // Held in memory only, then posted cross-origin as a form field.
    setPending({ code: result.code, targetOrigin: result.targetOrigin });
  };

  if (pending) return <AuthContinueForm handoff={pending} />;

  return (
    <AuthBrandLayout>
      <form onSubmit={(e) => void submit(e)} className="space-y-5 animate-fade-in">
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{screen.title}</h2>
          <p className="text-sm text-slate-500">{text.subtitle}</p>
        </div>

        <Field label={text.usernameLabel}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            name="kb-username"
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
              name="kb-current-password"
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

        <Button
          type="submit"
          size="lg"
          loading={submitting}
          className="w-full"
          disabled={username.trim() === "" || !password}
        >
          {text.submit}
        </Button>
      </form>
    </AuthBrandLayout>
  );
}
