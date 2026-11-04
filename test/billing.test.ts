import { describe, expect, it } from "vitest";
import { buildLines, computeBill, BillingError } from "../src/billing";
import { centsToValue } from "../src/money";

const catalog = [
  { id: "c", name: "Consulta general", price_cents: 45000, active: 1 },
  { id: "v", name: "Vacuna rabia", price_cents: 38050, active: 1 },
  { id: "m", name: "Amoxicilina", price_cents: 12525, active: 1 },
  { id: "off", name: "Inactivo", price_cents: 100, active: 0 },
];

describe("billing (V9 arithmetic, D.4)", () => {
  it("V9: 450.00 + 380.50 + 2 × 125.25 − deposit 200.00 = 881.00, all in integer cents", () => {
    const lines = buildLines(
      [
        { catalogItemId: "c", quantity: 1, source: "doctor_added" },
        { catalogItemId: "v", quantity: 1, source: "ai_detected" },
        { catalogItemId: "m", quantity: 2, source: "ai_detected" },
      ],
      catalog,
    );
    const bill = computeBill(lines, 20000);
    expect(bill.totalCents).toBe(108100);
    expect(bill.balanceCents).toBe(88100);
    expect(centsToValue(bill.balanceCents)).toBe("881.00");
    expect(lines[2]?.lineTotalCents).toBe(25050);
  });

  it("deposit ≥ total → balance 0 (never negative)", () => {
    const lines = buildLines([{ catalogItemId: "c", quantity: 1, source: "doctor_added" }], catalog);
    expect(computeBill(lines, 45000).balanceCents).toBe(0);
    expect(computeBill(lines, 99999).balanceCents).toBe(0);
  });

  it("unknown, inactive or fractional/out-of-range items are refused (ids come from the client)", () => {
    expect(() => buildLines([{ catalogItemId: "nope", quantity: 1, source: "doctor_added" }], catalog)).toThrow(BillingError);
    expect(() => buildLines([{ catalogItemId: "off", quantity: 1, source: "doctor_added" }], catalog)).toThrow(BillingError);
    expect(() => buildLines([{ catalogItemId: "m", quantity: 1.5, source: "doctor_added" }], catalog)).toThrow(BillingError);
    expect(() => buildLines([{ catalogItemId: "m", quantity: 101, source: "doctor_added" }], catalog)).toThrow(BillingError);
    expect(() => computeBill([], -1)).toThrow(BillingError);
  });
});
