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
 * Coordinator Management row-level actions (rename/phone/remove/link/relink/
 * unlink) for ONE coordinator - the same business logic both
 * `CoordinatorRow` (Setup's flex-column list) and
 * `CoordinatorAllocationLive`'s column-aligned grid table need, factored out
 * so neither layout has to duplicate the `onManage` wiring or the eligibility
 * computation. This hook owns state + handlers + derived booleans only -
 * every caller renders its own JSX.
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
  const suggestionCount = countVotersWithRawCoordinatorName(
    contacts,
    coordinator.displayName,
  );
  const showLinkSuggestion =
    coordinator.linkedAssignmentName === null && suggestionCount > 0;
  const showRelinkSuggestion =
    coordinator.linkedAssignmentName !== null &&
    coordinator.linkedAssignmentName !== coordinator.displayName &&
    suggestionCount > 0;

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

  const handleLinkClick = (kind: "link" | "relink") =>
    onManage(
      [
        {
          action: kind,
          coordinatorId: coordinator.id,
          linkedAssignmentName: coordinator.displayName,
        },
      ],
      {
        title: text.confirm.linkTitle,
        summary: text.confirm.linkSummary(coordinator.displayName),
        confirmLabel: text.confirm.confirmButton,
      },
    );

  const handleUnlinkClick = () =>
    onManage([{ action: "unlink", coordinatorId: coordinator.id }], {
      title: text.confirm.unlinkTitle,
      summary: text.confirm.unlinkSummary(coordinator.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  return {
    isEligibleForEditOrRemove,
    showLinkSuggestion,
    showRelinkSuggestion,
    suggestionCount,
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
    handleLinkClick,
    handleUnlinkClick,
  };
}
