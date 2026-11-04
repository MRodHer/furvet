// Doctor console auth: HTTP Basic over HTTPS (the browser supplies the dialog).
// Fail-closed: without BOTH secrets every guarded route answers 503, never "open".
// Comparison is constant-time over SHA-256 hex of each side (fixed length → no length leak).
// Brute force (audit H3): failed attempts are counted in D1 per origin (cf-connecting-ip; IPv6 by /64);
// past a threshold the origin is blocked for a progressive, BOUNDED time (429 + Retry-After).
// The store failing is a 503 (deny), never a pass.
import type { MiddlewareHandler } from "hono";
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
// Per origin only: after IP_THRESHOLD failures inside WINDOW_MS the origin is blocked IP_BLOCK_BASE_MS,
// doubling per further failure up to IP_BLOCK_MAX_MS, so a shared NAT, or the doctor's own typos,
// never lock her out for longer than that and another origin never affects hers. There is NO global
// counter on purpose: one would let any stranger re-arm a lockout of the doctor with one failure a
// minute. A distributed dictionary attack is the WAF's job (edge rate limit, custom domain) plus a
// long random credential; both are the operator's decisions, not this module's.
export const LOCKOUT = {
  WINDOW_MS: 15 * 60_000,
  IP_THRESHOLD: 5,
  IP_BLOCK_BASE_MS: 60_000,
  IP_BLOCK_MAX_MS: 15 * 60_000,
} as const;

// One statement: reset the window when stale, count the failure, and derive the block from the NEW
// count (the CASE is repeated because DO UPDATE sees only old values).
const NEW_COUNT = "CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE failures + 1 END";
const RECORD_FAILURE = `INSERT INTO auth_failures (key, failures, window_start, blocked_until) VALUES (?1, 1, ?2, 0)
  ON CONFLICT(key) DO UPDATE SET
    failures = ${NEW_COUNT},
    window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
    blocked_until = CASE WHEN (${NEW_COUNT}) >= ?4 THEN ?2 + min(?5 << min((${NEW_COUNT}) - ?4, 10), ?6) ELSE 0 END
  RETURNING failures`;

/**
 * Counter key for an address: IPv4 as is; IPv6 collapsed to its /64, the smallest block a home or
 * mobile line normally gets, so one subscriber cannot multiply counters by rotating interface ids.
 */
export function originKey(ip: string): string {
  if (!ip.includes(":")) return `ip:${ip}`;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `ip:${full.slice(0, 4).map((x) => x.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

/** Returns ms until the block on this origin lifts; 0 when not blocked. Throws on store failure. */
async function blockedFor(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT blocked_until FROM auth_failures WHERE key = ?1").bind(key).first<{ blocked_until: number }>();
  return Math.max(0, (row?.blocked_until ?? 0) - now);
}

/** Counts one failure; returns the origin's failure count in the current window. Throws on store failure. */
async function recordFailure(db: D1Database, key: string, now: number): Promise<number> {
  const L = LOCKOUT;
  const row = await db.prepare(RECORD_FAILURE).bind(key, now, L.WINDOW_MS, L.IP_THRESHOLD, L.IP_BLOCK_BASE_MS, L.IP_BLOCK_MAX_MS).first<{ failures: number }>();
  return row?.failures ?? 0;
}

export function doctorAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.env.DOCTOR_DEMO_USER;
    const pass = c.env.DOCTOR_DEMO_PASSWORD;
    if (!user || !pass) {
      log("doctor_auth_unconfigured", { path: new URL(c.req.url).pathname });
      return c.json({ error: "doctor credentials not configured" }, 503);
    }
    // Set by Cloudflare on every request to the Worker; absent only outside the platform (tests, dev).
    const key = originKey(c.req.header("cf-connecting-ip") ?? "none");
    const now = Date.now();
    let waitMs: number;
    try {
      waitMs = await blockedFor(c.env.DB, key, now);
    } catch (e) {
      // The counter is part of the credential check: if it cannot be read, nobody gets in.
      log("doctor_auth_store_failed", { error: errName(e), route: c.req.routePath });
      return c.json({ error: "authentication temporarily unavailable" }, 503);
    }
    if (waitMs > 0) {
      const retryAfter = Math.ceil(waitMs / 1000);
      // No origin in the log: a hash of an IPv4 address is reversible, so the signal is the count and the route.
      log("doctor_auth_blocked", { retry_after_s: retryAfter, route: c.req.routePath });
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
          if (ok) await c.env.DB.prepare("DELETE FROM auth_failures WHERE key = ?1").bind(key).run();
          else log("doctor_auth_denied", { reason: okUser ? "password" : "user", failures: await recordFailure(c.env.DB, key, now) });
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
