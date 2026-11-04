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
    })(c, next);
  };
}
