import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DOCTOR_AUTH, makeApp, paypalFakes, seedBooking, withEnv } from "./helpers";

describe("app-level guards and board", () => {
  it("PAYPAL_ENV other than sandbox → every request is 503", async () => {
    const { app } = makeApp({});
    const res = await app.request("/health", {}, withEnv({ PAYPAL_ENV: "live" }));
    expect(res.status).toBe(503);
  });

  it("/health reports an unpriced catalog as 503 and a priced one as 200", async () => {
    const { app } = makeApp({});
    await env.DB.prepare("INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, 'CONSULTA-GENERAL', 'Consulta', 'consulta', 0) ON CONFLICT(sku) DO UPDATE SET price_cents = 0").bind(crypto.randomUUID()).run();
    expect((await app.request("/health", {}, env)).status).toBe(503);
    await env.DB.prepare("UPDATE catalog_items SET price_cents = 45000 WHERE sku = 'CONSULTA-GENERAL'").run();
    const ok = await app.request("/health", {}, env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, paypal_env: "sandbox", paypal_configured: true, catalog_unpriced: false });
  });

  // Pentest M1/M2: a Hono route and a static asset carry the SAME security headers, CSP as a header included.
  it("security headers, identical on a Hono response and on a static asset (M1), with a CSP header (M2)", async () => {
    const { app } = makeApp({});
    const EXPECTED = {
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=15552000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    for (const path of ["/health", "/sim.js", "/sim"]) {
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(200);
      for (const [h, v] of Object.entries(EXPECTED)) expect(res.headers.get(h), `${path} ${h}`).toBe(v);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).toContain("script-src 'self' https://cdn.jsdelivr.net");
    }
    expect(await (await app.request("/sim.js", {}, env)).text()).toContain("furvet.session");
    // Unknown paths stay 404; a write to an unknown path never reaches the asset worker.
    expect((await app.request("/nope", {}, env)).status).toBe(404);
    expect((await app.request("/api/v1/sim/chat", { method: "DELETE" }, env)).status).toBe(404);
  });

  it("board exposes amounts as strings and no raw payloads or payer data", async () => {
    const { appt, conv } = await seedBooking();
    const { claimCharge } = await import("../src/ledger");
    const id = crypto.randomUUID();
    await claimCharge(env.DB, { id, kind: "deposit", appointmentId: appt, conversationId: conv, paypalOrderId: `O-${id}`, paypalRequestId: `deposit-${appt}`, amountCents: 20000, currency: "MXN", approveUrl: "https://www.sandbox.paypal.com/x" }, { payer: { email_address: "x@example.com" } });
    const { app } = makeApp(paypalFakes());
    const list = await (await app.request("/api/v1/charges", { headers: DOCTOR_AUTH }, env)).json<Record<string, unknown>[]>();
    const row = list.find((r) => r.id === id);
    expect(row).toMatchObject({ id, kind: "deposit", amount: "200.00", currency: "MXN", status: "created" });
    expect(JSON.stringify(list)).not.toMatch(/raw|payer|@/);
    const events = await (await app.request(`/api/v1/charges/${id}/events`, { headers: DOCTOR_AUTH }, env)).json<Record<string, unknown>[]>();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "created", amount: "200.00" });
    expect(JSON.stringify(events)).not.toMatch(/raw|payer|@/);
  });
});
