// Integer-cent money helpers. Amounts flow through the API as integer cents;
// we never use floats for money. Inputs are captured as dollar strings and
// converted to cents here.

/** Format integer cents as "$1,234.56". Negative values render as "-$12.50". */
export function formatCents(cents: number): string {
  const n = Math.trunc(cents);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(rem).padStart(2, "0")}`;
}

/**
 * Parse a dollar string into integer cents.
 *  "12.50"   -> 1250
 *  "$1,234"  -> 123400
 *  "12"      -> 1200
 *  "12.5"    -> 1250
 *  "12.999"  -> 1299  (truncated to 2 places)
 * Returns NaN for unparseable input so callers can show a validation error.
 */
export function toCents(input: string): number {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const dot = body.indexOf(".");
  let whole: string;
  let frac: string;
  if (dot === -1) {
    whole = body;
    frac = "";
  } else {
    whole = body.slice(0, dot);
    frac = body.slice(dot + 1);
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return NaN;
  const fracPadded = (frac + "00").slice(0, 2);
  const value = Number(whole || "0") * 100 + Number(fracPadded);
  return negative ? -value : value;
}

// ponytail: self-check — money is a trust-boundary path; smallest thing that fails if parsing breaks.
// Runs only in dev. Upgrade to a real unit test suite if money logic grows beyond this.
if (import.meta.env.DEV) {
  const parsed: Array<[string, number]> = [
    ["12.50", 1250], ["$1,234", 123400], ["12", 1200],
    ["12.5", 1250], ["12.999", 1299], ["", 0],
  ];
  const check = (got: unknown, want: unknown, label: string) => {
    // eslint-disable-next-line no-console
    console.assert(Object.is(got, want), `money self-check failed: ${label} => ${got}, want ${want}`);
  };
  check(formatCents(1250), "$12.50", "formatCents(1250)");
  check(formatCents(-5), "-$0.05", "formatCents(-5)");
  check(formatCents(123456789), "$1,234,567.89", "formatCents big");
  for (const [s, want] of parsed) check(toCents(s), want, `toCents("${s}")`);
}
