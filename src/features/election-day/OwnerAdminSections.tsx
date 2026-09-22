import type { ReactNode } from "react";
import { AdminListFrame, AdminSection } from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useOwnerAdmin, type OwnerAdminContext } from "./ownerAdminContext";
import { PermissionUsersPanel } from "./PermissionUsersPanel";
import { RoleManagementPanel } from "./RoleManagementPanel";

const text = ELECTION_DAY_TEXT.owner.rolesPage;
const adminText = ELECTION_DAY_TEXT.owner.admin;

/** Users: create / delete Managers and ordinary users, reset ordinary users. */
export function OwnerUsersSection() {
  const { userManagement, roleManagement } = useOwnerAdmin();
  return (
    <PermissionUsersPanel
      users={userManagement.users}
      roles={roleManagement.roles}
      loaded={userManagement.loaded}
      loadError={userManagement.loadError}
      onRetry={userManagement.reload}
      onAdd={userManagement.createUser}
      onCheckUsername={userManagement.checkUsername}
      onDelete={userManagement.deleteUser}
      onReset={userManagement.resetPassword}
      // The Owner may now reset ANY of their users, Manager roles included:
      // a Manager has no e-mail and no self-service recovery, so their Owner
      // is the only possible recovery path. The server-side
      // CANNOT_RESET_MANAGER refusal was lifted with it, so this is not a
      // hidden button standing in for an enforcement rule.
      canResetPassword={() => true}
      usernameCollision={userManagement.usernameCollision}
      onClearUsernameCollision={userManagement.clearUsernameCollision}
    />
  );
}

/** Roles & Permissions, with the explicit Manager-role flag. */
export function OwnerRolesSection() {
  const { roleManagement, userManagement } = useOwnerAdmin();
  return (
    <RoleManagementPanel
      roleManagement={roleManagement}
      permissionUsers={userManagement.users}
    />
  );
}

function SummaryState({
  error,
  onRetry,
  children,
  loading,
}: {
  error: unknown;
  onRetry: () => void;
  loading: boolean;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-opponent">
          {text.loadError}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {text.retry}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-12 w-full max-w-2xl" />
        <Skeleton className="h-12 w-full max-w-2xl" />
      </div>
    );
  }
  return <>{children}</>;
}

/** The workspace's module entitlements - informational for the Owner. The
 * Platform Owner alone assigns modules; nothing here can ever change them,
 * which is why this is no longer a destination of its own: it is a FACT about
 * the workspace, and facts about the workspace belong on the settings screen.
 *
 * Rendered there as a titled block rather than its own `AdminSection`, and it
 * keeps the `owner-modules-section` test id so every existing reference to
 * this content still finds it. `summary`/`error`/`reload` are passed in from
 * the settings screen, so the whole admin area still makes ONE workspace
 * request, not two. */
function ModulesBlock({ workspace }: { workspace: OwnerAdminContext["workspace"] }) {
  const { summary, error, reload } = workspace;
  return (
    <section data-testid="owner-modules-section" className="space-y-3">
      <div>
        <h3 className="text-sm font-extrabold text-slate-800">{text.modulesTitle}</h3>
        <p className="mt-1 text-xs text-slate-500">{adminText.modules.description}</p>
      </div>
      <SummaryState error={error} onRetry={reload} loading={!summary}>
        <div className="max-w-2xl space-y-3">
          <AdminListFrame>
            <ul className="divide-y divide-slate-100">
              {(summary?.modules ?? []).map((m) => (
                <li
                  key={m.key}
                  data-module={m.key}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-800">
                      {moduleLabel(m.key)}
                    </p>
                    {!m.available && (
                      <p className="text-xs text-slate-400">{text.moduleUnavailable}</p>
                    )}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                      m.enabled
                        ? "bg-supporter-soft text-emerald-800"
                        : "bg-slate-100 text-slate-600",
                    )}
                  >
                    {m.enabled ? text.moduleEnabled : text.moduleDisabled}
                  </span>
                </li>
              ))}
            </ul>
          </AdminListFrame>
          <p className="text-xs text-slate-500">{adminText.modules.readOnlyNote}</p>
        </div>
      </SummaryState>
    </section>
  );
}

function SettingRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm font-semibold break-words text-slate-800">
        {value}
        {hint && (
          <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>
        )}
      </dd>
    </div>
  );
}

/** Settings: read-only workspace and account details - no new authority. */
export function OwnerSettingsSection() {
  const { workspace, ownerEmail } = useOwnerAdmin();
  const { summary, error, reload } = workspace;
  const s = adminText.settings;
  return (
    <AdminSection
      testId="owner-settings-section"
      title={s.title}
      description={s.description}
    >
      <SummaryState error={error} onRetry={reload} loading={!summary}>
        <AdminListFrame className="max-w-2xl">
          <dl className="divide-y divide-slate-100">
            <SettingRow
              label={s.workspaceName}
              value={<span dir="auto">{summary?.workspaceName ?? s.notSet}</span>}
            />
            <SettingRow
              label={s.loginCode}
              value={
                summary?.loginCode ? (
                  <span dir="ltr" className="font-mono tracking-widest">
                    {summary.loginCode}
                  </span>
                ) : (
                  s.notSet
                )
              }
              hint={text.workspaceCodeHint}
            />
            <SettingRow
              label={s.electionEnd}
              value={
                summary?.electionEndAt
                  ? s.formatDateTime(summary.electionEndAt)
                  : s.notSet
              }
            />
            <SettingRow
              label={s.ownerAccount}
              value={<span dir="ltr">{ownerEmail}</span>}
            />
            <SettingRow label={s.ownerRoleLabel} value={s.ownerRoleValue} />
          </dl>
        </AdminListFrame>
      </SummaryState>
      {/* Modules used to be a menu item of its own. It is read-only - only the
          Platform Owner can change an entitlement - so it belongs with the
          other read-only facts about this workspace rather than behind a
          separate click. */}
      <div className="mt-8">
        <ModulesBlock workspace={workspace} />
      </div>
    </AdminSection>
  );
}
