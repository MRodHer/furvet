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

  it("security headers are present", async () => {
    const { app } = makeApp({});
    const res = await app.request("/health", {}, env);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
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
