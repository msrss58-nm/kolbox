import { useState } from "react";
import { Tabs } from "../../components/ui/Tabs";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";
import { NonVotingReasonDrillDownModal } from "./NonVotingReasonDrillDownModal";
import { NonVotingReasonsCatalogPanel } from "./NonVotingReasonsCatalogPanel";
import { NonVotingReasonsReportCard } from "./NonVotingReasonsReportCard";
import { useNonVotingReasons } from "./useNonVotingReasons";

/**
 * "סיבות אי-הצבעה" screen: report + catalog as tabs over the same domain.
 * The drill-down trigger state (`reportReasonId`) is local to this page -
 * the Dashboard page owns its own copy for the same shared
 * `NonVotingReasonDrillDownModal`, since the drill-down can be opened from
 * either screen (see Blueprint - expected duplication, not a fork).
 */
export function ElectionDayReasonsPage() {
  const {
    nonVotingReasonReport,
    allContacts,
    nonVotingReasons,
    reloadNonVotingReasons,
    openContact,
  } = useElectionDayShell();
  const reasonsManagement = useNonVotingReasons(nonVotingReasons, reloadNonVotingReasons);
  const [reportReasonId, setReportReasonId] = useState<string | null>(null);

  return (
    <>
      <Tabs
        tabs={[
          {
            id: "report",
            label: ELECTION_DAY_TEXT.nonVotingReasonsReport.navButton,
            content: (
              <NonVotingReasonsReportCard
                rows={nonVotingReasonReport}
                onOpenReasonReport={setReportReasonId}
              />
            ),
          },
          {
            id: "catalog",
            label: ELECTION_DAY_TEXT.nonVotingReasonsManager.button,
            content: (
              <NonVotingReasonsCatalogPanel
                contacts={allContacts}
                reasonsManagement={reasonsManagement}
              />
            ),
          },
        ]}
      />

      <NonVotingReasonDrillDownModal
        open={reportReasonId !== null}
        onClose={() => setReportReasonId(null)}
        row={nonVotingReasonReport.find((r) => r.reasonId === reportReasonId) ?? null}
        onOpenVoter={(id) => {
          setReportReasonId(null);
          openContact(id);
        }}
      />
    </>
  );
}
