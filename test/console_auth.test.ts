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

describe("console: automatic AI draft after transcription (encargo fix-movil ítem 1)", () => {
  it("AD1: console.js fires the draft once after a finished transcription, only through the shared requestDraft and only when the clinic may use the AI (pin on the served script; behaviour not measured in a browser)", async () => {
    const js = await (await env.ASSETS.fetch(new Request("https://furvet.test/console.js"))).text();
    expect(js).toContain("if (aiAllowed()) await requestDraft(id); else await refresh();"); // the automatic call, gated
    // Exactly three mentions: the definition, the automatic call, the button. Any extra call site (a loop, a retry) breaks this.
    expect(js.match(/requestDraft\(/g)).toHaveLength(3);
    expect(js).toContain('$("fillBtn").addEventListener("click", () => requestDraft(consultId));');
    expect(js).toContain("if (drafting) return;"); // never two drafts in flight
    // The client half of the gate: default closed, open only with an active subscription or the documented switch.
    expect(js).toContain('let subscription = { status: "none", required: true };');
    expect(js).toContain('const aiAllowed = () => !subscription.required || subscription.status === "active";');
  });
});

describe("console: collapsible cards for the phone (encargo fix-consola-secciones-plegables)", () => {
  it("CF1: every card is a <details open> whose title is its <summary><h2>; the recording state lives in the summary", async () => {
    const { app } = makeApp({});
    const html = await (await app.request("/console", { headers: DOCTOR_AUTH }, env)).text();
    const cards = html.match(/<details class="card[^>]*>/g) ?? [];
    expect(cards).toHaveLength(7);
    for (const tag of cards) expect(tag, tag).toMatch(/ open>$/); // desktop: everything open; the phone folds by script
    expect(html.match(/<summary><h2 id="h-[a-z]+">/g)).toHaveLength(7);
    expect(html).not.toContain("<section");
    expect(html).toMatch(/<summary><h2 id="h-rec">3\. Grabación<\/h2> <span><span class="rec" id="recDot"[^]*?<span id="timer">00:00<\/span><\/span><\/summary>/);
  });
  it("CF2: console.js folds only on a narrow screen, never on a desktop (pin on the served script; browser behaviour measured by hand)", async () => {
    const js = await (await env.ASSETS.fetch(new Request("https://furvet.test/console.js"))).text();
    expect(js).toContain('const narrow = matchMedia("(max-width: 639px)");');
    expect(js).toContain("if (!narrow.matches) return;");
    expect(js.match(/focusSection\(/g)).toHaveLength(3); // definition, initial card, the flow in refresh — nothing else moves the doctor around
    expect(js).not.toMatch(/recorder\.stop\(\)[^\n]*toggle|toggle[^\n]*recorder/); // folding never reaches the recorder
  });
});
