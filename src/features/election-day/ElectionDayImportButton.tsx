import { useRef } from "react";
import { Loader2 } from "lucide-react";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

export function ElectionDayImportButton({
  onFileSelected,
  busy,
}: {
  onFileSelected: (file: File) => void;
  busy: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.xls,.csv,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileSelected(file);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={busy}
        title={ELECTION_DAY_TEXT.import.columnsHint}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border-s-4 border-s-transparent bg-white p-5 text-start ring-1 ring-slate-200 transition hover:bg-slate-50 focus-visible:border-s-primary-500 focus-visible:outline-none active:border-s-primary-500 disabled:pointer-events-none disabled:opacity-50"
      >
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">
            📁 {ELECTION_DAY_TEXT.import.button}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {ELECTION_DAY_TEXT.import.columnsHint}
          </p>
        </div>
        {busy && <Loader2 className="size-5 shrink-0 animate-spin text-primary-600" />}
      </button>
    </>
  );
}
