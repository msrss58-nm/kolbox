import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
import { Navigate, useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import { provisionWorkspace, type ProvisionedWorkspace } from "./electionDayOwnerClient";
import {
  OWNER_PROVISIONING_TEXT,
  ownerProvisioningError,
} from "./ownerProvisioning.constants";
import { useOwnerSession } from "./ownerSession";

const setupText = OWNER_PROVISIONING_TEXT.setup;
const createdText = OWNER_PROVISIONING_TEXT.created;

type Stage = "setup" | "created";

/**
 * Stage 3B - first-run provisioning for an approved Election Owner.
 *
 * Guards itself rather than sitting behind OwnerAuthGuard: that guard requires
 * `owner`, which by definition does not exist yet here. The three outcomes
 * after bootstrap are exhaustive - an already-provisioned Owner is sent to
 * their administration page, a pending Owner sees this flow, and anyone else
 * goes back to the login screen.
 *
 * Platform Stage 9: provisioning ends here. There is no mandatory "first
 * user" step any more - the Owner is the workspace's administrator and goes
 * straight to the administration page, where users (the first Manager
 * included) can be created now or at any later time. A workspace with zero
 * users is a valid state, and leaving/reloading this screen cannot strand the
 * Owner: a provisioned Owner is always redirected to administration.
 *
 * Nothing on this screen is authority. The Owner's right to provision is
 * re-established server-side on every call from their JWT plus the locked
 * pending-access row; this component only decides what to render.
 */
export function OwnerSetupPage() {
  const navigate = useNavigate();
  const owner = useOwnerSession((s) => s.owner);
  const provisioning = useOwnerSession((s) => s.provisioning);
  const bootstrapped = useOwnerSession((s) => s.bootstrapped);
  const bootstrap = useOwnerSession((s) => s.bootstrap);
  const refreshProvisioning = useOwnerSession((s) => s.refreshProvisioning);
  const getAccessToken = useOwnerSession((s) => s.getAccessToken);

  const [stage, setStage] = useState<Stage>("setup");
  const [workspace, setWorkspace] = useState<ProvisionedWorkspace | null>(null);

  const [workspaceName, setWorkspaceName] = useState("");
  const [electionEndAt, setElectionEndAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!bootstrapped) void bootstrap();
  }, [bootstrapped, bootstrap]);

  const expired = provisioning?.state === "expired";

  const submitProvisioning = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const name = workspaceName.trim();
    if (!name) {
      setError(setupText.missingName);
      return;
    }
    if (!electionEndAt) {
      setError(setupText.missingEnd);
      return;
    }

    setSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError(ownerProvisioningError("UNAUTHORIZED"));
        return;
      }
      const result = await provisionWorkspace(token, {
        workspaceName: name,
        // datetime-local yields a local wall-clock string with no zone; make
        // the Owner's own timezone explicit rather than letting Postgres
        // guess.
        electionEndAt: new Date(electionEndAt).toISOString(),
      });
      if (result.status !== "ok") {
        setError(ownerProvisioningError(result.code));
        return;
      }
      setWorkspace(result.workspace);
      setStage("created");
      // Promote this session from "pending" to a real Owner so the rest of
      // the app stops treating them as mid-onboarding.
      await refreshProvisioning();
    } finally {
      setSubmitting(false);
    }
  };

  const copyCode = async () => {
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(workspace.loginCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied - the code is displayed in full anyway.
    }
  };

  const goToAdministration = () =>
    void navigate(ROUTES.electionDayOwnerRoles, { replace: true });

  const heading = useMemo(
    () => (stage === "setup" ? setupText.title : createdText.title),
    [stage],
  );

  if (!bootstrapped) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
        <p className="text-sm text-slate-500">{setupText.submitting}</p>
      </div>
    );
  }

  // Already provisioned and not mid-flow - administration is the home page.
  if (owner && stage === "setup") {
    return <Navigate to={ROUTES.electionDayOwnerRoles} replace />;
  }

  if (!owner && !provisioning) {
    return <Navigate to={ROUTES.electionDayOwnerLogin} replace />;
  }

  return (
    <div className="flex min-h-dvh items-start justify-center bg-slate-50 p-4 md:items-center">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 md:p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark />
          <h1 className="text-xl font-semibold text-slate-900">{heading}</h1>
        </div>

        {expired && (
          <div className="space-y-3 text-center">
            <h2 className="text-base font-semibold text-slate-900">
              {setupText.expiredTitle}
            </h2>
            <p className="text-sm text-slate-600">{setupText.expiredBody}</p>
          </div>
        )}

        {!expired && stage === "setup" && (
          <form onSubmit={submitProvisioning} className="space-y-4">
            {provisioning?.pendingName && (
              <p className="text-sm font-medium text-slate-900">
                {setupText.welcome(provisioning.pendingName)}
              </p>
            )}
            <p className="text-sm text-slate-600">{setupText.subtitle}</p>

            <Field label={setupText.workspaceNameLabel}>
              <Input
                id="ws-name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                maxLength={120}
                required
              />
              <span className="block text-xs text-slate-500">
                {setupText.workspaceNameHint}
              </span>
            </Field>

            <Field label={setupText.electionEndLabel}>
              <Input
                id="ws-end"
                type="datetime-local"
                value={electionEndAt}
                onChange={(e) => setElectionEndAt(e.target.value)}
                required
              />
              <span className="block text-xs text-slate-500">
                {setupText.electionEndHint}
              </span>
            </Field>

            {error && (
              <p role="alert" className="text-sm text-rose-600">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? setupText.submitting : setupText.submit}
            </Button>
          </form>
        )}

        {stage === "created" && workspace && (
          <div className="space-y-6">
            <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <p className="mb-2 text-sm text-slate-600">{createdText.subtitle}</p>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">{createdText.loginCodeLabel}</p>
                  <p className="font-mono text-2xl tracking-widest text-slate-900">
                    {workspace.loginCode}
                  </p>
                </div>
                <Button type="button" variant="secondary" onClick={copyCode}>
                  <Copy className="me-1 h-4 w-4" aria-hidden />
                  {copied ? createdText.copied : createdText.copy}
                </Button>
              </div>
              <p className="mt-3 text-xs text-slate-500">{createdText.loginCodeHint}</p>
            </div>

            <p className="text-sm text-slate-600">{createdText.nextHint}</p>
            <Button type="button" className="w-full" onClick={goToAdministration}>
              {createdText.continue}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
