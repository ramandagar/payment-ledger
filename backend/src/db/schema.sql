-- Mini Payment Ledger & Invoice Service — schema
-- Money rules enforced here:
--   * All amounts stored as integer CENTS (BIGINT). No floats anywhere.
--   * Tax stored in BASIS POINTS (tax_bps): 1800 = 18.00%. Integer math only.
--   * Account balances are NEVER stored — always derived from ledger_entries.
--   * Every transaction is double-entry: SUM(debits) == SUM(credits).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ---------- Chart of accounts ----------
DO $$ BEGIN CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,           -- e.g. 1000 / AR_<cust>
  name       TEXT NOT NULL,
  type       account_type NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Transactions = one business event (a journal entry) ----------
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference   TEXT,                          -- invoice/payment id, etc.
  source      TEXT NOT NULL,                 -- manual | invoice | payment | refund
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Ledger entries = the debit/credit legs ----------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES accounts(id),
  direction      TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn ON ledger_entries(transaction_id);

-- Guard: every transaction's debits must equal its credits.
CREATE OR REPLACE VIEW txn_balance_check AS
  SELECT transaction_id,
         SUM(CASE direction WHEN 'debit'  THEN amount_cents END) AS debits,
         SUM(CASE direction WHEN 'credit' THEN amount_cents END) AS credits
  FROM ledger_entries GROUP BY transaction_id;

-- ---------- Invoices ----------
DO $$ BEGIN CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'partial', 'paid', 'overdue', 'void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number              TEXT NOT NULL UNIQUE,          -- INV-0001
  customer_account_id UUID NOT NULL REFERENCES accounts(id),
  status              invoice_status NOT NULL DEFAULT 'draft',
  issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date            DATE NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position         INT NOT NULL DEFAULT 0,
  description      TEXT NOT NULL,
  quantity         INT NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  tax_bps          INT NOT NULL DEFAULT 0 CHECK (tax_bps >= 0 AND tax_bps < 10000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);

-- ---------- Payments ----------
DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoices(id),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  idempotency_key TEXT NOT NULL UNIQUE,             -- prevents double webhook processing
  status          payment_status NOT NULL DEFAULT 'completed',
  method          TEXT,
  reference       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
