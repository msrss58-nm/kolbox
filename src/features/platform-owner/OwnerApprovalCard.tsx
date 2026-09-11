import { UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { Field, Input } from "../../components/ui/Field";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  PLATFORM_OWNER_TEXT,
  platformApproveOwnerError,
} from "./platform-owner.constants";
import { OneTimeLinkBox } from "./OneTimeLinkBox";
import { createOwnerAccess, type CreatedOwnerAccess } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.approveOwner;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Stage 3B approval form, extracted from the console page in Stage 8B.
 *
 * The activation link is a one-time credential: it lives in this component's
 * state for exactly as long as the success panel is on screen and is never
 * persisted, cached, or sent anywhere else. `onChanged` lets the approvals list
 * refetch after every outcome that may have changed the server's state.
 */
export function OwnerApprovalCard({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOwnerAccess | null>(null);

  const reset = () => {
    setCreated(null);
    setName("");
    setEmail("");
    setPhone("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (approving) return;
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !EMAIL_RE.test(trimmedEmail)) {
      setError(text.missingFields);
      return;
    }

    setApproving(true);
    try {
      const { data } = await platformOwnerAuthClient.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setError(platformApproveOwnerError("UNAUTHORIZED"));
        return;
      }
      const result = await createOwnerAccess(accessToken, {
        name: trimmedName,
        email: trimmedEmail,
        phone: phone.trim() || undefined,
      });
      if (result.status !== "ok") {
        const base = platformApproveOwnerError(result.code);
        setError(
          result.orphanedAuthUserId
            ? `${base} ${text.orphanWarning(result.orphanedAuthUserId)}`
            : base,
        );
        return;
      }
      setCreated(result.access);
      onChanged();
    } finally {
      setApproving(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <UserPlus className="size-5 text-slate-700" />
        <CardTitle>{text.title}</CardTitle>
      </div>

      {!created && (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <p className="text-sm text-slate-600">{text.subtitle}</p>

          <Field label={text.nameLabel}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              autoComplete="off"
              required
            />
          </Field>

          <Field label={text.emailLabel}>
            <Input
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              autoComplete="off"
              required
            />
          </Field>

          <Field label={text.phoneLabel}>
            <Input
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              autoComplete="off"
            />
          </Field>

          {error && (
            <p role="alert" className="text-sm text-opponent">
              {error}
            </p>
          )}

          <Button type="submit" loading={approving} className="w-full">
            {approving ? text.submitting : text.submit}
          </Button>
        </form>
      )}

      {created && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-slate-800">{text.successTitle}</p>
          {created.alreadyExisted && (
            <p className="text-sm text-slate-600">{text.alreadyExisted}</p>
          )}
          {created.expiresAt && (
            <p className="text-xs text-slate-500">{text.expiresAt(created.expiresAt)}</p>
          )}

          {created.activationLink ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">{text.linkLabel}</p>
              <OneTimeLinkBox link={created.activationLink} />
              <p className="text-xs text-slate-500">{text.linkHint}</p>
            </div>
          ) : (
            <p role="alert" className="text-sm text-opponent">
              {text.linkMissing}
            </p>
          )}

          <Button type="button" variant="secondary" size="sm" onClick={reset}>
            {text.another}
          </Button>
        </div>
      )}
    </Card>
  );
}
