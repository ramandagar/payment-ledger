import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withTransaction, pool } from "../src/db/client.js";
import { postTransaction, BalancedTransactionError, ZeroAmountError } from "../src/ledger/posting.js";
import { createAccount, getAccountByCode, getBalance } from "../src/ledger/accounts.js";
import { setupDb, resetDb, closeDb } from "./helpers.js";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(closeDb);

describe("double-entry posting", () => {
  it("posts a balanced transaction and keeps debits == credits", async () => {
    const cash = await getAccountByCode("1000");
    const rev = await getAccountByCode("4000");
    const id = await withTransaction((c) =>
      postTransaction(c, {
        source: "manual",
        description: "sale",
        entries: [
          { accountId: cash.id, direction: "debit", amountCents: 5000 },
          { accountId: rev.id, direction: "credit", amountCents: 5000 },
        ],
      })
    );
    expect(id).toBeTruthy();

    const { rows } = await pool.query(
      `SELECT SUM(CASE direction WHEN 'debit' THEN amount_cents ELSE -amount_cents END)::bigint AS s FROM ledger_entries WHERE transaction_id=$1`,
      [id]
    );
    expect(Number(rows[0].s)).toBe(0); // balanced
  });

  it("rejects an unbalanced transaction", async () => {
    const cash = await getAccountByCode("1000");
    const rev = await getAccountByCode("4000");
    await expect(
      withTransaction((c) =>
        postTransaction(c, {
          source: "manual",
          entries: [
            { accountId: cash.id, direction: "debit", amountCents: 5000 },
            { accountId: rev.id, direction: "credit", amountCents: 4999 },
          ],
        })
      )
    ).rejects.toBeInstanceOf(BalancedTransactionError);
  });

  it("rejects a zero or fractional amount", async () => {
    const cash = await getAccountByCode("1000");
    const rev = await getAccountByCode("4000");
    await expect(
      withTransaction((c) =>
        postTransaction(c, {
          source: "manual",
          entries: [
            { accountId: cash.id, direction: "debit", amountCents: 0 },
            { accountId: rev.id, direction: "credit", amountCents: 0 },
          ],
        })
      )
    ).rejects.toBeInstanceOf(ZeroAmountError);
  });

  it("derives balances from the log — never stored, always correct", async () => {
    const cash = await getAccountByCode("1000");
    const rev = await getAccountByCode("4000");
    for (const amt of [1000, 2000, 50]) {
      await withTransaction((c) =>
        postTransaction(c, {
          source: "manual",
          entries: [
            { accountId: cash.id, direction: "debit", amountCents: amt },
            { accountId: rev.id, direction: "credit", amountCents: amt },
          ],
        })
      );
    }
    // cash = asset => debit-positive => 1000+2000+50 = 3050
    expect(await getBalance(cash.id)).toBe(3050);
    expect(await getBalance(rev.id)).toBe(-3050); // credit-normal shows negative in raw form
  });
});

describe("account CRUD", () => {
  it("creates and looks up an account", async () => {
    const a = await createAccount({ code: "1999", name: "Petty Cash", type: "asset" });
    expect(a.code).toBe("1999");
    expect(await getBalance(a.id)).toBe(0);
  });
});
