import { initSchema } from "./client.js";
import { createAccount, getAccountByCode } from "../ledger/accounts.js";

const STANDARDS = [
  { code: "1000", name: "Cash / Bank", type: "asset" as const },
  { code: "1200", name: "Accounts Receivable (control)", type: "asset" as const },
  { code: "4000", name: "Sales Revenue", type: "revenue" as const },
  { code: "5000", name: "Tax Payable (Output VAT)", type: "liability" as const },
  { code: "6000", name: "Sales Refunds", type: "expense" as const },
];

/** Idempotent: creates the standard chart of accounts + a demo customer if missing. */
export async function ensureSeed(): Promise<void> {
  await initSchema();
  for (const a of STANDARDS) {
    if (!(await getAccountByCode(a.code))) await createAccount(a);
  }
  if (!(await getAccountByCode("AR_DEMO"))) {
    await createAccount({ code: "AR_DEMO", name: "Acme Logistics (demo customer)", type: "asset" });
  }
}
