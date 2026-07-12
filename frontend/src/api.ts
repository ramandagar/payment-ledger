// All backend calls + types. Amounts are integer cents everywhere.
// Backend base URL comes from VITE_API_URL (default http://localhost:4000).

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

// ---------------- domain types ----------------
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type Direction = "debit" | "credit";
export type InvoiceStatus = "draft" | "sent" | "partial" | "paid" | "overdue" | "void";

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
}
export interface AccountWithBalance extends Account {
  balanceCents: number; // debits - credits (positive = debit-normal)
}

export interface Entry {
  accountId: string;
  direction: Direction;
  amountCents: number;
}
// Backend returns snake_case created_at on transactions — typed as-is.
export interface Transaction {
  id: string;
  reference: string | null;
  source: string | null;
  description: string | null;
  created_at: string;
  entries: Entry[];
}

export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxBps?: number;
}
export interface LineItemView extends LineItemInput {
  id: string;
  lineTotalCents: number;
}
export interface InvoiceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
export interface InvoiceView {
  id: string;
  number: string;
  customerAccountId: string;
  status: InvoiceStatus;
  effectiveStatus: InvoiceStatus; // overlays 'overdue' from due date
  issueDate: string;
  dueDate: string;
  currency: string;
  notes: string | null;
  lineItems: LineItemView[];
  totals: InvoiceTotals;
  paidCents: number;
  amountDueCents: number;
  createdAt: string;
}

// listPayments uses SELECT *, so snake_case columns.
export interface Payment {
  id: string;
  invoice_id: string;
  amount_cents: number;
  idempotency_key: string;
  method: string | null;
  reference: string | null;
  status: string;
  created_at: string;
}
// applyPayment result is camelCase.
export interface PaymentResult {
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  idempotent: boolean;
  invoice: InvoiceView;
}

// ---------------- error ----------------
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------------- fetch helper ----------------
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError("Cannot reach the API server. Is the backend running?", 0);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      const err = body?.error;
      if (typeof err === "string") message = err;
      else if (Array.isArray(err)) message = err.map((e: { message?: string }) => e.message).filter(Boolean).join("; ");
      else if (err && typeof err === "object" && "message" in err) message = String((err as { message: unknown }).message);
      else if (body?.message) message = String(body.message);
    } catch {
      // response had no JSON body
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------------- API surface ----------------
export const api = {
  health: () => req<{ ok: boolean }>("/health"),

  listAccounts: () => req<AccountWithBalance[]>("/accounts"),
  createAccount: (body: { code: string; name: string; type: AccountType; currency?: string }) =>
    req<Account>("/accounts", { method: "POST", body: JSON.stringify(body) }),
  getBalance: (id: string) => req<{ balanceCents: number }>(`/accounts/${id}/balance`),

  listTransactions: () => req<Transaction[]>("/transactions"),
  postTransaction: (body: {
    reference?: string;
    description?: string;
    entries: Entry[];
  }) => req<{ id: string }>("/transactions", { method: "POST", body: JSON.stringify(body) }),

  listInvoices: () => req<InvoiceView[]>("/invoices"),
  getInvoice: (id: string) => req<InvoiceView>(`/invoices/${id}`),
  createInvoice: (body: {
    customerAccountId: string;
    dueDate: string;
    lineItems: LineItemInput[];
    notes?: string;
    currency?: string;
  }) => req<InvoiceView>("/invoices", { method: "POST", body: JSON.stringify(body) }),
  issueInvoice: (id: string) => req<InvoiceView>(`/invoices/${id}/issue`, { method: "POST" }),
  deleteInvoice: (id: string) => req<void>(`/invoices/${id}`, { method: "DELETE" }),

  listInvoicePayments: (id: string) => req<Payment[]>(`/invoices/${id}/payments`),
  applyPayment: (id: string, body: { amountCents: number; idempotencyKey: string; method?: string; reference?: string }) =>
    req<PaymentResult>(`/invoices/${id}/payments`, { method: "POST", body: JSON.stringify(body) }),
  listPayments: () => req<Payment[]>("/payments"),
};
