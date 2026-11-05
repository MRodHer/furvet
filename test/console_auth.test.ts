import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DOCTOR_AUTH, makeApp, withEnv } from "./helpers";

const GUARDED = ["/console", "/api/v1/consults/appointments", "/api/v1/consults/00000000-0000-4000-8000-000000000000", "/api/v1/subscription"];

describe("doctor console auth (V16, D.7)", () => {
  it("V16: empty credential → 503 on every guarded route (fail-closed, even with a valid header)", async () => {
    const { app } = makeApp({});
    for (const e of [withEnv({ DOCTOR_DEMO_PASSWORD: "" }), withEnv({ DOCTOR_DEMO_USER: undefined })]) {
      for (const path of GUARDED) {
        expect((await app.request(path, { headers: DOCTOR_AUTH }, e)).status, path).toBe(503);
      }
    }
  });

  it("no header → 401 with WWW-Authenticate; wrong user or password → 401; right → not 401/503", async () => {
    const { app } = makeApp({});
    for (const [i, path] of GUARDED.entries()) {
      const ip = { "cf-connecting-ip": `198.51.100.${i}` }; // one origin per path: 3 failures each, under the H3 threshold
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic /);
      expect((await app.request(path, { headers: { ...ip, Authorization: `Basic ${btoa("doctor:wrong")}` } }, env)).status).toBe(401);
      expect((await app.request(path, { headers: { ...ip, Authorization: `Basic ${btoa("nurse:test-doctor-pass")}` } }, env)).status).toBe(401);
      // Same length as the real password, one char off (constant-time compare, not prefix match).
      expect((await app.request(path, { headers: { ...ip, Authorization: `Basic ${btoa("doctor:test-doctor-pasz")}` } }, env)).status).toBe(401);
      const ok = await app.request(path, { headers: DOCTOR_AUTH }, env);
      expect([200, 404]).toContain(ok.status);
    }
  });

  it("the console page is served through the Worker only after auth, with a self-only CSP", async () => {
    const { app } = makeApp({});
    const res = await app.request("/console", { headers: DOCTOR_AUTH }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'');
    expect(html).not.toMatch(/<script[^>]*src=["']https?:/);
  });
});
