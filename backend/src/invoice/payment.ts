import { randomUUID } from "node:crypto";
import { pool, withTransaction, type DbClient } from "../db/client.js";
import { postTransaction } from "../ledger/posting.js";
import { getAccountByCode } from "../ledger/accounts.js";
import { getInvoice, isPayable, ConflictError, ValidationError, type InvoiceView } from "./invoice.js";

export interface ApplyPaymentInput {
  invoiceId: string;
  amountCents: number;
  idempotencyKey: string;   // the payment-gateway reference; identical on a duplicate webhook
  method?: string;
  reference?: string;
}

export interface PaymentResult {
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  idempotent: boolean;       // true => this was a duplicate webhook, no new ledger posting
  invoice: InvoiceView;
}

/**
 * Apply a payment to an invoice. Hardened for two real-world hazards:
 *
 *  (A) DOUBLE WEBHOOK — the gateway fires the same payment twice. We look up the
 *      `idempotency_key` first; if a payment already exists for it we return the
 *      original result with idempotent=true and post nothing. The UNIQUE
 *      constraint on idempotency_key is the hard backstop if two race.
 *
 *  (B) CONCURRENT PAYMENTS — two *different* payments race for the same invoice.
 *      `SELECT ... FOR UPDATE` on the invoice row serializes them, so the second
 *      recomputes amountDueCents under the lock and is rejected if it would
 *      overpay. Overpayment is impossible.
 *
 * Order matters: we validate against the CURRENT amount due (which does not yet
 * include this payment) BEFORE inserting the payment row — otherwise the paid
 * sum would count the row we're about to validate.
 */
export async function applyPayment(input: ApplyPaymentInput): Promise<PaymentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError("amountCents must be a positive integer");
  }
  if (!input.idempotencyKey?.trim()) {
    throw new ValidationError("idempotencyKey is required (use the gateway payment reference)");
  }

  return withTransaction(async (client: DbClient) => {
    // --- (B) lock the invoice: serializes concurrent payments on the same invoice ---
    const locked = await client.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [input.invoiceId]);
    if (!locked.rowCount) throw new ConflictError("invoice not found");

    // --- (A) idempotency: already processed this gateway reference? ---
    const existing = await client.query<{ id: string; amount_cents: string }>(
      "SELECT id, amount_cents FROM payments WHERE idempotency_key = $1",
      [input.idempotencyKey]
    );
    if (existing.rowCount) {
      return {
        paymentId: existing.rows[0].id,
        invoiceId: input.invoiceId,
        amountCents: Number(existing.rows[0].amount_cents),
        idempotent: true,
        invoice: await getInvoice(input.invoiceId, client),
      };
    }

    // validate against the current (pre-insertion) amount due
    const view = await isPayable(input.invoiceId, client);
    if (input.amountCents > view.amountDueCents) {
      throw new ConflictError(
        `payment ${input.amountCents}c exceeds amount due ${view.amountDueCents}c on ${view.number}`
      );
    }

    // record the payment (UNIQUE idempotency_key is the backstop against a racing duplicate)
    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO payments (id, invoice_id, amount_cents, idempotency_key, method, reference)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [paymentId, input.invoiceId, input.amountCents, input.idempotencyKey, input.method ?? null, input.reference ?? null]
    );

    // post the double-entry: debit Cash, credit the customer's receivable account
    const cash = await getAccountByCode("1000");
    if (!cash) throw new ConflictError("chart of accounts not seeded — run `npm run seed`");
    await postTransaction(client, {
      reference: `PAY:${input.idempotencyKey}`,
      source: "payment",
      description: `Payment for ${view.number}`,
      entries: [
        { accountId: cash.id, direction: "debit", amountCents: input.amountCents },
        { accountId: view.customerAccountId, direction: "credit", amountCents: input.amountCents },
      ],
    });

    const newDue = view.amountDueCents - input.amountCents;
    await client.query("UPDATE invoices SET status = $1 WHERE id = $2", [
      newDue === 0 ? "paid" : "partial",
      input.invoiceId,
    ]);

    return {
      paymentId,
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      idempotent: false,
      invoice: await getInvoice(input.invoiceId, client),
    };
  });
}

export async function listPayments(invoiceId?: string) {
  const { rows } = await pool.query(
    invoiceId
      ? "SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC"
      : "SELECT * FROM payments ORDER BY created_at DESC",
    invoiceId ? [invoiceId] : []
  );
  return rows;
}
