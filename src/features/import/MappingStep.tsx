import { ArrowRight, CheckCircle2, Table2, Upload, XCircle } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { Field, Select } from "../../components/ui/Field";
import { APP_CONFIG } from "../../constants/config";
import { fmtNum } from "../../lib/utils";
import { IMPORT_FIELDS, type ParsedSheet } from "../../services/excel/excel";
import { IMPORT_TEXT } from "./import.constants";
import { readCell, type ColumnMapping, type MappingPreview } from "./importMapping";

export function MappingStep({
  sheet,
  fileName,
  mapping,
  onFieldMappingChange,
  preview,
  requiredMapped,
  busy,
  onCommit,
  onBack,
}: {
  sheet: ParsedSheet;
  fileName: string;
  mapping: ColumnMapping;
  onFieldMappingChange: (
    key: (typeof IMPORT_FIELDS)[number]["key"],
    columnIndex: number | undefined,
  ) => void;
  preview: MappingPreview | null;
  requiredMapped: boolean;
  busy: boolean;
  onCommit: () => void;
  onBack: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-1">
        <CardTitle className="mb-3">{IMPORT_TEXT.mapping.title}</CardTitle>
        <p className="mb-4 text-xs text-slate-400">
          {IMPORT_TEXT.mapping.fileSummary(fileName, sheet.rows.length)}
        </p>
        <div className="space-y-3">
          {IMPORT_FIELDS.map(({ key, label, required }) => (
            <Field key={key} label={required ? `${label} *` : label}>
              <Select
                value={mapping[key] ?? ""}
                onChange={(e) =>
                  onFieldMappingChange(
                    key,
                    e.target.value === "" ? undefined : Number(e.target.value),
                  )
                }
              >
                <option value="">{IMPORT_TEXT.mapping.unmappedOption}</option>
                {sheet.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || IMPORT_TEXT.mapping.columnFallback(i + 1)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      </Card>

      <div className="space-y-4 lg:col-span-2">
        {preview && (
          <div className="grid grid-cols-2 gap-3">
            <Card className="flex items-center gap-3">
              <CheckCircle2 className="size-8 text-supporter" />
              <div>
                <p className="text-2xl font-extrabold tabular-nums text-slate-800">
                  {fmtNum(preview.valid)}
                </p>
                <p className="text-xs text-slate-500">{IMPORT_TEXT.mapping.validRows}</p>
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <XCircle className="size-8 text-opponent" />
              <div>
                <p className="text-2xl font-extrabold tabular-nums text-slate-800">
                  {fmtNum(preview.invalid)}
                </p>
                <p className="text-xs text-slate-500">
                  {IMPORT_TEXT.mapping.invalidRows}
                </p>
              </div>
            </Card>
          </div>
        )}

        <Card className="overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <Table2 className="size-4 text-slate-400" />
            <CardTitle className="text-sm">
              {IMPORT_TEXT.mapping.previewTitle(APP_CONFIG.importPreviewRowCount)}
            </CardTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  {IMPORT_FIELDS.map(({ key, label }) => (
                    <th
                      key={key}
                      className="whitespace-nowrap px-3 py-2 text-start font-bold"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview?.sample.map((row, ri) => (
                  <tr key={ri} className="border-t border-slate-50">
                    {IMPORT_FIELDS.map(({ key }) => (
                      <td
                        key={key}
                        className="whitespace-nowrap px-3 py-2 text-slate-600"
                      >
                        {readCell(row, mapping[key]) ?? (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="flex gap-2">
          <Button
            onClick={onCommit}
            loading={busy}
            disabled={!requiredMapped || preview?.valid === 0}
            className="flex-1 md:flex-none"
          >
            <Upload className="size-4" />
            {IMPORT_TEXT.mapping.commitButton(preview?.valid ?? 0)}
          </Button>
          <Button variant="secondary" onClick={onBack}>
            <ArrowRight className="size-4" />
            {IMPORT_TEXT.mapping.back}
          </Button>
        </div>
        {!requiredMapped && (
          <p className="text-xs font-medium text-opponent">
            {IMPORT_TEXT.mapping.missingRequired}
          </p>
        )}
      </div>
    </div>
  );
}
