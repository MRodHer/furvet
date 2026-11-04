import { describe, expect, it } from "vitest";
import { centsToValue, formatCents, valueToCents } from "../src/money";

describe("money (E5 — exact integer arithmetic)", () => {
  it("formats cents as two-decimal text", () => {
    expect(centsToValue(0)).toBe("0.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(centsToValue(88100)).toBe("881.00");
    expect(centsToValue(69597)).toBe("695.97");
  });

  it("3 × 199.99 is exactly 599.97", () => {
    expect(centsToValue(3 * valueToCents("199.99"))).toBe("599.97");
  });

  it("V9 arithmetic: 450.00 + 380.50 + 2 × 125.25 − 200.00 = 881.00", () => {
    const total = valueToCents("450.00") + valueToCents("380.50") + 2 * valueToCents("125.25");
    expect(centsToValue(total - valueToCents("200.00"))).toBe("881.00");
  });

  it("rejects anything that is not strict two-decimal text", () => {
    for (const bad of ["695.9", "695", "1e3", " 695.97", "695.97 ", "-1.00", "1,00", "", "0x10.00"]) {
      expect(() => valueToCents(bad), bad).toThrow(RangeError);
    }
  });

  it("rejects non-integer or negative cents", () => {
    expect(() => centsToValue(1.5)).toThrow(RangeError);
    expect(() => centsToValue(-1)).toThrow(RangeError);
    expect(() => centsToValue(Number.NaN)).toThrow(RangeError);
  });

  it("formats for humans", () => {
    expect(formatCents(20000, "MXN")).toBe("$200.00 MXN");
  });
});
