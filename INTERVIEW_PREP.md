# Payment Ledger — Interview Prep (know it cold)

A fintech **double-entry payment ledger + invoice service** for a TMS (Transportation Management System) *Accounts Payable / payment-processing module*.

- **Backend:** Node.js + TypeScript + Express + PostgreSQL
- **Frontend:** React + Vite + TypeScript
- **Tests:** Vitest (17, all passing) · **Deployed:** API on Railway (Postgres), UI on GitHub Pages

> Live: UI https://ramandagar.github.io/payment-ledger/ · API https://payment-ledger-production-9b60.up.railway.app · Repo https://github.com/ramandagar/payment-ledger

---

## 1. The 30-second pitch (memorize)

"It's a double-entry ledger and invoice service. Every money movement is a balanced transaction — debit one account, credit another by the same amount. Account balances are **never stored**; they're always derived by summing the immutable ledger. All money is integer cents with tax in basis points, so there are zero floating-point errors. On top of that I built invoices (draft→sent→paid→overdue) and payments that are **idempotent** (a duplicate payment webhook is a no-op) and **concurrency-safe** (two payments racing one invoice can never overpay it, via row-level locking)."

---

## 2. The three inviolable rules (everything follows from these)

1. **Double-entry always balances** — `SUM(debits) == SUM(credits)` per transaction, enforced in `postTransaction()` (`ledger/posting.ts:42-48`).
2. **Balances are derived, never stored** — there is no `balance` column anywhere. Balances = `SUM(debit) − SUM(credit)` over `ledger_entries` (`accounts.ts:55-65`). You can drop and replay the ledger and get identical numbers.
3. **No floats for money** — every amount is integer cents (`BIGINT`); tax is basis points (`1800` = 18%). All math is integer math in `lib/money.ts`.

---

## 3. Directory structure

```
payment-ledger/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── schema.sql          # 6 tables + enums + checks + indexes
│   │   │   ├── client.ts           # pg Pool, withTransaction(), initSchema()
│   │   │   ├── seed-runner.ts      # ensureSeed() — chart of accounts
│   │   │   ├── init.ts             # CLI: apply schema
│   │   │   └── seed.ts             # CLI: seed + print
│   │   ├── lib/money.ts            # cents/bps helpers (no floats)
│   │   ├── ledger/
│   │   │   ├── accounts.ts         # account CRUD + DERIVED balance
│   │   │   └── posting.ts          # double-entry postTransaction()
│   │   ├── invoice/
│   │   │   ├── invoice.ts          # invoice model, issue flow, state machine
│   │   │   └── payment.ts          # applyPayment() — idempotent + concurrency-safe
│   │   └── server.ts               # Express routes, zod validation, errors, boot
│   ├── tests/                      # money, ledger, invoice-payment (17 tests)
│   ├── Dockerfile, railway.json, vitest.config.ts, package.json
├── frontend/                       # React + Vite UI (Overview/Accounts/Invoices/Journal)
├── docker-compose.yml, README.md
```

---

## 4. Data model (`backend/src/db/schema.sql`)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `accounts` | Chart of accounts + per-customer receivable sub-accounts | `code` UNIQUE, `type` ENUM(asset/liability/equity/revenue/expense), `currency` |
| `transactions` | One business event (a journal entry) | `reference` (invoice/payment id), `source` (manual/invoice/payment/refund) |
| `ledger_entries` | The debit/credit **legs** | `direction` CHECK(debit/credit), `amount_cents BIGINT CHECK(>=0)`, FK→transactions(CASCADE), FK→accounts |
| `invoices` | Invoice header + status state machine | `number` UNIQUE, `status` ENUM(draft/sent/partial/paid/overdue/void), `due_date` |
| `invoice_line_items` | Lines on an invoice | `quantity CHECK(>0)`, `unit_price_cents`, `tax_bps CHECK(0..9999)`, FK→invoices(CASCADE) |
| `payments` | Payments applied to invoices | `amount_cents CHECK(>0)`, **`idempotency_key TEXT UNIQUE`** ← the double-webhook guard |

Also: `txn_balance_check` VIEW (per-txn debits vs credits), indexes on `ledger_entries(account_id, transaction_id)`, `invoice_line_items(invoice_id)`, `payments(invoice_id)`.

**Why this shape?** `transactions` (1) → many `ledger_entries` (N) is the classic accounting journal. Splitting them lets one event carry multiple balanced legs (e.g. invoice = debit AR, credit revenue + credit tax payable — a 3-leg entry).

---

## 5. File-by-file: backend

### `src/lib/money.ts` — money math, zero floats
- `type Cents = number`
- `toCents(input)` — `"$12.50"` or `0.1` → `1250`. Validates with regex `/^-?\d+(\.\d{1,2})?$/`; rejects garbage. Handles negatives.
- `formatCents(cents)` — `1250` → `"12.50"` (display).
- `lineTotalCents({qty, unitPriceCents, taxBps})` — `round(qty * unit * (10000 + taxBps) / 10000)`. Pure integer.
- `totalsFor(items)` → `{subtotalCents, taxCents, totalCents}`.
- Self-check block at bottom (asserts) — runnable via `npx tsx src/lib/money.ts`.

### `src/db/client.ts` — Postgres access
- `pool` — `pg.Pool` from `DATABASE_URL` (default local docker).
- `type DbClient = pg.PoolClient`
- `withTransaction(fn)` — checks out a client, `BEGIN`, runs `fn(client)`, `COMMIT`; on throw `ROLLBACK`; always `release()`. **This is the atomicity boundary for all multi-step money ops.**
- `initSchema()` — reads `schema.sql` (next to this file) and runs it. Idempotent (`IF NOT EXISTS` + guarded enums) → safe on every boot.
- `closePool()`.

### `src/db/seed-runner.ts`
- `ensureSeed()` — idempotent. Creates the 5 standard accounts if missing: `1000 Cash/Bank`, `1200 AR (control)`, `4000 Sales Revenue`, `5000 Tax Payable`, `6000 Sales Refunds`; plus a demo customer `AR_DEMO` "Acme Logistics". Called on boot and by `/seed`.

### `src/db/init.ts` / `seed.ts` — CLI wrappers (`npm run db:init`, `npm run seed`).

### `src/ledger/accounts.ts` — accounts + derived balances
- `createAccount({code,name,type,currency?})` — INSERT, returns Account.
- `getAccount(id, client?)` / `getAccountByCode(code)` — lookups.
- `getBalance(accountId, client?)` — **derived**: `SUM(CASE direction WHEN debit THEN +amount WHEN credit THEN -amount)`. Raw signed (asset-positive).
- `listAccounts()` — every account joined with its derived balance via `LEFT JOIN ledger_entries … GROUP BY`.

### `src/ledger/posting.ts` — the double-entry kernel
- Types: `Direction`, `LedgerEntryInput {accountId, direction, amountCents}`, `PostTxnInput {reference?, source, description?, entries[]}`.
- Errors: `BalancedTransactionError`, `ZeroAmountError`.
- **`postTransaction(client, input)`** — the most important function. In order:
  1. `entries.length >= 2`
  2. each `amountCents` is a positive integer (else `ZeroAmountError`)
  3. `sum(debits) === sum(credits)` (else `BalancedTransactionError`)
  4. INSERT `transactions` row, then each `ledger_entries` leg.
  - Caller wraps it in a transaction → atomic.

### `src/invoice/invoice.ts` — invoice model + state machine
- Types: `InvoiceLineInput`, `CreateInvoiceInput`, `InvoiceStatus`, `InvoiceView` (the full read shape incl. `effectiveStatus`, `totals`, `paidCents`, `amountDueCents`).
- Errors: `ValidationError(400)`, `NotFoundError(404)`, `ConflictError(409)`.
- `nextInvoiceNumber(client)` — `INV-NNNN` from `MAX(SUBSTRING(number FROM 5)) + 1`.
- `createInvoice(input)` — validates ≥1 line + **total > 0**; in a txn inserts the invoice (status `draft`) + line items; returns `getInvoice`.
- **`getInvoice(id, client?)`** — assembles the view: line items, computed `totals` (via `totalsFor`), and **derived** `paidCents` = `SUM(payments WHERE completed)`, `amountDueCents = max(0, total − paid)`. Computes `effectiveStatus`: overlays `overdue` when `due_date < now` and not paid/void.
- `listInvoices()` — maps `getInvoice` over all invoice ids.
- `deleteInvoice(id)` — **drafts only** (else `ConflictError`); deletes line items + invoice.
- **`issueInvoice(id)`** — draft→sent, with ledger posting:
  1. `SELECT … FOR UPDATE` (locks row → concurrent issues/pays serialize)
  2. must be `draft`, total > 0
  3. builds entries: **debit the customer's AR account** for total; **credit Revenue** for subtotal; **credit Tax Payable** for tax (if any)
  4. `postTransaction(source:"invoice")`
  5. set status `sent`.
- `isPayable(id, client)` — returns view only if status ∈ {sent, partial}, else `ConflictError`.
- `withClient(p, fn)` — local BEGIN/COMMIT helper (avoids a circular import on `withTransaction`).

### `src/invoice/payment.ts` — idempotent + concurrency-safe payments
- Types: `ApplyPaymentInput`, `PaymentResult {paymentId, amountCents, idempotent, invoice}`.
- **`applyPayment(input)`** — the second most-important function. Steps, in order, all inside one `withTransaction`:
  1. validate `amountCents` positive integer, `idempotencyKey` non-empty
  2. **`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`** ← serializes concurrent payments on this invoice
  3. **idempotency**: `SELECT … FROM payments WHERE idempotency_key=$1` — if exists, return `idempotent:true` with the original result, **post nothing**
  4. `isPayable` (status sent/partial)
  5. overpay check: `amountCents > amountDueCents` → `ConflictError` (and the insert is rolled back with the txn)
  6. INSERT the payment row (the UNIQUE `idempotency_key` is the hard backstop if two duplicates truly race)
  7. `postTransaction(source:"payment")` → **debit Cash, credit customer AR**
  8. recompute due: `0 → status 'paid'`, else `'partial'`.
  - **Order matters**: validate against the *current* amount due **before** inserting the payment, otherwise the paid sum would count the row we're validating (this was a real bug I caught and fixed).
- `listPayments(invoiceId?)`.

### `src/server.ts` — Express app
- CORS (`*`/unset → reflect; else comma-allowlist), `express.json()`.
- Zod schemas: `accountSchema`, `txnSchema`, `lineItemSchema`, `invoiceSchema`, `paySchema`.
- **Routes:**
  - `GET /`, `GET /health`, `POST /seed`
  - `POST /accounts`, `GET /accounts`, `GET /accounts/:id/balance`
  - `POST /transactions` (manual double-entry, wrapped in `withTransaction`), `GET /transactions` (joins legs)
  - `POST /invoices`, `GET /invoices`, `GET /invoices/:id`, `POST /invoices/:id/issue`, `DELETE /invoices/:id`
  - `POST /invoices/:id/payments`, `GET /invoices/:id/payments`, `GET /payments`
- **Error handler** maps: `ValidationError→400`, `NotFoundError→404`, `ConflictError→409`, `Balanced/ZeroAmount→422`, `ZodError→400`, else `500`. Returns `{error}`.
- **Boot** (`app.listen`): `initSchema()` + `ensureSeed()` (best-effort), then logs ready. SIGINT/SIGTERM → close server + pool.

### Tests (`backend/tests/`)
- `helpers.ts` — `setupDb`, `resetDb` (truncate all + re-seed), `closeDb`.
- `money.test.ts` (5) — parsing, formatting, tax basis-points, rounding, rejection of bad input.
- `ledger.test.ts` (5) — balanced posting, imbalance rejected, zero rejected, balances derived correctly after multiple postings, account CRUD.
- `invoice-payment.test.ts` (7) — invoice totals, issue→sent, full/partial/overpay, **idempotency (duplicate webhook = no double count)**, **concurrency (Promise.all of 2 full payments → exactly 1 wins, never overpaid)**.
- `vitest.config.ts` — `fileParallelism:false` + single fork (all suites share one DB, so they must run serially — otherwise one file's TRUNCATE wipes another's data mid-test).

---

## 6. File-by-file: frontend & infra (briefer)

**Frontend** (`React + Vite + TS`, dependency-light — no router/Redux/UI lib):
- `src/api.ts` — all fetch calls + TS types mirroring the backend contract; `ApiError`; `req()` helper.
- `src/lib/money.ts` — client-side `formatCents`/`toCents` (dollar-string input → cents).
- `src/lib/useAsync.ts` — 30-line hook for loading/error/data fetch state.
- `src/components/Overview.tsx` — stat tiles (Receivable, Cash, #Invoices, Overdue).
- `Accounts.tsx` — accounts table + new-account modal.
- `Invoices.tsx` — invoice list + new-invoice form with live total.
- `InvoiceDetail.tsx` — line items, totals, Issue + Delete-draft + Record-payment (with idempotency key from `crypto.randomUUID()`).
- `Journal.tsx` — transactions with debit/credit legs.
- `ui.tsx` — Button/Modal/Spinner/Toast/EmptyState/StatusBadge primitives.

**Infra:**
- `backend/Dockerfile` — node:20, `npm ci`, build (copies `schema.sql` to `dist`), CMD runs `db:init && seed && start`.
- `backend/railway.json` — Nixpacks builder, `npm start`, healthcheck `/health`.
- `frontend/Dockerfile` + `nginx.conf` — Vite build stage → nginx static serve (SPA fallback).
- `docker-compose.yml` — `db` (postgres:16) + `api` + `web`, one `docker compose up`.
- `README.md` — run steps, design decisions, shortcuts, what-I'd-do-next.

---

## 7. The two flows to narrate flawlessly

### Flow A — Issue an invoice
1. Client `POST /invoices` → `createInvoice`: validate lines + total>0, insert header (`draft`) + line items in one txn.
2. Client `POST /invoices/:id/issue` → `issueInvoice`:
   - `SELECT … FOR UPDATE` on the invoice (lock).
   - Build a **3-leg balanced entry**: debit customer AR (total), credit Revenue (subtotal), credit Tax Payable (tax).
   - `postTransaction` writes `transactions` + `ledger_entries` atomically.
   - Status `draft → sent`.
3. Result: customer's AR balance goes up; revenue + tax payable go up. Nothing was paid yet.

### Flow B — Record a payment (the star)
1. `POST /invoices/:id/payments {amountCents, idempotencyKey}` → `applyPayment`.
2. Lock the invoice row (`FOR UPDATE`) → **no other payment on this invoice runs concurrently**.
3. If `idempotency_key` already exists → return the original, `idempotent:true`, **nothing posted**.
4. Else check payable + overpay, insert payment, post **debit Cash / credit customer AR**, flip status to `paid` or `partial`.
5. Two guarantees: (a) duplicate webhook can't double-charge; (b) two simultaneous payments can't overpay.

---

## 8. "Extend the system" — likely asks, and exactly what to change

| Ask | How to extend (files) |
|---|---|
| **Refund flow** | Add `POST /invoices/:id/refunds`. A refund is a **reversing transaction**: `postTransaction(source:"refund")` with **credit Cash / debit customer AR** (mirror of the payment). Add a `refunds` table or a `payments.type` column + its own idempotency key. Recompute invoice status (paid→partial) and `amountDue` (already derived, so it auto-updates). |
| **Multi-currency (fixed FX)** | Add `currency` on invoice/line (already a column), an `exchange_rates` table, and at payment posting convert to base currency; post any FX diff to a `FX Gain/Loss` account. |
| **Void an invoice** | New status `void` (already in enum). Void = reverse the original issue posting (debit Revenue/Tax, credit AR). Block if payments exist. |
| **Payment provider + webhook** | Add `POST /webhooks/payments` with **signature verification**; treat the provider's `payment_intent_id` as the `idempotency_key` (already the design); insert payment as `pending` then flip to `completed` on confirmation. |
| **GraphQL** | Add Apollo Server in front of the **same** service-layer functions (`createInvoice`, `applyPayment`, …) — no logic duplication. |
| **Auth / multi-tenant** | JWT middleware in `server.ts`; add `tenant_id`/`owner_id` on accounts + invoices; enforce in queries (or Postgres RLS). |
| **Audit log / event sourcing** | The ledger is already append-only. Add an immutable `events`/`webhook_log` table or an outbox; never DELETE ledger entries — only post reversing entries. |
| **Reporting / trial balance** | Pure derivation: `SELECT account, SUM(debit), SUM(credit) FROM ledger_entries GROUP BY account`. Add a `GET /reports/trial-balance` route. |
| **Overdue as a job** | Currently `overdue` is a read-time overlay in `getInvoice`. Add a daily cron (or Railway cron) that flips `sent/partial → overdue` when `due_date < today`. |
| **Scale** | Indexes exist; add materialized/cached balances for read-heavy dashboards, partition `ledger_entries` by month, read replicas for reports. |

---

## 9. Honest shortcuts (if asked "what would you do differently")

- **REST, not GraphQL/Spring Boot** — brief allowed "language of your choice"; I'd add GraphQL as a thin layer.
- **Single currency** — I chose the concurrency edge case over multi-currency.
- **`number` for cents in TS** (safe to 2^53) — production would use `bigint` end-to-end + a `Money` value object.
- **Schema applied on boot** (idempotent) not a migration tool — fine at this size; reach for a migrator once schema churns.
- **No auth** — out of scope; middleware drops in cleanly.

---

## 10. Rapid-fire Q&A

- **Where's a balance stored?** Nowhere. `accounts.ts:getBalance` derives it from `ledger_entries`.
- **How do you prevent floating-point errors?** Integer cents + basis-point tax; all math in `lib/money.ts`.
- **How do you handle a webhook firing twice?** `payments.idempotency_key` is UNIQUE; a repeat returns the original with `idempotent:true`.
- **How do you handle two payments at once?** `SELECT … FOR UPDATE` on the invoice serializes them; the second sees the reduced amount due.
- **Can an unbalanced transaction ever be written?** No — `postTransaction` rejects it before any INSERT, and the whole thing is in a transaction.
- **What's atomic?** `withTransaction` (and `withClient`) wrap multi-step writes; failure rolls back the INSERT + ledger posting together.
