import { useCallback, useState } from "react";
import { Eye, KeyRound, Plus, Truck } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/Toast";
import { useAsyncData } from "../../hooks/useAsyncData";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT, budgetErrorMessage } from "./budget.constants";
import { BudgetApiError, budgetCall, type RevealedBank, type Supplier } from "./budgetClient";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { LoadError, Money, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.suppliers;
const c = BUDGET_TEXT.common;

type Dialog =
  | { kind: "edit"; supplier: Supplier | null }
  | { kind: "stepup"; supplier: Supplier; action: "reveal" | "change" }
  | { kind: "bank"; supplier: Supplier; proof: string }
  | null;

export function BudgetSuppliersPage() {
  const session = useBudgetSession((s) => s.session);
  const canManage = budgetCan(session, "budget.manageSuppliers");
  const fetchSuppliers = useCallback(() => budgetCall<Supplier[]>("list_suppliers"), []);
  const { data, error, reload } = useAsyncData(fetchSuppliers);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [revealed, setRevealed] = useState<Record<string, RevealedBank | null>>({});
  const [query, setQuery] = useState("");

  const rows = (data ?? []).filter(
    (s) => !query.trim() || s.businessName.includes(query.trim()) || (s.taxId ?? "").includes(query.trim()),
  );

  /** After a successful step-up: a reveal is performed immediately with the
   * one-time proof; a change opens the bank form carrying it. The proof
   * lives only in this component's memory and is discarded after one use. */
  const onProof = async (supplier: Supplier, action: "reveal" | "change", proof: string) => {
    if (action === "change") {
      setDialog({ kind: "bank", supplier, proof });
      return;
    }
    setDialog(null);
    try {
      const r = await budgetCall<{ bank: RevealedBank | null }>("reveal_supplier_bank", { supplierId: supplier.id, proof });
      setRevealed((prev) => ({ ...prev, [supplier.id]: r.bank }));
    } catch (e) {
      toast.error(budgetErrorMessage(e instanceof BudgetApiError ? e.code : undefined));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={canManage ? (
          <Button onClick={() => setDialog({ kind: "edit", supplier: null })} data-testid="new-supplier">
            <Plus className="size-4" />
            {t.newSupplier}
          </Button>
        ) : undefined}
      />
      <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={c.search} aria-label={c.search} />

      {error && <LoadError onRetry={reload} />}
      {!data && !error ? (
        <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : data && rows.length === 0 ? (
        <EmptyState icon={Truck} title={t.empty} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2" data-testid="supplier-list">
          {rows.map((s) => {
            const bank = revealed[s.id];
            return (
              <li key={s.id}>
                <Card className={cn("space-y-3 p-4", !s.isActive && "opacity-60")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-800">{s.businessName}</p>
                      <p className="text-xs text-slate-500">
                        {[s.contactName, s.phone, s.taxId ? `${t.taxId} ${s.taxId}` : null].filter(Boolean).join(" · ") || c.none}
                        {!s.isActive && ` · ${c.inactive}`}
                      </p>
                    </div>
                    {canManage && (
                      <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "edit", supplier: s })}>{c.edit}</Button>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-slate-500">{t.expenseCount}</dt><dd className="font-bold">{s.expenseCount}</dd></div>
                    <div><dt className="text-xs text-slate-500">{t.totalAmount}</dt><dd className="font-bold"><Money value={s.totalAmount} /></dd></div>
                    <div><dt className="text-xs text-slate-500">{t.outstandingParty}</dt><dd><Money value={s.partyOutstanding} /></dd></div>
                    <div><dt className="text-xs text-slate-500">{t.outstandingCampaign}</dt><dd><Money value={s.campaignOutstanding} /></dd></div>
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm" data-testid="supplier-bank">
                    <span className="text-slate-600">
                      {t.bank}:{" "}
                      {bank ? (
                        <span dir="ltr" className="font-mono font-bold">{[bank.bankCode, bank.branchCode, bank.accountNumber].filter(Boolean).join("-")}</span>
                      ) : s.bank ? (
                        <>{t.bankMasked}<span dir="ltr" className="font-mono font-bold">{s.bank.accountLast4}</span></>
                      ) : (
                        t.bankNone
                      )}
                    </span>
                    {canManage && (
                      <span className="flex gap-1.5">
                        {s.bank && !bank && (
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "stepup", supplier: s, action: "reveal" })}>
                            <Eye className="size-4" />{t.reveal}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "stepup", supplier: s, action: "change" })}>
                          <KeyRound className="size-4" />{t.changeBank}
                        </Button>
                      </span>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === "edit" && (
        <SupplierDialog supplier={dialog.supplier} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />
      )}
      {dialog?.kind === "stepup" && (
        <StepUpDialog supplier={dialog.supplier} action={dialog.action} onClose={() => setDialog(null)}
          onProof={(proof) => void onProof(dialog.supplier, dialog.action, proof)} />
      )}
      {dialog?.kind === "bank" && (
        <BankDialog supplier={dialog.supplier} proof={dialog.proof} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setRevealed((p) => ({ ...p, [dialog.supplier.id]: undefined as unknown as null })); reload(); }} />
      )}
    </div>
  );
}

function SupplierDialog({ supplier, onClose, onDone }: { supplier: Supplier | null; onClose: () => void; onDone: () => void }) {
  const [businessName, setBusinessName] = useState(supplier?.businessName ?? "");
  const [contactName, setContactName] = useState(supplier?.contactName ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [taxId, setTaxId] = useState(supplier?.taxId ?? "");
  const [address, setAddress] = useState(supplier?.address ?? "");
  const [notes, setNotes] = useState(supplier?.notes ?? "");
  const [isActive, setIsActive] = useState(supplier?.isActive ?? true);
  const { run, busy } = useBudgetAction();
  return (
    <Modal open onClose={onClose} title={supplier ? c.edit : t.newSupplier} wide>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        const args = { businessName: businessName.trim(), contactName: contactName.trim() || null, phone: phone.trim() || null,
          taxId: taxId.trim() || null, address: address.trim() || null, notes: notes.trim() || null };
        void run(() => (supplier
          ? budgetCall("update_supplier", { supplierId: supplier.id, expectedVersion: supplier.version, isActive, ...args })
          : budgetCall("create_supplier", args)), c.saved).then((r) => r !== undefined && onDone());
      }}>
        <div className="sm:col-span-2"><Field label={t.businessName}><Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={200} required /></Field></div>
        <Field label={t.contactName}><Input value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={200} /></Field>
        <Field label={t.phone}><Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} /></Field>
        <Field label={t.taxId}><Input dir="ltr" inputMode="numeric" value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={20} /></Field>
        <Field label={t.address}><Input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} /></Field>
        <div className="sm:col-span-2"><Field label={c.notes}><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field></div>
        {supplier && (
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="size-4 accent-primary-600" />
            {c.active}
          </label>
        )}
        <div className="sm:col-span-2"><Button type="submit" className="w-full" loading={busy} disabled={!businessName.trim()}>{c.save}</Button></div>
      </form>
    </Modal>
  );
}

/** Fresh password confirmation for ONE bank action on ONE supplier. The
 * server verifies it with the caller's own authoritative credential check and
 * returns a single-use, 5-minute proof bound to user, workspace, supplier and
 * action. The password is never stored. */
function StepUpDialog({ supplier, action, onClose, onProof }: {
  supplier: Supplier; action: "reveal" | "change"; onClose: () => void; onProof: (proof: string) => void;
}) {
  const [password, setPassword] = useState("");
  const { run, busy } = useBudgetAction();
  return (
    <Modal open onClose={onClose} title={t.stepUpTitle}>
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        void run(() => budgetCall<{ proof: string }>("stepup", { kind: action, supplierId: supplier.id, password })).then((r) => {
          setPassword("");
          if (r?.proof) onProof(r.proof);
        });
      }}>
        <p className="text-sm text-slate-600">{t.stepUpHint}</p>
        <Field label={t.password}>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!password}>{t.confirm}</Button>
      </form>
    </Modal>
  );
}

function BankDialog({ supplier, proof, onClose, onDone }: { supplier: Supplier; proof: string; onClose: () => void; onDone: () => void }) {
  const [bankCode, setBankCode] = useState("");
  const [branchCode, setBranchCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const { run, busy } = useBudgetAction();
  return (
    <Modal open onClose={onClose} title={`${t.changeBank} - ${supplier.businessName}`}>
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        void run(() => budgetCall("set_supplier_bank", {
          supplierId: supplier.id, proof, accountNumber: accountNumber.trim(),
          ...(bankCode.trim() ? { bankCode: bankCode.trim() } : {}),
          ...(branchCode.trim() ? { branchCode: branchCode.trim() } : {}),
          ...(accountHolder.trim() ? { accountHolder: accountHolder.trim() } : {}),
        }), c.saved).then((r) => r !== undefined && onDone());
      }}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.bankCode}><Input dir="ltr" inputMode="numeric" value={bankCode} onChange={(e) => setBankCode(e.target.value)} maxLength={3} /></Field>
          <Field label={t.branchCode}><Input dir="ltr" inputMode="numeric" value={branchCode} onChange={(e) => setBranchCode(e.target.value)} maxLength={5} /></Field>
        </div>
        <Field label={t.accountNumber}><Input dir="ltr" inputMode="numeric" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} maxLength={30} required /></Field>
        <Field label={t.accountHolder}><Input value={accountHolder} onChange={(e) => setAccountHolder(e.target.value)} maxLength={200} /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!accountNumber.trim()}>{c.save}</Button>
      </form>
    </Modal>
  );
}
