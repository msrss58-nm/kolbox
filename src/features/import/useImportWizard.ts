import { useCallback, useMemo, useState } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { api, type ImportSummary } from "../../services/api";
import {
  autoDetectMapping,
  exportVotersToExcel,
  parseJsonFile,
  parseSpreadsheet,
  type ParsedSheet,
} from "../../services/excel/excel";
import { IMPORT_TEXT } from "./import.constants";
import {
  buildImportRows,
  isRequiredMapped,
  previewMapping,
  type ColumnMapping,
} from "./importMapping";

export type ImportStep = "upload" | "map" | "done";

/** Owns the whole 3-step wizard: file parsing, column mapping, commit, and summary. */
export function useImportWizard() {
  const [step, setStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const reset = useCallback(() => {
    setStep("upload");
    setSheet(null);
    setFileName("");
    setMapping({});
    setSummary(null);
  }, []);

  // ---- step 1: upload ---------------------------------------------------------
  const { run: parseFile, busy: parsing } = useAsyncAction(
    async (file: File) => {
      const parsed = /\.json$/i.test(file.name)
        ? await parseJsonFile(file)
        : await parseSpreadsheet(file);
      if (parsed.rows.length === 0) throw new Error(IMPORT_TEXT.errors.emptyFile);
      return parsed;
    },
    { errorMessage: IMPORT_TEXT.errors.readError },
  );

  const loadFile = useCallback(
    async (file: File) => {
      const parsed = await parseFile(file);
      if (parsed) {
        setSheet(parsed);
        setFileName(file.name);
        setMapping(autoDetectMapping(parsed.headers));
        setStep("map");
      }
    },
    [parseFile],
  );

  const { run: loadDemo, busy: loadingDemo } = useAsyncAction(
    async () => {
      await api.resetToDemo();
      return true as const; // distinguishes success from useAsyncAction's `undefined`-on-error
    },
    { successMessage: IMPORT_TEXT.toast.demoLoaded },
  );

  const { run: exportRegistry, busy: exporting } = useAsyncAction(
    async () => {
      const { items } = await api.listVoters({});
      exportVotersToExcel(items);
      return items.length;
    },
    { successMessage: (count) => IMPORT_TEXT.toast.exported(count) },
  );

  // ---- step 2: mapping + preview ------------------------------------------------
  const preview = useMemo(
    () => (sheet ? previewMapping(sheet, mapping) : null),
    [sheet, mapping],
  );
  const requiredMapped = isRequiredMapped(mapping);

  const setFieldMapping = useCallback(
    (key: keyof ColumnMapping, columnIndex: number | undefined) => {
      setMapping((prev) => ({ ...prev, [key]: columnIndex }));
    },
    [],
  );

  const { run: commitImport, busy: committing } = useAsyncAction(
    () => (sheet ? api.importVoters(buildImportRows(sheet, mapping)) : Promise.reject()),
    { errorMessage: IMPORT_TEXT.errors.importError },
  );

  const commit = useCallback(async () => {
    if (!sheet) return;
    const result = await commitImport();
    if (result) {
      setSummary(result);
      setStep("done");
    }
  }, [sheet, commitImport]);

  return {
    step,
    fileName,
    sheet,
    mapping,
    preview,
    requiredMapped,
    summary,
    busy: parsing || loadingDemo || exporting || committing,
    loadFile,
    loadDemo,
    exportRegistry,
    setFieldMapping,
    commit,
    reset,
  };
}
