import { describe, it, expect } from "vitest";
import { toCents, formatCents, totalsFor } from "../src/lib/money.js";

describe("money math (no floats)", () => {
  it("parses decimal strings and numbers into integer cents", () => {
    expect(toCents("12.50")).toBe(1250);
    expect(toCents("0.1")).toBe(10);
    expect(toCents(0.1)).toBe(10);            // float 0.1 must NOT become 10.0000001 etc.
    expect(toCents("1000")).toBe(100000);
    expect(toCents("-3.33")).toBe(-333);
  });

  it("rejects non-monetary input", () => {
    expect(() => toCents("abc")).toThrow();
    expect(() => toCents("12.345")).toThrow();
  });

  it("formats cents back to a 2-dp display string", () => {
    expect(formatCents(1250)).toBe("12.50");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(-333)).toBe("-3.33");
  });

  it("computes line totals with basis-point tax using integer math only", () => {
    const t = totalsFor([{ quantity: 2, unitPriceCents: 1000, taxBps: 1800 }]); // 2 x $10 @ 18%
    expect(t.subtotalCents).toBe(2000);
    expect(t.taxCents).toBe(360);
    expect(t.totalCents).toBe(2360);
  });

  it("rounds half-up correctly on odd amounts", () => {
    // 3 x $0.33 @ 18% => gross 99c, tax = round(99*1800/10000)=round(17.82)=18
    const t = totalsFor([{ quantity: 3, unitPriceCents: 33, taxBps: 1800 }]);
    expect(t.subtotalCents).toBe(99);
    expect(t.taxCents).toBe(18);
    expect(t.totalCents).toBe(117);
  });
});
