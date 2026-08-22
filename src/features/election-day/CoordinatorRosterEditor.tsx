import { useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import { COMMON_TEXT } from "../../constants/common-text";
import { isValidIsraeliPhone, normalizeIsraeliPhone } from "../../lib/phone";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { CoordinatorRow } from "./CoordinatorRow";
import { resolveMissingCoordinatorNames } from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.roster;
const detectedText = text.detected;
const liveText = ELECTION_DAY_TEXT.coordinatorAllocation.live;

/**
 * Coordinator Allocation Management (Phase 5): the "add a coordinator" form
 * (name + optional phone + detected-from-import suggestions), plus - only
 * where `showExistingCoordinators` is true - the full existing-coordinator
 * management list (rename/phone/remove + the explicit Excel-assignment
 * link/relink/unlink flow, via `CoordinatorRow`).
 *
 * Two call sites, two different needs (UX fix, 2026-08-22): the Setup
 * wizard's dedicated "coordinators" step (`CoordinatorAllocationSetup.tsx`)
 * keeps the default `showExistingCoordinators` (true) - this component is its
 * only coordinator list - and now ALSO passes `collapsibleAddForm` so its add
 * form behaves exactly like the live view's (closed by default, behind an
 * explicit "➕ הוסף אחראי" toggle, with a real `ביטול`) instead of always
 * being open with no way to back out of it (a UX inconsistency found and
 * fixed 2026-08-22 - Setup's add form used to have no trigger and therefore
 * no meaningful cancel). The live/day-of view's collapsible "➕ הוסף אחראי"
 * panel (`CoordinatorAllocationLive.tsx`) instead passes
 * `showExistingCoordinators={false}` and controls the WHOLE component's
 * mount/unmount itself via its own `onCancelAdd` - adding a coordinator and
 * managing an existing one are different actions there, and that screen
 * already has its own always-visible main "אחראים" table where `הסר אחראי`
 * lives alongside `העבר הקצאות`/`סיום פעילות` (via the same `CoordinatorRow`'s
 * underlying `useCoordinatorRowActions` hook, called directly from that
 * table's own row component instead). Both call sites reuse the exact same
 * add-form state/handlers below - only the show/hide mechanism differs
 * (parent-controlled mount for Live, this component's own internal toggle
 * for Setup) - no add-form logic is duplicated between them.
 */
export function CoordinatorRosterEditor({
  coordinators,
  contacts,
  onManage,
  busy,
  allowRename,
  allowRemove,
  onCancelAdd,
  showExistingCoordinators = true,
  collapsibleAddForm = false,
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
  /** When provided, an explicit `ביטול` action is shown next to the add
   * button - closes the caller's own add-coordinator panel (e.g.
   * `CoordinatorAllocationLive.tsx`'s collapsible "הוסף אחראי" section).
   * Omitted where this editor has no such panel to close (the Setup
   * wizard's dedicated coordinators step - it uses `collapsibleAddForm`
   * instead, a self-contained toggle, since it has no parent panel to
   * collapse). */
  onCancelAdd?: () => void;
  /** Default true. False hides the existing-coordinator management list
   * entirely - see this file's own comment above for why. */
  showExistingCoordinators?: boolean;
  /** Default false (the add form is always visible, e.g. inside Live's own
   * parent-controlled panel). True makes this component manage its OWN
   * "➕ הוסף אחראי" toggle - the add form starts closed, opens on click, and
   * its `ביטול` closes it back (in addition to clearing name/phone) rather
   * than calling `onCancelAdd` (there is no parent panel to unmount here -
   * the existing-coordinator list/detected-suggestions stay visible either
   * way). Used by `CoordinatorAllocationSetup.tsx`. */
  collapsibleAddForm?: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [showAddForm, setShowAddForm] = useState(!collapsibleAddForm);

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

  const isDuplicateActiveName = (candidate: string) =>
    coordinators.some((c) => c.status === "active" && c.displayName === candidate);

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

  const handleCancelAdd = () => {
    setName("");
    setPhone("");
    if (collapsibleAddForm) setShowAddForm(false);
    onCancelAdd?.();
  };

  return (
    <div className="space-y-5">
      {collapsibleAddForm && !showAddForm ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => setShowAddForm(true)}
        >
          ➕ {liveText.addCoordinatorButton}
        </Button>
      ) : (
        <>
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
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => void handleAddClick()}
            >
              ➕ {text.addButton}
            </Button>
            {(onCancelAdd || collapsibleAddForm) && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={handleCancelAdd}
              >
                {COMMON_TEXT.cancel}
              </Button>
            )}
          </div>
        </>
      )}

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

      {showExistingCoordinators &&
        (coordinators.length === 0 ? (
          <EmptyState icon={UserPlus} title={text.empty} hint={text.emptyHint} dense />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
            {coordinators.map((c) => (
              <CoordinatorRow
                key={c.id}
                coordinator={c}
                contacts={contacts}
                allCoordinators={coordinators}
                onManage={onManage}
                busy={busy}
                allowRename={allowRename}
                allowRemove={allowRemove}
              />
            ))}
          </ul>
        ))}
    </div>
  );
}
