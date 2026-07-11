// Money helpers. Everything is integer CENTS. No floats for currency, ever.
// ponytail: JS number holds integers exactly up to 2^53 (~$90 trillion in cents);
// a real ledger would use BIGINT end-to-end + a Money type. Fine for this scale.

export type Cents = number;

/** Parse a human decimal ("12.50") into cents (1250). Throws on non-monetary input. */
export function toCents(input: string | number): Cents {
  const str = typeof input === "number" ? input.toFixed(2) : String(input).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(str)) {
    throw new Error(`Invalid money value: ${input}`);
  }
  const [whole, frac = ""] = str.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return str.startsWith("-") ? -cents : cents;
}

/** Cents (1250) -> display string ("12.50"). */
export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}

export interface LineItem {
  quantity: number;
  unitPriceCents: Cents;
  taxBps: number; // 1800 = 18%
}

/** Integer-only line total: qty * unit * (10000 + taxBps) / 10000. */
export function lineTotalCents(item: LineItem): Cents {
  const gross = item.quantity * item.unitPriceCents;
  return Math.round((gross * (10_000 + item.taxBps)) / 10_000);
}

export interface InvoiceTotals {
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

/** Roll up many line items into subtotal / tax / total. All integer math. */
export function totalsFor(items: LineItem[]): InvoiceTotals {
  let subtotalCents = 0;
  let totalCents = 0;
  for (const it of items) {
    const gross = it.quantity * it.unitPriceCents;
    subtotalCents += gross;
    totalCents += lineTotalCents(it);
  }
  return { subtotalCents, taxCents: totalCents - subtotalCents, totalCents };
}

// ---------- self-check (run: npx tsx src/lib/money.ts) ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`money self-check FAILED: ${msg}`);
  };
  assert(toCents("12.50") === 1250, "toCents 12.50");
  assert(toCents(0.1) === 10, "toCents 0.1");
  assert(formatCents(1250) === "12.50", "format 1250");
  assert(formatCents(-5) === "-0.05", "format -5");
  const t = totalsFor([{ quantity: 2, unitPriceCents: 1000, taxBps: 1800 }]);
  assert(t.subtotalCents === 2000, "subtotal");
  assert(t.taxCents === 360, "tax 18% of 2000");
  assert(t.totalCents === 2360, "total");
  console.log("money self-check OK");
}
