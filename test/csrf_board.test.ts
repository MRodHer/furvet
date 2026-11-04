// H1 (board behind the doctor's credential) and H2 (CSRF guard on doctor writes) — closes
// encargos/audit-furvet-seguridad.md; probes A-1 and A-7 of the audit, inverted.
import { describe, expect, it } from "vitest";
import { approvedBody, claudeToolFake, count, depositCaptured, doctorEnv, doctorHeaders, fakeJpeg, makeApp, multipart, paypalFakes, seedConsult, uniqueOrderFake, withEnv } from "./helpers";

const fakes = () => ({ ...paypalFakes(), ...uniqueOrderFake, ...claudeToolFake(["Resumen sencillo."]) });
const JSON_H = { "Content-Type": "application/json" };
const msgs = (conv: string) => count("messages", "conversation_id = ?1", conv);

async function approved() {
  const s = await seedConsult();
  await depositCaptured(s.appt, 20000);
  const made = makeApp(fakes());
  const body = approvedBody(s.ids, { billable: [{ catalog_item_id: s.ids["MED-AMOXI"], quantity: { value: 2, source: "doctor" } }] });
  body.prescription[0] = { ...body.prescription[0], catalog_item_id: undefined };
  expect((await made.app.request(`/api/v1/consults/${s.consult}/approve`, { method: "POST", headers: doctorHeaders(JSON_H), body: JSON.stringify(body) }, doctorEnv())).status).toBe(201);
  return { ...s, ...made };
}

describe("H1: the ledger board is clinic data (doctor credential, fail-closed)", () => {
  const BOARD = ["/cobros", "/cobros.html", "/api/v1/charges", "/api/v1/charges/x/events"];

  it("no credential → 401; wrong credential → 401; unconfigured secrets → 503; right credential → 200", async () => {
    const { app } = makeApp(fakes());
    for (const path of BOARD) {
      expect((await app.request(path, {}, doctorEnv())).status, path).toBe(401);
      expect((await app.request(path, { headers: { Authorization: `Basic ${btoa("val:wrong")}` } }, doctorEnv())).status, path).toBe(401);
      expect((await app.request(path, { headers: doctorHeaders() }, withEnv({ DOCTOR_DEMO_USER: "val", DOCTOR_DEMO_PASSWORD: "" }))).status, path).toBe(503);
      expect((await app.request(path, { headers: doctorHeaders() }, doctorEnv())).status, path).toBe(200);
    }
    expect(await (await app.request("/cobros", { headers: doctorHeaders() }, doctorEnv())).text()).toContain("/cobros.js");
  });

  it("the public surface never carries pay links or ledger ids: /health", async () => {
    const t = await approved();
    expect((await t.app.request(`/api/v1/consults/${t.consult}/charge`, { method: "POST", headers: doctorHeaders() }, doctorEnv())).status).toBe(201);
    const health = JSON.stringify(await (await t.app.request("/health", {}, doctorEnv())).json());
    expect(health).not.toMatch(/paypal\.com|ORDER-|approve_url|consult_id|appointment_id/);
  });
});

describe("H2: doctor writes refuse cross-site requests and form-encodable bodies", () => {
  it("cross-site form POST with the cached credential → 403 on charge/approve/send-explanation/images; nothing written, nobody called", async () => {
    const t = await approved();
    const s2 = await seedConsult();
    const before = await msgs(t.conv);
    const calls0 = t.calls.length;
    const cross = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    const form = { "Content-Type": "application/x-www-form-urlencoded", ...cross };
    expect((await t.app.request(`/api/v1/consults/${t.consult}/charge`, { method: "POST", headers: doctorHeaders(form), body: "x=1" }, doctorEnv())).status).toBe(403);
    expect((await t.app.request(`/api/v1/consults/${t.consult}/send-explanation`, { method: "POST", headers: doctorHeaders(form), body: "x=1" }, doctorEnv())).status).toBe(403);
    expect((await t.app.request(`/api/v1/consults/${s2.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "text/plain", ...cross }), body: `${JSON.stringify(approvedBody(s2.ids))}\r\n` }, doctorEnv())).status).toBe(403);
    // multipart is what /images needs, so only the origin guard stops a cross-site multipart form.
    expect((await t.app.request(`/api/v1/consults/${s2.consult}/images`, { method: "POST", headers: doctorHeaders(cross), body: multipart(fakeJpeg(), "a.jpg") }, doctorEnv())).status).toBe(403);
    expect(await msgs(t.conv)).toBe(before);
    expect(await count("charges", "consult_id = ?1", t.consult)).toBe(0);
    expect(await count("consult_bills", "consult_id = ?1", s2.consult)).toBe(0);
    expect(await count("report_images", "consult_id = ?1", s2.consult)).toBe(0);
    expect(t.calls.length).toBe(calls0);
  });

  it("denies on error: unknown Sec-Fetch-Site, same-site, Origin null or another port → 403; same-origin or none → passes the guard", async () => {
    const t = await approved();
    const url = `/api/v1/consults/${t.consult}/delivery`; // GET: never guarded
    expect((await t.app.request(url, { headers: doctorHeaders({ "Sec-Fetch-Site": "cross-site" }) }, doctorEnv())).status).toBe(200);
    const post = (h: Record<string, string>) => t.app.request(`/api/v1/consults/${t.consult}/send-explanation`, { method: "POST", headers: doctorHeaders(h) }, doctorEnv());
    const denied: Record<string, string>[] = [{ "Sec-Fetch-Site": "garbage" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "null" }, { Origin: "http://localhost:8787" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }];
    for (const h of denied) {
      expect((await post(h)).status, JSON.stringify(h)).toBe(403);
    }
    expect(await count("explanation_releases", "consult_id = ?1", t.consult)).toBe(0);
    // Same-origin browser request (what console.js sends) and a direct navigation pass the guard: 201 = the route ran.
    expect((await post({ "Sec-Fetch-Site": "same-origin", Origin: "http://localhost", ...JSON_H })).status).toBe(201);
  });

  it("body type: text/plain or urlencoded → 415 even same-origin; missing Content-Type with a body → 415; JSON/audio/multipart or no body → the route runs", async () => {
    const t = await approved();
    const s2 = await seedConsult();
    const approve = (h: Record<string, string>) => t.app.request(`/api/v1/consults/${s2.consult}/approve`, { method: "POST", headers: doctorHeaders(h), body: JSON.stringify(approvedBody(s2.ids)) }, doctorEnv());
    const bad: Record<string, string>[] = [{ "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }, { "Content-Type": "application/xml" }, {}];
    for (const h of bad) {
      expect((await approve({ "Sec-Fetch-Site": "same-origin", ...h })).status, JSON.stringify(h)).toBe(415);
    }
    expect(await count("consult_bills", "consult_id = ?1", s2.consult)).toBe(0);
    expect((await approve(JSON_H)).status).toBe(201);
    // No body and no Content-Type (curl, the console's bodyless POSTs): allowed.
    expect((await t.app.request(`/api/v1/consults/${s2.consult}/charge`, { method: "POST", headers: doctorHeaders() }, doctorEnv())).status).toBe(201);
    // audio/* reaches the route (409: this consult is past recording — the guard let it through).
    expect((await t.app.request(`/api/v1/consults/${s2.consult}/audio`, { method: "POST", headers: doctorHeaders({ "Content-Type": "audio/webm" }), body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) }, doctorEnv({ AI: { run: async () => ({ text: "" }) } as unknown as Ai }))).status).toBe(409);
  });
});
