import { randomUUID } from "node:crypto";
import { pool, type DbClient } from "../db/client.js";
import type { Cents } from "../lib/money.js";
import { ConflictError } from "../lib/errors.js";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  currency: string;
}

export interface AccountWithBalance extends Account {
  /** Raw signed balance: debits - credits (asset-positive convention). */
  balanceCents: Cents;
}

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

export async function createAccount(input: {
  code: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  currency?: string;
}): Promise<Account> {
  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO accounts (id, code, name, type, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.code, input.name, input.type, input.currency ?? "USD"]
    );
  } catch (err) {
    // unique_violation on accounts.code → friendly 409 instead of a raw DB error
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new ConflictError(`Account code "${input.code}" already exists — choose a different code.`);
    }
    throw err;
  }
  return { id, code: input.code, name: input.name, type: input.type, currency: input.currency ?? "USD" };
}

export async function getAccount(id: string, client: DbClient | typeof pool = pool): Promise<Account | null> {
  const { rows } = await client.query<Account>(
    `SELECT id, code, name, type::text AS type, currency FROM accounts WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function getAccountByCode(code: string): Promise<Account | null> {
  const { rows } = await pool.query<Account>(
    `SELECT id, code, name, type::text AS type, currency FROM accounts WHERE code = $1`,
    [code]
  );
  return rows[0] ?? null;
}

/**
 * Balance is DERIVED from the ledger, never stored.
 * Returns debits - credits for the account (asset-positive).
 */
export async function getBalance(accountId: string, client: DbClient | typeof pool = pool): Promise<Cents> {
  const { rows } = await client.query<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE direction
         WHEN 'debit'  THEN amount_cents
         WHEN 'credit' THEN -amount_cents
       END), 0)::bigint AS balance
     FROM ledger_entries WHERE account_id = $1`,
    [accountId]
  );
  return Number(rows[0].balance);
}

export async function listAccounts(): Promise<AccountWithBalance[]> {
  const { rows } = await pool.query<AccountWithBalance & { balance: string }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.currency,
            COALESCE(SUM(CASE le.direction
              WHEN 'debit'  THEN le.amount_cents
              WHEN 'credit' THEN -le.amount_cents
            END), 0)::bigint AS balance
     FROM accounts a
     LEFT JOIN ledger_entries le ON le.account_id = a.id
     GROUP BY a.id, a.code, a.name, a.type, a.currency
     ORDER BY a.code`,
  );
  return rows.map((r) => ({ ...r, balanceCents: Number(r.balance) }));
}
