import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { BUDGET_TEXT } from "./budget.constants";
import { FILE_ACCEPT, MAX_FILE_BYTES, fileMime, formatBytes } from "./budgetFiles";

const t = BUDGET_TEXT.documents;
const c = BUDGET_TEXT.common;

export interface UploadFields {
  documentTypeId?: string;
  title?: string;
  notes?: string;
  validUntil?: string;
}

/**
 * One file-upload dialog for every Budget document flow (expense document,
 * new version of a document, supplier document, supplier-returned order form).
 * It validates type and size up front for a clear message; the server
 * re-validates everything, including the file's real bytes.
 */
export function DocumentUploadDialog({ title, hint, types, defaultTypeId, showTitle = true, showValidUntil = false, busy, onClose, onSubmit }: {
  title: string;
  hint?: string;
  /** Offered when choosing the type of a NEW document; omitted for a new version. */
  types?: { id: string; name: string }[];
  defaultTypeId?: string;
  showTitle?: boolean;
  showValidUntil?: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (file: File, fields: UploadFields) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [typeId, setTypeId] = useState(defaultTypeId ?? types?.[0]?.id ?? "");
  const [docTitle, setDocTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const mime = file ? fileMime(file) : null;
  const problem = !file
    ? null
    : !mime
      ? BUDGET_TEXT.errors.UNSUPPORTED_FILE_TYPE
      : file.size > MAX_FILE_BYTES
        ? BUDGET_TEXT.errors.FILE_TOO_LARGE
        : file.size === 0
          ? BUDGET_TEXT.errors.INVALID_FILE
          : null;
  const valid = Boolean(file) && !problem && (!types || typeId !== "");

  return (
    <Modal open onClose={onClose} title={title}>
      <form className="space-y-3" data-testid="document-upload" onSubmit={(e) => {
        e.preventDefault();
        if (!file || !valid) return;
        onSubmit(file, {
          ...(types ? { documentTypeId: typeId } : {}),
          ...(docTitle.trim() ? { title: docTitle.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(validUntil ? { validUntil } : {}),
        });
      }}>
        {hint && <p className="text-sm text-slate-600">{hint}</p>}
        {types && (
          <Field label={t.type}>
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t.file}>
          <input type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block min-h-11 w-full rounded-xl text-sm text-slate-700 ring-1 ring-slate-200 file:me-3 file:min-h-11 file:rounded-xl file:border-0 file:bg-primary-50 file:px-3 file:font-semibold file:text-primary-700" />
        </Field>
        <p className="text-xs text-slate-500">
          {file ? `${file.name} · ${formatBytes(file.size)}` : t.fileHint}
        </p>
        {mime === "image/heic" || mime === "image/heif" ? <p className="text-xs text-slate-500">{t.heicHint}</p> : null}
        {problem && <p role="alert" className="text-sm font-semibold text-rose-700">{problem}</p>}
        {showTitle && (
          <Field label={t.docTitle}><Input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} maxLength={200} /></Field>
        )}
        <Field label={c.notes}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></Field>
        {showValidUntil && (
          <Field label={t.validUntil}><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{t.upload}</Button>
      </form>
    </Modal>
  );
}
