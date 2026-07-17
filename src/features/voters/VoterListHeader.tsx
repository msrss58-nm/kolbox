import { VOTERS_TEXT } from "./voters.constants";

export function VoterListHeader({
  allSelected,
  onSelectAll,
}: {
  allSelected: boolean;
  onSelectAll: (checked: boolean) => void;
}) {
  return (
    <div className="hidden rounded-t-xl border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500 md:grid md:grid-cols-[2rem_1.4fr_0.7fr_1.1fr_0.9fr_7rem_13rem] md:items-center md:gap-3">
      <input
        type="checkbox"
        checked={allSelected}
        onChange={(e) => onSelectAll(e.target.checked)}
        className="size-4 accent-primary-600"
        aria-label={VOTERS_TEXT.columns.select}
      />
      <span>{VOTERS_TEXT.columns.nameId}</span>
      <span>{VOTERS_TEXT.columns.city}</span>
      <span>{VOTERS_TEXT.columns.address}</span>
      <span>{VOTERS_TEXT.columns.phone}</span>
      <span>{VOTERS_TEXT.columns.classification}</span>
      <span>{VOTERS_TEXT.columns.quickClassify}</span>
    </div>
  );
}
