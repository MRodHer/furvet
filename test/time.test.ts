import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { executeTool, type ToolContext } from "../src/agent/tools";
import { makePayPal } from "../src/paypal";
import { formatClinicTime } from "../src/time";
import { fakeFetch, NOW, paypalFakes, seedBooking } from "./helpers";

describe("clinic time (one zone for chat, console and owner texts)", () => {
  it("formats an instant in America/Mexico_City, never UTC: 16:00Z is 10:00 a.m.", () => {
    const label = formatClinicTime("2026-11-05T16:00:00Z");
    expect(label).toMatch(/5 nov/);
    expect(label).toMatch(/10:00/);
    expect(label).not.toMatch(/16:00|4:00/);
    // 02:30Z of the 6th is still the evening of the 5th in the clinic.
    expect(formatClinicTime("2026-11-06T02:30:00Z")).toMatch(/5 nov.*8:30/);
  });

  it("list_slots hands the model the clinic-local label (what the owner reads), not the UTC instant", async () => {
    const { conv } = await seedBooking();
    const slot = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO slots (id, starts_at) VALUES (?1, '2026-11-05T16:30:00.000Z')").bind(slot).run();
    const ff = fakeFetch(paypalFakes());
    const ctx: ToolContext = { env, deps: { fetch: ff.fetchImpl, now: () => NOW }, paypal: makePayPal(ff.fetchImpl, { clientId: "id", clientSecret: "s" }), conversationId: conv, contactId: conv };
    const out = await executeTool(ctx, "list_slots", {});
    expect(out).toContain(slot);
    expect(out).toMatch(/5 nov 2026, 10:30/);
    expect(out).not.toContain("16:30");
    expect(out).not.toContain("2026-11-05T");
  });
});
