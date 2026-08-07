import { Modal } from "../../components/ui/Modal";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { RideCoordinationTable } from "./RideCoordinationTable";

/** Thin nav-menu wrapper around the dashboard's own `RideCoordinationTable`
 * - a second entry point to the exact same data/component, not a fork of it.
 * Keep it that way: any behavior change belongs in the table itself. */
export function RideTableModal({
  open,
  onClose,
  contacts,
  onToggleCompleted,
}: {
  open: boolean;
  onClose: () => void;
  contacts: ElectionDayVoter[];
  onToggleCompleted: (contact: ElectionDayVoter, completed: boolean) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ELECTION_DAY_TEXT.rideTableModal.modalTitle}
      wide
    >
      <RideCoordinationTable contacts={contacts} onToggleCompleted={onToggleCompleted} />
    </Modal>
  );
}
