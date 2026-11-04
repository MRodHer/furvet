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

describe("V18-C: bill snapshot is append-only", () => {
  it("UPDATE/DELETE on consult_bills and bill_lines → append-only", async () => {
    const consult = crypto.randomUUID();
    const item = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO catalog_items (id, sku, name, category, price_cents) VALUES (?1, ?1, 'x', 'otro', 100)").bind(item),
      env.DB.prepare("INSERT INTO consult_bills (consult_id, approval_id, total_cents, deposit_cents, balance_cents, approved_by, explanation, explanation_source) VALUES (?1, ?2, 100, 0, 100, 'val', 'x', 'template')").bind(consult, crypto.randomUUID()),
      env.DB.prepare("INSERT INTO bill_lines (consult_id, catalog_item_id, name, quantity, unit_price_cents, line_total_cents, source) VALUES (?1, ?2, 'x', 1, 100, 100, 'doctor_added')").bind(consult, item),
    ]);
    for (const sql of [
      "UPDATE consult_bills SET balance_cents = 0 WHERE consult_id = ?1",
      "DELETE FROM consult_bills WHERE consult_id = ?1",
      "UPDATE bill_lines SET unit_price_cents = 1 WHERE consult_id = ?1",
      "DELETE FROM bill_lines WHERE consult_id = ?1",
    ]) {
      await expect(env.DB.prepare(sql).bind(consult).run()).rejects.toThrow(/append-only/);
    }
    // And the CHECK keeps the arithmetic honest even for a direct writer.
    await expect(
      env.DB.prepare("INSERT INTO bill_lines (consult_id, catalog_item_id, name, quantity, unit_price_cents, line_total_cents, source) VALUES (?1, ?2, 'x', 2, 100, 100, 'doctor_added')").bind(consult, item).run(),
    ).rejects.toThrow(/CHECK/);
  });
});
