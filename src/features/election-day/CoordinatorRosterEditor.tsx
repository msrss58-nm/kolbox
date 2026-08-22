import { useMemo, useState } from "react";
import { Check, Link2, Pencil, Phone, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import { isValidIsraeliPhone, normalizeIsraeliPhone } from "../../lib/phone";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import {
  countVotersWithRawCoordinatorName,
  resolveMissingCoordinatorNames,
} from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.roster;
const detectedText = text.detected;

/**
 * Coordinator Allocation Management (Phase 5): "today's coordinators" roster
 * - add/rename/remove + the explicit Excel-assignment link/relink/unlink
 * flow (`countVotersWithRawCoordinatorName`, exact-match-only, never
 * fuzzy/automatic - see that function's own comment). Used both as Setup
 * Step 1 and as the always-available "הוסף אחראי" section in the live
 * management view - both call sites now pass `allowRename allowRemove`
 * (true), since the server's `edit`/`remove` guard (2026-08-21) is a real
 * per-coordinator predicate (participation history + currently-assigned
 * voters), not the old global activity flag that made hiding these
 * conservatively necessary in the live view.
 *
 * Per-row eligibility (`isEligibleForEditOrRemove`, below): a certain,
 * client-computable proxy for "no voter currently assigned" via
 * `countVotersWithRawCoordinatorName(contacts, c.displayName)` PLUS the same
 * check against `c.linkedAssignmentName` when set - the exact same two-name
 * free-text match `election_day_end_coordinator_activity_v2` has always used
 * (`v_source_names`) and the final identity-invariant RPC (2026-08-21) now
 * also uses for its own `edit`/`remove` voter check - so a row with any
 * voter matching EITHER identity name is disabled with an inline reason
 * (`assignedVotersReason`), zero RPC round trip. Two OTHER conditions the
 * same RPC also enforces have no cheap client-side signal: real
 * participation/history, and a `election_day_permission_users.name` sharing
 * either identity name (the app's `assigned_to_me` login scoping matches
 * purely by that same free-text string, with zero relationship to this
 * table - see `electionDayScope.ts`). Fetching either signal just to render
 * row state would mean a new per-coordinator RPC call or a whole extra
 * permission-users fetch in this component tree, for a rare edge case - so
 * both stay client-blind by design, and a blocked attempt on either surfaces
 * through the normal error-toast mapper
 * (`DISPLAY_NAME_LOCKED`/`COORDINATOR_LOCKED`/`COORDINATOR_HAS_LOGIN_ACCOUNT`)
 * instead - exactly the "frontend pre-checks are UX only, RPC remains
 * authoritative" contract this feature
 * was built to respect. Link/unlink/relink stay visible in both call sites,
 * unchanged - that lock is per-coordinator (`COORDINATOR_LOCKED`) and always
 * has been, nothing about this change alters those three actions.
 *
 * Security Hardening (Reauth), Phase 2: every action here is a single
 * explicit user click -> one `onManage([action], copy)` call, which runs
 * through `useCoordinatorAllocation`'s shared `reauth.gate` - the first
 * action after a page load (or after the cached proof expires/is revoked)
 * shows the shared `AllocationPasswordDialog` with this action's own
 * `copy`; every further action within the ~15-minute proof lifetime runs
 * immediately with no dialog at all. Always a single-element `actions`
 * array - never a staged multi-edit batch, so there is no "promised atomic
 * batch UX" to accidentally break into N separate calls (see the Phase 5
 * spec's "ADD + LINK LIMITATION" section - a newly-added coordinator's id is
 * only known after this component's own reload, so a later link is
 * naturally its own explicit action, never invented as a client-side temp
 * id).
 */
export function CoordinatorRosterEditor({
  coordinators,
  contacts,
  onManage,
  busy,
  allowRename,
  allowRemove,
}: {
  coordinators: Coordinator[];
  contacts: readonly ElectionDayVoter[];
  onManage: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  busy: boolean;
  allowRename: boolean;
  allowRemove: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingPhoneId, setEditingPhoneId] = useState<string | null>(null);
  const [editingPhoneValue, setEditingPhoneValue] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Read-only: distinct, non-empty `voter.coordinator` names not yet
  // represented by any coordinator entity (any status) - see
  // `resolveMissingCoordinatorNames`'s own comment. Computed fresh from
  // already-fetched props on every render; opening/viewing this screen never
  // writes anything on its own - a name only becomes a real
  // `election_day_coordinators` row when its own "הוסף" button below is
  // explicitly clicked, going through the exact same `onManage` call (same
  // permission + reauth gate) as typing it into the field above by hand.
  const missingCoordinatorNames = useMemo(
    () => resolveMissingCoordinatorNames(coordinators, contacts),
    [coordinators, contacts],
  );

  const handleAddDetectedClick = (detectedName: string) =>
    onManage([{ action: "add", displayName: detectedName }], {
      title: text.confirm.addTitle,
      summary: text.confirm.addSummary(detectedName),
      confirmLabel: text.confirm.confirmButton,
    });

  const isDuplicateActiveName = (candidate: string, excludeId?: string) =>
    coordinators.some(
      (c) => c.status === "active" && c.id !== excludeId && c.displayName === candidate,
    );

  const handleAddClick = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(text.emptyNameBlocked);
      return;
    }
    if (isDuplicateActiveName(trimmed)) {
      toast.error(text.duplicateActiveName);
      return;
    }
    let normalizedPhone: string | undefined;
    if (phone.trim()) {
      normalizedPhone = normalizeIsraeliPhone(phone);
      if (!isValidIsraeliPhone(normalizedPhone)) {
        toast.error(text.invalidPhone);
        return;
      }
    }
    const result = await onManage(
      [{ action: "add", displayName: trimmed, phone: normalizedPhone }],
      {
        title: text.confirm.addTitle,
        summary: text.confirm.addSummary(trimmed),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) {
      setName("");
      setPhone("");
    }
  };

  const startPhoneEdit = (c: Coordinator) => {
    setEditingPhoneId(c.id);
    setEditingPhoneValue(c.phone ?? "");
    setPhoneError(null);
  };
  const cancelPhoneEdit = () => {
    setEditingPhoneId(null);
    setEditingPhoneValue("");
    setPhoneError(null);
  };
  const confirmPhoneEditClick = async (c: Coordinator) => {
    const trimmed = editingPhoneValue.trim();
    let normalizedPhone: string | undefined;
    if (trimmed) {
      normalizedPhone = normalizeIsraeliPhone(trimmed);
      if (!isValidIsraeliPhone(normalizedPhone)) {
        setPhoneError(text.invalidPhone);
        return;
      }
    }
    // Same reauth-gated `onManage` path as every other coordinator
    // mutation (unchanged) - only the RPC's own server-side guard differs:
    // `update_phone` carries none of `edit`'s identity/participation checks
    // (contact metadata, not identity), so this call succeeds even for a
    // coordinator whose name/status edits are currently blocked.
    const result = await onManage(
      [{ action: "update_phone", coordinatorId: c.id, phone: normalizedPhone }],
      {
        title: text.confirm.editPhoneTitle,
        summary: text.confirm.editPhoneSummary(c.displayName),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) cancelPhoneEdit();
  };

  const startEdit = (c: Coordinator) => {
    setEditingId(c.id);
    setEditingName(c.displayName);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };
  const confirmEditClick = async (c: Coordinator) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      toast.error(text.emptyNameBlocked);
      return;
    }
    if (trimmed === c.displayName) {
      cancelEdit();
      return;
    }
    if (isDuplicateActiveName(trimmed, c.id)) {
      toast.error(text.duplicateActiveName);
      return;
    }
    const result = await onManage(
      [{ action: "edit", coordinatorId: c.id, displayName: trimmed }],
      {
        title: text.confirm.editTitle,
        summary: text.confirm.editSummary(c.displayName, trimmed),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) cancelEdit();
  };

  const handleRemoveClick = (c: Coordinator) =>
    onManage([{ action: "remove", coordinatorId: c.id }], {
      title: text.confirm.removeTitle,
      summary: text.confirm.removeSummary(c.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  const handleLinkClick = (c: Coordinator, kind: "link" | "relink") =>
    onManage(
      [{ action: kind, coordinatorId: c.id, linkedAssignmentName: c.displayName }],
      {
        title: text.confirm.linkTitle,
        summary: text.confirm.linkSummary(c.displayName),
        confirmLabel: text.confirm.confirmButton,
      },
    );

  const handleUnlinkClick = (c: Coordinator) =>
    onManage([{ action: "unlink", coordinatorId: c.id }], {
      title: text.confirm.unlinkTitle,
      summary: text.confirm.unlinkSummary(c.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  return (
    <div className="space-y-5">
      <Field label={text.nameLabel}>
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={text.namePlaceholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddClick();
            }}
            className="flex-1"
          />
        </div>
      </Field>
      <Field label={text.phoneLabel}>
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={text.phonePlaceholder}
          dir="ltr"
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAddClick();
          }}
        />
      </Field>
      <Button className="w-full" disabled={busy} onClick={() => void handleAddClick()}>
        ➕ {text.addButton}
      </Button>

      {missingCoordinatorNames.length > 0 && (
        <div className="space-y-2 rounded-xl bg-primary-50 p-3">
          <div>
            <p className="text-xs font-bold text-primary-800">
              {detectedText.sectionLabel}
            </p>
            <p className="text-xs text-primary-700">{detectedText.hint}</p>
          </div>
          <ul className="space-y-1.5">
            {missingCoordinatorNames.map((detectedName) => (
              <li
                key={detectedName}
                className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-primary-100"
              >
                <span className="min-w-0 truncate font-semibold text-slate-700">
                  {detectedName}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleAddDetectedClick(detectedName)}
                  aria-label={detectedText.addAriaLabel(detectedName)}
                  className="shrink-0 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-700 disabled:opacity-50"
                >
                  {detectedText.addButton}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {coordinators.length === 0 ? (
        <EmptyState icon={UserPlus} title={text.empty} hint={text.emptyHint} dense />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
          {coordinators.map((c) => {
            const isEditing = editingId === c.id;
            const assignedCount =
              countVotersWithRawCoordinatorName(contacts, c.displayName) +
              (c.linkedAssignmentName !== null
                ? countVotersWithRawCoordinatorName(contacts, c.linkedAssignmentName)
                : 0);
            const isEligibleForEditOrRemove = assignedCount === 0;
            const showLinkSuggestion =
              c.linkedAssignmentName === null &&
              countVotersWithRawCoordinatorName(contacts, c.displayName) > 0;
            const showRelinkSuggestion =
              c.linkedAssignmentName !== null &&
              c.linkedAssignmentName !== c.displayName &&
              countVotersWithRawCoordinatorName(contacts, c.displayName) > 0;
            const suggestionCount = countVotersWithRawCoordinatorName(
              contacts,
              c.displayName,
            );

            return (
              <li key={c.id} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  {isEditing && allowRename ? (
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void confirmEditClick(c);
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmEditClick(c)}
                        aria-label={text.saveAriaLabel}
                        className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
                      >
                        <Check className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        aria-label={text.cancelEditAriaLabel}
                        className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">
                          {c.displayName}
                          {c.status === "ended" && (
                            <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                              {text.endedBadge}
                            </span>
                          )}
                        </p>
                        {c.linkedAssignmentName !== null && (
                          <p className="truncate text-xs text-slate-500">
                            {text.linkedBadge(c.linkedAssignmentName)}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {allowRename && c.status === "active" && (
                          <button
                            type="button"
                            disabled={!isEligibleForEditOrRemove}
                            onClick={() => isEligibleForEditOrRemove && startEdit(c)}
                            aria-label={
                              isEligibleForEditOrRemove
                                ? text.editAriaLabel
                                : text.editAriaLabelBlocked
                            }
                            className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <Pencil className="size-4" />
                          </button>
                        )}
                        {allowRemove && c.status === "active" && (
                          <button
                            type="button"
                            disabled={busy || !isEligibleForEditOrRemove}
                            onClick={() => void handleRemoveClick(c)}
                            aria-label={
                              isEligibleForEditOrRemove
                                ? text.removeAriaLabel
                                : text.removeAriaLabelBlocked
                            }
                            className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {!isEligibleForEditOrRemove &&
                  c.status === "active" &&
                  (allowRename || allowRemove) && (
                    <p className="text-xs text-slate-500">{text.assignedVotersReason}</p>
                  )}

                {/* Phone is CONTACT METADATA, not identity - a plain
                    inline field, editable regardless of the name-lock state
                    above (no visual grouping with the identity pencil/trash
                    icons). */}
                {editingPhoneId === c.id ? (
                  <div className="flex items-center gap-2">
                    <Phone className="size-3.5 shrink-0 text-slate-400" />
                    <Input
                      value={editingPhoneValue}
                      onChange={(e) => {
                        setEditingPhoneValue(e.target.value);
                        if (phoneError) setPhoneError(null);
                      }}
                      placeholder={text.phonePlaceholder}
                      dir="ltr"
                      invalid={!!phoneError}
                      autoFocus
                      className="flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmPhoneEditClick(c);
                        if (e.key === "Escape") cancelPhoneEdit();
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void confirmPhoneEditClick(c)}
                      aria-label={text.savePhoneAriaLabel}
                      className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
                    >
                      <Check className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelPhoneEdit}
                      aria-label={text.cancelPhoneEditAriaLabel}
                      className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => startPhoneEdit(c)}
                    aria-label={text.editPhoneAriaLabel}
                    className="flex w-fit items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-primary-600"
                  >
                    <Phone className="size-3.5 shrink-0" />
                    {c.phone ? (
                      <span dir="ltr" className="tabular-nums">
                        {c.phone}
                      </span>
                    ) : (
                      text.addPhoneLink
                    )}
                  </button>
                )}
                {phoneError && editingPhoneId === c.id && (
                  <p className="text-xs text-opponent">{phoneError}</p>
                )}

                {showLinkSuggestion && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800">
                    <Link2 className="size-3.5 shrink-0" />
                    <span>{text.linkSuggestion(suggestionCount, c.displayName)}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleLinkClick(c, "link")}
                      className="ms-auto font-semibold underline hover:no-underline"
                    >
                      {text.linkButton}
                    </button>
                  </div>
                )}

                {showRelinkSuggestion && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800">
                    <Link2 className="size-3.5 shrink-0" />
                    <span>{text.linkSuggestion(suggestionCount, c.displayName)}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleLinkClick(c, "relink")}
                      className="ms-auto font-semibold underline hover:no-underline"
                    >
                      {text.relinkButton}
                    </button>
                  </div>
                )}

                {c.linkedAssignmentName !== null && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlinkClick(c)}
                    className="self-start text-xs font-semibold text-slate-500 underline hover:no-underline"
                  >
                    {text.unlinkButton}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
