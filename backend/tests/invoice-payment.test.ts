import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupDb, resetDb, closeDb } from "./helpers.js";
import { getAccountByCode } from "../src/ledger/accounts.js";
import { createInvoice, issueInvoice, getInvoice, ConflictError } from "../src/invoice/invoice.js";
import { applyPayment } from "../src/invoice/payment.js";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(closeDb);

async function makeInvoice(totalCents: number, dueInDays = 30) {
  const customer = await getAccountByCode("AR_DEMO");
  const due = new Date(Date.now() + dueInDays * 86_400_000).toISOString().slice(0, 10);
  return createInvoice({
    customerAccountId: customer.id,
    dueDate: due,
    lineItems: [{ description: "Freight service", quantity: 1, unitPriceCents: totalCents, taxBps: 0 }],
  });
}

describe("invoice flow", () => {
  it("creates an invoice with computed integer totals and draft status", async () => {
    const customer = await getAccountByCode("AR_DEMO");
    const due = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const inv = await createInvoice({
      customerAccountId: customer.id,
      dueDate: due,
      lineItems: [
        { description: "Line haul", quantity: 2, unitPriceCents: 5000, taxBps: 1800 },
        { description: "Fuel surcharge", quantity: 1, unitPriceCents: 1000, taxBps: 0 },
      ],
    });
    expect(inv.status).toBe("draft");
    expect(inv.totals.subtotalCents).toBe(11000); // 2*5000 + 1000
    expect(inv.totals.taxCents).toBe(1800);       // 18% on 10000
    expect(inv.totals.totalCents).toBe(12800);
    expect(inv.amountDueCents).toBe(12800);
  });

  it("issues a draft invoice -> sent, and amount due is derived", async () => {
    const inv = await issueInvoice((await makeInvoice(7000)).id);
    expect(inv.status).toBe("sent");
    expect(inv.amountDueCents).toBe(7000);
    expect(inv.paidCents).toBe(0);
  });
});

describe("payment: full, partial, overpay", () => {
  it("marks invoice paid on a full payment", async () => {
    const inv = await issueInvoice((await makeInvoice(7000)).id);
    const r = await applyPayment({ invoiceId: inv.id, amountCents: 7000, idempotencyKey: "pay-1" });
    expect(r.idempotent).toBe(false);
    expect(r.invoice.status).toBe("paid");
    expect(r.invoice.amountDueCents).toBe(0);
  });

  it("supports partial payments and tracks remaining due", async () => {
    const inv = await issueInvoice((await makeInvoice(7000)).id);
    await applyPayment({ invoiceId: inv.id, amountCents: 3000, idempotencyKey: "p1" });
    const r2 = await applyPayment({ invoiceId: inv.id, amountCents: 4000, idempotencyKey: "p2" });
    expect(r2.invoice.status).toBe("paid");
    expect(r2.invoice.amountDueCents).toBe(0);
  });

  it("prevents overpayment", async () => {
    const inv = await issueInvoice((await makeInvoice(7000)).id);
    await applyPayment({ invoiceId: inv.id, amountCents: 7000, idempotencyKey: "full" });
    await expect(
      applyPayment({ invoiceId: inv.id, amountCents: 100, idempotencyKey: "extra" })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("idempotency: duplicate webhook fires twice for same payment", () => {
  it("processes once, second call is a no-op (idempotent=true, no double posting)", async () => {
    const inv = await issueInvoice((await makeInvoice(7000)).id);
    const first = await applyPayment({ invoiceId: inv.id, amountCents: 7000, idempotencyKey: "WEBHOOK-XYZ" });
    const second = await applyPayment({ invoiceId: inv.id, amountCents: 7000, idempotencyKey: "WEBHOOK-XYZ" });

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.paymentId).toBe(first.paymentId); // same payment, not a new one
    expect(second.invoice.paidCents).toBe(7000);     // NOT 14000 — never double-counted
  });
});

describe("Part 3 — concurrent payments racing the same invoice", () => {
  it("serializes via row lock: never overpays, applies at most the amount due", async () => {
    const inv = await issueInvoice((await makeInvoice(5000)).id); // due = 5000

    // Two DIFFERENT payments, each for the full amount, fired simultaneously.
    // If both passed the balance check, the invoice would be overpaid (10000).
    const [a, b] = await Promise.allSettled([
      applyPayment({ invoiceId: inv.id, amountCents: 5000, idempotencyKey: "race-A" }),
      applyPayment({ invoiceId: inv.id, amountCents: 5000, idempotencyKey: "race-B" }),
    ]);

    const settled = [a, b].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ invoice: { paidCents: number } }>[];
    expect(settled.length).toBe(1);                 // exactly one wins
    expect(settled[0].value.invoice.paidCents).toBe(5000);

    // final invoice state is consistent regardless of who won
    const final = await getInvoice(inv.id);
    expect(final.paidCents).toBe(5000);
    expect(final.status).toBe("paid");
  });
});
