import { api, type AccountWithBalance, type InvoiceView } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatCents } from "../lib/money";
import { EmptyState, ErrorBanner, Spinner } from "./ui";

// Receivable = asset accounts whose name/code reads as receivable (1200 AR control, AR_* customers).
function isReceivable(a: AccountWithBalance) {
  return a.type === "asset" && (/receivable/i.test(a.name) || /^12\d\d$/.test(a.code) || /^ar/i.test(a.code));
}
// ponytail: cash by convention is account code 1000 (the seeded Cash/Bank). If the chart
// grows multiple cash accounts, sum asset accounts whose name contains "cash"/"bank".
function isCash(a: AccountWithBalance) {
  return a.code === "1000" || (/cash|bank/i.test(a.name) && a.type === "asset");
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`tile${accent ? " tile-accent" : ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function Overview({ refreshKey }: { refreshKey: number; onMutate: () => void }) {
  const accounts = useAsync<AccountWithBalance[]>(() => api.listAccounts(), [refreshKey]);
  const invoices = useAsync<InvoiceView[]>(() => api.listInvoices(), [refreshKey]);

  const accs = accounts.data ?? [];
  const invs = invoices.data ?? [];

  const totalReceivable = accs.filter(isReceivable).reduce((s, a) => s + a.balanceCents, 0);
  const totalCash = accs.filter(isCash).reduce((s, a) => s + a.balanceCents, 0);
  const overdueCount = invs.filter((i) => i.effectiveStatus === "overdue").length;

  const loading = accounts.loading || invoices.loading;
  const error = accounts.error || invoices.error;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Overview</h2>
          <p className="muted">Double-entry ledger and invoice health at a glance.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => { accounts.reload(); invoices.reload(); }} />}
      {loading && !accs.length && !invs.length && <Spinner label="Loading ledger…" />}

      {!loading || accs.length || invs.length ? (
        <div className="tile-grid">
          <Tile label="Total Receivable" value={formatCents(totalReceivable)} accent sub="Outstanding AR balances" />
          <Tile label="Cash on Hand" value={formatCents(totalCash)} sub="Cash / Bank balance" />
          <Tile label="Invoices" value={String(invs.length)} sub={`${invs.filter((i) => i.status === "draft").length} draft`} />
          <Tile
            label="Overdue"
            value={String(overdueCount)}
            sub={overdueCount ? "Past due date" : "None — looking good"}
          />
        </div>
      ) : null}

      {!loading && !invs.length && (
        <div className="card">
          <EmptyState
            title="No invoices yet"
            hint="Create a customer account under Accounts, then draft an invoice and record a payment to see the ledger update."
          />
        </div>
      )}
    </section>
  );
}
