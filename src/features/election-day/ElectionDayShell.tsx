import { useState } from "react";
import { Outlet, useOutletContext } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { ELECTION_DAY_NAV_ITEMS, ELECTION_DAY_ROUTES } from "../../constants/routes";
import { usePermissions } from "../../permissions/usePermissions";
import { AppShell } from "../../app/AppShell";
import { CountdownHeader } from "./CountdownHeader";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayContactModal } from "./ElectionDayContactModal";
import { useElectionDaySession } from "./electionDaySession";
import type { ElectionDayOutletContext as BootstrapContext } from "./ElectionDayGuard";
import { roleDisplayName } from "./roleDisplayName";
import { useCountdown } from "./useCountdown";
import { useElectionDay, type ElectionDayHook } from "./useElectionDay";

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
  const { isBootstrap } = useOutletContext<BootstrapContext>();
  const electionDay = useElectionDay(isBootstrap);
  const countdownParts = useCountdown(electionDay.deadline);
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const sessionUser = useElectionDaySession((s) => s.user);
  const logout = useElectionDaySession((s) => s.logout);
  const { can } = usePermissions();

  // Per-screen visibility - mirrors exactly what the retired
  // ElectionDayNav.tsx accordion's per-category gating checked, just applied
  // to a route instead of an accordion section. `isBootstrap` widens ONLY
  // the permissions screen (same one deliberate exception as before - see
  // useElectionDay.ts's addPermissionUser and CLAUDE.md).
  const showFiles = can("electionDay.import") || can("electionDay.clearData");
  const showPermissions =
    can("electionDay.manageUsers") ||
    can("electionDay.manageRolesAndPermissions") ||
    isBootstrap;
  const showRides = can("electionDay.manageRideCoordinators");
  const showReasons =
    can("electionDay.manageNonVotingReasons") || can("voter.viewVotedStatus");
  const showReports = can("electionDay.export");

  const visibleNavItems = ELECTION_DAY_NAV_ITEMS.filter((item) => {
    if (item.to === ELECTION_DAY_ROUTES.files) return showFiles;
    if (item.to === ELECTION_DAY_ROUTES.permissions) return showPermissions;
    if (item.to === ELECTION_DAY_ROUTES.rides) return showRides;
    if (item.to === ELECTION_DAY_ROUTES.reasons) return showReasons;
    if (item.to === ELECTION_DAY_ROUTES.reports) return showReports;
    return true; // dashboard + voters: always visible to any signed-in session
  });

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
      navItems={visibleNavItems}
      footer={
        sessionUser
          ? {
              name: sessionUser.name,
              subtitle: roleDisplayName(sessionUser.roleId, electionDay.roles),
              onLogout: logout,
            }
          : undefined
      }
    >
      <div className="mx-auto max-w-[1400px]">
        <PageHeader
          title={ELECTION_DAY_TEXT.title}
          subtitle={ELECTION_DAY_TEXT.subtitle}
        />

        <CountdownHeader
          deadline={electionDay.deadline}
          parts={countdownParts}
          onSetDeadline={(iso) => void electionDay.setElectionDayDeadline(iso)}
        />

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
        onCancelReminder={(contact) => void electionDay.setReminder(contact.id, null)}
        onToggleVoted={(contact, voted) => void electionDay.setVoted(contact.id, voted)}
        onSetNonVotingReason={(id, reasonId) =>
          void electionDay.setNonVotingReason(id, reasonId)
        }
        nonVotingReasons={electionDay.nonVotingReasons}
        onSetNotes={(id, notes) => void electionDay.setNotes(id, notes)}
        onSetPhone={electionDay.setPhone}
        settingPhone={electionDay.settingPhone}
        onIncrementCallAttempts={electionDay.incrementCallAttempts}
        onExtendCallAttemptsThreshold={electionDay.extendCallAttemptsThreshold}
      />
    </AppShell>
  );
}
