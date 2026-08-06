import type { ElectionDayVoter, NonVotingReason } from "../../types";

/**
 * A contact's follow-up status for the coordinator worklist:
 * - `"voted"` - already voted; nothing left to do.
 * - `"closed"` - not voted, but assigned a reason whose
 *   `requiresFollowUp === false` (e.g. "נפטר"/"עבר עיר") - the case is closed,
 *   no further calls needed.
 * - `"remaining"` - not voted and either has no reason yet, or a reason that
 *   still requires follow-up (e.g. "לא עונה") - the coordinator should keep
 *   trying.
 */
export type FollowUpStatus = "voted" | "closed" | "remaining";

/**
 * Resolves a single contact's follow-up status. This is the single source of
 * truth for this decision - other code (worklist filters, reports, badges)
 * must read through this function, never re-implement the logic inline.
 *
 * Precedence: `voted` always wins, regardless of any reason attached. Below
 * that, the decision is driven ONLY by the reason's `requiresFollowUp`
 * column - never by the reason's name/text. A missing, deleted, or otherwise
 * unresolvable `notVotingReasonId` (not present in `reasonsById`) defaults to
 * `"remaining"` - it never throws and never silently closes a case it can't
 * actually verify is closed.
 */
export function resolveFollowUpStatus(
  contact: ElectionDayVoter,
  reasonsById: ReadonlyMap<string, NonVotingReason>,
): FollowUpStatus {
  if (contact.voted) return "voted";
  if (contact.notVotingReasonId) {
    const reason = reasonsById.get(contact.notVotingReasonId);
    if (reason && reason.requiresFollowUp === false) return "closed";
  }
  return "remaining";
}
