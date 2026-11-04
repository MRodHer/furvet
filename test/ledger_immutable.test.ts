import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimCharge } from "../src/ledger";
import { seedBooking } from "./helpers";

describe("ledger is append-only (E10 / V18 — real D1 triggers)", () => {
  async function seededCharge() {
    const { appt, conv } = await seedBooking();
    const id = crypto.randomUUID();
    const ok = await claimCharge(
      env.DB,
      { id, kind: "deposit", appointmentId: appt, conversationId: conv, paypalOrderId: `ORD-${id}`, paypalRequestId: `deposit-${appt}`, amountCents: 20000, currency: "MXN", approveUrl: "https://www.sandbox.paypal.com/x" },
      { fake: true },
    );
    expect(ok).toBe(true);
    return id;
  }

  it("UPDATE on charges is refused", async () => {
    const id = await seededCharge();
    await expect(env.DB.prepare("UPDATE charges SET amount_cents = 1 WHERE id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
  });

  it("DELETE on charges is refused", async () => {
    const id = await seededCharge();
    await expect(env.DB.prepare("DELETE FROM charges WHERE id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
  });

  it("UPDATE / DELETE on charge_events are refused", async () => {
    const id = await seededCharge();
    await expect(env.DB.prepare("UPDATE charge_events SET status = 'captured' WHERE charge_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM charge_events WHERE charge_id = ?1").bind(id).run()).rejects.toThrow(/append-only/);
  });

  it("claimCharge is a one-row claim: the second claim for the same appointment inserts nothing", async () => {
    const { appt, conv } = await seedBooking();
    const base = { kind: "deposit" as const, appointmentId: appt, conversationId: conv, paypalRequestId: `deposit-${appt}`, amountCents: 20000, currency: "MXN", approveUrl: "https://www.sandbox.paypal.com/x" };
    expect(await claimCharge(env.DB, { ...base, id: crypto.randomUUID(), paypalOrderId: "ORD-1" }, {})).toBe(true);
    expect(await claimCharge(env.DB, { ...base, id: crypto.randomUUID(), paypalOrderId: "ORD-2" }, {})).toBe(false);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM charges WHERE appointment_id = ?1").bind(appt).first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM charge_events WHERE charge_id IN (SELECT id FROM charges WHERE appointment_id = ?1)").bind(appt).first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("a deposit charge must point at an appointment and a balance at a consult (CHECKs)", async () => {
    await expect(
      env.DB.prepare("INSERT INTO charges (id, kind, paypal_request_id, amount_cents, currency) VALUES ('x', 'deposit', 'r', 100, 'MXN')").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("INSERT INTO charges (id, kind, consult_id, paypal_request_id, amount_cents, currency) VALUES ('y', 'balance', 'c1', 'r2', 0, 'MXN')").run(),
    ).rejects.toThrow();
  });
});
