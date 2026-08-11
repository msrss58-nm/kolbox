import { useState } from "react";
import { ElectionDayDashboard } from "./ElectionDayDashboard";
import { NonVotingReasonDrillDownModal } from "./NonVotingReasonDrillDownModal";
import { useElectionDayShell } from "./ElectionDayShell";

export function ElectionDayDashboardPage() {
  const electionDay = useElectionDayShell();
  // Which non-voting reason's drill-down is open - not lifted to the Shell
  // (only `openContact` was), so it lives here, local to the screen that
  // triggers it. See `NonVotingReasonsReportCard` / `NonVotingReasonDrillDownModal`.
  const [reportReasonId, setReportReasonId] = useState<string | null>(null);

  return (
    <>
      <ElectionDayDashboard
        stats={electionDay.stats}
        coordinatorBreakdown={electionDay.coordinatorBreakdown}
        followUpBreakdown={electionDay.followUpBreakdown}
        closedRemindersToday={electionDay.closedRemindersToday}
        rideStatusBreakdown={electionDay.rideStatusBreakdown}
        attentionAlerts={electionDay.attentionAlerts}
        turnoutPace={electionDay.turnoutPace}
        lastUpdatedAt={electionDay.lastUpdatedAt}
        onRefresh={electionDay.refresh}
        rideCoordinationQueue={electionDay.rideCoordinationQueue}
        onToggleRideCompleted={(contact, completed) =>
          void electionDay.setRideCompleted(contact.id, completed)
        }
        nonVotingReasonReport={electionDay.nonVotingReasonReport}
        onOpenReasonReport={setReportReasonId}
        closedReasonBreakdown={electionDay.closedReasonBreakdown}
        callAttemptsWatchlist={electionDay.callAttemptsWatchlist}
        onOpenVoter={electionDay.openContact}
        loaded={electionDay.loaded}
      />

      <NonVotingReasonDrillDownModal
        open={reportReasonId !== null}
        onClose={() => setReportReasonId(null)}
        row={
          electionDay.nonVotingReasonReport.find((r) => r.reasonId === reportReasonId) ??
          null
        }
        onOpenVoter={(id) => {
          setReportReasonId(null);
          electionDay.openContact(id);
        }}
      />
    </>
  );
}
