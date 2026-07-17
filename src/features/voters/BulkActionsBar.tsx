import { X } from "lucide-react";
import type { Classification } from "../../types";
import { ClassifySegment } from "./ClassifySegment";
import { VOTERS_TEXT } from "./voters.constants";

export function BulkActionsBar({
  selectedCount,
  onClassify,
  onClear,
}: {
  selectedCount: number;
  onClassify: (c: Classification) => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-primary-950 px-4 py-2.5 text-sm text-white animate-fade-in-up">
      <span className="font-bold">{VOTERS_TEXT.bulk.selectedCount(selectedCount)}</span>
      <span className="text-primary-300">{VOTERS_TEXT.bulk.quickClassifyLabel}</span>
      <ClassifySegment value="unclassified" onChange={onClassify} size="sm" tone="dark" />
      <button
        onClick={onClear}
        className="ms-auto touch-target grid place-items-center rounded-lg text-primary-300 hover:text-white"
        aria-label={VOTERS_TEXT.bulk.clearSelectionAriaLabel}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
