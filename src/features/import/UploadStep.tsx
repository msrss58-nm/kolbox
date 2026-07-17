import { useRef, useState, type DragEvent } from "react";
import { Database, FileSpreadsheet, FileUp, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { downloadTemplate } from "../../services/excel/excel";
import { cn } from "../../lib/utils";
import { IMPORT_TEXT } from "./import.constants";

export function UploadStep({
  onFileSelected,
  onLoadDemo,
  busy,
}: {
  onFileSelected: (file: File) => void;
  onLoadDemo: () => void;
  busy: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileSelected(file);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        aria-label={IMPORT_TEXT.upload.dropzoneAriaLabel}
        className={cn(
          "flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-8 text-center transition-colors lg:col-span-2",
          dragOver
            ? "border-primary-500 bg-primary-50"
            : "border-slate-300 bg-white hover:border-primary-400",
        )}
      >
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
        <span className="grid size-14 place-items-center rounded-2xl bg-primary-50">
          <FileUp className="size-7 text-primary-500" />
        </span>
        <p className="font-bold text-slate-700">{IMPORT_TEXT.upload.dropHint}</p>
        <p className="text-sm text-slate-400">{IMPORT_TEXT.upload.fileTypes}</p>
        <button
          className="mt-1 text-xs font-semibold text-primary-600 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            downloadTemplate();
          }}
        >
          <FileSpreadsheet className="me-1 inline size-3.5" />
          {IMPORT_TEXT.upload.downloadTemplate}
        </button>
      </div>

      <Card className="flex flex-col justify-center gap-3 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-violet-50">
          <Database className="size-6 text-violet-500" />
        </span>
        <CardTitle>{IMPORT_TEXT.upload.demoTitle}</CardTitle>
        <p className="text-sm text-slate-500">{IMPORT_TEXT.upload.demoHint}</p>
        <Button variant="secondary" onClick={onLoadDemo} loading={busy}>
          <RefreshCw className="size-4" />
          {IMPORT_TEXT.upload.demoButton}
        </Button>
      </Card>
    </div>
  );
}
