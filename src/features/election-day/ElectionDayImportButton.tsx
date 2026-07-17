import { useRef } from "react";
import { Button } from "../../components/ui/Button";
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
      <Button
        variant="secondary"
        onClick={() => fileInput.current?.click()}
        loading={busy}
        title={ELECTION_DAY_TEXT.import.columnsHint}
      >
        📁 {ELECTION_DAY_TEXT.import.button}
      </Button>
    </>
  );
}
