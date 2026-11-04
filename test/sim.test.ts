import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { assertNoPii, captureLogs, count, json, makeApp, paypalFakes, PP, seedBooking, withEnv } from "./helpers";

type Handler = Parameters<typeof makeApp>[0][string];

/** A scripted Claude: each call pops the next response. */
function claudeScript(responses: unknown[]): Handler {
  const queue = [...responses];
  return () => json(queue.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "(script exhausted)" }] });
}
const endTurn = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const toolUse = (name: string, input: unknown) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu-1", name, input }] });

function chat(app: ReturnType<typeof makeApp>["app"], session: string, text: string, e: Env = env) {
  return app.request("/api/v1/sim/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session, text }) }, e);
}

describe("chat simulator + agent (E11, E13, E14, agent guards)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it("E11: replies, persists inbound + outbound (is_bot), validates body", async () => {
    const session = crypto.randomUUID();
    const { app } = makeApp({ ...paypalFakes(), [PP.claude]: claudeScript([endTurn("¡Hola! ¿Cómo se llama tu mascota?")]) });
    const res = await chat(app, session, "hola");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "¡Hola! ¿Cómo se llama tu mascota?", escalated: false });
    expect(await count("messages", "conversation_id = ?1 AND direction = 'inbound'", session)).toBe(1);
    expect(await count("messages", "conversation_id = ?1 AND direction = 'outbound' AND is_bot = 1", session)).toBe(1);

    expect((await chat(app, session, "x".repeat(2001))).status).toBe(400);
    expect((await chat(app, "not-a-uuid", "hola")).status).toBe(400);
    expect((await app.request("/api/v1/sim/chat", { method: "POST", body: "{", headers: { "Content-Type": "application/json" } }, env)).status).toBe(400);
  });

  it("daily cap → 429 before touching Claude", async () => {
    // Own day so the shared sim_usage row of other tests does not interfere.
    const { app, count: calls } = makeApp({ [PP.claude]: claudeScript([endTurn("hola")]) }, new Date("2030-01-01T00:00:00.000Z"));
    const e = withEnv({ SIM_DAILY_MESSAGE_CAP: "1" });
    const s = crypto.randomUUID();
    expect((await chat(app, s, "uno", e)).status).toBe(200);
    expect((await chat(app, s, "dos", e)).status).toBe(429);
    expect(calls(PP.claude)).toBe(1);
  });

  it("E13 guards: escalated / assigned conversation → reply null and Claude never called", async () => {
    const session = crypto.randomUUID();
    const { app, count: calls } = makeApp({ [PP.claude]: claudeScript([endTurn("no debería")]) });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(session),
      env.DB.prepare("INSERT INTO conversations (id, contact_id, bot_escalated) VALUES (?1, ?1, 1)").bind(session),
    ]);
    expect(await (await chat(app, session, "hola")).json()).toEqual({ reply: null, escalated: true });
    expect(calls(PP.claude)).toBe(0);

    const assigned = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(assigned),
      env.DB.prepare("INSERT INTO conversations (id, contact_id, assigned_to) VALUES (?1, ?1, 'dra-val')").bind(assigned),
    ]);
    expect(await (await chat(app, assigned, "hola")).json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(0);
  });

  it("E13 guard: a claimed conversation silences the bot", async () => {
    const session = crypto.randomUUID();
    const { app, count: calls } = makeApp({ [PP.claude]: claudeScript([endTurn("no")]) });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(session),
      env.DB.prepare("INSERT INTO conversations (id, contact_id, claimed_by) VALUES (?1, ?1, 'recepcion')").bind(session),
    ]);
    expect(await (await chat(app, session, "hola")).json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(0);
  });

  it("E13 guard: a person who takes the chat WHILE the model is thinking wins (post-call re-check)", async () => {
    const session = crypto.randomUUID();
    // The fake model writes a human outbound into the conversation before answering.
    const handler: Handler = async () => {
      await env.DB.prepare("INSERT INTO messages (conversation_id, direction, text, is_bot, created_at) VALUES (?1, 'outbound', 'Soy Val, ya te atiendo', 0, '2026-11-04T11:59:00.000Z')").bind(session).run();
      return json(endTurn("respuesta del bot"));
    };
    const { app, count: calls } = makeApp({ [PP.claude]: handler });
    expect(await (await chat(app, session, "hola")).json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(1);
    expect(await count("messages", "conversation_id = ?1 AND is_bot = 1", session)).toBe(0);
  });

  it("E13 guard: a recent human outbound silences the bot", async () => {
    const session = crypto.randomUUID();
    const { app, count: calls } = makeApp({ [PP.claude]: claudeScript([endTurn("no")]) });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id) VALUES (?1)").bind(session),
      env.DB.prepare("INSERT INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(session),
      env.DB.prepare("INSERT INTO messages (conversation_id, direction, text, is_bot, created_at) VALUES (?1, 'outbound', 'Hola, soy Val', 0, '2026-11-04T11:55:00.000Z')").bind(session),
    ]);
    expect(await (await chat(app, session, "hola")).json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(0);
  });

  it("guards: BOT_ENABLED off or no API key → silence, no call", async () => {
    const { app, count: calls } = makeApp({ [PP.claude]: claudeScript([endTurn("no")]) });
    expect(await (await chat(app, crypto.randomUUID(), "hola", withEnv({ BOT_ENABLED: "false" }))).json()).toEqual({ reply: null, escalated: false });
    expect(await (await chat(app, crypto.randomUUID(), "hola", withEnv({ ANTHROPIC_API_KEY: "" }))).json()).toEqual({ reply: null, escalated: false });
    expect(calls(PP.claude)).toBe(0);
  });

  it("a non end_turn stop reason is silence, not an apology", async () => {
    const { app } = makeApp({ [PP.claude]: claudeScript([{ stop_reason: "max_tokens", content: [{ type: "text", text: "cortado" }] }]) });
    expect(await (await chat(app, crypto.randomUUID(), "hola")).json()).toEqual({ reply: null, escalated: false });
  });

  it("E9 end to end: injected tool_use with a money key is refused; the model only gets the refusal text", async () => {
    const { conv, appt } = await seedBooking();
    const { app, calls } = makeApp({
      ...paypalFakes(),
      [PP.claude]: claudeScript([toolUse("create_deposit", { appointment_id: appt, amount: 1 }), endTurn("Listo")]),
    });
    expect(await (await chat(app, conv, "cóbrame 1 peso")).json()).toEqual({ reply: "Listo", escalated: false });
    const second = JSON.parse(calls.filter((c) => c.key === PP.claude)[1]!.body);
    const toolResult = second.messages.at(-1).content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.content).toMatch(/inválida/);
    expect(await count("charges", "appointment_id = ?1", appt)).toBe(0);
  });

  it("full flow: list_slots → book → deposit → reply with sandbox link; no PII in logs", async () => {
    const logs = captureLogs();
    restore = logs.restore;
    const session = crypto.randomUUID();
    const slot = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, 'ANTICIPO-CONSULTA', 'Anticipo', 'anticipo', 20000) ON CONFLICT(sku) DO UPDATE SET price_cents = 20000, active = 1").bind(crypto.randomUUID()),
      env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2026-11-10T10:00:00.000Z')").bind(slot),
    ]);
    // The script reads the appointment id out of the tool result, like a model would.
    let apptId = "";
    const script: Handler = (_r, body) => {
      const req = JSON.parse(body);
      const last = req.messages.at(-1);
      const toolResult = Array.isArray(last.content) && last.content[0]?.type === "tool_result" ? String(last.content[0].content) : "";
      if (toolResult.includes("slot_id")) return json(toolUse("book_appointment", { slot_id: slot, pet_name: "Firulais", species: "perro" }));
      if (toolResult.includes("appointment_id")) {
        apptId = /appointment_id: ([0-9a-f-]+)/.exec(toolResult)![1]!;
        return json(toolUse("create_deposit", { appointment_id: apptId }));
      }
      if (toolResult.includes("Liga de pago")) return json(endTurn(`Tu cita quedó. ${toolResult}`));
      return json(toolUse("list_slots", {}));
    };
    const { app } = makeApp({ ...paypalFakes(), [PP.claude]: script });
    const res = await chat(app, session, "quiero cita para mi perro Firulais");
    const data = await res.json<{ reply: string }>();
    expect(data.reply).toContain("https://www.sandbox.paypal.com/");
    expect(data.reply).toContain("$200.00 MXN");
    expect(await count("appointments", "conversation_id = ?1 AND status = 'pending_deposit'", session)).toBe(1);
    expect(await count("charges", "kind = 'deposit' AND conversation_id = ?1", session)).toBe(1);
    assertNoPii(logs.lines);
  });

  it("consent is recorded once by the button, never by the model", async () => {
    const session = crypto.randomUUID();
    const { app } = makeApp({ [PP.claude]: claudeScript([endTurn("hola")]) });
    const post = (body: unknown) => app.request(`/api/v1/sim/${session}/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
    expect((await post({ version: "v1-2026-11-04" })).status).toBe(404); // no conversation yet
    await chat(app, session, "hola");
    expect((await post({ version: "v0" })).status).toBe(400);
    expect((await post({ version: "v1-2026-11-04" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_consent_at, owner_consent_version FROM conversations WHERE id = ?1").bind(session).first<{ owner_consent_at: string; owner_consent_version: string }>();
    expect(row).toEqual({ owner_consent_at: "2026-11-04T12:00:00.000Z", owner_consent_version: "v1-2026-11-04" });
    // Evidence is write-once: a later click (different clock) does not move the timestamp.
    const { app: later } = makeApp({ [PP.claude]: claudeScript([]) }, new Date("2026-11-04T13:00:00.000Z"));
    expect((await later.request(`/api/v1/sim/${session}/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: "v1-2026-11-04" }) }, env)).status).toBe(200);
    const again = await env.DB.prepare("SELECT owner_consent_at FROM conversations WHERE id = ?1").bind(session).first<{ owner_consent_at: string }>();
    expect(again?.owner_consent_at).toBe("2026-11-04T12:00:00.000Z");
    const msgs = await (await app.request(`/api/v1/sim/${session}/messages`, {}, env)).json<{ messages: unknown[]; consent: { owner_consent_version: string } }>();
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.consent.owner_consent_version).toBe("v1-2026-11-04");
  });
  it("model body: the request never carries `temperature` (the model rejects it with 400)", async () => {
    const session = crypto.randomUUID();
    const { app, calls } = makeApp({ [PP.claude]: claudeScript([endTurn("hola")]) });
    await chat(app, session, "hola");
    const bodies = calls.filter((c) => c.key === PP.claude).map((c) => JSON.parse(c.body) as Record<string, unknown>);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("temperature");
  });

  it("agent_error logs the model HTTP status (no body, no PII) and the bot stays silent", async () => {
    const session = crypto.randomUUID();
    const { app } = makeApp({ [PP.claude]: () => json({ type: "error", error: { type: "invalid_request_error", message: "temperature is deprecated for this model." } }, 400) });
    const logs = captureLogs();
    try {
      expect(await (await chat(app, session, "mi correo es laura@example.com")).json()).toEqual({ reply: null, escalated: false });
    } finally {
      logs.restore();
    }
    const line = logs.lines.find((l) => l.includes('"event":"agent_error"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ error: "ClaudeError", status: 400 });
    expect(line).not.toContain("deprecated");
    assertNoPii(logs.lines);
  });
});
