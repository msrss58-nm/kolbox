import { Modal } from "../../components/ui/Modal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { NonVotingReasonsReportCard } from "./NonVotingReasonsReportCard";
import type { NonVotingReasonReportRow } from "./nonVotingReasonReport";

/** Thin nav-menu wrapper around the dashboard's own `NonVotingReasonsReportCard`
 * - a second entry point to the exact same data/component, not a fork of it.
 * Keep it that way: any behavior change belongs in the card itself. */
export function NonVotingReasonsReportModal({
  open,
  onClose,
  rows,
  onOpenReasonReport,
}: {
  open: boolean;
  onClose: () => void;
  rows: NonVotingReasonReportRow[];
  onOpenReasonReport: (reasonId: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ELECTION_DAY_TEXT.nonVotingReasonsReport.modalTitle}
    >
      <NonVotingReasonsReportCard rows={rows} onOpenReasonReport={onOpenReasonReport} />
    </Modal>
  );
}
