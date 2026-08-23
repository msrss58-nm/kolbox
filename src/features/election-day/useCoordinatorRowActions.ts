import { useState } from "react";
import { toast } from "../../components/ui/Toast";
import { isValidIsraeliPhone, normalizeIsraeliPhone } from "../../lib/phone";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { countVotersWithRawCoordinatorName } from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.roster;

/**
 * Coordinator Management row-level actions (rename/phone/remove/unlink) for
 * ONE coordinator - the same business logic both `CoordinatorRow` (Setup's
 * flex-column list) and `CoordinatorAllocationLive`'s column-aligned grid
 * table need, factored out so neither layout has to duplicate the `onManage`
 * wiring or the eligibility computation. This hook owns state + handlers +
 * derived booleans only - every caller renders its own JSX.
 *
 * The "link"/"relink" suggestion UI (auto-detected from a raw Excel name
 * match, used only to preserve a coordinator's voter-linkage across a
 * pre-activity rename) was removed 2026-08-23 - product decision:
 * responsibility changes now go through add-new/transfer/end, never a
 * rename, so the suggestion was permanent noise with no normal-operation
 * use. `handleUnlinkClick` and the `linkedAssignmentName`-aware
 * `assignedCount`/eligibility logic below are untouched - they manage/read
 * an EXISTING link, which is a different, still-supported concern; the
 * `link`/`relink` actions themselves remain fully intact in
 * `CoordinatorAction`/the RPC/API layer for any existing or future caller,
 * only this hook's own UI-triggering wrapper was removed.
 */
export function useCoordinatorRowActions(
  coordinator: Coordinator,
  contacts: readonly ElectionDayVoter[],
  allCoordinators: readonly Coordinator[],
  onManage: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>,
) {
  const [isEditingName, setIsEditingName] = useState(false);
  const [editingName, setEditingName] = useState(coordinator.displayName);
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [editingPhoneValue, setEditingPhoneValue] = useState(coordinator.phone ?? "");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const assignedCount =
    countVotersWithRawCoordinatorName(contacts, coordinator.displayName) +
    (coordinator.linkedAssignmentName !== null
      ? countVotersWithRawCoordinatorName(contacts, coordinator.linkedAssignmentName)
      : 0);
  const isEligibleForEditOrRemove = assignedCount === 0;

  const isDuplicateActiveName = (candidate: string) =>
    allCoordinators.some(
      (c) =>
        c.status === "active" && c.id !== coordinator.id && c.displayName === candidate,
    );

  const startEdit = () => {
    setEditingName(coordinator.displayName);
    setIsEditingName(true);
  };
  const cancelEdit = () => setIsEditingName(false);
  const confirmEdit = async () => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      toast.error(text.emptyNameBlocked);
      return;
    }
    if (trimmed === coordinator.displayName) {
      setIsEditingName(false);
      return;
    }
    if (isDuplicateActiveName(trimmed)) {
      toast.error(text.duplicateActiveName);
      return;
    }
    const result = await onManage(
      [{ action: "edit", coordinatorId: coordinator.id, displayName: trimmed }],
      {
        title: text.confirm.editTitle,
        summary: text.confirm.editSummary(coordinator.displayName, trimmed),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) setIsEditingName(false);
  };

  const startPhoneEdit = () => {
    setEditingPhoneValue(coordinator.phone ?? "");
    setPhoneError(null);
    setIsEditingPhone(true);
  };
  const cancelPhoneEdit = () => {
    setIsEditingPhone(false);
    setPhoneError(null);
  };
  const confirmPhoneEdit = async () => {
    const trimmed = editingPhoneValue.trim();
    let normalizedPhone: string | undefined;
    if (trimmed) {
      normalizedPhone = normalizeIsraeliPhone(trimmed);
      if (!isValidIsraeliPhone(normalizedPhone)) {
        setPhoneError(text.invalidPhone);
        return;
      }
    }
    const result = await onManage(
      [{ action: "update_phone", coordinatorId: coordinator.id, phone: normalizedPhone }],
      {
        title: text.confirm.editPhoneTitle,
        summary: text.confirm.editPhoneSummary(coordinator.displayName),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) setIsEditingPhone(false);
  };

  const handleRemoveClick = () =>
    onManage([{ action: "remove", coordinatorId: coordinator.id }], {
      title: text.confirm.removeTitle,
      summary: text.confirm.removeSummary(coordinator.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  const handleUnlinkClick = () =>
    onManage([{ action: "unlink", coordinatorId: coordinator.id }], {
      title: text.confirm.unlinkTitle,
      summary: text.confirm.unlinkSummary(coordinator.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  return {
    isEligibleForEditOrRemove,
    isEditingName,
    editingName,
    setEditingName,
    startEdit,
    cancelEdit,
    confirmEdit,
    isEditingPhone,
    editingPhoneValue,
    setEditingPhoneValue,
    phoneError,
    startPhoneEdit,
    cancelPhoneEdit,
    confirmPhoneEdit,
    handleRemoveClick,
    handleUnlinkClick,
  };
}
