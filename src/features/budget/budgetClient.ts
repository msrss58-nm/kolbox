/**
 * Budget Stage 3: the one client for the dedicated Budget endpoint
 * (`api/budget/actions.ts`). Two principals, never mixed:
 *   - "worker": the PermissionUser's HttpOnly session cookie (sent by the
 *     browser automatically - no token ever touches this module);
 *   - "owner": the Election Owner's Supabase access token as a Bearer header.
 * The server derives the workspace, entitlement and permissions itself; this
 * module sends an op name and its arguments only - never a workspace id,
 * actor id or permission. Amounts are integer agorot.
 */
import { useOwnerSession } from "../election-day/ownerSession";

const BUDGET_ENDPOINT = "/api/budget/actions";

export type BudgetPrincipal = "worker" | "owner";

export interface BudgetErrorDetails {
  field?: string;
  blockers?: string[];
  existingSupplierId?: string;
  entity?: string;
}

/** A failed Budget call. `code` is a fixed server code (e.g. "FORBIDDEN",
 * "STALE_VERSION") or "NETWORK" / "UNEXPECTED". */
export class BudgetApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: BudgetErrorDetails;
  constructor(code: string, status: number, details: BudgetErrorDetails = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function budgetCall<T>(
  op: string,
  args: Record<string, unknown> = {},
  principal: BudgetPrincipal = "worker",
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (principal === "owner") {
    const token = await useOwnerSession.getState().getAccessToken();
    if (!token) throw new BudgetApiError("UNAUTHORIZED", 401);
    headers.authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(principal === "owner" ? `${BUDGET_ENDPOINT}?principal=owner` : BUDGET_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ op, args }),
    });
  } catch {
    throw new BudgetApiError("NETWORK", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const obj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof obj.error === "string" ? obj.error : "UNEXPECTED";
    throw new BudgetApiError(code, res.status, {
      field: typeof obj.field === "string" ? obj.field : undefined,
      blockers: Array.isArray(obj.blockers) ? obj.blockers.filter((b): b is string => typeof b === "string") : undefined,
      existingSupplierId: typeof obj.existingSupplierId === "string" ? obj.existingSupplierId : undefined,
      entity: typeof obj.entity === "string" ? obj.entity : undefined,
    });
  }
  if (op === "stepup") return obj as T;
  return obj.data as T;
}

// ---------------------------------------------------------------------------
// Response shapes (what the dispatchers return; amounts in agorot).
// ---------------------------------------------------------------------------
export type FundingKind = "party" | "donation" | "personal";
export type ExpenseStatus = "draft" | "committed" | "incurred" | "closed" | "cancelled";
export type PaymentStatus = "unpaid" | "partial" | "paid";
export type SubmissionDisplayState =
  | "awaiting_preapproval"
  | "preapproved"
  | "sent"
  | "returned"
  | "reference_received";
export type ConfirmationSource = "funder_notice" | "supplier_confirmation" | "bank_transfer" | "other";

export interface BudgetSession {
  actorType: "worker" | "owner";
  actorName: string;
  workspaceName: string;
  permissions: string[];
  modules: string[];
}

export interface BudgetOverview {
  totalBudget: number;
  partyBudget: number;
  donationBudget: number;
  personalBudget: number;
  committed: number;
  actual: number;
  available: number;
  plannedInCategories: number;
  unallocatedPlan: number;
  unfundedTotal: number;
  paid: number;
  outstanding: number;
  partyOutstanding: number;
  campaignLiability: number;
  authorizedNotFullyPaid: { count: number; amount: number };
  awaitingPreapproval: number;
  sentWaitingReference: number;
  unfundedExpenses: number;
  overrunCategories: number;
  overrunSources: number;
}

export interface FundingSource {
  id: string;
  name: string;
  kind: FundingKind;
  isActive: boolean;
  sortOrder: number;
  originalAmount: number;
  adjustments: number;
  currentAmount: number;
  committed: number;
  actual: number;
  remaining: number;
  overrun: boolean;
  version: number;
}

export interface BudgetCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  originalPlan: number;
  adjustments: number;
  currentPlan: number;
  committed: number;
  actual: number;
  remaining: number;
  overrun: boolean;
  inUse: boolean;
  version: number;
}

export interface PlanAdjustment {
  id: string;
  categoryId: string;
  delta: number;
  kind: "increase" | "decrease" | "transfer";
  transferId: string | null;
  reason: string;
  actorName: string;
  createdAt: string;
}

export interface SourceAdjustment {
  id: string;
  sourceId: string;
  delta: number;
  reason: string;
  actorName: string;
  createdAt: string;
}

export interface Supplier {
  id: string;
  businessName: string;
  contactName: string | null;
  phone: string | null;
  taxId: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
  bank: { accountLast4: string } | null;
  expenseCount: number;
  totalAmount: number;
  outstanding: number;
  partyOutstanding: number;
  campaignOutstanding: number;
  unfundedOutstanding: number;
}

export interface RevealedBank {
  bankCode: string | null;
  branchCode: string | null;
  accountNumber: string;
  accountHolder: string | null;
}

export interface ExpenseListRow {
  id: string;
  referenceNo: number;
  status: ExpenseStatus;
  description: string;
  supplierId: string | null;
  categoryId: string | null;
  total: number | null;
  expenseDate: string | null;
  allocated: number;
  unfunded: number;
  paid: number;
  outstanding: number;
  paymentStatus: PaymentStatus;
  partyAllocations: number;
  awaitingPreapproval: number;
  sentWaitingReference: number;
  authorizedNotFullyPaid: number;
  version: number;
}

export interface ExpenseList {
  total: number;
  totalAmount: number;
  rows: ExpenseListRow[];
}

export interface Allocation {
  id: string;
  sourceId: string;
  kind: FundingKind;
  payer: "party" | "campaign";
  amount: number;
  paid: number;
  version: number;
  paymentStatus: PaymentStatus;
  preapproval: {
    orderNumber: string | null;
    approvalCode: string;
    approverName: string;
    approvalDate: string;
    preapprovedAmount: number | null;
    version: number;
  } | null;
  submission: {
    state: "not_sent" | "sent" | "returned";
    displayState: SubmissionDisplayState;
    requestedAmount: number | null;
    lastSentAt: string | null;
    lastReturnedAt: string | null;
  } | null;
  reference: {
    referenceNumber: string;
    authorizedAmount: number;
    receivedDate: string;
    version: number;
  } | null;
}

export interface Payment {
  id: string;
  allocationId: string;
  amount: number;
  paymentDate: string;
  payer: "party" | "campaign";
  confirmationSource: ConfirmationSource;
  externalReference: string | null;
  note: string | null;
  recordedByName: string;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface SubmissionEvent {
  id: string;
  allocationId: string;
  event: "sent" | "returned";
  recipientPhone: string | null;
  note: string | null;
  actorName: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  referenceNo: number;
  description: string;
  supplierId: string | null;
  categoryId: string | null;
  total: number | null;
  net: number | null;
  vat: number | null;
  vatRateBp: number | null;
  expenseDate: string | null;
  deliveryDate: string | null;
  invoiceDate: string | null;
  status: ExpenseStatus;
  notes: string | null;
  statusReason: string | null;
  closedAt: string | null;
  version: number;
  facts: {
    allocated: number;
    unfunded: number;
    paid: number;
    outstanding: number;
    partyOutstanding: number;
    campaignOutstanding: number;
    partyAuthorized: number;
    paymentStatus: PaymentStatus;
    awaitingPreapproval: number;
    sentWaitingReference: number;
    authorizedNotFullyPaid: number;
    preapprovalExceeded: number;
  };
  allocations: Allocation[];
  payments: Payment[];
  submissionEvents: SubmissionEvent[];
}

export interface HistoryEntry {
  id: number;
  entityType: string;
  action: "insert" | "update" | "delete" | "event";
  actorType: "worker" | "owner";
  actorName: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: string;
}

export interface DocumentRule {
  id: string;
  documentTypeId: string;
  documentTypeKey: string;
  fundingKind: FundingKind | null;
  condition: "always" | "amount_gt" | "amount_gte" | "category" | "manual";
  threshold: number | null;
  isActive: boolean;
  version: number;
  categoryIds: string[];
}

// ---------------------------------------------------------------------------
// Stage 4 - documents, requirements, order form, supplier file.
// ---------------------------------------------------------------------------
export type DocumentMime = "application/pdf" | "image/jpeg" | "image/png" | "image/heic" | "image/heif";

export interface DocumentVersion {
  id: string;
  versionNo: number;
  fileName: string;
  mimeType: DocumentMime;
  sizeBytes: number;
  sha256: string;
  origin: "upload" | "generated";
  orderFormVersionId: string | null;
  note: string | null;
  createdByName: string;
  createdAt: string;
}

export interface BudgetDocument {
  id: string;
  documentTypeId: string;
  typeKey: string;
  typeName: string;
  expenseId: string | null;
  supplierId: string | null;
  title: string | null;
  notes: string | null;
  validUntil: string | null;
  status: "active" | "archived";
  archivedAt: string | null;
  archiveReason: string | null;
  version: number;
  createdAt: string;
  /** Newest first. */
  versions: DocumentVersion[];
}

export interface RequirementItem {
  documentTypeId: string;
  key: string;
  name: string;
  required: boolean;
  rules: { ruleId: string; condition: DocumentRule["condition"]; threshold: number | null; matched: boolean }[];
  satisfied: boolean;
  satisfiedBy: { documentId: string; versionId: string; versionNo: number; source: "expense" | "supplier" | "order_form_return" } | null;
}

/** The server's ONE requirement evaluation (live, or the close-time snapshot). */
export interface DocumentRequirements {
  mode: "live" | "snapshot";
  capturedAt?: string;
  total: number | null;
  fundingKinds: FundingKind[];
  partyFunded: boolean;
  invoiceRequired: boolean;
  supplierSignatureRequired: boolean;
  photoRequired: boolean;
  latestOrderFormVersionId: string | null;
  items: RequirementItem[];
  missing: string[];
  ready: boolean;
}

export type OrderFormState = "not_applicable" | "draft" | "ready" | "generated" | "sent" | "returned";

export interface OrderFormVersion {
  id: string;
  versionNo: number;
  documentVersionId: string;
  templateKey: string;
  supplierSignatureRequired: boolean;
  sentAt: string | null;
  sentByName: string | null;
  sentNote: string | null;
  createdByName: string;
  createdAt: string;
  returns: { versionId: string; versionNo: number; fileName: string; mimeType: DocumentMime; createdByName: string; createdAt: string }[];
}

export interface OrderFormInfo {
  state: OrderFormState;
  /** Newest first. */
  versions: OrderFormVersion[];
  canPreview: boolean;
  canGenerate: boolean;
  generateBlockers: string[];
}

export interface ExpenseDocuments {
  expenseId: string;
  expenseStatus: ExpenseStatus;
  requirements: DocumentRequirements;
  documents: BudgetDocument[];
  supplierDocuments: BudgetDocument[];
  orderForm: OrderFormInfo;
  flags: string[];
  manualTypes: { documentTypeId: string; key: string; name: string }[];
  /** The types a user may choose for a new document (active, not order-form-managed). */
  documentTypes: { id: string; key: string; name: string }[];
}

export interface SupplierFile {
  supplier: Supplier;
  documentTypes: { id: string; key: string; name: string }[];
  documents: BudgetDocument[];
  expenses: {
    id: string;
    referenceNo: number;
    description: string;
    status: ExpenseStatus;
    total: number | null;
    expenseDate: string | null;
    documentsReady: boolean;
    missing: string[];
    documents: { id: string; typeName: string; status: "active" | "archived"; currentVersion: { id: string; versionNo: number; fileName: string } | null }[];
  }[];
}

export interface BudgetSettings {
  periodStart: string | null;
  periodEnd: string | null;
  branchName: string | null;
  branchNumber: string | null;
  defaultOrderer: string | null;
  electionYearLabel: string | null;
  funderHeaderLines: string[];
  whatsappFunderPhone: string | null;
  whatsappSupplierTemplate: string | null;
  whatsappFunderTemplate: string | null;
  alertMissingDocsDays: number;
  alertSupplierFormDays: number;
  alertNoReferenceDays: number;
  alertUnpaidDays: number;
  alertSupplierDocExpiryDays: number;
  categoryUsageWarningPct: number;
  version: number;
  documentTypes: { id: string; key: string; name: string; isSystem: boolean; isActive: boolean; sortOrder: number }[];
  documentRules: DocumentRule[];
}
