import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { approxBirthDate, executeTool, TOOLS, type ToolContext } from "../src/agent/tools";
import { systemPrompt } from "../src/agent/run";
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
    // Both calls come from the same chat: the loser gets the winner's id back (idempotent), never a second row.
    const ids = [a, b].map((x) => /appointment_id: ([0-9a-f-]{36})/.exec(x)?.[1]);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBe(ids[0]);
    expect(await count("appointments", "conversation_id = ?1", conv)).toBe(1);
    expect(await count("pets", "contact_id = ?1", conv)).toBe(1);
  });

  describe("re-sent booking (prod bug: the bot asked «¿genero la liga?», then re-booked and orphaned the slot)", () => {
    async function seed(conv: string, slot: string) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
        env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
        env.DB.prepare("INSERT OR IGNORE INTO slots (id, starts_at) VALUES (?1, '2026-11-10T11:00:00.000Z')").bind(slot),
      ]);
    }
    const idOf = (out: string) => /appointment_id: ([0-9a-f-]{36})/.exec(out)?.[1];

    it("same slot, same chat → the same appointment_id again, one appointment, one pet, and create_deposit accepts it", async () => {
      const conv = crypto.randomUUID();
      const slot = crypto.randomUUID();
      await seed(conv, slot);
      const c = ctx(conv);
      const input = { slot_id: slot, pet_name: "Firulais", species: "perro" };
      const first = await executeTool(c, "book_appointment", input);
      const again = await executeTool(c, "book_appointment", input);
      expect(idOf(first)).toBeDefined();
      expect(again).not.toMatch(/ya se ocupó/);
      expect(idOf(again)).toBe(idOf(first));
      expect(await count("appointments", "conversation_id = ?1", conv)).toBe(1);
      expect(await count("pets", "contact_id = ?1", conv)).toBe(1);
      // create_deposit is keyed by that same id (unchanged code): the chat gets the link for the existing booking.
      expect(await executeTool(c, "create_deposit", { appointment_id: idOf(again) })).not.toBe("Cita inválida.");
    });

    it("same slot, ANOTHER chat → still «ya se ocupó» and the other chat's appointment id never leaks", async () => {
      const convA = crypto.randomUUID();
      const convB = crypto.randomUUID();
      const slot = crypto.randomUUID();
      await seed(convA, slot);
      await seed(convB, slot);
      const a = await executeTool(ctx(convA), "book_appointment", { slot_id: slot, pet_name: "Firulais", species: "perro" });
      const b = await executeTool(ctx(convB), "book_appointment", { slot_id: slot, pet_name: "Luna", species: "gato" });
      expect(b).toMatch(/ya se ocupó/);
      expect(b).not.toContain(idOf(a)!);
      expect(await count("appointments", "conversation_id = ?1", convB)).toBe(0);
    });

    it("the booking result and the system prompt tell the model to call create_deposit NOW, in the same turn, without asking", async () => {
      const conv = crypto.randomUUID();
      const slot = crypto.randomUUID();
      await seed(conv, slot);
      const out = await executeTool(ctx(conv), "book_appointment", { slot_id: slot, pet_name: "Firulais", species: "perro" });
      expect(out).toMatch(/create_deposit AHORA .*en el mismo turno, sin preguntar al dueño/);
      expect(out).not.toMatch(/ofrece/);
      const prompt = systemPrompt("Clínica");
      expect(prompt).toMatch(/llama create_deposit AHORA con ese appointment_id, en el mismo turno, sin preguntar al dueño/);
      expect(prompt).not.toMatch(/ofrece el anticipo/);
    });
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

  describe("pet data at booking (breed, sex, age → printable rx)", () => {
    async function freshSlot(conv: string) {
      const slot = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(conv),
        env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(conv),
        env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2026-11-10T16:00:00.000Z')").bind(slot),
      ]);
      return slot;
    }
    const pet = (conv: string) => env.DB.prepare("SELECT breed, sex, birth_date FROM pets WHERE contact_id = ?1").bind(conv).first<{ breed: string | null; sex: string | null; birth_date: string | null }>();

    it("books without them (optional data never blocks a booking); stores NULLs", async () => {
      const conv = crypto.randomUUID();
      const slot = await freshSlot(conv);
      expect(await executeTool(ctx(conv), "book_appointment", { slot_id: slot, pet_name: "Firulais", species: "perro" })).toMatch(/appointment_id/);
      expect(await pet(conv)).toEqual({ breed: null, sex: null, birth_date: null });
    });

    it("stores breed, sex and an approximate birth date (day 1 of the month) derived by the server from the spoken age", async () => {
      const conv = crypto.randomUUID();
      const slot = await freshSlot(conv);
      expect(await executeTool(ctx(conv), "book_appointment", { slot_id: slot, pet_name: "Luna", species: "gato", breed: " siamés ", sex: "hembra", age_years: 3, age_months: 4 })).toMatch(/appointment_id/);
      // NOW = 2026-11-04 → 3 years 4 months earlier = 2023-07
      expect(await pet(conv)).toEqual({ breed: "siamés", sex: "hembra", birth_date: "2023-07-01" });
      expect(approxBirthDate(NOW, undefined, 2)).toBe("2026-09-01");
      expect(approxBirthDate(NOW, 1)).toBe("2025-11-01");
      expect(approxBirthDate(NOW, 0, 11)).toBe("2025-12-01");
      expect(approxBirthDate(NOW)).toBeNull();
    });

    it("rejects an unknown sex, an age out of range, months ≥ 12 or a model-sent birth date with a clear message; nothing is written and the slot stays free", async () => {
      const conv = crypto.randomUUID();
      const slot = await freshSlot(conv);
      const c = ctx(conv);
      const base = { slot_id: slot, pet_name: "X", species: "perro" };
      for (const bad of [{ sex: "otro" }, { age_years: 31 }, { age_years: -1 }, { age_months: 12 }, { age_years: 2.5 }, { birth_date: "2020-01-01" }, { breed: "" }]) {
        const out = await executeTool(c, "book_appointment", { ...base, ...bad });
        expect(out).toMatch(/inválida/);
        expect(out).toMatch(/macho\|hembra/);
      }
      expect(await count("appointments", "conversation_id = ?1", conv)).toBe(0);
      expect(await count("pets", "contact_id = ?1", conv)).toBe(0);
      expect(await count("slots", "id = ?1 AND taken = 0", slot)).toBe(1);
    });

    it("the agent prompt asks for breed, sex and age in one question and never blocks the booking on them; the tool schema stays closed", () => {
      const prompt = systemPrompt("Clínica X");
      expect(prompt).toMatch(/raza, sexo y edad/);
      expect(prompt).toMatch(/nunca retrases ni bloquees la cita/);
      const tool = TOOLS.find((t) => t.name === "book_appointment")!;
      const schema = tool.input_schema as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
      expect(schema.required).toEqual(["slot_id", "pet_name", "species"]);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(["age_months", "age_years", "breed", "pet_name", "sex", "slot_id", "species"]);
    });
  });
});
