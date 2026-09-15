/**
 * Budget Stage 4: file transfer for Budget documents.
 *
 * Upload = three steps, the server authoritative at both ends:
 *   1. `document_upload_start` - the server authorizes, records the intent and
 *      returns a signed upload URL for ONE server-generated private path;
 *   2. the browser PUTs the bytes straight to Storage (never through a
 *      function - photos can be several MB);
 *   3. `document_upload_complete` - the server downloads what was stored,
 *      verifies size + real type (magic bytes) + sha256, and only then files
 *      it as a new version (or deletes it and refuses).
 * Download = a 60-second signed link, requested per click. Nothing here ever
 * sees a workspace id, a storage path or a permanent URL.
 */
import { BudgetApiError, budgetCall, type BudgetPrincipal, type DocumentMime } from "./budgetClient";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif";

const BY_EXTENSION: Record<string, DocumentMime> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
};

/** The declared type: the browser's, or (HEIC often arrives untyped) the
 * extension's. The server re-checks the real bytes either way. */
export function fileMime(file: File): DocumentMime | null {
  const t = file.type.toLowerCase();
  if (Object.values(BY_EXTENSION).includes(t as DocumentMime)) return t as DocumentMime;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[ext] ?? null;
}

export type UploadTarget =
  | { purpose: "expense"; expenseId: string; documentTypeId?: string; documentId?: string; title?: string; notes?: string }
  | { purpose: "supplier"; supplierId: string; documentTypeId?: string; documentId?: string; title?: string; notes?: string; validUntil?: string }
  | { purpose: "order_form_return"; orderFormVersionId: string; notes?: string };

export async function uploadBudgetFile<T>(target: UploadTarget, file: File, principal: BudgetPrincipal = "worker"): Promise<T> {
  const mimeType = fileMime(file);
  if (!mimeType) throw new BudgetApiError("UNSUPPORTED_FILE_TYPE", 400);
  if (file.size > MAX_FILE_BYTES) throw new BudgetApiError("FILE_TOO_LARGE", 400);
  if (file.size === 0) throw new BudgetApiError("INVALID_FILE", 400);
  const start = await budgetCall<{ uploadId: string; uploadUrl: string }>(
    "document_upload_start",
    { ...target, fileName: file.name, mimeType, sizeBytes: file.size },
    principal,
  );
  let put: Response;
  try {
    put = await fetch(start.uploadUrl, { method: "PUT", headers: { "content-type": mimeType, "x-upsert": "false" }, body: file });
  } catch {
    throw new BudgetApiError("NETWORK", 0);
  }
  if (!put.ok) throw new BudgetApiError("UPLOAD_FAILED", put.status);
  return budgetCall<T>("document_upload_complete", { uploadId: start.uploadId }, principal);
}

function clickLink(href: string, fileName?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Opens (downloads) one stored version through a fresh 60-second link. */
export async function downloadBudgetDocument(versionId: string, principal: BudgetPrincipal = "worker"): Promise<void> {
  const r = await budgetCall<{ url: string; fileName: string }>("document_download", { versionId }, principal);
  clickLink(r.url);
}

/** Fetches the stored bytes of a version as a File (for the Web Share API). */
export async function fetchBudgetDocumentFile(versionId: string): Promise<File> {
  const r = await budgetCall<{ url: string; fileName: string; mimeType: string }>("document_download", { versionId });
  let res: Response;
  try {
    res = await fetch(r.url);
  } catch {
    throw new BudgetApiError("NETWORK", 0);
  }
  if (!res.ok) throw new BudgetApiError("UNEXPECTED", res.status);
  return new File([await res.blob()], r.fileName, { type: r.mimeType });
}

/** The order-form PREVIEW: rendered server-side, never stored. */
export async function downloadOrderFormPreview(expenseId: string): Promise<void> {
  const r = await budgetCall<{ pdfBase64: string; fileName: string }>("order_form_preview", { expenseId });
  const bin = atob(r.pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  clickLink(url, r.fileName);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
