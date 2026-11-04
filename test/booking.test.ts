import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { executeTool, TOOLS, type ToolContext } from "../src/agent/tools";
import { makePayPal } from "../src/paypal";
import { count, fakeFetch, NOW, paypalFakes, PP, seedBooking, withEnv } from "./helpers";

function ctx(conv: string, overrides: Partial<ToolContext> = {}): ToolContext & { calls: ReturnType<typeof fakeFetch>["calls"]; count: ReturnType<typeof fakeFetch>["count"] } {
  const ff = fakeFetch(paypalFakes());
  const e = overrides.env ?? env;
  return {
    env: e,
    deps: { fetch: ff.fetchImpl, now: () => NOW },
    paypal: makePayPal(ff.fetchImpl, { clientId: "id", clientSecret: "s" }),
    conversationId: conv,
    contactId: conv,
    ...overrides,
    calls: ff.calls,
    count: ff.count,
  };
}

describe("booking + deposit tools (E7, E8, E9, V17)", () => {
  it("E8: no tool schema has a money field", () => {
    for (const t of TOOLS) {
      const props = Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties);
      expect(props.some((p) => /amount|price|precio|monto|total|unit_price/i.test(p)), t.name).toBe(false);
      expect(t.input_schema.additionalProperties).toBe(false);
    }
    expect(TOOLS.find((t) => t.name === "create_deposit")?.input_schema.required).toEqual(["appointment_id"]);
  });

  it("E8/E9: an extra `amount` key on create_deposit is rejected before any DB or PayPal call", async () => {
    const { conv, appt } = await seedBooking();
    const c = ctx(conv);
    const out = await executeTool(c, "create_deposit", { appointment_id: appt, amount: 1 });
    expect(out).toMatch(/inválida/);
    expect(c.count(PP.orders)).toBe(0);
    expect(await count("charges", "appointment_id = ?1", appt)).toBe(0);
  });

  it("E9: an appointment from another conversation is refused", async () => {
    const { appt } = await seedBooking();
    const other = crypto.randomUUID();
    await env.DB.batch([env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(other), env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(other)]);
    const c = ctx(other);
    expect(await executeTool(c, "create_deposit", { appointment_id: appt })).toBe("Cita inválida.");
    expect(c.count(PP.orders)).toBe(0);
    expect(await count("charges", "appointment_id = ?1", appt)).toBe(0);
  });

  it("deposit amount comes from the catalog; unpriced catalog refuses (no order)", async () => {
    const { conv, appt } = await seedBooking(0);
    const c = ctx(conv);
    expect(await executeTool(c, "create_deposit", { appointment_id: appt })).toMatch(/no está configurado/);
    expect(c.count(PP.orders)).toBe(0);
  });

  it("E9: catalog price above MAX_CHARGE_CENTS refuses", async () => {
    const { conv, appt } = await seedBooking(20000);
    const c = ctx(conv, { env: withEnv({ MAX_CHARGE_CENTS: "19999" }) });
    expect(await executeTool(c, "create_deposit", { appointment_id: appt })).toMatch(/No se pudo/);
    expect(c.count(PP.orders)).toBe(0);
  });

  it("E7: deposit is idempotent — same appointment twice → one charge, one PayPal-Request-Id, same link", async () => {
    const { conv, appt } = await seedBooking(20000);
    const c = ctx(conv);
    const first = await executeTool(c, "create_deposit", { appointment_id: appt });
    const second = await executeTool(c, "create_deposit", { appointment_id: appt });
    expect(first).toContain("https://www.sandbox.paypal.com/");
    expect(first).toContain("$200.00 MXN");
    expect(second).toBe(first);
    expect(c.count(PP.orders)).toBe(1);
    const order = c.calls.find((x) => x.key === PP.orders)!;
    expect(order.headers.get("PayPal-Request-Id")).toBe(`deposit-${appt}`);
    const body = JSON.parse(order.body);
    expect(body.purchase_units[0].amount).toEqual({ currency_code: "MXN", value: "200.00" });
    expect(await count("charges", "appointment_id = ?1", appt)).toBe(1);
    expect(await count("charge_events", "status = 'created' AND charge_id IN (SELECT id FROM charges WHERE appointment_id = ?1)", appt)).toBe(1);
  });

  it("B1: crash between createOrder and claimCharge, then retry → PayPal's custom_id still equals our charge id", async () => {
    const { conv, appt } = await seedBooking(20000);
    const c = ctx(conv);
    // Intent 1 died right after the order was created (nothing claimed in D1).
    const first = await c.paypal!.createOrder({ amountCents: 20000, currency: "MXN", customId: appt, requestId: `deposit-${appt}`, description: "x", returnUrl: "https://furvet.test/r", cancelUrl: "https://furvet.test/c" });
    const customIdAtPayPal = new URL(first.approveUrl).searchParams.get("cid");
    // Intent 2: the tool runs normally; PayPal (same request id) hands back the SAME order.
    expect(await executeTool(c, "create_deposit", { appointment_id: appt })).toContain("Liga de pago");
    const row = await env.DB.prepare("SELECT id, paypal_order_id FROM charges WHERE appointment_id = ?1").bind(appt).first<{ id: string; paypal_order_id: string }>();
    expect(row?.id).toBe(customIdAtPayPal);
    expect(row?.id).toBe(appt);
  });

  it("no PayPal secrets → payments unavailable, nothing written", async () => {
    const { conv, appt } = await seedBooking();
    const c = ctx(conv, { paypal: null });
    expect(await executeTool(c, "create_deposit", { appointment_id: appt })).toMatch(/no están disponibles/);
    expect(await count("charges", "appointment_id = ?1", appt)).toBe(0);
  });

  it("V17: two bookings of the same slot → exactly one appointment", async () => {
    const conv = crypto.randomUUID();
    const slot = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
      env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
      env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2026-11-10T10:00:00.000Z')").bind(slot),
    ]);
    const c = ctx(conv);
    const input = { slot_id: slot, pet_name: "Firulais", species: "perro" };
    const [a, b] = await Promise.all([executeTool(c, "book_appointment", input), executeTool(c, "book_appointment", input)]);
    const wins = [a, b].filter((x) => x.includes("appointment_id")).length;
    expect(wins).toBe(1);
    expect(await count("appointments", "conversation_id = ?1", conv)).toBe(1);
    expect(await count("pets", "contact_id = ?1", conv)).toBe(1);
  });

  it("book_appointment rejects a past slot, a bad species and extra keys", async () => {
    const conv = crypto.randomUUID();
    const slot = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
      env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
      env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2020-01-01T10:00:00.000Z')").bind(slot),
    ]);
    const c = ctx(conv);
    expect(await executeTool(c, "book_appointment", { slot_id: slot, pet_name: "X", species: "perro" })).toMatch(/ya se ocupó/);
    expect(await executeTool(c, "book_appointment", { slot_id: slot, pet_name: "X", species: "iguana" })).toMatch(/inválida/);
    expect(await executeTool(c, "book_appointment", { slot_id: slot, pet_name: "X", species: "perro", amount: 5 })).toMatch(/inválida/);
    expect(await count("appointments", "conversation_id = ?1", conv)).toBe(0);
  });

  it("list_slots only shows free future slots", async () => {
    const conv = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
      env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
      env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2020-01-01T10:00:00.000Z')").bind(`past-${conv}`),
      env.DB.prepare("INSERT INTO slots (id, starts_at, taken) VALUES (?1, '2026-11-05T10:00:00.000Z', 1)").bind(`taken-${conv}`),
      env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2026-11-05T10:30:00.000Z')").bind(`free-${conv}`),
    ]);
    const out = await executeTool(ctx(conv), "list_slots", {});
    expect(out).toContain(`free-${conv}`);
    expect(out).not.toContain(`past-${conv}`);
    expect(out).not.toContain(`taken-${conv}`);
  });

  it("save_contact_info is a partial update; escalate flips the conversation", async () => {
    const { conv } = await seedBooking();
    const c = ctx(conv);
    await executeTool(c, "save_contact_info", { name: "Laura Demo" });
    await executeTool(c, "save_contact_info", { notes: "prefiere tardes" });
    const row = await env.DB.prepare("SELECT name, notes, email FROM contacts WHERE id = ?1").bind(conv).first<{ name: string; notes: string; email: string | null }>();
    expect(row).toEqual({ name: "Laura Demo", notes: "prefiere tardes", email: null });
    await executeTool(c, "escalate_to_human", { reason: "pide humano" });
    const conv2 = await env.DB.prepare("SELECT bot_escalated FROM conversations WHERE id = ?1").bind(conv).first<{ bot_escalated: number }>();
    expect(conv2?.bot_escalated).toBe(1);
  });
});
