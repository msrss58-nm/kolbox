/**
 * Budget Stage 7A: the Election Owner's DELETION EXPORT, written straight into
 * a folder the Owner picks (File System Access API) - one part or one document
 * at a time, never a whole-export blob in memory:
 *   manifest.json                  the server manifest (row counts, part
 *                                  checksums, the content fingerprint)
 *   data/<table>/part-00001.json   one part = the exact JSON text the server
 *                                  hashed (sha256 in the manifest)
 *   documents/<versionId>-<name>   each stored file, checked against its sha256
 *   verification.json              written after the server confirmed
 * Every part and every file is checksum-verified here BEFORE it is written;
 * `export_verify` then confirms on the server that everything was served by
 * this export and the Budget data has not changed since it started.
 */
import { BudgetApiError, budgetCall, type BudgetExportManifest, type BudgetExportPart, type BudgetExportStatus } from "./budgetClient";

interface WritableLike {
  write(data: BufferSource | string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}
export interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<DirectoryHandleLike>;
};

export interface ExportProgress {
  done: number;
  total: number;
}

/** Folder export needs the File System Access API (desktop Chrome / Edge). */
export function exportFolderSupported(): boolean {
  return typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Asks the Owner for the target folder (throws if cancelled). */
export async function pickExportFolder(): Promise<DirectoryHandleLike> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new BudgetApiError("EXPORT_UNSUPPORTED", 0);
  return picker.call(window, { mode: "readwrite" });
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function writeFile(dir: DirectoryHandleLike, name: string, data: BufferSource | string): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

/** A file name valid on every desktop OS (the stored name is display metadata only). */
function safeFileName(name: string): string {
  const cleaned = Array.from(name, (ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? "_" : ch)).join("").trim();
  return (cleaned || "file").slice(0, 120);
}

interface ExportedVersionRow {
  id: string;
  file_name: string;
  sha256: string;
}

export async function runDeletionExport(
  root: DirectoryHandleLike,
  onProgress: (p: ExportProgress) => void,
): Promise<BudgetExportStatus> {
  const manifest = await budgetCall<BudgetExportManifest>("export_start", {}, "owner");
  const dir = await root.getDirectoryHandle(
    `kolbox-budget-export-${manifest.createdAt.slice(0, 10)}-${manifest.exportId.slice(0, 8)}`,
    { create: true },
  );
  const dataDir = await dir.getDirectoryHandle("data", { create: true });
  const docsDir = await dir.getDirectoryHandle("documents", { create: true });
  await writeFile(dir, "manifest.json", JSON.stringify(manifest, null, 2));

  const encoder = new TextEncoder();
  const parts: { table: string; part: number; sha256: string }[] = [];
  const documents: { versionId: string; sha256: string }[] = [];
  const versions: ExportedVersionRow[] = [];
  const total = manifest.totals.parts + manifest.documents.count;
  let done = 0;
  onProgress({ done, total });

  for (const table of manifest.tables) {
    if (table.parts.length === 0) continue;
    const tableDir = await dataDir.getDirectoryHandle(table.name, { create: true });
    for (const p of table.parts) {
      const got = await budgetCall<BudgetExportPart>(
        "export_part", { exportId: manifest.exportId, table: table.name, part: p.part }, "owner",
      );
      const bytes = encoder.encode(got.rowsJson);
      if ((await sha256Hex(bytes)) !== p.sha256) throw new BudgetApiError("CHECKSUM_MISMATCH", 0);
      await writeFile(tableDir, `part-${String(p.part + 1).padStart(5, "0")}.json`, bytes);
      parts.push({ table: table.name, part: p.part, sha256: p.sha256 });
      if (table.name === "budget_document_versions") {
        for (const row of JSON.parse(got.rowsJson) as ExportedVersionRow[]) {
          versions.push({ id: row.id, file_name: row.file_name, sha256: row.sha256 });
        }
      }
      onProgress({ done: ++done, total });
    }
  }

  for (const version of versions) {
    const link = await budgetCall<{ url: string }>(
      "export_document", { exportId: manifest.exportId, versionId: version.id }, "owner",
    );
    let res: Response;
    try {
      res = await fetch(link.url);
    } catch {
      throw new BudgetApiError("NETWORK", 0);
    }
    if (!res.ok) throw new BudgetApiError("STORAGE_ERROR", res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = await sha256Hex(bytes);
    if (sha !== version.sha256) throw new BudgetApiError("CHECKSUM_MISMATCH", 0);
    await writeFile(docsDir, `${version.id}-${safeFileName(version.file_name)}`, bytes);
    documents.push({ versionId: version.id, sha256: sha });
    onProgress({ done: ++done, total });
  }

  const status = await budgetCall<BudgetExportStatus>(
    "export_verify", { exportId: manifest.exportId, parts, documents }, "owner",
  );
  await writeFile(dir, "verification.json", JSON.stringify({
    exportId: manifest.exportId,
    verifiedAt: status.latest?.verifiedAt ?? null,
    parts: parts.length,
    documents: documents.length,
  }, null, 2));
  return status;
}
