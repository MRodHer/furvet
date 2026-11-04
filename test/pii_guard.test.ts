import { describe, expect, it } from "vitest";
import { assertNoPii } from "./helpers";

describe("assertNoPii (test helper)", () => {
  it("does not mistake a digit-heavy UUID for a phone number (the intermittent failure)", () => {
    expect(() => assertNoPii(['{"event":"x","consult_id":"96505394-8f64-4143-a61e-837505331325"}'])).not.toThrow();
  });

  it("still rejects an email, a phone number and a payer object", () => {
    expect(() => assertNoPii(['{"owner":"laura@example.com"}'])).toThrow(/PII-looking/);
    expect(() => assertNoPii(['{"id":"96505394-8f64-4143-a61e-837505331325","phone":"5512345678"}'])).toThrow(/PII-looking/);
    expect(() => assertNoPii(['{"payer":{}}'])).toThrow(/PII-looking/);
  });
});
