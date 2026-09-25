import { useCallback, useMemo, useState } from "react";
import { Link, Outlet, useNavigate, useOutletContext } from "react-router";
import { ArrowLeftRight } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { toast } from "../../components/ui/Toast";
import { COMMON_TEXT } from "../../constants/common-text";
import {
  BUDGET_NAV_SECTION_LABEL,
  ELECTION_DAY_NAV_SECTION_LABEL,
  NAV_ITEMS,
  ROUTES,
  VOTER_MANAGEMENT_NAV_SECTION_LABEL,
} from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { BUDGET_TEXT } from "../budget/budget.constants";
import { budgetNavItemsFor, useBudgetSession } from "../budget/budgetSession";
import { usePermissions } from "../../permissions/usePermissions";
import { AppShell } from "../../app/AppShell";
import { VOTER_MANAGEMENT_MODULE } from "../../app/VoterManagementGuard";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { CountdownHeader } from "./CountdownHeader";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayContactModal } from "./ElectionDayContactModal";
import { getVisibleElectionDayNavItems } from "./electionDayNavVisibility";
import { useElectionDaySession } from "./electionDaySession";
import { OverdueReminderStack } from "./OverdueReminderStack";
import { roleDisplayName } from "./roleDisplayName";
import { useCountdown } from "./useCountdown";
import { useElectionDay, type ElectionDayHook } from "./useElectionDay";
import { Settings, ShieldCheck, Users, Wallet } from "lucide-react";
import { useLocation } from "react-router";
import { isOwnerSessionRoleId } from "../../permissions/ownerSessionRole";
const ownerNav = ELECTION_DAY_TEXT.owner.admin.nav;

/** Every page under `/election-day/*` reads shared data/mutations through
 * this - `useElectionDay()` is called exactly once, here, so navigating
 * between screens never re-fetches or re-subscribes (see the Blueprint's
 * note on lifting the hook to the Shell level). `openContact` is the shared
 * voter-card trigger (`ElectionDayContactModal` lives here too, one instance
 * for the whole shell) - any screen can open a specific voter's card without
 * needing its own modal instance (e.g. the reasons report's reason ->
 * coordinator -> voters -> card drill-down opens the SAME modal a Voters-
 * screen row click would). */
export interface ElectionDayShellContext extends ElectionDayHook {
  openContact: (id: string) => void;
}

export function useElectionDayShell() {
  return useOutletContext<ElectionDayShellContext>();
}

export function ElectionDayShell() {
  const electionDay = useElectionDay();
  const countdownParts = useCountdown(electionDay.deadline);
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const navigate = useNavigate();
  const sessionUser = useElectionDaySession((s) => s.user);
  const logoutAction = useElectionDaySession((s) => s.logout);
  // Phase 3B logout cutover: `logout()` makes a real server DELETE and
  // throws on failure. `ElectionDayGuard`'s own `sessionResult` (from its
  // own `useAsyncData(bootstrap)` call) is intentionally independent of
  // this store's `user` field - that's what stops a stale `user` from ever
  // granting route access - but it also means the Guard has no way to
  // notice `user` becoming `null` here on its own; nothing re-triggers its
  // bootstrap fetch. Confirmed empirically (not just by code reading): a
  // real browser, already on the authenticated protected route, stayed
  // there indefinitely after a successful logout DELETE with no explicit
  // navigation. So this handler navigates explicitly on success - the
  // Guard doesn't need to authorize from `user` for this to work, it just
  // needs to unmount, which leaving its route does directly. On failure,
  // no navigation happens and the authenticated screen (and `user`, which
  // the store itself left untouched) stays exactly as it was - same
  // toast-on-error convention as every other mutation in this codebase.
  // Duplicate-click protection is the store's own `loggingOut` guard, not
  // anything tracked here.
  const logout = async () => {
    try {
      await logoutAction();
      // Unified entry: every election-origin sign-out returns to the one
      // KOLBOX entry screen, never a principal-specific login path.
      navigate(ROUTES.login, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : COMMON_TEXT.genericError);
    }
  };
  const location = useLocation();
  const { can } = usePermissions();

  const visibleNavItems = useMemo(() => getVisibleElectionDayNavItems(can), [can]);

  // Budget Stage 3: ask the Budget endpoint once whether this session may use
  // Budget; if so, its section sits directly below Election Day. Navigation
  // only - the Budget module re-authorizes every request server-side.
  const loadBudget = useBudgetSession((s) => s.load);
  const fetchBudgetStatus = useCallback(() => loadBudget(), [loadBudget]);
  const { data: budgetStatus } = useAsyncData(fetchBudgetStatus);
  const budgetSession = useBudgetSession((s) => s.session);
  const budgetItems = useMemo(
    () => (budgetStatus === "ready" ? budgetNavItemsFor(budgetSession) : []),
    [budgetStatus, budgetSession],
  );

  // The Election Owner administers the workspace from THIS shell - there is no
  // second one. Their sections are one more group in the sidebar the shell
  // already renders, so nothing about the navigation is duplicated. Workers
  // never see it, and the sections are Owner-only server-side regardless.
  const isOwner = isOwnerSessionRoleId(sessionUser?.roleId ?? null);

  // Which module groups appear is ENTITLEMENT-driven, not permission-driven.
  // That distinction only matters for the Owner: their permissions are
  // unrestricted by definition, so keying Election Day off `can()` alone would
  // keep offering the module after it was disabled. A worker cannot hold a
  // session without the entitlement at all (`login()` refuses), so their nav is
  // decided by the permission engine exactly as before.
  const showElectionDay = isOwner
    ? (sessionUser?.modules?.includes("election_day") ?? false)
    : visibleNavItems.length > 0;

  // Voter Management is a module like any other, and the ONLY group that was
  // still offered unconditionally. `VoterManagementGuard` already refuses its
  // routes on exactly this key, so an unentitled workspace was being shown a
  // menu whose every destination is a full-page refusal. Same fail-closed
  // reading of `modules` the guard uses: absent means not entitled.
  const showVoterManagement =
    sessionUser?.modules?.includes(VOTER_MANAGEMENT_MODULE) ?? false;

  // The mobile bottom bar already shows only the CURRENT module (see AppShell)
  // and this shell has no drawer, so while the Owner is inside their
  // administration sections the bar carries those - otherwise they would be
  // reachable only from the desktop sidebar. It carries ALL of them, not the
  // owning menu's slice: on a phone these four are one short list, and
  // splitting them would strand Budget settings with no way back.
  const onOwnerAdminRoute = location.pathname.startsWith(
    `${ROUTES.electionDayOwnerAdmin}/`,
  );
  // THERE IS NO SEPARATE ADMINISTRATION MENU. The Owner's workspace-wide
  // sections belong to the module they administer: users, roles and settings
  // sit at the foot of the Election Day menu, and Budget settings at the foot
  // of the Budget menu. Modules is gone as an item - its content is now part
  // of the settings screen, because "which modules do we have" is a fact
  // about the workspace, not a place to go.
  const ownerElectionDayItems = useMemo(
    () =>
      isOwner
        ? [
            { to: ROUTES.electionDayOwnerUsers, label: ownerNav.users, icon: Users },
            {
              to: ROUTES.electionDayOwnerRoles,
              label: ownerNav.roles,
              icon: ShieldCheck,
            },
            {
              to: ROUTES.electionDayOwnerSettings,
              label: ownerNav.settings,
              icon: Settings,
            },
          ]
        : [],
    [isOwner],
  );

  // Only when the workspace actually has Budget: an Owner with no Budget
  // entitlement has no Budget menu to hang it on, and a settings link for a
  // module they do not own would be an orphan.
  const ownerBudgetItems = useMemo(
    () =>
      isOwner && budgetItems.length > 0
        ? [
            {
              to: ROUTES.electionDayOwnerBudgetSettings,
              label: BUDGET_TEXT.settings.title,
              icon: Wallet,
            },
          ]
        : [],
    [isOwner, budgetItems.length],
  );

  // Every owner-administration destination, in one list, for the phone bar
  // only - see `mobileNavItems` below for why it is not split there.
  const ownerItems = useMemo(
    () => [...ownerElectionDayItems, ...ownerBudgetItems],
    [ownerElectionDayItems, ownerBudgetItems],
  );

  const electionDaySections = useMemo(() => {
    // The module's own screens appear only when the workspace is entitled to
    // it; the Owner's administration items appear regardless, because an
    // Owner whose workspace is entitled to nothing must still be able to
    // administer it. The group is rendered when it has anything at all.
    const electionDayItems = [
      ...(showElectionDay ? visibleNavItems : []),
      ...ownerElectionDayItems,
    ];
    const budgetGroupItems = [...budgetItems, ...ownerBudgetItems];
    return [
      ...(electionDayItems.length > 0
        ? [{ label: ELECTION_DAY_NAV_SECTION_LABEL, items: electionDayItems }]
        : []),
      ...(budgetGroupItems.length > 0
        ? [{ label: BUDGET_NAV_SECTION_LABEL, items: budgetGroupItems }]
        : []),
    ];
  }, [
    showElectionDay,
    visibleNavItems,
    budgetItems,
    ownerElectionDayItems,
    ownerBudgetItems,
  ]);

  // Looks up against `allContacts` (unfiltered/unpaginated), not the Voters
  // screen's own filtered/paginated view - a voter opened from elsewhere
  // (e.g. the non-voting-reasons report drill-down) is very often NOT
  // present in the Voters screen's current filter, and must still be openable.
  const openContact = electionDay.allContacts.find((c) => c.id === openContactId) ?? null;

  const shellContext: ElectionDayShellContext = {
    ...electionDay,
    openContact: setOpenContactId,
  };

  return (
    <AppShell
      navItems={showVoterManagement ? NAV_ITEMS : []}
      navLabel={showVoterManagement ? VOTER_MANAGEMENT_NAV_SECTION_LABEL : undefined}
      sections={electionDaySections}
      workspaceName={sessionUser?.workspaceName}
      mobileNavItems={
        onOwnerAdminRoute && ownerItems.length > 0 ? ownerItems : visibleNavItems
      }
      footer={
        sessionUser
          ? {
              name: sessionUser.name,
              // The Owner's sentinel role id is not a catalog row, so looking
              // it up would read "תפקיד לא ידוע". Their standing is fixed, and
              // this is the label the Owner admin shell already used.
              subtitle: isOwner
                ? ELECTION_DAY_TEXT.owner.admin.accountRole
                : roleDisplayName(sessionUser.roleId, electionDay.roles),
              onLogout: logout,
            }
          : undefined
      }
    >
      <div className="mx-auto max-w-[1400px]">
        {budgetItems.length > 0 && (
          <div className="mb-3 flex justify-end md:hidden">
            <Link
              to={ROUTES.budget}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary-700 ring-1 ring-slate-200"
            >
              <ArrowLeftRight className="size-4" />
              {BUDGET_TEXT.nav.switchToBudget}
            </Link>
          </div>
        )}
        {/* The Owner's administration sections share this shell but are NOT
            the Election Day module: they must not be titled after it, and
            must not carry its countdown - which offers a deadline for a
            module the workspace may not even be entitled to. They carry no
            shared heading of their own either: every section already titles
            itself (Users, Roles & Permissions, Settings), so the group
            header above them said nothing the screen did not already say. */}
        {!onOwnerAdminRoute && (
          <>
            <PageHeader
              title={ELECTION_DAY_TEXT.title}
              subtitle={ELECTION_DAY_TEXT.subtitle}
            />

            <CountdownHeader
              deadline={electionDay.deadline}
              parts={countdownParts}
              onSetDeadline={(iso) => void electionDay.setElectionDayDeadline(iso)}
            />
          </>
        )}

        <Outlet context={shellContext} />
      </div>

      <ElectionDayContactModal
        contact={openContact}
        onClose={() => setOpenContactId(null)}
        onToggleRideRequested={(contact) => void electionDay.toggleRideRequested(contact)}
        onSendToDriver={(contact) => void electionDay.sendRideRequestToDriver(contact)}
        onCancelRideCoordination={(contact) =>
          void electionDay.cancelRideCoordination(contact)
        }
        onSetReminder={(contact, minutes) =>
          void electionDay.setReminder(contact.id, minutes)
        }
        onSetReminderAt={(contact, at) =>
          void electionDay.setReminderAt(contact.id, at.toISOString())
        }
        onCancelReminder={(contact) => void electionDay.cancelReminder(contact.id)}
        onLoadReminderEvents={(contactId) => electionDay.listReminderEvents(contactId)}
        onToggleVoted={(contact, voted) => void electionDay.setVoted(contact.id, voted)}
        onSetNonVotingReason={(id, reasonId) =>
          void electionDay.setNonVotingReason(id, reasonId)
        }
        onCloseCallAsNoAnswer={(id) => void electionDay.closeCallAsNoAnswer(id)}
        nonVotingReasons={electionDay.nonVotingReasons}
        onSetNotes={(id, notes) => void electionDay.setNotes(id, notes)}
        onSetPhone={electionDay.setPhone}
        settingPhone={electionDay.settingPhone}
        onIncrementCallAttempts={electionDay.incrementCallAttempts}
        incrementingCallAttempts={electionDay.incrementingCallAttempts}
        onRecordNoAnswer={electionDay.recordNoAnswer}
        onRecordCallAnswered={electionDay.recordCallAnswered}
        recordingCallOutcome={electionDay.recordingCallOutcome}
        onExtendNoAnswerStreakThreshold={electionDay.extendNoAnswerStreakThreshold}
      />

      {/* Security Hardening (Reauth): the shared password-reauth prompt for
          this hook's remaining legacy admin/import mutations (delete
          permission user, reset password, import) - reuses
          `AllocationPasswordDialog`'s existing visual pattern, same as the
          coordinator-allocation mutations already do. */}
      {electionDay.reauthDialog && (
        <AllocationPasswordDialog {...electionDay.reauthDialog} />
      )}

      {/* Phase 3 Import/Clear frontend cutover: independent password
          prompts, each a SEPARATE dialog instance from the legacy one above. */}
      {electionDay.importVotersReauthDialog && (
        <AllocationPasswordDialog {...electionDay.importVotersReauthDialog} />
      )}
      {electionDay.clearVotersReauthDialog && (
        <AllocationPasswordDialog {...electionDay.clearVotersReauthDialog} />
      )}

      <OverdueReminderStack
        contacts={electionDay.scopedContacts}
        onOpen={setOpenContactId}
      />
    </AppShell>
  );
}
