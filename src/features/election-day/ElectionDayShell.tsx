import { useMemo, useState } from "react";
import { Outlet, useOutletContext } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { ELECTION_DAY_NAV_SECTION_LABEL, NAV_ITEMS } from "../../constants/routes";
import { useAuth } from "../auth/authStore";
import { usePermissions } from "../../permissions/usePermissions";
import { AppShell } from "../../app/AppShell";
import { CountdownHeader } from "./CountdownHeader";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayContactModal } from "./ElectionDayContactModal";
import { getVisibleElectionDayNavItems } from "./electionDayNavVisibility";
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
  /** From `ElectionDayGuard`'s Outlet context - re-exposed here so screens
   * nested under this Shell's own `<Outlet context={shellContext}>` (which
   * shadows the Guard's context) can still read it, e.g.
   * `ElectionDayPermissionsPage` widening the "add first account" exception
   * to the Add-user form's visibility, matching `addPermissionUser`'s own
   * bootstrap exception in `useElectionDay.ts`. */
  isBootstrap: boolean;
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

  // Same managerOnly filter AppLayout.tsx applies to NAV_ITEMS, reused as-is
  // (not a new permission mechanism) - `useAuth`'s Supabase session listener
  // is already subscribed at module load regardless of route, so reading it
  // here costs no new fetch and doesn't connect Election Day's own login to
  // Supabase Auth in any way.
  const supabaseUser = useAuth((s) => s.user);
  const mainNavItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) => !item.managerOnly || supabaseUser?.role === "manager"),
    [supabaseUser?.role],
  );

  const visibleNavItems = useMemo(
    () => getVisibleElectionDayNavItems(can, isBootstrap),
    [can, isBootstrap],
  );

  const electionDaySections = useMemo(
    () => [{ label: ELECTION_DAY_NAV_SECTION_LABEL, items: visibleNavItems }],
    [visibleNavItems],
  );

  // Looks up against `allContacts` (unfiltered/unpaginated), not the Voters
  // screen's own filtered/paginated view - a voter opened from elsewhere
  // (e.g. the non-voting-reasons report drill-down) is very often NOT
  // present in the Voters screen's current filter, and must still be openable.
  const openContact = electionDay.allContacts.find((c) => c.id === openContactId) ?? null;

  const shellContext: ElectionDayShellContext = {
    ...electionDay,
    openContact: setOpenContactId,
    isBootstrap,
  };

  return (
    <AppShell
      navItems={mainNavItems}
      sections={electionDaySections}
      mobileNavItems={visibleNavItems}
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
        onCancelReminder={(contact) => void electionDay.cancelReminder(contact.id)}
        onCloseReminder={(contact) => void electionDay.closeReminder(contact.id)}
        onLoadReminderEvents={(contactId) => electionDay.listReminderEvents(contactId)}
        onToggleVoted={(contact, voted) => void electionDay.setVoted(contact.id, voted)}
        onSetNonVotingReason={(id, reasonId) =>
          void electionDay.setNonVotingReason(id, reasonId)
        }
        nonVotingReasons={electionDay.nonVotingReasons}
        onSetNotes={(id, notes) => void electionDay.setNotes(id, notes)}
        onSetPhone={electionDay.setPhone}
        settingPhone={electionDay.settingPhone}
        onIncrementCallAttempts={electionDay.incrementCallAttempts}
        incrementingCallAttempts={electionDay.incrementingCallAttempts}
        onExtendCallAttemptsThreshold={electionDay.extendCallAttemptsThreshold}
      />
    </AppShell>
  );
}
