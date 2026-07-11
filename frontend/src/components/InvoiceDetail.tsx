import { useEffect, useState } from "react";
import { api, type InvoiceView, type Payment } from "../api";
import { formatCents, toCents } from "../lib/money";
import { Button, Modal, Spinner, StatusBadge, useToast } from "./ui";

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function randomKey(): string {
  return crypto.randomUUID();
}

export function InvoiceDetail({
  invoiceId,
  onClose,
  onMutate,
  accountName,
}: {
  invoiceId: string | null;
  onClose: () => void;
  onMutate: () => void;
  accountName: Map<string, string>;
}) {
  const notify = useToast();
  const [inv, setInv] = useState<InvoiceView | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // payment form
  const [amount, setAmount] = useState("");
  const [idemKey, setIdemKey] = useState(randomKey);
  const [method, setMethod] = useState("card");
  const [paying, setPaying] = useState(false);
  const [issuing, setIssuing] = useState(false);

  useEffect(() => {
    if (!invoiceId) {
      setInv(null);
      setPayments([]);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([api.getInvoice(invoiceId), api.listInvoicePayments(invoiceId)])
      .then(([i, p]) => {
        if (!alive) return;
        setInv(i);
        setPayments(p);
        setAmount(i.amountDueCents > 0 ? (i.amountDueCents / 100).toFixed(2) : "");
        setIdemKey(randomKey());
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [invoiceId]);

  async function refresh() {
    if (!inv) return;
    const [i, p] = await Promise.all([api.getInvoice(inv.id), api.listInvoicePayments(inv.id)]);
    setInv(i);
    setPayments(p);
    setAmount(i.amountDueCents > 0 ? (i.amountDueCents / 100).toFixed(2) : "");
  }

  async function issue() {
    if (!inv) return;
    setIssuing(true);
    try {
      const next = await api.issueInvoice(inv.id);
      setInv(next);
      notify(`Invoice ${next.number} issued → posted to ledger`, "success");
      onMutate();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setIssuing(false);
    }
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!inv) return;
    const cents = toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) return notify("Enter a valid payment amount", "error");
    if (cents > inv.amountDueCents) return notify(`Payment exceeds amount due (${formatCents(inv.amountDueCents)})`, "error");
    setPaying(true);
    try {
      const res = await api.applyPayment(inv.id, {
        amountCents: cents,
        idempotencyKey: idemKey.trim() || randomKey(),
        method: method || undefined,
      });
      if (res.idempotent) notify("Duplicate payment ignored (idempotent)", "info");
      else notify(`Payment of ${formatCents(cents)} recorded`, "success");
      await refresh();
      onMutate();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setPaying(false);
    }
  }

  const payable = inv?.status === "sent" || inv?.status === "partial";

  return (
    <Modal open={!!invoiceId} title={inv ? `Invoice ${inv.number}` : "Invoice"} onClose={onClose} wide>
      {loading && <Spinner label="Loading invoice…" />}
      {error && <p className="error-banner">{error}</p>}

      {inv && (
        <div className="stack">
          <div className="detail-meta">
            <div>
              <StatusBadge status={inv.effectiveStatus} />
              <span className="muted small" style={{ marginLeft: 8 }}>
                stored: {inv.status}
              </span>
            </div>
            <span className="muted small">{accountName.get(inv.customerAccountId) ?? inv.customerAccountId}</span>
          </div>

          <div className="detail-dates">
            <div><span className="muted">Issued</span><span>{fmtDate(inv.issueDate)}</span></div>
            <div><span className="muted">Due</span><span>{fmtDate(inv.dueDate)}</span></div>
            <div><span className="muted">Created</span><span>{fmtDate(inv.createdAt)}</span></div>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="ta-right">Qty</th>
                <th className="ta-right">Unit</th>
                <th className="ta-right">Tax</th>
                <th className="ta-right">Line total</th>
              </tr>
            </thead>
            <tbody>
              {inv.lineItems.map((li) => (
                <tr key={li.id}>
                  <td>{li.description}</td>
                  <td className="ta-right mono">{li.quantity}</td>
                  <td className="ta-right mono">{formatCents(li.unitPriceCents)}</td>
                  <td className="ta-right mono muted">{((li.taxBps ?? 0) / 100).toFixed(2)}%</td>
                  <td className="ta-right mono">{formatCents(li.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="totals-preview">
            <div><span className="muted">Subtotal</span><span className="mono">{formatCents(inv.totals.subtotalCents)}</span></div>
            <div><span className="muted">Tax</span><span className="mono">{formatCents(inv.totals.taxCents)}</span></div>
            <div><span className="muted">Total</span><span className="mono">{formatCents(inv.totals.totalCents)}</span></div>
            <div><span className="muted">Paid</span><span className="mono">{formatCents(inv.paidCents)}</span></div>
            <div className="total-row"><span>Amount due</span><span className="mono strong">{formatCents(inv.amountDueCents)}</span></div>
          </div>

          {inv.notes && (
            <div className="notes">
              <span className="muted small">Notes</span>
              <p>{inv.notes}</p>
            </div>
          )}

          {inv.status === "draft" && (
            <div className="callout">
              <span>This is a draft. Issue it to post the receivable and revenue to the ledger.</span>
              <Button onClick={issue} disabled={issuing}>
                {issuing ? "Issuing…" : "Issue invoice"}
              </Button>
            </div>
          )}

          {inv.status !== "draft" && inv.status !== "void" && (
            <form className="payment-form" onSubmit={pay}>
              <h4>Record payment</h4>
              <div className="grid-pay">
                <label className="field">
                  <span>Amount ($)</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={!payable}
                  />
                </label>
                <label className="field">
                  <span>Method</span>
                  <select value={method} onChange={(e) => setMethod(e.target.value)} disabled={!payable}>
                    <option value="card">card</option>
                    <option value="ach">ach</option>
                    <option value="wire">wire</option>
                    <option value="cash">cash</option>
                  </select>
                </label>
                <label className="field fi-wide">
                  <span>Idempotency key</span>
                  <input value={idemKey} onChange={(e) => setIdemKey(e.target.value)} disabled={!payable} />
                </label>
              </div>
              <div className="form-actions">
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  onClick={() => setIdemKey(randomKey())}
                  disabled={!payable}
                >
                  New key
                </Button>
                <Button type="submit" disabled={paying || !payable}>
                  {!payable ? "Not payable" : paying ? "Recording…" : "Record payment"}
                </Button>
              </div>
              {!payable && (
                <p className="muted small">Invoice is {inv.effectiveStatus} — not accepting payments.</p>
              )}
            </form>
          )}

          <div>
            <h4>Payments ({payments.length})</h4>
            {payments.length === 0 ? (
              <p className="muted small">No payments recorded.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Method</th>
                    <th>Reference</th>
                    <th>Status</th>
                    <th className="ta-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td className="muted small">{fmtDate(p.created_at)}</td>
                      <td className="mono">{p.method ?? "—"}</td>
                      <td className="mono small muted">{p.reference ?? p.idempotency_key.slice(0, 8)}</td>
                      <td><span className="chip">{p.status}</span></td>
                      <td className="ta-right mono">{formatCents(p.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
