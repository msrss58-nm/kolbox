import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, Copy, KeyRound } from "lucide-react";
import { Navigate, useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { ROUTES } from "../../constants/routes";
import {
  bootstrapFirstUser,
  fetchOwnerRoles,
  ownerReauth,
  provisionWorkspace,
  type ProvisionedWorkspace,
} from "./electionDayOwnerClient";
import {
  OWNER_PROVISIONING_TEXT,
  ownerProvisioningError,
} from "./ownerProvisioning.constants";
import { useOwnerSession } from "./ownerSession";

const setupText = OWNER_PROVISIONING_TEXT.setup;
const createdText = OWNER_PROVISIONING_TEXT.created;
const firstUserText = OWNER_PROVISIONING_TEXT.firstUser;

const MIN_USER_PASSWORD_LENGTH = 6;

type Stage = "setup" | "created" | "done";

interface RoleOption {
  id: string;
  name: string;
}

/**
 * Stage 3B - first-run provisioning for an approved Election Owner.
 *
 * Guards itself rather than sitting behind OwnerAuthGuard: that guard requires
 * `owner`, which by definition does not exist yet here. The three outcomes
 * after bootstrap are exhaustive - an already-provisioned Owner is sent to
 * their console, a pending Owner sees this flow, and anyone else goes back to
 * the login screen.
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

  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [userName, setUserName] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!bootstrapped) void bootstrap();
  }, [bootstrapped, bootstrap]);

  // Roles only exist after provisioning, and are seeded by it - so this loads
  // once the workspace is real, never before.
  useEffect(() => {
    if (stage !== "created") return;
    void (async () => {
      const token = await getAccessToken();
      if (!token) return;
      const result = await fetchOwnerRoles(token);
      if (result.status !== "ok") return;
      const options = result.rows
        .map((row) => {
          const r = row as unknown as Record<string, unknown>;
          return typeof r.id === "string" && typeof r.name === "string"
            ? { id: r.id, name: r.name }
            : null;
        })
        .filter((r): r is RoleOption => r !== null);
      setRoles(options);
      // Default to the fullest role so the first account can actually manage
      // the system it was just handed.
      const manager = options.find((r) => r.name === "מנהל");
      setRoleId(manager?.id ?? options[0]?.id ?? "");
    })();
  }, [stage, getAccessToken]);

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

  const submitFirstUser = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingUser) return;
    setUserError(null);

    const name = userName.trim();
    if (!name) {
      setUserError(firstUserText.missingName);
      return;
    }
    if (!userPassword) {
      setUserError(firstUserText.missingPassword);
      return;
    }
    if (userPassword.length < MIN_USER_PASSWORD_LENGTH) {
      setUserError(firstUserText.passwordTooShort);
      return;
    }
    if (!roleId) {
      setUserError(firstUserText.missingRole);
      return;
    }
    if (!ownerPassword) {
      setUserError(firstUserText.wrongOwnerPassword);
      return;
    }

    setCreatingUser(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setUserError(ownerProvisioningError("UNAUTHORIZED"));
        return;
      }

      // Fresh, one-time, action-bound proof minted inside this same async
      // chain and never stored anywhere - matching useOwnerReauth's contract.
      const proof = await ownerReauth(token, ownerPassword, "bootstrap_first_user");
      if (proof.status === "wrong_password") {
        setUserError(firstUserText.wrongOwnerPassword);
        return;
      }
      if (proof.status === "rate_limited") {
        setUserError(firstUserText.rateLimited);
        return;
      }
      if (proof.status !== "ok") {
        setUserError(ownerProvisioningError("SERVER_ERROR"));
        return;
      }

      const created = await bootstrapFirstUser(token, proof.proof, {
        name,
        password: userPassword,
        roleId,
      });
      if (created.status !== "ok") {
        setUserError(ownerProvisioningError(created.code));
        return;
      }
      setOwnerPassword("");
      setUserPassword("");
      setStage("done");
    } finally {
      setCreatingUser(false);
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

  const heading = useMemo(() => {
    if (stage === "setup") return setupText.title;
    if (stage === "created") return createdText.title;
    return firstUserText.doneTitle;
  }, [stage]);

  if (!bootstrapped) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 p-4">
        <p className="text-sm text-slate-500">{setupText.submitting}</p>
      </div>
    );
  }

  // Already provisioned and not mid-flow - nothing to do here.
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

            <form onSubmit={submitFirstUser} className="space-y-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <KeyRound className="h-4 w-4" aria-hidden />
                  {firstUserText.title}
                </h2>
                <p className="mt-1 text-sm text-slate-600">{firstUserText.subtitle}</p>
              </div>

              <Field label={firstUserText.nameLabel}>
                <Input
                  id="fu-name"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  required
                />
              </Field>

              <Field label={firstUserText.passwordLabel}>
                <Input
                  id="fu-password"
                  name="first-user-password"
                  type="password"
                  autoComplete="new-password"
                  value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)}
                  required
                />
              </Field>

              <Field label={firstUserText.roleLabel}>
                <Select
                  id="fu-role"
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label={firstUserText.ownerPasswordLabel}>
                <Input
                  id="fu-owner-password"
                  name="owner-current-password"
                  type="password"
                  autoComplete="current-password"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  required
                />
                <span className="block text-xs text-slate-500">
                  {firstUserText.ownerPasswordHint}
                </span>
              </Field>

              {userError && (
                <p role="alert" className="text-sm text-rose-600">
                  {userError}
                </p>
              )}

              <Button type="submit" disabled={creatingUser} className="w-full">
                {creatingUser ? firstUserText.submitting : firstUserText.submit}
              </Button>
            </form>
          </div>
        )}

        {stage === "done" && (
          <div className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" aria-hidden />
            <p className="text-sm text-slate-600">{firstUserText.doneBody}</p>
            {workspace && (
              <p className="font-mono text-xl tracking-widest text-slate-900">
                {workspace.loginCode}
              </p>
            )}
            <Button type="button" onClick={() => void navigate(ROUTES.electionDayLogin)}>
              {firstUserText.goToLogin}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
