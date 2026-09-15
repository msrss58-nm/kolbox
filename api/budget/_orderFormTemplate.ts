// Budget Stage 4 - the order-form TEMPLATE (layout + wording), versioned per
// funder layout and kept apart from the renderer (_orderFormPdf.ts) and the
// data (the DB snapshot), so the official source can refine it later without
// any data-model change: a new layout is a new template key.
//
// Structure follows the official funder form as mapped from the user's
// screenshot (CURRENT_STATUS.md, Budget design): branch sections 1-3 with the
// "אישור תקציבי מוקדם" box, the two "מאשרי הזמנה" signature lines, supplier
// section 4 (signature + stamp only) and instructions 1-5. The exact field
// placement and the instruction wording are NOT taken from the original
// source file (not available yet) - they are a faithful-as-practical
// approximation, and the wording of the instructions below is ours.

export const ORDER_FORM_TEMPLATE_KEY = "kolbox-order-form-v1";

export interface ThresholdRule {
  condition: string;
  threshold: number;
}

export const ORDER_FORM_TEMPLATE_V1 = {
  key: ORDER_FORM_TEMPLATE_KEY,
  /** A4 portrait, points. */
  page: { width: 595.28, height: 841.89, margin: 36 },
  size: { headerLine: 11, title: 19, subtitle: 11, section: 11.5, label: 9, value: 10.5, small: 8.5, watermark: 96 },
  text: {
    title: "טופס הזמנה",
    previewBanner: "טיוטה לתצוגה בלבד - אינה טופס הזמנה סופי",
    watermark: "טיוטה",
    orderNumber: "מספר הזמנה",
    expenseRef: "מספר הוצאה",
    version: "גרסה",
    s1: "1. פרטי הסניף המזמין",
    branchName: "שם הסניף",
    branchNumber: "מספר סניף",
    orderer: "שם המזמין",
    s2: "2. פרטי הספק",
    supplierName: "שם הספק",
    taxId: "ח.פ / ע.מ",
    address: "כתובת",
    phone: "טלפון",
    contact: "איש קשר",
    s3: "3. פרטי ההזמנה",
    description: "תיאור ההזמנה",
    category: "קטגוריה",
    orderDate: "תאריך הזמנה",
    deliveryDate: "תאריך אספקה / ביצוע",
    net: "סכום לפני מע\"מ",
    vat: "מע\"מ",
    total: "סה\"כ כולל מע\"מ",
    partyAmount: "מתוכו במימון המפלגה",
    preapprovalBox: "אישור תקציבי מוקדם",
    approvalCode: "קוד אישור",
    approverName: "שם המאשר",
    approvalDate: "תאריך אישור",
    preapprovedAmount: "סכום שאושר מראש",
    preapprovalMissing: "טרם נרשם אישור תקציבי מוקדם",
    morePreapprovals: (n: number) => `ועוד ${n} אישורים נוספים - ראו בתיק ההוצאה`,
    approvers: "מאשרי הזמנה",
    name: "שם",
    signature: "חתימה",
    date: "תאריך",
    s4: "4. אישור הספק (חתימה וחותמת בלבד)",
    supplierSignature: "חתימת הספק",
    stamp: "חותמת",
    instructionsTitle: "הוראות",
    none: "—",
  },
  /** "מעל 1,500.00 ₪" (strictly greater) / "מ־1,500.00 ₪ ומעלה". */
  thresholdPhrase(rule: ThresholdRule, money: (agorot: number) => string): string {
    return rule.condition === "amount_gte" ? `מ־${money(rule.threshold)} ומעלה` : `מעל ${money(rule.threshold)}`;
  },
  signatureNote(required: boolean, rule: ThresholdRule | null, money: (agorot: number) => string): string {
    if (required) {
      return rule ? `נדרשת חתימת הספק - הזמנה ${this.thresholdPhrase(rule, money)}` : "נדרשת חתימת הספק";
    }
    return rule
      ? `חתימת הספק אינה נדרשת - הזמנה שאינה ${this.thresholdPhrase(rule, money)}; טופס חתום ע"י הסניף מספיק`
      : "חתימת הספק אינה נדרשת";
  },
  instructions(rules: { supplierSignature: ThresholdRule | null; invoice: ThresholdRule | null }, money: (agorot: number) => string): string[] {
    const sig = rules.supplierSignature ? `בהזמנה ${this.thresholdPhrase(rules.supplierSignature, money)} נדרשת חתימת הספק על טופס זה` : "";
    const inv = rules.invoice ? `בהזמנה ${this.thresholdPhrase(rules.invoice, money)} יש לצרף חשבונית מס` : "";
    return [
      "סעיפים 1-3 ממולאים על ידי הסניף המזמין; הספק חותם וחותם בחותמת בסעיף 4 בלבד.",
      "אין לבצע את ההזמנה לפני קבלת אישור תקציבי מוקדם.",
      "יש לצרף להגשה הצעת מחיר ואישור ניהול חשבון בנק של הספק.",
      [sig, inv].filter(Boolean).join("; ") + (sig || inv ? "." : "אין דרישת חתימה או חשבונית לפי סכום."),
      "את הטופס החתום יש להחזיר לסניף, והוא יצורף לתיק ההוצאה.",
    ];
  },
  footer(referenceNo: number, versionNo: number | null): string {
    return versionNo === null
      ? `טופס הזמנה - הוצאה ${referenceNo} - טיוטה`
      : `טופס הזמנה - הוצאה ${referenceNo} - גרסה ${versionNo}`;
  },
} as const;
