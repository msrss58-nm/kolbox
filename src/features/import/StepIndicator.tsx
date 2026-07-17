import { cn } from "../../lib/utils";
import { IMPORT_TEXT } from "./import.constants";
import type { ImportStep } from "./useImportWizard";

const STEPS: { key: ImportStep; label: string }[] = [
  { key: "upload", label: IMPORT_TEXT.steps.upload },
  { key: "map", label: IMPORT_TEXT.steps.map },
  { key: "done", label: IMPORT_TEXT.steps.done },
];

export function StepIndicator({ current }: { current: ImportStep }) {
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs font-bold">
      {STEPS.map(({ key, label }, i) => (
        <li key={key} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-slate-200" />}
          <span
            className={cn(
              "rounded-full px-3 py-1",
              current === key
                ? "bg-primary-600 text-white"
                : "bg-slate-100 text-slate-400",
            )}
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
