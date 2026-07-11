import { useState } from "react";
import { api, type AccountType, type AccountWithBalance } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatCents } from "../lib/money";
import { Button, EmptyState, ErrorBanner, Modal, Spinner, useToast } from "./ui";

const TYPES: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];

export function Accounts({ refreshKey, onMutate }: { refreshKey: number; onMutate: () => void }) {
  const notify = useToast();
  const { data, loading, error, reload } = useAsync<AccountWithBalance[]>(
    () => api.listAccounts(),
    [refreshKey]
  );
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const accounts = data ?? [];

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = String(form.get("code") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const type = String(form.get("type") ?? "asset") as AccountType;
    const currency = String(form.get("currency") ?? "").trim();
    if (!code || !name) return notify("Code and name are required", "error");
    setSaving(true);
    try {
      await api.createAccount({ code, name, type, currency: currency || undefined });
      notify(`Account ${code} created`, "success");
      setOpen(false);
      onMutate();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Chart of Accounts</h2>
          <p className="muted">{accounts.length} account{accounts.length === 1 ? "" : "s"} · balances derived from the ledger</p>
        </div>
        <Button onClick={() => setOpen(true)}>New account</Button>
      </div>

      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !accounts.length && <Spinner label="Loading accounts…" />}

      {!loading && !accounts.length && !error && (
        <div className="card">
          <EmptyState title="No accounts" hint="Create one, or seed demo data from the Overview tab." />
        </div>
      )}

      {accounts.length > 0 && (
        <div className="card table-card">
          <table className="table">
            <thead>
              <tr>
                <th className="ta-right">Code</th>
                <th>Name</th>
                <th>Type</th>
                <th className="ta-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="ta-right mono">{a.code}</td>
                  <td>{a.name}</td>
                  <td><span className="chip">{a.type}</span> <span className="muted">{a.currency}</span></td>
                  <td className={`ta-right mono ${a.balanceCents < 0 ? "neg" : ""}`}>{formatCents(a.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} title="New account" onClose={() => setOpen(false)}>
        <form className="stack" onSubmit={submit}>
          <div className="grid-2">
            <label className="field">
              <span>Code</span>
              <input name="code" placeholder="e.g. 1500" required autoFocus />
            </label>
            <label className="field">
              <span>Type</span>
              <select name="type" defaultValue="asset">
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Name</span>
            <input name="name" placeholder="e.g. Inventory Reserve" required />
          </label>
          <label className="field">
            <span>Currency (optional)</span>
            <input name="currency" placeholder="USD" />
          </label>
          <div className="form-actions">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Create account"}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
