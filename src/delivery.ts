// Delivery tokens (hash at rest) and outbound chat messages for the owner.
import { sha256Hex } from "./auth";

export type TokenKind = "rx" | "report";
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX = 4000; // messages.text CHECK

/** 256-bit token, base64url. Only its sha256 is stored. */
export async function newToken(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token, hash: await sha256Hex(token) };
}

export function tokenInsert(db: D1Database, hash: string, consultId: string, kind: TokenKind, now: Date, guardSql = "1 = 1", ...guardBinds: unknown[]) {
  const expires = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
  return db
    .prepare(`INSERT INTO delivery_tokens (token_sha256, consult_id, kind, expires_at) SELECT ?1, ?2, ?3, ?4 WHERE ${guardSql}`)
    .bind(hash, consultId, kind, expires, ...guardBinds);
}

/** Looks a clear token up by hash. Null when unknown, wrong kind or expired (caller answers 404 uniformly). */
export async function lookupToken(db: D1Database, token: string, kind: TokenKind, now: Date): Promise<{ consult_id: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  return db
    .prepare("SELECT consult_id FROM delivery_tokens WHERE token_sha256 = ?1 AND kind = ?2 AND expires_at > ?3")
    .bind(hash, kind, now.toISOString())
    .first<{ consult_id: string }>();
}

/** Clinic (non-bot) outbound messages, split so each row fits the 4000-char CHECK. */
/** `isBot` 1 = the bot speaks (the agent keeps answering afterwards); 0 = a human-approved message
 *  (the agent's E13 guard then treats the chat as taken by a person for HUMAN_WINDOW_MS). */
export function messageInserts(db: D1Database, conversationId: string, text: string, guardSql = "1 = 1", guardBinds: unknown[] = [], isBot: 0 | 1 = 0) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MESSAGE_MAX) chunks.push(text.slice(i, i + MESSAGE_MAX));
  return chunks.map((t) =>
    db
      .prepare(`INSERT INTO messages (conversation_id, direction, text, is_bot) SELECT ?1, 'outbound', ?2, ?3 WHERE ${guardSql}`)
      .bind(conversationId, t, isBot, ...guardBinds),
  );
}
