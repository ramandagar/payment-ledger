import "dotenv/config";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { initSchema, pool, closePool, withTransaction } from "./db/client.js";
import { ensureSeed } from "./db/seed-runner.js";
import { createAccount, getBalance, listAccounts } from "./ledger/accounts.js";
import { postTransaction, BalancedTransactionError, ZeroAmountError } from "./ledger/posting.js";
import { createInvoice, getInvoice, issueInvoice, listInvoices, ValidationError, NotFoundError, ConflictError } from "./invoice/invoice.js";
import { applyPayment, listPayments } from "./invoice/payment.js";

const app = express();
// "*" or unset => reflect any origin (wildcard). Otherwise treat as a comma allowlist.
const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(cors(corsOrigin && corsOrigin !== "*" ? { origin: corsOrigin.split(",") } : { origin: true }));
app.use(express.json());

const port = Number(process.env.PORT ?? 4000);

// ---------------- account types ----------------
const accountType = z.enum(["asset", "liability", "equity", "revenue", "expense"]);

// ---------------- routes ----------------
app.get("/", (_req, res) =>
  res.json({
    service: "Mini Payment Ledger & Invoice Service",
    docs: { accounts: "/accounts", invoices: "/invoices", payments: "/payments", transactions: "/transactions" },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/seed", async (_req, res, next) => {
  try {
    await ensureSeed();
    res.json({ seeded: true });
  } catch (e) { next(e); }
});

// --- accounts ---
const accountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: accountType,
  currency: z.string().optional(),
});
app.post("/accounts", async (req, res, next) => {
  try {
    const body = accountSchema.parse(req.body);
    res.status(201).json(await createAccount(body));
  } catch (e) { next(e); }
});
app.get("/accounts", async (_req, res, next) => {
  try { res.json(await listAccounts()); } catch (e) { next(e); }
});
app.get("/accounts/:id/balance", async (req, res, next) => {
  try { res.json({ balanceCents: await getBalance(req.params.id) }); } catch (e) { next(e); }
});

// --- transactions (manual double-entry) ---
const txnSchema = z.object({
  reference: z.string().optional(),
  description: z.string().optional(),
  entries: z.array(z.object({
    accountId: z.string().uuid(),
    direction: z.enum(["debit", "credit"]),
    amountCents: z.number().int().positive(),
  })).min(2),
});
app.post("/transactions", async (req, res, next) => {
  try {
    const body = txnSchema.parse(req.body);
    const id = await withTransaction((client) =>
      postTransaction(client, {
        reference: body.reference,
        source: "manual",
        description: body.description,
        entries: body.entries,
      })
    );
    res.status(201).json({ id });
  } catch (e) { next(e); }
});
app.get("/transactions", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.reference, t.source, t.description, t.created_at,
              json_agg(json_build_object('accountId', e.account_id, 'direction', e.direction, 'amountCents', e.amount_cents)) AS entries
       FROM transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
       GROUP BY t.id ORDER BY t.created_at DESC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// --- invoices ---
const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  taxBps: z.number().int().min(0).max(9999).optional(),
});
const invoiceSchema = z.object({
  customerAccountId: z.string().uuid(),
  dueDate: z.string().min(1),
  notes: z.string().optional(),
  currency: z.string().optional(),
  lineItems: z.array(lineItemSchema).min(1),
});
app.post("/invoices", async (req, res, next) => {
  try { res.status(201).json(await createInvoice(invoiceSchema.parse(req.body))); } catch (e) { next(e); }
});
app.get("/invoices", async (_req, res, next) => {
  try { res.json(await listInvoices()); } catch (e) { next(e); }
});
app.get("/invoices/:id", async (req, res, next) => {
  try { res.json(await getInvoice(req.params.id)); } catch (e) { next(e); }
});
app.post("/invoices/:id/issue", async (req, res, next) => {
  try { res.json(await issueInvoice(req.params.id)); } catch (e) { next(e); }
});

// --- payments ---
const paySchema = z.object({
  amountCents: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  method: z.string().optional(),
  reference: z.string().optional(),
});
app.post("/invoices/:id/payments", async (req, res, next) => {
  try {
    const body = paySchema.parse(req.body);
    res.status(201).json(await applyPayment({ invoiceId: req.params.id, ...body }));
  } catch (e) { next(e); }
});
app.get("/invoices/:id/payments", async (req, res, next) => {
  try { res.json(await listPayments(req.params.id)); } catch (e) { next(e); }
});
app.get("/payments", async (_req, res, next) => {
  try { res.json(await listPayments()); } catch (e) { next(e); }
});

// ---------------- error handling ----------------
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status =
    err instanceof ValidationError ? 400 :
    err instanceof NotFoundError ? 404 :
    err instanceof ConflictError ? 409 :
    err instanceof BalancedTransactionError || err instanceof ZeroAmountError ? 422 :
    err instanceof z.ZodError ? 400 : 500;
  const message = err instanceof z.ZodError ? err.issues : (err as Error).message;
  res.status(status).json({ error: message });
});

// ---------------- boot ----------------
const server = app.listen(port, async () => {
  try {
    await initSchema();
    await ensureSeed(); // best-effort: chart of accounts + demo customer on fresh DBs
    console.log(`✓ API on http://localhost:${port}`);
  } catch (e) {
    console.error("schema init failed — is Postgres up? (DATABASE_URL =", process.env.DATABASE_URL, ")");
    console.error(e);
  }
});

const shutdown = async (sig: string) => {
  console.log(`${sig} received, shutting down…`);
  server.close();
  await closePool();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
