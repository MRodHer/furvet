// Chat simulator (stands in for WhatsApp in the demo). The session id is a
// client-generated UUID that doubles as contact id and conversation id.
import { Hono } from "hono";
import { z } from "zod";
import type { Deps, Env } from "../env";
import { intVar } from "../env";
import type { PayPalClient } from "../paypal";
import { runAgent } from "../agent/run";
import { OWNER_CONSENT_VERSION } from "../agent/tools";
import { log } from "../log";

const MAX_MESSAGES_PER_CONVERSATION = 60;

const ChatBody = z.object({ session_id: z.string().uuid(), text: z.string().trim().min(1).max(2000) }).strict();
const ConsentBody = z.object({ version: z.literal(OWNER_CONSENT_VERSION) }).strict();
const SessionParam = z.string().uuid();

interface MessageOut {
  id: number;
  direction: string;
  text: string;
  is_bot: number;
  created_at: string;
}

export function simRoutes(deps: Deps, paypalFor: (env: Env) => PayPalClient | null) {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/chat", async (c) => {
    const body = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const { session_id: sessionId, text } = body.data;
    const env = c.env;

    const cap = intVar(env.SIM_DAILY_MESSAGE_CAP, 300);
    const day = deps.now().toISOString().slice(0, 10);
    const usage = await env.DB.prepare(
      `INSERT INTO sim_usage (day, messages) VALUES (?1, 1)
       ON CONFLICT(day) DO UPDATE SET messages = messages + 1 WHERE messages < ?2
       RETURNING messages`,
    )
      .bind(day, cap)
      .first<{ messages: number }>();
    if (!usage) {
      log("sim_cap_reached", { day });
      return c.json({ error: "demo cap reached" }, 429);
    }

    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO contacts (id) VALUES (?1)").bind(sessionId),
      env.DB.prepare("INSERT OR IGNORE INTO conversations (id, contact_id) VALUES (?1, ?1)").bind(sessionId),
    ]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1").bind(sessionId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_MESSAGES_PER_CONVERSATION) return c.json({ error: "conversation cap reached" }, 429);

    await env.DB.prepare("INSERT INTO messages (conversation_id, direction, text) VALUES (?1, 'inbound', ?2)").bind(sessionId, text).run();

    const reply = await runAgent({ env, deps, paypal: paypalFor(env), conversationId: sessionId, contactId: sessionId }, text);
    if (reply !== null) {
      await env.DB.prepare("INSERT INTO messages (conversation_id, direction, text, is_bot) VALUES (?1, 'outbound', ?2, 1)").bind(sessionId, reply).run();
    }
    const conv = await env.DB.prepare("SELECT bot_escalated FROM conversations WHERE id = ?1").bind(sessionId).first<{ bot_escalated: number }>();
    return c.json({ reply, escalated: conv?.bot_escalated === 1 });
  });

  app.get("/:session/messages", async (c) => {
    const session = SessionParam.safeParse(c.req.param("session"));
    if (!session.success) return c.json({ error: "invalid session" }, 400);
    const { results } = await c.env.DB.prepare(
      "SELECT id, direction, text, is_bot, created_at FROM messages WHERE conversation_id = ?1 ORDER BY id ASC LIMIT 200",
    )
      .bind(session.data)
      .all<MessageOut>();
    const conv = await c.env.DB.prepare("SELECT owner_consent_at, owner_consent_version FROM conversations WHERE id = ?1")
      .bind(session.data)
      .first<{ owner_consent_at: string | null; owner_consent_version: string | null }>();
    return c.json({ messages: results, consent: conv ?? null });
  });

  // The CONSENT comes from a button, never from the model. Versioned text, first click wins.
  app.post("/:session/consent", async (c) => {
    const session = SessionParam.safeParse(c.req.param("session"));
    if (!session.success) return c.json({ error: "invalid session" }, 400);
    const body = ConsentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const res = await c.env.DB.prepare(
      "UPDATE conversations SET owner_consent_at = ?1, owner_consent_version = ?2 WHERE id = ?3 AND owner_consent_at IS NULL",
    )
      .bind(deps.now().toISOString(), body.data.version, session.data)
      .run();
    if (res.meta.changes === 0) {
      const exists = await c.env.DB.prepare("SELECT 1 AS x FROM conversations WHERE id = ?1").bind(session.data).first();
      if (!exists) return c.json({ error: "unknown session" }, 404);
    }
    log("owner_consent_recorded", { conversation_id: session.data, version: body.data.version });
    return c.json({ ok: true, version: body.data.version });
  });

  return app;
}
