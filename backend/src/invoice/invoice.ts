import { randomUUID } from "node:crypto";
import { pool, type DbClient } from "../db/client.js";
import { totalsFor, type InvoiceTotals, type LineItem } from "../lib/money.js";
import { postTransaction, type LedgerEntryInput } from "../ledger/posting.js";
import { getAccountByCode } from "../ledger/accounts.js";
import { ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxBps?: number;
}

export interface CreateInvoiceInput {
  customerAccountId: string;
  dueDate: string; // ISO yyyy-mm-dd
  lineItems: InvoiceLineInput[];
  notes?: string;
  currency?: string;
}

export type InvoiceStatus = "draft" | "sent" | "partial" | "paid" | "overdue" | "void";

export interface InvoiceView {
  id: string;
  number: string;
  customerAccountId: string;
  status: InvoiceStatus;            // stored state
  effectiveStatus: InvoiceStatus;   // overlays 'overdue' from due date
  issueDate: string;
  dueDate: string;
  currency: string;
  notes: string | null;
  lineItems: (InvoiceLineInput & { id: string; lineTotalCents: number })[];
  totals: InvoiceTotals;
  paidCents: number;
  amountDueCents: number;           // DERIVED: total - completed payments
  createdAt: string;
}

const PAYABLE_STATES: InvoiceStatus[] = ["sent", "partial"];

// Re-exported so route handlers keep a single import surface for HTTP errors.
export { ValidationError, NotFoundError, ConflictError } from "../lib/errors.js";

async function nextInvoiceNumber(client: DbClient): Promise<string> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(number FROM 5) AS int)), 0) + 1 AS n FROM invoices`
  );
  return `INV-${String(rows[0].n).padStart(4, "0")}`;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<InvoiceView> {
  if (!input.lineItems?.length) throw new ValidationError("invoice needs at least one line item");
  const previewTotal = totalsFor(
    input.lineItems.map((li) => ({ quantity: li.quantity, unitPriceCents: li.unitPriceCents, taxBps: li.taxBps ?? 0 }))
  ).totalCents;
  if (previewTotal <= 0) {
    throw new ValidationError("invoice total must be greater than zero — set a unit price on at least one line");
  }
  return withClient(pool, async (client) => {
    const cust = await client.query("SELECT id FROM accounts WHERE id = $1", [input.customerAccountId]);
    if (!cust.rowCount) throw new NotFoundError("customer account not found");

    const id = randomUUID();
    const number = await nextInvoiceNumber(client);
    await client.query(
      `INSERT INTO invoices (id, number, customer_account_id, status, due_date, currency, notes)
       VALUES ($1, $2, $3, 'draft', $4, $5, $6)`,
      [id, number, input.customerAccountId, input.dueDate, input.currency ?? "USD", input.notes ?? null]
    );
    for (const [i, li] of input.lineItems.entries()) {
      if (li.quantity <= 0) throw new ValidationError("quantity must be > 0");
      if (li.unitPriceCents < 0) throw new ValidationError("unit price must be >= 0");
      await client.query(
        `INSERT INTO invoice_line_items (invoice_id, position, description, quantity, unit_price_cents, tax_bps)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, i, li.description, li.quantity, li.unitPriceCents, li.taxBps ?? 0]
      );
    }
    return getInvoice(id, client);
  });
}

/** Full invoice view: line items, integer-math totals, and DERIVED amount due. */
export async function getInvoice(id: string, client: DbClient | typeof pool = pool): Promise<InvoiceView> {
  const inv = await client.query(
    `SELECT id, number, customer_account_id, status::text AS status, issue_date::text AS issue_date,
            due_date::text AS due_date, currency, notes, created_at
     FROM invoices WHERE id = $1`,
    [id]
  );
  if (!inv.rowCount) throw new NotFoundError("invoice not found");

  const li = await client.query<{
    id: string; position: number; description: string; quantity: string;
    unit_price_cents: string; tax_bps: string;
  }>(
    `SELECT id, position, description, quantity, unit_price_cents, tax_bps
     FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
    [id]
  );

  const lineItems = li.rows.map((r) => {
    const item: LineItem = {
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      taxBps: Number(r.tax_bps),
    };
    return {
      id: r.id,
      description: r.description,
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      taxBps: Number(r.tax_bps),
      lineTotalCents: totalsFor([item]).totalCents,
    };
  });

  const totals = totalsFor(
    li.rows.map((r) => ({
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      taxBps: Number(r.tax_bps),
    }))
  );

  const paid = await client.query<{ paid: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS paid
     FROM payments WHERE invoice_id = $1 AND status = 'completed'`,
    [id]
  );
  const paidCents = Number(paid.rows[0].paid);
  const amountDueCents = Math.max(0, totals.totalCents - paidCents);

  const stored = inv.rows[0].status as InvoiceStatus;
  const overdue =
    stored !== "paid" && stored !== "void" && new Date(inv.rows[0].due_date) < new Date();

  return {
    id: inv.rows[0].id,
    number: inv.rows[0].number,
    customerAccountId: inv.rows[0].customer_account_id,
    status: stored,
    effectiveStatus: overdue ? "overdue" : stored,
    issueDate: inv.rows[0].issue_date,
    dueDate: inv.rows[0].due_date,
    currency: inv.rows[0].currency,
    notes: inv.rows[0].notes,
    lineItems,
    totals,
    paidCents,
    amountDueCents,
    createdAt: inv.rows[0].created_at,
  };
}

export async function listInvoices(): Promise<InvoiceView[]> {
  const { rows } = await pool.query("SELECT id FROM invoices ORDER BY created_at DESC");
  return Promise.all(rows.map((r) => getInvoice(r.id)));
}

/** Delete a draft invoice (and its line items). Only drafts — once issued it's in the ledger. */
export async function deleteInvoice(id: string): Promise<void> {
  const { rows } = await pool.query("SELECT status::text AS status FROM invoices WHERE id = $1", [id]);
  if (!rows.length) throw new NotFoundError("invoice not found");
  if (rows[0].status !== "draft") {
    throw new ConflictError(`only draft invoices can be deleted (this one is '${rows[0].status}')`);
  }
  await pool.query("DELETE FROM invoice_line_items WHERE invoice_id = $1", [id]);
  await pool.query("DELETE FROM invoices WHERE id = $1", [id]);
}

/** Issue a draft invoice: status draft→sent, then post the double-entry to the ledger. */
export async function issueInvoice(id: string): Promise<InvoiceView> {
  return withClient(pool, async (client) => {
    // lock the invoice row so concurrent issues/pays serialize
    const { rows } = await client.query("SELECT status::text AS status FROM invoices WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) throw new NotFoundError("invoice not found");
    if (rows[0].status !== "draft") throw new ConflictError(`cannot issue invoice in '${rows[0].status}' state`);

    const view = await getInvoice(id, client);
    if (view.totals.totalCents <= 0) {
      throw new ConflictError("cannot issue an invoice with a zero total — edit the line items first");
    }
    // Each customer is modeled as their own receivable (asset) account, so the
    // invoice debits THAT account and the payment credits it — they net to zero
    // when paid in full. (1200 is the AR control account in the chart of accounts.)
    const rev = await getAccountByCode("4000");          // Sales Revenue
    const tax = view.totals.taxCents > 0 ? await getAccountByCode("5000") : null; // Tax Payable
    if (!rev || (view.totals.taxCents > 0 && !tax)) {
      throw new ConflictError("chart of accounts not seeded — run `npm run seed`");
    }

    const entries: LedgerEntryInput[] = [
      { accountId: view.customerAccountId, direction: "debit", amountCents: view.totals.totalCents },
      { accountId: rev.id, direction: "credit", amountCents: view.totals.subtotalCents },
    ];
    if (tax) {
      entries.push({ accountId: tax.id, direction: "credit", amountCents: view.totals.taxCents });
    }

    await postTransaction(client, {
      reference: view.number,
      source: "invoice",
      description: `Invoice ${view.number} issued`,
      entries,
    });

    await client.query("UPDATE invoices SET status = 'sent' WHERE id = $1", [id]);
    return getInvoice(id, client);
  });
}

export async function isPayable(id: string, client: DbClient): Promise<InvoiceView> {
  const view = await getInvoice(id, client);
  if (!PAYABLE_STATES.includes(view.status)) {
    throw new ConflictError(`invoice is '${view.status}', not payable`);
  }
  return view;
}

// tiny local helper so invoice fns don't all import withTransaction circularly
async function withClient<T>(p: typeof pool, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
