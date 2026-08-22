import { Modal } from "../../components/ui/Modal";
import { telHref } from "../../lib/phone";
import type { Coordinator } from "../../types";
import {
  resolveCoordinatorPhoneForReminderRow,
  type CoordinatorReminderSupervisionRow,
} from "./coordinatorReminderSupervision";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { formatReminderDisplay, formatWaitingDuration } from "./reminderDisplay";

const text = ELECTION_DAY_TEXT.dashboard.reminderSupervision;

/**
 * Manager Dashboard Reminders detail modal - read-only drill-down into one
 * coordinator's currently-DUE reminders. Deliberately has no "פתח בוחר"
 * action (unlike every other voter-row surface in this app) - the manager
 * manages the coordinator's workload here, not an individual voter's case;
 * jumping into a specific voter's own record is the scoped coordinator's
 * job via their own personal popup/worklist, not this supervisory view's.
 *
 * Call action (2026-08-22): `row.coordinator` is a plain free-text name, not
 * a coordinator id - `resolveCoordinatorPhoneForReminderRow` resolves it
 * against `coordinators` by displayName/linkedAssignmentName and only
 * returns a phone when the name matches EXACTLY one row. No match, an
 * ambiguous match, or a null phone all mean no call action - never a
 * guessed number.
 */
export function CoordinatorReminderDetailModal({
  open,
  row,
  now,
  coordinators,
  onClose,
}: {
  open: boolean;
  row: CoordinatorReminderSupervisionRow | null;
  now: Date;
  coordinators: readonly Coordinator[];
  onClose: () => void;
}) {
  if (!row) return null;

  const phone = resolveCoordinatorPhoneForReminderRow(coordinators, row.coordinator);

  return (
    <Modal open={open} onClose={onClose} title={text.modal.header(row.coordinator)} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold text-slate-600">
          <span>{text.dueCount(row.dueCount)}</span>
          <span>{text.oldestWaiting(formatWaitingDuration(row.oldestReminderAt, now))}</span>
        </div>

        {phone && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-3 py-2">
            <span className="text-sm font-semibold text-slate-700">
              <span dir="ltr" className="tabular-nums">
                {text.modal.phoneLabel(phone)}
              </span>
            </span>
            <a
              href={telHref(phone)}
              className="ms-auto rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-700"
            >
              {text.modal.callButton(row.coordinator)}
            </a>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-xs text-slate-400">
                <th className="pb-1.5 text-start font-semibold">{text.modal.voterColumn}</th>
                <th className="pb-1.5 text-start font-semibold">
                  {text.modal.reminderTimeColumn}
                </th>
                <th className="pb-1.5 text-start font-semibold">
                  {text.modal.waitingColumn}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {row.voters.map((voter) => (
                <tr key={voter.id}>
                  <td className="py-1.5 font-semibold text-slate-700">
                    {voter.firstName} {voter.lastName}
                  </td>
                  <td className="py-1.5 tabular-nums text-slate-600">
                    {voter.reminderAt && formatReminderDisplay(voter.reminderAt, now)}
                  </td>
                  <td className="py-1.5 tabular-nums text-slate-600">
                    {voter.reminderAt && formatWaitingDuration(voter.reminderAt, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
