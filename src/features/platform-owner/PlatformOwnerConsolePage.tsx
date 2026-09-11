import { Copy, Network, ShieldCheck, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ROUTES } from "../../constants/routes";
import { Field, Input } from "../../components/ui/Field";
import {
  PLATFORM_OWNER_TEXT,
  platformApproveOwnerError,
} from "./platform-owner.constants";
import { createOwnerAccess, type CreatedOwnerAccess } from "./platformOwnerClient";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import { useMultiEntityManagement } from "./useMultiEntityManagement";
import { Skeleton } from "../../components/ui/Skeleton";

const text = PLATFORM_OWNER_TEXT.console;
const approveText = PLATFORM_OWNER_TEXT.approveOwner;
const multiEntityText = PLATFORM_OWNER_TEXT.multiEntity.entry;

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <span
        dir="ltr"
        className="break-all text-start text-sm font-semibold text-slate-800 sm:text-end"
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Stage 4B entry point. A summary line plus a link - deliberately NOT the
 * management surface itself, which lives on its own route so it survives a
 * reload mid-workflow and keeps this page from growing a second admin domain.
 *
 * It reuses the management hook purely for its read: one `multi_entity_state`
 * call, the same 401-to-refreshStatus handling, and no duplicated mapping. On
 * a read error the button still renders - the target page owns real error
 * handling, and a summary that failed to load is no reason to block access.
 */
function MultiEntityEntryCard() {
  const { seat, assignedCount, loading } = useMultiEntityManagement();
  const navigate = useNavigate();

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Network className="size-5 text-slate-700" />
        <CardTitle>{multiEntityText.title}</CardTitle>
      </div>

      {loading ? (
        <Skeleton className="w-2/3" />
      ) : (
        <p className="text-sm break-words text-slate-600">
          {seat
            ? multiEntityText.provisioned(seat.name, assignedCount)
            : multiEntityText.unprovisioned}
        </p>
      )}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => void navigate(ROUTES.platformMultiEntity)}
        className="w-full sm:w-auto"
      >
        {multiEntityText.open}
      </Button>
    </Card>
  );
}

/**
 * Platform Stage 2: the Platform Owner console landing screen. Reachable ONLY
 * through `PlatformOwnerAuthGuard`'s single "authorized" branch, i.e. only
 * after `GET /api/platform/session` returned 200 for an `aal2` session.
 *
 * Stage 2 is auth/session proof ONLY - it confirms the verified identity and
 * offers logout. Workspace provisioning is Stage 3 and deliberately absent.
 * Renders its own standalone layout: this route is NOT nested under
 * `AppLayout` or `ElectionDayShell`, and it must never import Election Day
 * data (no voter PII may reach this surface).
 */
export function PlatformOwnerConsolePage() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOwnerAccess | null>(null);
  const [copied, setCopied] = useState(false);

  // The Owner's activation link is a one-time credential. It lives in this
  // component's state for exactly as long as the success panel is on screen
  // and is never persisted, cached, or sent anywhere else.
  const resetApproval = () => {
    setCreated(null);
    setName("");
    setEmail("");
    setPhone("");
    setApproveError(null);
  };

  const submitApproval = async (event: FormEvent) => {
    event.preventDefault();
    if (approving) return;
    setApproveError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setApproveError(approveText.missingFields);
      return;
    }

    setApproving(true);
    try {
      const { data } = await platformOwnerAuthClient.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setApproveError(platformApproveOwnerError("UNAUTHORIZED"));
        return;
      }
      const result = await createOwnerAccess(accessToken, {
        name: trimmedName,
        email: trimmedEmail,
        phone: phone.trim() || undefined,
      });
      if (result.status !== "ok") {
        setApproveError(platformApproveOwnerError(result.code));
        return;
      }
      setCreated(result.access);
    } finally {
      setApproving(false);
    }
  };

  const copyLink = async () => {
    if (!created?.activationLink) return;
    try {
      await navigator.clipboard.writeText(created.activationLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied - the link is shown in full and can be selected.
    }
  };

  const handleLogout = async () => {
    await logout();
    void navigate(ROUTES.platformLogin, { replace: true });
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LogoMark className="size-9" />
          <div>
            <h1 className="text-lg font-extrabold text-slate-800">{text.title}</h1>
            {owner && (
              <p className="text-xs text-slate-500">{text.signedInAs(owner.email)}</p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={loggingOut}
          onClick={() => void handleLogout()}
        >
          {text.logout}
        </Button>
      </header>

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-supporter" />
          <CardTitle>{text.identityTitle}</CardTitle>
        </div>
        <div>
          <IdentityRow label={text.emailLabel} value={owner?.email ?? ""} />
          <IdentityRow label={text.ownerIdLabel} value={owner?.platformOwnerId ?? ""} />
          <IdentityRow label={text.mfaLabel} value={text.mfaValue} />
        </div>
      </Card>

      <MultiEntityEntryCard />

      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <UserPlus className="size-5 text-slate-700" />
          <CardTitle>{approveText.title}</CardTitle>
        </div>

        {!created && (
          <form onSubmit={submitApproval} className="space-y-3">
            <p className="text-sm text-slate-600">{approveText.subtitle}</p>

            <Field label={approveText.nameLabel}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
              />
            </Field>

            <Field label={approveText.emailLabel}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>

            <Field label={approveText.phoneLabel}>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={40}
              />
            </Field>

            {approveError && (
              <p role="alert" className="text-sm text-opponent">
                {approveError}
              </p>
            )}

            <Button type="submit" loading={approving} className="w-full">
              {approving ? approveText.submitting : approveText.submit}
            </Button>
          </form>
        )}

        {created && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-800">
              {approveText.successTitle}
            </p>
            {created.alreadyExisted && (
              <p className="text-sm text-slate-600">{approveText.alreadyExisted}</p>
            )}
            {created.expiresAt && (
              <p className="text-xs text-slate-500">
                {approveText.expiresAt(created.expiresAt)}
              </p>
            )}

            {created.activationLink ? (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="text-xs font-semibold text-slate-700">
                  {approveText.linkLabel}
                </p>
                <p className="font-mono text-xs break-all text-slate-800">
                  {created.activationLink}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void copyLink()}
                >
                  <Copy className="me-1 size-4" aria-hidden />
                  {copied ? approveText.copied : approveText.copy}
                </Button>
                <p className="text-xs text-slate-500">{approveText.linkHint}</p>
              </div>
            ) : (
              <p className="text-sm text-opponent">{approveText.linkMissing}</p>
            )}

            <Button type="button" variant="secondary" size="sm" onClick={resetApproval}>
              {approveText.another}
            </Button>
          </div>
        )}
      </Card>

      <p className="text-center text-xs text-slate-500">{text.stageNote}</p>
    </div>
  );
}
