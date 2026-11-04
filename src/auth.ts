// Doctor console auth: HTTP Basic over HTTPS (the browser supplies the dialog).
// Fail-closed: without BOTH secrets every guarded route answers 503, never "open".
// Comparison is constant-time over SHA-256 hex of each side (fixed length → no length leak).
// Brute force (audit H3): failed attempts are counted in D1 per origin ("ip:<cf-connecting-ip>") and
// globally; past a threshold the origin is blocked for a progressive, BOUNDED time (429 + Retry-After).
// The store failing is a 503 (deny), never a pass.
import type { Context, MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Env } from "./env";
import { errName, log } from "./log";
import { timingSafeEqual } from "./prior/hmac";

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  return timingSafeEqual(await sha256Hex(given), await sha256Hex(expected));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_TYPES = /^(application\/json|audio\/|multipart\/form-data)/i;

/**
 * CSRF guard for state changes behind the cached Basic credential. A browser always sends
 * Sec-Fetch-Site (and Origin on POST), so a cross-site form is refused (403) before the route runs;
 * the body type is then restricted to what the console sends (415 otherwise), so a form-encodable
 * body never reaches a handler. A client that sends neither header (curl, tests) is not a CSRF
 * vector and is judged by its Content-Type alone.
 */
export const sameOriginWrite: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  const crossSite = site !== undefined && site !== "same-origin" && site !== "none";
  const originMismatch = origin !== undefined && origin !== new URL(c.req.url).origin;
  if (crossSite || originMismatch) {
    log("doctor_csrf_denied", { cross_site: crossSite, origin_mismatch: originMismatch, route: c.req.routePath });
    return c.json({ error: "cross-site request refused" }, 403);
  }
  const type = c.req.header("content-type");
  const bodyless = (c.req.header("content-length") ?? "0") === "0";
  if (type ? !BODY_TYPES.test(type) : !bodyless) return c.json({ error: "unsupported content type" }, 415);
  return next();
};

// ---- H3: failed-attempt counter -------------------------------------------------------------
// Per origin: after IP_THRESHOLD failures inside WINDOW_MS the origin is blocked IP_BLOCK_BASE_MS,
// doubling per further failure up to IP_BLOCK_MAX_MS (so a shared NAT, or the doctor's own typos,
// never lock her out for longer than that). Globally: GLOBAL_THRESHOLD failures from ANY origins
// inside the window block everyone for a flat GLOBAL_BLOCK_MS — that caps a distributed dictionary
// attack at ~GLOBAL_THRESHOLD guesses per minute while bounding the outage an attacker can impose.
export const LOCKOUT = {
  WINDOW_MS: 15 * 60_000,
  IP_THRESHOLD: 5,
  IP_BLOCK_BASE_MS: 60_000,
  IP_BLOCK_MAX_MS: 15 * 60_000,
  GLOBAL_THRESHOLD: 50,
  GLOBAL_BLOCK_MS: 60_000,
} as const;

// One statement per key: reset the window when stale, count the failure, and derive the block
// from the NEW count (the CASE is repeated because DO UPDATE sees only old values).
const NEW_COUNT = "CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE failures + 1 END";
const RECORD_FAILURE = `INSERT INTO auth_failures (key, failures, window_start, blocked_until) VALUES (?1, 1, ?2, 0)
  ON CONFLICT(key) DO UPDATE SET
    failures = ${NEW_COUNT},
    window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
    blocked_until = CASE WHEN (${NEW_COUNT}) >= ?4 THEN ?2 + min(?5 << min((${NEW_COUNT}) - ?4, 10), ?6) ELSE 0 END
  RETURNING failures`;

function originOf(c: Context<{ Bindings: Env }>): { ip: string; keys: [string, string] } {
  // Set by Cloudflare on every request to the Worker; absent only outside the platform (tests, dev).
  const ip = c.req.header("cf-connecting-ip") ?? "none";
  return { ip, keys: [`ip:${ip}`, "global"] };
}

/** Hashed origin for logs: a stable signal of "same source" without storing the address itself. */
async function originHash(ip: string): Promise<string> {
  return (await sha256Hex(ip)).slice(0, 16);
}

/** Returns ms until the block on this origin (or the global one) lifts; 0 when not blocked. Throws on store failure. */
async function blockedFor(db: D1Database, keys: [string, string], now: number): Promise<number> {
  const row = await db.prepare("SELECT MAX(blocked_until) AS until FROM auth_failures WHERE key IN (?1, ?2)").bind(...keys).first<{ until: number | null }>();
  return Math.max(0, (row?.until ?? 0) - now);
}

/** Counts one failure on both keys; returns the origin's failure count in the current window. Throws on store failure. */
async function recordFailure(db: D1Database, keys: [string, string], now: number): Promise<number> {
  const L = LOCKOUT;
  const [ip] = await db.batch<{ failures: number }>([
    db.prepare(RECORD_FAILURE).bind(keys[0], now, L.WINDOW_MS, L.IP_THRESHOLD, L.IP_BLOCK_BASE_MS, L.IP_BLOCK_MAX_MS),
    db.prepare(RECORD_FAILURE).bind(keys[1], now, L.WINDOW_MS, L.GLOBAL_THRESHOLD, L.GLOBAL_BLOCK_MS, L.GLOBAL_BLOCK_MS),
  ]);
  return ip?.results[0]?.failures ?? 0;
}

export function doctorAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.env.DOCTOR_DEMO_USER;
    const pass = c.env.DOCTOR_DEMO_PASSWORD;
    if (!user || !pass) {
      log("doctor_auth_unconfigured", { path: new URL(c.req.url).pathname });
      return c.json({ error: "doctor credentials not configured" }, 503);
    }
    const { ip, keys } = originOf(c);
    const now = Date.now();
    let waitMs: number;
    try {
      waitMs = await blockedFor(c.env.DB, keys, now);
    } catch (e) {
      // The counter is part of the credential check: if it cannot be read, nobody gets in.
      log("doctor_auth_store_failed", { error: errName(e), route: c.req.routePath });
      return c.json({ error: "authentication temporarily unavailable" }, 503);
    }
    if (waitMs > 0) {
      const retryAfter = Math.ceil(waitMs / 1000);
      log("doctor_auth_blocked", { origin: await originHash(ip), retry_after_s: retryAfter, route: c.req.routePath });
      return c.json({ error: "too many attempts" }, 429, { "Retry-After": String(retryAfter) });
    }
    return basicAuth({
      realm: "FurVet doctor console",
      verifyUser: async (u, p) => {
        // Both compared always (no short-circuit on the username).
        const okUser = await sameSecret(u, user);
        const okPass = await sameSecret(p, pass);
        const ok = okUser && okPass;
        try {
          if (ok) await c.env.DB.prepare("DELETE FROM auth_failures WHERE key = ?1").bind(keys[0]).run();
          else log("doctor_auth_denied", { origin: await originHash(ip), failures: await recordFailure(c.env.DB, keys, now) });
        } catch (e) {
          log("doctor_auth_store_failed", { error: errName(e), route: c.req.routePath });
          return false; // store down ⇒ deny, even with the right credential
        }
        return ok;
      },
    })(c, async () => {
      // basicAuth discards what its `next` returns: hand the guard's refusal to the context.
      const refused = await sameOriginWrite(c, next);
      if (refused instanceof Response) c.res = refused;
    });
  };
}
