import { useMemo, useState } from "react";
import {
  api,
  type AccountWithBalance,
  type InvoiceView,
  type LineItemInput,
} from "../api";
import { useAsync } from "../lib/useAsync";
import { formatCents, toCents } from "../lib/money";
import { Button, EmptyState, ErrorBanner, Modal, Spinner, StatusBadge, useToast } from "./ui";
import { InvoiceDetail } from "./InvoiceDetail";

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { dateStyle: "medium" });
}

interface LineState {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxPct: string;
}

// Mirrors backend lib/money.ts totalsFor exactly (integer math).
function previewTotals(lines: LineState[]) {
  let subtotal = 0;
  let total = 0;
  for (const l of lines) {
    const qty = Math.max(0, Math.trunc(Number(l.quantity) || 0));
    const unit = toCents(l.unitPrice);
    if (!Number.isFinite(unit) || unit < 0) continue;
    const gross = qty * unit;
    const bps = Math.round((Math.max(0, parseFloat(l.taxPct) || 0)) * 100);
    subtotal += gross;
    total += Math.round((gross * (10_000 + bps)) / 10_000);
  }
  return { subtotal, tax: total - subtotal, total };
}

export function Invoices({ refreshKey, onMutate }: { refreshKey: number; onMutate: () => void }) {
  const notify = useToast();
  const invoices = useAsync<InvoiceView[]>(() => api.listInvoices(), [refreshKey]);
  const accounts = useAsync<AccountWithBalance[]>(() => api.listAccounts(), [refreshKey]);

  const list = invoices.data ?? [];
  const accs = accounts.data ?? [];
  const nameById = useMemo(
    () => new Map(accs.map((a) => [a.id, `${a.code} · ${a.name}`])),
    [accs]
  );

  const [detailId, setDetailId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const error = invoices.error || accounts.error;
  const loading = invoices.loading && !list.length;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Invoices</h2>
          <p className="muted">{list.length} invoice{list.length === 1 ? "" : "s"} · click a row for detail, issue, and payments</p>
        </div>
        <Button onClick={() => setCreating(true)} disabled={!accs.length}>
          New invoice
        </Button>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => { invoices.reload(); accounts.reload(); }} />}
      {loading && <Spinner label="Loading invoices…" />}

      {!loading && !list.length && !error && (
        <div className="card">
          <EmptyState
            title="No invoices yet"
            hint={accs.length ? "Click “New invoice” to draft one." : "Create a customer account under Accounts first."}
          />
        </div>
      )}

      {list.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Due</th>
                <th className="ta-right">Total</th>
                <th className="ta-right">Paid</th>
                <th className="ta-right">Due</th>
              </tr>
            </thead>
            <tbody>
              {list.map((inv) => (
                <tr key={inv.id} className="clickable" onClick={() => setDetailId(inv.id)}>
                  <td className="mono">{inv.number}</td>
                  <td className="muted">{nameById.get(inv.customerAccountId) ?? "—"}</td>
                  <td><StatusBadge status={inv.effectiveStatus} /></td>
                  <td className="muted small">{fmtDate(inv.issueDate)}</td>
                  <td className="muted small">{fmtDate(inv.dueDate)}</td>
                  <td className="ta-right mono">{formatCents(inv.totals.totalCents)}</td>
                  <td className="ta-right mono">{formatCents(inv.paidCents)}</td>
                  <td className="ta-right mono strong">{formatCents(inv.amountDueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <InvoiceDetail
        invoiceId={detailId}
        onClose={() => setDetailId(null)}
        onMutate={onMutate}
        accountName={nameById}
      />

      <NewInvoiceModal
        open={creating}
        accounts={accs}
        onClose={() => setCreating(false)}
        onCreated={(num) => {
          setCreating(false);
          notify(`Invoice ${num} created as draft`, "success");
          onMutate();
        }}
      />
    </section>
  );
}

function NewInvoiceModal({
  open,
  accounts,
  onClose,
  onCreated,
}: {
  open: boolean;
  accounts: AccountWithBalance[];
  onClose: () => void;
  onCreated: (number: string) => void;
}) {
  const notify = useToast();
  const defaultCustomer =
    accounts.find((a) => /^ar/i.test(a.code))?.id ?? accounts[0]?.id ?? "";
  const [customer, setCustomer] = useState(defaultCustomer);
  const [dueDate, setDueDate] = useState(todayPlus(30));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineState[]>([
    { key: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "", taxPct: "0" },
  ]);
  const [saving, setSaving] = useState(false);

  const totals = useMemo(() => previewTotals(lines), [lines]);

  function reset() {
    setLines([{ key: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "", taxPct: "0" }]);
    setNotes("");
    setDueDate(todayPlus(30));
  }

  function update(key: string, patch: Partial<LineState>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, { key: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "", taxPct: "0" }]);
  }
  function removeLine(key: string) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((l) => l.key !== key)));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!customer) return notify("Pick a customer account", "error");
    if (!dueDate) return notify("Choose a due date", "error");

    const items: LineItemInput[] = [];
    for (const [i, l] of lines.entries()) {
      if (!l.description.trim()) return notify(`Line ${i + 1}: description is required`, "error");
      const qty = Math.trunc(Number(l.quantity));
      if (!Number.isFinite(qty) || qty < 1) return notify(`Line ${i + 1}: quantity must be a positive integer`, "error");
      const unit = toCents(l.unitPrice);
      if (!Number.isFinite(unit) || unit < 0) return notify(`Line ${i + 1}: invalid unit price`, "error");
      const taxPct = parseFloat(l.taxPct);
      const taxBps = Math.round((Number.isFinite(taxPct) ? Math.max(0, taxPct) : 0) * 100);
      if (taxBps > 9999) return notify(`Line ${i + 1}: tax cannot exceed 99.99%`, "error");
      items.push({ description: l.description.trim(), quantity: qty, unitPriceCents: unit, taxBps });
    }

    setSaving(true);
    try {
      const inv = await api.createInvoice({ customerAccountId: customer, dueDate, lineItems: items, notes: notes.trim() || undefined });
      onCreated(inv.number);
      reset();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="New invoice" onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="grid-2">
          <label className="field">
            <span>Customer account</span>
            <select value={customer} onChange={(e) => setCustomer(e.target.value)} required>
              <option value="" disabled>
                Select…
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Due date</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
          </label>
        </div>

        <div className="line-items">
          <div className="line-items-head">
            <span>Line items</span>
            <Button type="button" variant="subtle" size="sm" onClick={addLine}>
              + Add line
            </Button>
          </div>
          {lines.map((l, idx) => (
            <div className="line-row" key={l.key}>
              <input
                className="li-desc"
                placeholder={`Item ${idx + 1} description`}
                value={l.description}
                onChange={(e) => update(l.key, { description: e.target.value })}
              />
              <input
                className="li-num"
                type="number"
                min={1}
                step={1}
                title="Quantity"
                value={l.quantity}
                onChange={(e) => update(l.key, { quantity: e.target.value })}
              />
              <input
                className="li-num"
                inputMode="decimal"
                placeholder="$ unit"
                title="Unit price (dollars)"
                value={l.unitPrice}
                onChange={(e) => update(l.key, { unitPrice: e.target.value })}
              />
              <input
                className="li-num"
                inputMode="decimal"
                placeholder="% tax"
                title="Tax %"
                value={l.taxPct}
                onChange={(e) => update(l.key, { taxPct: e.target.value })}
              />
              <button
                type="button"
                className="li-remove"
                aria-label="Remove line"
                onClick={() => removeLine(l.key)}
                disabled={lines.length === 1}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <label className="field">
          <span>Notes (optional)</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal note for this invoice" />
        </label>

        <div className="totals-preview">
          <div><span className="muted">Subtotal</span><span className="mono">{formatCents(totals.subtotal)}</span></div>
          <div><span className="muted">Tax</span><span className="mono">{formatCents(totals.tax)}</span></div>
          <div className="total-row"><span>Total</span><span className="mono strong">{formatCents(totals.total)}</span></div>
        </div>

        <div className="form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !accounts.length}>
            {saving ? "Creating…" : "Create draft"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
