import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DOCTOR_AUTH, makeApp } from "./helpers";

const served = async (path: string) => (await env.ASSETS.fetch(new Request(`https://furvet.test${path}`))).text();

// Minimal DOM stub for the served sim.js (same approach as ticket.test.ts): records the tree, throws on innerHTML.
type N = { tag: string; children: N[]; textContent: string; value: string; disabled: boolean; listeners: Record<string, (e: unknown) => unknown>; [k: string]: unknown };
const txt = (n: N) => n.children.map((c) => c.textContent).join("");
function dom() {
  const mk = (tag: string): N => {
    const n: N = {
      tag,
      children: [],
      textContent: "",
      value: "",
      disabled: false,
      listeners: {},
      appendChild(c: N) {
        n.children.push(c);
        return c;
      },
      replaceChildren() {
        n.children = [];
      },
      addEventListener(ev: string, fn: (e: unknown) => unknown) {
        n.listeners[ev] = fn;
      },
      focus() {},
    };
    Object.defineProperty(n, "innerHTML", {
      set() {
        throw new Error("innerHTML assigned");
      },
    });
    return n;
  };
  const byId: Record<string, N> = {};
  const document = {
    getElementById: (id: string) => (byId[id] ??= mk(id)),
    createElement: mk,
    createTextNode: (t: string) => ({ tag: "#text", children: [], textContent: t }),
    addEventListener() {},
    visibilityState: "visible",
  };
  return { document, byId };
}
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, direction: i % 2 ? "outbound" : "inbound", text: `m${i + 1}` }));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("frontend audit, lane C (public/* only)", () => {
  it("F1 (B1): a failed audio upload keeps the blob in memory and turns the button into «Reintentar envío»; the blob is dropped only after res.ok", async () => {
    const js = await served("/console.js");
    expect(js).toContain("async function upload(id, blob) {");
    expect(js).toContain("pending = { id, blob };");
    expect(js).toContain('$("recBtn").textContent = "Reintentar envío"; $("recBtn").disabled = false;');
    // The retry path comes BEFORE the microphone is asked for.
    expect(js.indexOf("if (pending) { await upload(pending.id, pending.blob); return; }")).toBeLessThan(js.indexOf("navigator.mediaDevices.getUserMedia"));
    // `pending = null` happens exactly once, after the !res.ok return.
    expect(js.match(/^ +pending = null;$/gm)).toHaveLength(1);
    expect(js.indexOf("    pending = null;")).toBeGreaterThan(js.indexOf("if (!res.ok) {\n      // The audio is still here"));
    // The stop handler no longer fetches by itself: one upload path.
    expect(js.match(/\/audio`, \{ method: "POST"/g)).toHaveLength(1);
    expect(js).toContain("} catch (e) {\n      res = { ok: false, status: 0 };");
  });

  it("F2 (M1): refresh() and renderDelivery() pin the consult id and drop a late answer for another consult; «Abrir consulta» is blocked while it loads", async () => {
    const js = await served("/console.js");
    expect(js).toContain("async function refresh() {\n    const id = consultId;\n    const { ok, data } = await api(`/${id}`);\n    if (id !== consultId) return;");
    expect(js).toContain("async function renderDelivery() {\n    const id = consultId;\n    const { ok, data } = await api(`/${id}/delivery`);\n    if (id !== consultId) return;");
    expect(js.match(/if \(id !== consultId\) return;/g)).toHaveLength(3); // refresh, renderDelivery, requestDraft
    expect(js).toContain('$("openBtn").disabled = true;');
    expect(js).toContain('} finally {\n      $("openBtn").disabled = false;\n    }');
  });

  it("F3 (M2): «Regenerar» asks before discarding hand edits, and a failed fill never repaints over them", async () => {
    const js = await served("/console.js");
    expect(js).toContain('$("soap").addEventListener("input", () => { edited = true; });');
    expect(js).toContain('if (edited && !confirm("Se perderá lo escrito a mano en el expediente. ¿Regenerar?")) return;');
    expect(js).toContain("if (ok || !edited) await refresh();");
    expect(js).not.toMatch(/\n\s*await refresh\(\); \/\/ renderDraft repaints/); // the old unconditional repaint
    expect(js).toContain("form.replaceChildren();\n    edited = false;"); // a fresh draft resets the flag
  });

  it("F4 (M5): the chat shows the real status on 503 and keeps the text in the box; on 200 the box is emptied and the thread re-read", async () => {
    const js = await served("/sim.js");
    const { document, byId } = dom();
    let chatStatus = 503;
    const fetch = async (url: string) => {
      if (url.endsWith("/chat")) return { ok: chatStatus === 200, status: chatStatus, json: async () => ({ reply: "Claro", escalated: false }) };
      return { ok: true, json: async () => ({ messages: chatStatus === 200 ? msgs(2) : [], consent: null, payment_pending: false }) };
    };
    new Function("document", "fetch", "localStorage", "setInterval", "clearInterval", js)(document, fetch, { getItem: () => "s", setItem() {} }, () => 0, () => {});
    await tick();
    const { form, text, status, log } = byId as Record<string, N>;
    const submit = form!.listeners as Record<string, (e: unknown) => Promise<void>>;
    text!.value = "Hola, quiero cita";
    await submit.submit!({ preventDefault() {} });
    await tick();
    expect(status!.textContent).toBe("No se pudo enviar (503). Intenta de nuevo.");
    expect(text!.value).toBe("Hola, quiero cita"); // nothing to retype
    expect(log!.children).toHaveLength(0); // no phantom bubble
    chatStatus = 200;
    await submit.submit!({ preventDefault() {} });
    await tick();
    expect(text!.value).toBe("");
    expect(status!.textContent).toBe("");
    expect(log!.children.map(txt)).toEqual(["m1", "m2"]); // painted from the server, once
  });

  it("F5 (M9): polling appends only the new messages; existing bubbles are the same nodes (no rebuild, no re-announce)", async () => {
    const js = await served("/sim.js");
    const { document, byId } = dom();
    let list = msgs(3);
    const fetch = async () => ({ ok: true, json: async () => ({ messages: list, consent: null, payment_pending: true }) });
    const loads: (() => void)[] = [];
    new Function("document", "fetch", "localStorage", "setInterval", "clearInterval", js)(document, fetch, { getItem: () => "s", setItem() {} }, (fn: () => void) => (loads.push(fn), 1), () => {});
    await tick();
    const log = byId.log!;
    expect(log.children).toHaveLength(3);
    const first = log.children[0];
    loads[0]!(); // the poll tick
    await tick();
    expect(log.children).toHaveLength(3); // same thread → nothing repainted
    expect(log.children[0]).toBe(first);
    list = msgs(4);
    loads[0]!();
    await tick();
    expect(log.children).toHaveLength(4);
    expect(log.children[0]).toBe(first);
    expect(txt(log.children[3]!)).toBe("m4");
  });

  it("F6: #status lives outside the cards; phone CSS for the exam grid and 44 px touch targets; the log is not a live region; paypal-return has no board link and no «confirmada»", async () => {
    const { app } = makeApp({});
    const html = await (await app.request("/console", { headers: DOCTOR_AUTH }, env)).text();
    const statusAt = html.indexOf('<div id="status" aria-live="polite"></div>');
    expect(statusAt).toBeGreaterThan(0);
    expect(statusAt).toBeLessThan(html.indexOf("<details")); // before the first card: visible whatever is folded or hidden
    expect(html.match(/id="status"/g)).toHaveLength(1);
    expect(html).toContain("@media (max-width: 639px) { .sys { grid-template-columns: 1fr 1fr; } .sys > span, .sys .field:last-child { grid-column: 1 / -1; } }");
    expect(html).toContain("@media (pointer: coarse) { .seg .who, button.link { min-height: 44px; padding: 10px 12px; } }");
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'; media-src \'self\' blob:; form-action \'none\'; base-uri \'none\'">'); // untouched
    const sim = await served("/sim.html");
    expect(sim).toContain('<div id="log" aria-label="Conversación"></div>');
    expect(sim).toContain('<p id="status" role="status"></p>');
    const ret = await served("/paypal-return.html");
    expect(ret).not.toContain("cobros");
    expect(ret).not.toContain("confirmada");
    expect(ret).toContain("la confirmación aparece en el chat");
    expect(ret).toContain('<a href="/sim.html">Volver al chat</a>');
  });
});
