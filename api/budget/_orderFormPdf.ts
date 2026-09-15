import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DAVID_LIBRE_BOLD_B64, DAVID_LIBRE_REGULAR_B64 } from "./_orderFormFont.js";
import { ORDER_FORM_TEMPLATE_KEY, ORDER_FORM_TEMPLATE_V1 as T, type ThresholdRule } from "./_orderFormTemplate.js";

// Budget Stage 4 - server-side order-form PDF renderer (pdf-lib + the embedded
// OFL David Libre font). Output is a PDF - never a spreadsheet.
//
// DETERMINISTIC: the same snapshot always yields the same bytes (no clock, no
// random font-subset tag, no metadata dates), so a stored version can be
// re-derived and compared.
//
// RTL: pdf-lib draws glyphs left to right, and fontkit on its own would
// reverse a whole Hebrew-detected string (digits included). So fontkit is
// told to lay out left to right, and THIS module decides the visual order:
// a simplified bidi pass for right-to-left paragraphs - Hebrew / neutral runs
// reversed (brackets mirrored), Latin / number runs ("1,500.00", "15/09/2026",
// "050-1234567") kept left to right, run order reversed.

export interface OrderFormSnapshot {
  template: string;
  header: { lines: string[] | null; electionYearLabel: string | null };
  branch: { name: string | null; number: string | null; orderer: string | null };
  order: {
    referenceNo: number;
    description: string;
    category: string | null;
    orderDate: string | null;
    deliveryDate: string | null;
    net: number | null;
    vat: number | null;
    vatRateBp: number | null;
    total: number | null;
    partyAmount: number | null;
  };
  supplier: {
    businessName: string | null;
    taxId: string | null;
    address: string | null;
    phone: string | null;
    contactName: string | null;
  };
  preapprovals: {
    orderNumber: string | null;
    approvalCode: string;
    approverName: string;
    approvalDate: string;
    preapprovedAmount: number | null;
  }[];
  supplierSignatureRequired: boolean;
  rules: { supplierSignature: ThresholdRule | null; invoice: ThresholdRule | null };
}

export interface RenderOptions {
  /** A preview is watermarked "טיוטה" and carries no version number. */
  preview: boolean;
  versionNo: number | null;
}

// ---------------------------------------------------------------------------
// Text helpers (exported for the tests).
// ---------------------------------------------------------------------------
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
const LTR_RUN = /[A-Za-z0-9](?:[A-Za-z0-9.,:/\-+%@_]*[A-Za-z0-9%])?/g;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

/** Logical -> visual order for one right-to-left line. */
export function toVisual(text: string): string {
  if (!HEBREW.test(text)) return text;
  const segs: { ltr: boolean; s: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(LTR_RUN)) {
    const at = m.index ?? 0;
    if (at > last) segs.push({ ltr: false, s: text.slice(last, at) });
    segs.push({ ltr: true, s: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) segs.push({ ltr: false, s: text.slice(last) });
  return segs
    .reverse()
    .map((g) => (g.ltr ? g.s : Array.from(g.s).reverse().map((ch) => MIRROR[ch] ?? ch).join("")))
    .join("");
}

/** Integer agorot -> "1,500.00 ₪" (no Intl: identical output everywhere). */
export function formatMoney(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined || !Number.isInteger(agorot)) return T.text.none;
  const neg = agorot < 0;
  const v = Math.abs(agorot);
  const shekels = Math.floor(v / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${shekels}.${String(v % 100).padStart(2, "0")} ₪`;
}

/** "2026-09-15" -> "15/09/2026". */
export function formatDate(iso: string | null | undefined): string {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : T.text.none;
}

/** Control characters and bidi marks / overrides (U+200E/F, U+202A-202E,
 * U+2066-2069) become spaces - they must never reorder or hide printed text. */
const isStripped = (cp: number): boolean =>
  cp < 0x20 || cp === 0x7f || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const clean = (s: string | null | undefined): string => {
  const v = Array.from(s ?? "", (ch) => (isStripped(ch.codePointAt(0) ?? 0) ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return v === "" ? T.text.none : v;
};

// fontkit's own RTL reversal is switched off; see the header comment.
type LayoutFn = (text: string, features?: unknown, script?: string, language?: string, direction?: string) => unknown;
function forceLtrLayout(font: PDFFont): void {
  const embedder = (font as unknown as { embedder?: { font?: { layout?: LayoutFn } } }).embedder;
  const fk = embedder?.font;
  if (!fk || typeof fk.layout !== "function") throw new Error("ORDER_FORM_FONT_LAYOUT_UNAVAILABLE");
  const layout = fk.layout.bind(fk);
  fk.layout = (text, features) => layout(text, features, undefined, undefined, "ltr");
}

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------
const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.38, 0.42, 0.48);
const RULE = rgb(0.62, 0.66, 0.72);
const FILL = rgb(0.95, 0.96, 0.98);
/** Smallest size an amount may shrink to (see Canvas.moneyField). */
const MIN_MONEY_SIZE = 7;

class Canvas {
  readonly page: PDFPage;
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  constructor(page: PDFPage, regular: PDFFont, bold: PDFFont) {
    this.page = page;
    this.regular = regular;
    this.bold = bold;
  }

  width(text: string, size: number, font: PDFFont = this.regular): number {
    return font.widthOfTextAtSize(text, size);
  }

  /** Right-aligned RTL text ending at xRight (baseline y). Returns its width. */
  right(text: string, xRight: number, y: number, size: number, font: PDFFont = this.regular, color = INK): number {
    const visual = toVisual(text);
    const w = font.widthOfTextAtSize(visual, size);
    this.page.drawText(visual, { x: xRight - w, y, size, font, color });
    return w;
  }

  center(text: string, xCenter: number, y: number, size: number, font: PDFFont = this.regular, color = INK): void {
    const visual = toVisual(text);
    const w = font.widthOfTextAtSize(visual, size);
    this.page.drawText(visual, { x: xCenter - w / 2, y, size, font, color });
  }

  /** "label: value" in one cell, the label bold and muted, the value clipped to the cell. */
  field(label: string, value: string, xRight: number, y: number, cellWidth: number): void {
    const lw = this.right(`${label}:`, xRight, y, T.size.label, this.bold, MUTED);
    const room = cellWidth - lw - 6;
    this.right(this.fit(value, T.size.value, room), xRight - lw - 6, y, T.size.value);
  }

  /** An amount is never cut: it shrinks in half-point steps (down to
   * MIN_MONEY_SIZE) until it fits its cell; only below that is it truncated. */
  moneyField(label: string, value: string, xRight: number, y: number, cellWidth: number): void {
    const lw = this.right(`${label}:`, xRight, y, T.size.label, this.bold, MUTED);
    const room = cellWidth - lw - 6;
    let size = T.size.value;
    while (size > MIN_MONEY_SIZE && this.width(value, size) > room) size -= 0.5;
    this.right(this.fit(value, size, room), xRight - lw - 6, y, size);
  }

  /** Truncates (with an ellipsis) to fit - a value never spills out of its cell. */
  fit(text: string, size: number, maxWidth: number): string {
    if (this.width(text, size) <= maxWidth) return text;
    const chars = Array.from(text);
    while (chars.length > 1 && this.width(`${chars.join("")}…`, size) > maxWidth) chars.pop();
    return `${chars.join("")}…`;
  }

  /** Word wrap in logical order (each line is then bidi-ordered on its own). */
  wrap(text: string, size: number, maxWidth: number, maxLines: number): string[] {
    const lines: string[] = [];
    let cur = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (!cur || this.width(cand, size) <= maxWidth) {
        cur = cand;
      } else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    const out = lines.map((l) => this.fit(l, size, maxWidth));
    if (out.length > maxLines) {
      out.length = maxLines;
      out[maxLines - 1] = this.fit(`${out[maxLines - 1]}…`, size, maxWidth);
    }
    return out;
  }

  /** Word wrap that NEVER truncates: a word wider than the line is broken
   * between characters. For identifiers (approval codes) that must print in
   * full on the official form. */
  breakAll(text: string, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    let cur = "";
    for (const word of text.split(" ").filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (this.width(cand, size) <= maxWidth) {
        cur = cand;
        continue;
      }
      if (cur) lines.push(cur);
      cur = "";
      for (const ch of Array.from(word)) {
        if (cur && this.width(cur + ch, size) > maxWidth) {
          lines.push(cur);
          cur = ch;
        } else {
          cur += ch;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [T.text.none];
  }

  box(x: number, yTop: number, w: number, h: number, fill = false): void {
    this.page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: RULE, borderWidth: 0.8, color: fill ? FILL : undefined });
  }

  hline(x1: number, x2: number, y: number, dashed = false): void {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.7, color: RULE, dashArray: dashed ? [2, 2] : undefined });
  }
}

/** Thrown when the content does not fit one page at the given gap scale. */
class LayoutOverflow extends Error {}

/** Renders at gap scale `k` (1 = the template's spacing). Only the vertical
 * gaps between blocks scale - never a font size, a value or a row. */
async function renderAt(s: OrderFormSnapshot, opts: RenderOptions, k: number): Promise<Uint8Array> {
  if (s.template !== ORDER_FORM_TEMPLATE_KEY) throw new Error("ORDER_FORM_TEMPLATE_UNKNOWN");
  const { width: W, height: H, margin: M } = T.page;
  const L = M;
  const R = W - M;
  const CW = R - L;

  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  // A fixed customName: pdf-lib would otherwise add a RANDOM subset tag.
  const regular = await doc.embedFont(Buffer.from(DAVID_LIBRE_REGULAR_B64, "base64"), { subset: true, customName: "DavidLibre-Regular" });
  const bold = await doc.embedFont(Buffer.from(DAVID_LIBRE_BOLD_B64, "base64"), { subset: true, customName: "DavidLibre-Bold" });
  forceLtrLayout(regular);
  forceLtrLayout(bold);
  doc.setTitle(T.footer(s.order.referenceNo, opts.preview ? null : opts.versionNo));
  doc.setLanguage("he-IL");

  const page = doc.addPage([W, H]);
  const c = new Canvas(page, regular, bold);
  const money = (a: number) => formatMoney(a);
  const gap = (n: number) => n * k;
  let y = H - M;

  if (opts.preview) {
    page.drawText(toVisual(T.text.watermark), {
      x: W / 2 - 170, y: H / 2 - 120, size: T.size.watermark, font: bold, color: rgb(0.85, 0.2, 0.2),
      opacity: 0.1, rotate: degrees(40),
    });
  }

  // --- Header -----------------------------------------------------------------
  for (const line of (s.header.lines ?? []).slice(0, 6)) {
    y -= 13;
    c.center(c.fit(clean(line), T.size.headerLine, CW), W / 2, y, T.size.headerLine, bold);
  }
  y -= gap(26);
  c.center(T.text.title, W / 2, y, T.size.title, bold);
  if (s.header.electionYearLabel) {
    y -= gap(15);
    c.center(c.fit(clean(s.header.electionYearLabel), T.size.subtitle, CW), W / 2, y, T.size.subtitle, regular, MUTED);
  }
  const orderNumber = s.preapprovals.map((p) => p.orderNumber).filter((v): v is string => Boolean(v)).join(", ");
  y -= gap(20);
  c.field(T.text.orderNumber, clean(orderNumber), R, y, CW / 2);
  c.page.drawText(
    toVisual(opts.preview ? T.text.previewBanner : `${T.text.version} ${opts.versionNo ?? ""}`.trim()),
    { x: L, y, size: T.size.label, font: bold, color: opts.preview ? rgb(0.75, 0.15, 0.15) : MUTED },
  );
  y -= 14;
  c.field(T.text.expenseRef, String(s.order.referenceNo), R, y, CW / 2);
  y -= gap(10);
  c.hline(L, R, y);

  // --- Sections ---------------------------------------------------------------
  const section = (title: string) => {
    y -= gap(20);
    c.right(title, R, y, T.size.section, bold);
    y -= gap(6);
  };
  /** A bordered grid of label:value cells, `cols` per row, right to left. A
   * money cell ([label, value, true]) shrinks to fit instead of being cut. */
  const grid = (cells: [string, string, boolean?][], cols: number) => {
    const rowH = 20;
    const rows = Math.ceil(cells.length / cols);
    c.box(L, y, CW, rows * rowH);
    const cellW = CW / cols;
    cells.forEach(([label, value, money], i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const xRight = R - col * cellW - 6;
      if (money) c.moneyField(label, value, xRight, y - row * rowH - 14, cellW - 12);
      else c.field(label, value, xRight, y - row * rowH - 14, cellW - 12);
    });
    y -= rows * rowH;
  };

  section(T.text.s1);
  grid([
    [T.text.branchName, clean(s.branch.name)],
    [T.text.branchNumber, clean(s.branch.number)],
    [T.text.orderer, clean(s.branch.orderer)],
  ], 3);

  section(T.text.s2);
  grid([
    [T.text.supplierName, clean(s.supplier.businessName)],
    [T.text.taxId, clean(s.supplier.taxId)],
    [T.text.phone, clean(s.supplier.phone)],
    [T.text.address, clean(s.supplier.address)],
    [T.text.contact, clean(s.supplier.contactName)],
  ], 3);

  section(T.text.s3);
  const descLines = c.wrap(clean(s.order.description), T.size.value, CW - 90, 3);
  const descH = 10 + descLines.length * 14;
  c.box(L, y, CW, descH);
  c.right(`${T.text.description}:`, R - 6, y - 14, T.size.label, bold, MUTED);
  descLines.forEach((line, i) => c.right(line, R - 84, y - 14 - i * 14, T.size.value));
  y -= descH;
  const vatLabel = s.order.vatRateBp !== null && s.order.vatRateBp !== undefined
    ? `${T.text.vat} (${(s.order.vatRateBp / 100).toFixed(2).replace(/\.00$/, "")}%)` : T.text.vat;
  grid([
    [T.text.category, clean(s.order.category)],
    [T.text.orderDate, formatDate(s.order.orderDate)],
    [T.text.deliveryDate, formatDate(s.order.deliveryDate)],
    [T.text.net, formatMoney(s.order.net), true],
    [vatLabel, formatMoney(s.order.vat), true],
    [T.text.total, formatMoney(s.order.total), true],
  ], 3);
  y -= gap(4);
  grid([[T.text.partyAmount, formatMoney(s.order.partyAmount), true]], 1);

  // The prior-budget-approval box (inside section 3).
  y -= gap(10);
  // At most 3 approval rows (an expense normally has one party allocation);
  // any further ones are counted, so the page can never overflow.
  const MAX_PRE_ROWS = 3;
  const pre = s.preapprovals.slice(0, MAX_PRE_ROWS);
  const hidden = s.preapprovals.length - pre.length;
  // Each approval takes two lines: the approval code on its own full-width
  // line (wrapped, NEVER truncated - it must be readable in full on the
  // official form), then approver / date / pre-approved amount. The box height
  // follows the wrapped lines.
  const codeLabel = `${T.text.approvalCode}:`;
  const codeRoom = CW - 12 - c.width(codeLabel, T.size.label, bold) - 6;
  let rowY = y - 33;
  const rows = pre.map((p) => {
    const codeLines = c.breakAll(clean(p.approvalCode), T.size.value, codeRoom);
    const codeY = rowY;
    const detailY = codeY - (codeLines.length - 1) * 13 - 16;
    rowY = detailY - 18;
    return { p, codeLines, codeY, detailY };
  });
  const lastY = rows.length ? rows[rows.length - 1].detailY : y - 33;
  const moreY = lastY - 16;
  const boxH = y - (hidden > 0 ? moreY : lastY) + 7;
  c.box(L, y, CW, boxH, true);
  // Drawn AFTER the filled box, or the fill would paint over it.
  if (hidden > 0) {
    c.right(T.text.morePreapprovals(hidden), R - 6, moreY, T.size.small, regular, MUTED);
  }
  c.right(T.text.preapprovalBox, R - 6, y - 15, T.size.value, bold);
  if (pre.length === 0) {
    c.right(T.text.preapprovalMissing, R - 6, y - 33, T.size.value, regular, MUTED);
  }
  // Detail columns (right to left): approver, date, pre-approved amount - each
  // at least as wide as before; the amount column stays the widest after the
  // approver so an amount is never truncated.
  const cols = [0.44, 0.24, 0.32].map((f) => f * CW);
  rows.forEach(({ p, codeLines, codeY, detailY }, i) => {
    if (i > 0) c.hline(L + 8, R - 8, codeY + 11, true);
    const lw = c.right(codeLabel, R - 6, codeY, T.size.label, bold, MUTED);
    codeLines.forEach((line, j) => c.right(line, R - 6 - lw - 6, codeY - j * 13, T.size.value));
    const values: [string, string][] = [
      [T.text.approverName, clean(p.approverName)],
      [T.text.approvalDate, formatDate(p.approvalDate)],
      [T.text.preapprovedAmount, formatMoney(p.preapprovedAmount)],
    ];
    let xRight = R - 6;
    values.forEach(([label, value], j) => {
      if (j === 2) c.moneyField(label, value, xRight, detailY, cols[j] - 12);
      else c.field(label, value, xRight, detailY, cols[j] - 12);
      xRight -= cols[j];
    });
  });
  y -= boxH;

  // --- Order approvers (1) and (2) ------------------------------------------------
  section(T.text.approvers);
  for (const n of [1, 2]) {
    y -= gap(22);
    c.right(`(${n})`, R, y, T.size.value, bold);
    const third = (CW - 30) / 3;
    [T.text.name, T.text.signature, T.text.date].forEach((label, i) => {
      const xRight = R - 26 - i * third;
      const lw = c.right(`${label}:`, xRight, y, T.size.label, bold, MUTED);
      c.hline(xRight - third + 14, xRight - lw - 4, y - 2, true);
    });
  }

  // --- Section 4: supplier (signature + stamp only) ---------------------------------
  section(T.text.s4);
  const sigH = 58;
  c.box(L, y, CW, sigH);
  const half = CW / 2;
  const sw = c.right(`${T.text.supplierSignature}:`, R - 8, y - 36, T.size.label, bold, MUTED);
  c.hline(R - half + 12, R - 8 - sw - 4, y - 38, true);
  const stw = c.right(`${T.text.stamp}:`, R - half - 8, y - 36, T.size.label, bold, MUTED);
  c.hline(L + 10, R - half - 8 - stw - 4, y - 38, true);
  y -= sigH + gap(12);
  c.right(T.signatureNote(s.supplierSignatureRequired, s.rules.supplierSignature, money), R, y, T.size.small, bold,
    s.supplierSignatureRequired ? rgb(0.6, 0.15, 0.1) : MUTED);

  // --- Instructions 1-5 -----------------------------------------------------------
  section(T.text.instructionsTitle);
  T.instructions(s.rules, money).forEach((line, i) => {
    for (const [j, part] of c.wrap(`${i + 1}. ${line}`, T.size.small, CW - 8, 2).entries()) {
      y -= 12;
      c.right(part, R - (j ? 12 : 0), y, T.size.small, regular, INK);
    }
  });

  // --- Footer -----------------------------------------------------------------------
  c.hline(L, R, M + 14);
  c.center(T.footer(s.order.referenceNo, opts.preview ? null : opts.versionNo), W / 2, M, T.size.small, regular, MUTED);

  if (y < M + 24) throw new LayoutOverflow("ORDER_FORM_LAYOUT_OVERFLOW");
  return doc.save();
}

/** Fixed, deterministic steps: the same snapshot always lands on the same
 * scale, so the output stays byte-identical. Extreme-but-valid data (long
 * settings headers, several approvals) tightens the gaps instead of failing. */
const GAP_SCALES = [1, 0.85, 0.7, 0.6];

export async function renderOrderFormPdf(s: OrderFormSnapshot, opts: RenderOptions): Promise<Uint8Array> {
  for (const k of GAP_SCALES) {
    try {
      return await renderAt(s, opts, k);
    } catch (e) {
      if (!(e instanceof LayoutOverflow)) throw e;
    }
  }
  throw new Error("ORDER_FORM_LAYOUT_OVERFLOW");
}
