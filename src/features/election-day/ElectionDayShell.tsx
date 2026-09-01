import { useMemo, useState } from "react";
import { Outlet, useNavigate, useOutletContext } from "react-router";
import { PageHeader } from "../../components/PageHeader";
import { toast } from "../../components/ui/Toast";
import { COMMON_TEXT } from "../../constants/common-text";
import {
  ELECTION_DAY_NAV_SECTION_LABEL,
  NAV_ITEMS,
  ROUTES,
} from "../../constants/routes";
import { useAuth } from "../auth/authStore";
import { usePermissions } from "../../permissions/usePermissions";
import { AppShell } from "../../app/AppShell";
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
      navigate(ROUTES.electionDayLogin, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : COMMON_TEXT.genericError);
    }
  };
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

  const visibleNavItems = useMemo(() => getVisibleElectionDayNavItems(can), [can]);

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

      {/* Phase 3C: the independent trusted-v3 password prompts for
          create/delete/reset-password - each a SEPARATE dialog instance
          from the legacy one above and from one another, never sharing
          pending/proof state. */}
      {electionDay.createUserReauthDialog && (
        <AllocationPasswordDialog {...electionDay.createUserReauthDialog} />
      )}
      {electionDay.deleteUserReauthDialog && (
        <AllocationPasswordDialog {...electionDay.deleteUserReauthDialog} />
      )}
      {electionDay.resetPasswordReauthDialog && (
        <AllocationPasswordDialog {...electionDay.resetPasswordReauthDialog} />
      )}

      {/* Phase 3 Import/Clear frontend cutover: same independent-dialog
          pattern as the 3 PermissionUser flows above. */}
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
