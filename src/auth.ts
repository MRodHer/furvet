// Doctor console auth: HTTP Basic over HTTPS (the browser supplies the dialog).
// Fail-closed: without BOTH secrets every guarded route answers 503, never "open".
// Comparison is constant-time over SHA-256 hex of each side (fixed length → no length leak).
import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";
import type { Env } from "./env";
import { log } from "./log";
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

export function doctorAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = c.env.DOCTOR_DEMO_USER;
    const pass = c.env.DOCTOR_DEMO_PASSWORD;
    if (!user || !pass) {
      log("doctor_auth_unconfigured", { path: new URL(c.req.url).pathname });
      return c.json({ error: "doctor credentials not configured" }, 503);
    }
    return basicAuth({
      realm: "FurVet doctor console",
      verifyUser: async (u, p) => {
        // Both compared always (no short-circuit on the username).
        const okUser = await sameSecret(u, user);
        const okPass = await sameSecret(p, pass);
        if (!(okUser && okPass)) log("doctor_auth_denied", {});
        return okUser && okPass;
      },
    })(c, async () => {
      // basicAuth discards what its `next` returns: hand the guard's refusal to the context.
      const refused = await sameOriginWrite(c, next);
      if (refused instanceof Response) c.res = refused;
    });
  };
}
