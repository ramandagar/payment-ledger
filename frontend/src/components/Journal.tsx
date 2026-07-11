import { api, type AccountWithBalance, type Transaction } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatCents } from "../lib/money";
import { EmptyState, ErrorBanner, Spinner } from "./ui";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function Journal({ refreshKey }: { refreshKey: number }) {
  const txns = useAsync<Transaction[]>(() => api.listTransactions(), [refreshKey]);
  const accs = useAsync<AccountWithBalance[]>(() => api.listAccounts(), [refreshKey]);

  const list = txns.data ?? [];
  const nameById = new Map<string, { code: string; name: string }>(
    (accs.data ?? []).map((a) => [a.id, { code: a.code, name: a.name }])
  );
  const error = txns.error || accs.error;
  const loading = txns.loading || accs.loading;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Journal</h2>
          <p className="muted">Every posted transaction and its balanced debit/credit legs.</p>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={() => { txns.reload(); accs.reload(); }} />}
      {loading && !list.length && <Spinner label="Loading journal…" />}
      {!loading && !list.length && !error && (
        <div className="card">
          <EmptyState title="No transactions yet" hint="Issue an invoice or record a payment to see entries here." />
        </div>
      )}

      <div className="journal">
        {list.map((t) => {
          const debits = t.entries.filter((e) => e.direction === "debit");
          const debitTotal = debits.reduce((s, e) => s + e.amountCents, 0);
          return (
            <article className="card journal-row" key={t.id}>
              <header className="journal-head">
                <div>
                  <span className="journal-ref">{t.reference ?? "—"}</span>
                  {t.source && <span className="chip">{t.source}</span>}
                  {t.description && <span className="muted journal-desc">{t.description}</span>}
                </div>
                <span className="muted small">{fmtDate(t.created_at)}</span>
              </header>
              <table className="table legs">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th className="ta-right">Debit</th>
                    <th className="ta-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {t.entries.map((e, i) => (
                    <tr key={i}>
                      <td className="mono small">
                        {nameById.get(e.accountId)?.code ?? "—"}{" "}
                        <span className="muted">{nameById.get(e.accountId)?.name ?? e.accountId.slice(0, 8)}</span>
                      </td>
                      <td className="ta-right mono">{e.direction === "debit" ? formatCents(e.amountCents) : "—"}</td>
                      <td className="ta-right mono">{e.direction === "credit" ? formatCents(e.amountCents) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="muted">Balanced</td>
                    <td className="ta-right mono">{formatCents(debitTotal)}</td>
                    <td className="ta-right mono">{formatCents(debitTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </article>
          );
        })}
      </div>
    </section>
  );
}
