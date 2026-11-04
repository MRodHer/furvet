import { describe, expect, it } from "vitest";
import { redactOwner } from "../src/clinical/redact";

describe("owner identity never reaches the model (M1, contract C.4 / D.2)", () => {
  it("replaces every name word (≥3 chars) and the email, ignoring case and accents; keeps the original elsewhere", () => {
    const o = { name: "Laura Demo", email: "laura@example.com" };
    expect(redactOwner("LAURA, ¿desde cuándo? Te escribo a laura@example.com, Láura. Demo y demodulador", o)).toBe(
      "el dueño, ¿desde cuándo? Te escribo a el dueño, el dueño. el dueño y demodulador",
    );
    expect(redactOwner("José María vino", { name: "Jose Maria Pérez", email: null })).toBe("el dueño el dueño vino");
    expect(redactOwner("Firulais tiene 39.5", { name: "Visitante", email: null })).toBe("Firulais tiene 39.5");
    expect(redactOwner("hola", { name: null, email: null })).toBe("hola");
    // A regex metacharacter in the name is literal.
    expect(redactOwner("x (Ana) y", { name: "(Ana)", email: null })).toBe("x el dueño y");
  });
});
