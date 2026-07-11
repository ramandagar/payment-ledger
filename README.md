# Mini Payment Ledger & Invoice Service

A double-entry payment ledger and invoice service for a TMS **Accounts Payable / payment-processing module**. Backend in **Node.js + TypeScript + Express + PostgreSQL**, frontend in **React + Vite + TypeScript**.

> Stack note: the JD mentioned GraphQL and Spring Boot. The brief explicitly allows *"language of your choice, or specify your stack."* I chose Node.js/TypeScript/PostgreSQL because it's my strongest stack, so the result is correct and defensible rather than thinly faked in a language I can't stand behind in an interview. A GraphQL layer is a clean add-on (see *What I'd do differently*).

---

## Why this design

The whole point of a ledger is **you can never have lost or invented money.** Three rules drove every decision:

1. **Balances are derived, never stored.** There is no `balance` column anywhere. Account balances are always `SUM()`-ed from the immutable `ledger_entries` log. You can replay the log from zero and get the same numbers.
2. **No floating point for money, anywhere.** Every amount is integer **cents** (`BIGINT`). Tax is stored in **basis points** (`1800` = 18.00%), so all money math is integer math — `qty * unitPrice * (10000 + taxBps) / 10000`. No `0.1 + 0.2` surprises.
3. **Every state change is a balanced double-entry transaction.** To move money you `debit` one account and `credit` another by the same amount, atomically. The posting function rejects anything that doesn't balance to the cent.

### The hard parts the brief called out

| Requirement | How it's solved |
|---|---|
| **Double-entry** | `postTransaction()` enforces `sum(debits) === sum(credits)` and writes the journal entry + its legs in one DB transaction. |
| **Balances derivable** | `getBalance()` = `SUM(debit) - SUM(credit)` over `ledger_entries`. Never cached. |
| **Invoice lifecycle** | Status state machine `draft → sent → partial → paid` (+ `overdue` overlaid from `due_date`, + `void`). Issuing an invoice posts the receivable; tax posts to a Tax Payable account. |
| **Partial payments** | `amountDueCents = total − sum(completed payments)`; status flips to `paid` only when due hits 0. |
| **No overpayment** | Validated against the live amount-due inside the row lock. |
| **Double webhook (Part 2)** | `payments.idempotency_key` has a `UNIQUE` constraint. A repeat of the same gateway reference returns the original payment with `idempotent: true` — nothing is posted twice. |
| **Concurrent payments (Part 3 ✦)** | `SELECT … FOR UPDATE` on the invoice row **serializes** concurrent payments on the same invoice. Two full-amount payments fired simultaneously cannot both succeed — the second recomputes the amount due under the lock and is rejected. Overpayment is structurally impossible. *(I picked this edge case because it's the one most likely to cause real money loss in production.)* |

---

## Run it

### Option A — Docker (one command, what a reviewer should use)

```bash
docker compose up --build
```

- API → http://localhost:4000
- UI  → http://localhost:5173

The API auto-applies the schema and seeds the chart of accounts + a demo customer on boot. On first load the UI has a **Seed demo data** button.

### Option B — local dev (Node 20+ and PostgreSQL)

```bash
# 1. database
createdb ledger

# 2. API
cd backend
cp .env.example .env          # edit DATABASE_URL if needed
npm install
npm run db:init && npm run seed
npm run dev                   # http://localhost:4000

# 3. UI (new terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

---

## API

All money values are integer cents. POST bodies are JSON.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/health` | — | liveness |
| `POST` | `/seed` | — | seed chart of accounts + demo customer |
| `POST` | `/accounts` | `{code,name,type,currency?}` | type ∈ asset\|liability\|equity\|revenue\|expense |
| `GET` | `/accounts` | — | list with derived balances |
| `POST` | `/transactions` | `{reference?,description?,entries:[{accountId,direction,amountCents}]}` | manual double-entry; must balance |
| `GET` | `/transactions` | — | journal with legs |
| `POST` | `/invoices` | `{customerAccountId,dueDate,lineItems:[…],notes?,currency?}` | creates as `draft` |
| `GET` | `/invoices` | — | list |
| `GET` | `/invoices/:id` | — | full view: line items, totals, paid, amountDue |
| `POST` | `/invoices/:id/issue` | — | draft→sent, posts receivable to ledger |
| `POST` | `/invoices/:id/payments` | `{amountCents,idempotencyKey,method?,reference?}` | returns `{idempotent, invoice}` |
| `GET` | `/invoices/:id/payments` | — | payments for an invoice |
| `GET` | `/payments` | — | all payments |

---

## Tests

```bash
cd backend && npm test
```

17 tests across money math, double-entry posting, balance derivation, invoice totals, and the payment edge cases — **including a live concurrency test** that fires two simultaneous full payments at one invoice and asserts exactly one wins and the invoice is never overpaid:

```
Part 3 — concurrent payments racing the same invoice
  ✓ serializes via row lock: never overpays, applies at most the amount due
```

---

## Data model

```
accounts            chart of accounts + per-customer receivable sub-accounts
transactions        one business event (a journal entry)
ledger_entries      the debit/credit legs  ← balances are SUM()ed from here
invoices            header + status state machine
invoice_line_items  qty, unit_price_cents, tax_bps  (totals are computed, not stored)
payments            amount_cents + UNIQUE(idempotency_key)
```

---

## Shortcuts I took (being honest)

- **REST, not GraphQL.** REST is clearer to review and the brief allowed it. A GraphQL gateway in front of the same service layer is a small, isolated addition.
- **Spring Boot skipped** — same reason; I won't list a language I can't defend.
- **Single currency (USD).** I chose the **concurrency** edge case over the multi-currency one. A fixed-rate second currency is additive: an `exchange_rate` table + a conversion step on payment posting.
- **Auth omitted.** No auth/identity — out of scope for the brief, but the route layer is structured so a middleware can drop in.
- **Integer `number` for cents in TS** (safe to 2^53). A production ledger would use `bigint` end-to-end + a `Money` value object. Noted in `src/lib/money.ts`.
- **Schema applied on boot** (idempotent `IF NOT EXISTS` + exception-guarded enums) instead of a formal migration tool — appropriate at this size; I'd reach for a migrator once the schema churns.

## What I'd do with more time

1. **Refund flow** that keeps the ledger balanced (reverse the original payment transaction with a new balancing entry) — the other listed edge case.
2. **Overdue as a scheduled job**, not just a read-time overlay — a daily cron flipping `sent/partial` → `overdue` when `due_date` passes.
3. **GraphQL layer** + query complexity analysis (they asked for it).
4. **Audit log / event sourcing** — the `transactions`/`ledger_entries` tables are already append-only; exposing an immutable event stream is a natural next step for fintech.
5. **Optimistic UI updates** on the cart/payment screens and **money as a real `Money` type** with `bigint`.
6. **CI**: typecheck + tests + build on every push, deploy on tag.

---

Built by Raman Dagar — Node.js / TypeScript / React / PostgreSQL.
