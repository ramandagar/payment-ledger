import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client.js";
import type { Cents } from "../lib/money.js";

export type Direction = "debit" | "credit";

export interface LedgerEntryInput {
  accountId: string;
  direction: Direction;
  amountCents: Cents;
}

export interface PostTxnInput {
  reference?: string;
  source: "manual" | "invoice" | "payment" | "refund";
  description?: string;
  entries: LedgerEntryInput[];
}

export class BalancedTransactionError extends Error {}
export class ZeroAmountError extends Error {}

/**
 * Post a double-entry transaction atomically.
 * Invariants enforced:
 *   - every entry amount > 0
 *   - SUM(debits) === SUM(credits)  (double-entry must balance)
 * The caller wraps this in withTransaction() so it commits/rolls back as a unit.
 */
export async function postTransaction(
  client: DbClient,
  input: PostTxnInput
): Promise<string> {
  if (input.entries.length < 2) {
    throw new BalancedTransactionError("a transaction needs at least two legs");
  }
  for (const e of input.entries) {
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
      throw new ZeroAmountError(`amount must be a positive integer (cents): ${e.amountCents}`);
    }
  }
  const debitTotal = sum(input.entries.filter((e) => e.direction === "debit"));
  const creditTotal = sum(input.entries.filter((e) => e.direction === "credit"));
  if (debitTotal !== creditTotal) {
    throw new BalancedTransactionError(
      `transaction not balanced: debits=${debitTotal} credits=${creditTotal}`
    );
  }

  const txnId = randomUUID();
  await client.query(
    `INSERT INTO transactions (id, reference, source, description)
     VALUES ($1, $2, $3, $4)`,
    [txnId, input.reference ?? null, input.source, input.description ?? null]
  );
  for (const e of input.entries) {
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents)
       VALUES ($1, $2, $3, $4)`,
      [txnId, e.accountId, e.direction, e.amountCents]
    );
  }
  return txnId;
}

const sum = (xs: LedgerEntryInput[]) =>
  xs.reduce((acc, e) => acc + e.amountCents, 0);
