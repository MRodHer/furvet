import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { domStub } from "./helpers";
import type { Bill } from "../src/billing";
import { buildPdf } from "../src/reports/pdf";
import { TICKET_COLS, ticketBlocks, ticketChat, ticketLines, ticketPage } from "../src/reports/render";

// Demo data from the encargo (no real names, no real prices).
const bill: Bill = {
  lines: [
    { catalogItemId: "c1", name: "Consulta general", quantity: 1, unitPriceCents: 50000, lineTotalCents: 50000, source: "doctor_added" },
    { catalogItemId: "c2", name: "Clindamicina 220 mg (tableta)", quantity: 7, unitPriceCents: 2000, lineTotalCents: 14000, source: "ai_detected" },
    { catalogItemId: "c3", name: "Meloxicam 1 mg (tableta)", quantity: 3, unitPriceCents: 1600, lineTotalCents: 4800, source: "ai_detected" },
  ],
  totalCents: 68800,
  depositCents: 20000,
  balanceCents: 48800,
};
const head = { clinicName: "FURVET DEMO CLINIC", petName: "Jack", date: "2026-11-07T18:00:00.000Z" };
const F = "```";

describe("32-column ticket (one formatter for chat and PDF)", () => {
  it("prints the encargo example EXACTLY: centered header, rules, name line + aligned amount line, Total / Anticipo / SALDO, currency", () => {
    expect(ticketLines(bill, "MXN", head)).toEqual([
      "       FURVET DEMO CLINIC",
      "    Ticket 07/11/2026 · Jack",
      "--------------------------------",
      "Consulta general",
      "  1 x $500.00            $500.00",
      "Clindamicina 220 mg (tableta)",
      "  7 x $20.00             $140.00",
      "Meloxicam 1 mg (tableta)",
      "  3 x $16.00              $48.00",
      "--------------------------------",
      "Total                    $688.00",
      "Anticipo                -$200.00",
      "SALDO                    $488.00",
      "MXN",
    ]);
  });

  it("every line is ≤ 32 columns and every amount ends exactly at column 32", () => {
    const lines = ticketLines(bill, "MXN", head);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(TICKET_COLS);
    const amounts = lines.filter((l) => /-?\$\d+\.\d\d$/.test(l));
    expect(amounts).toHaveLength(6); // 3 concepts + Total + Anticipo + SALDO
    for (const l of amounts) expect(l.length, l).toBe(TICKET_COLS);
  });

  it("a 61-char concept wraps onto two lines without touching the amount columns; a zero deposit has no «Anticipo» line", () => {
    const long = "Suspensión antibiótica de amplio espectro sabor pollo 250 ml.";
    expect(long.length).toBe(61);
    const b: Bill = { lines: [{ ...bill.lines[0]!, name: long, quantity: 2, unitPriceCents: 12345, lineTotalCents: 24690 }], totalCents: 24690, depositCents: 0, balanceCents: 24690 };
    const lines = ticketLines(b, "MXN", head);
    const i = lines.indexOf("Suspensión antibiótica de amplio"); // exactly 32
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe("espectro sabor pollo 250 ml.");
    expect(lines[i + 2]).toBe("  2 x $123.45            $246.90");
    expect(lines.some((l) => l.startsWith("Anticipo"))).toBe(false);
    // A 40-char word without spaces is split at 32 (wrapText never breaks words on its own); 120-char names keep all 4 lines.
    const word = "Suspensionantibioticaamplioespectro250ml";
    expect(word.length).toBe(40);
    const w = ticketLines({ ...b, lines: [{ ...b.lines[0]!, name: word }] }, "MXN", head);
    expect(w).toContain("Suspensionantibioticaamplioespec");
    expect(w).toContain("tro250ml");
    const name120 = Array.from({ length: 15 }, () => "palabra").join(" ") + " fin";
    expect(name120.length).toBe(123);
    const long120 = name120.slice(0, 120);
    const n = ticketLines({ ...b, lines: [{ ...b.lines[0]!, name: long120 }] }, "MXN", head);
    expect(n.join(" ").includes("…")).toBe(false);
    for (const l of [...w, ...n]) expect(l.length, l).toBeLessThanOrEqual(TICKET_COLS);
    expect(lines.at(-2)).toBe("SALDO                    $246.90");
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(TICKET_COLS);
  });

  it("the chat block is the same strings fenced; the PDF writes the same strings in Courier with parentheses escaped, on a 226 pt strip", () => {
    const lines = ticketLines(bill, "MXN", head);
    expect(ticketChat(bill, "MXN", head)).toEqual([F, ...lines, F]);
    const blocks = ticketBlocks({ clinicName: head.clinicName, doctorName: "x", licenseLabel: "x", petName: head.petName, species: "perro", folio: "F", approvedAt: head.date }, bill, "MXN");
    const page = ticketPage(blocks);
    expect(page.w).toBe(226);
    const pdf = new TextDecoder("latin1").decode(buildPdf(blocks, page));
    expect(pdf).toContain("/BaseFont /Courier");
    expect(pdf).toContain(`/MediaBox [0 0 226 ${page.h}]`);
    expect(pdf).toContain("/Count 1");
    expect(pdf).toContain("/F3 9 Tf");
    expect(pdf).toContain("(Clindamicina 220 mg \\(tableta\\)) Tj");
    expect(pdf).toContain("(  7 x $20.00             $140.00) Tj");
    expect(pdf).toContain("no es un comprobante fiscal");
  });
});

describe("sim.js renders fenced blocks as <pre> through textContent", () => {
  it("a <script> inside a concept name stays inert text inside the <pre>; innerHTML is never assigned", async () => {
    const js = await (await env.ASSETS.fetch(new Request("https://furvet.test/sim.js"))).text();
    expect(js).not.toContain("innerHTML");
    expect(js).toContain('const pre = document.createElement("pre");');
    expect(js).toContain("pre.textContent = chunk;");
    const { document, byId } = domStub(); // records the tree, throws on innerHTML
    const payload = `${F}\nConsulta <script>alert(1)</script>\n  1 x $1.00               $1.00\n${F}\nTicket en PDF: https://furvet.test/t/x`;
    const fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 1, direction: "outbound", text: payload }], consent: null, payment_pending: false }) });
    const localStorage = { getItem: () => "s", setItem() {} };
    new Function("document", "fetch", "localStorage", "setInterval", "clearInterval", js)(document, fetch, localStorage, () => 0, () => {});
    await new Promise((r) => setTimeout(r, 0)); // load(): fetch → json → render
    const log = byId.log!;
    expect(log.children).toHaveLength(1);
    const msg = log.children[0]!;
    const pre = msg.children.filter((c) => c.tag === "pre");
    expect(pre).toHaveLength(1);
    expect(pre[0]!.textContent).toBe("Consulta <script>alert(1)</script>\n  1 x $1.00               $1.00");
    expect(msg.children.some((c) => c.tag === "script")).toBe(false);
    // Everything else is text nodes: no anchor for a non-PayPal URL, no element from the payload.
    expect(msg.children.filter((c) => c.tag !== "#text").map((c) => c.tag)).toEqual(["pre"]);
  });

  it("T7-bis: the pay link's href is EXACTLY the approve URL (the sentence after it starts a new line, so no «.» is glued on)", async () => {
    const js = await (await env.ASSETS.fetch(new Request("https://furvet.test/sim.js"))).text();
    type N = { tag: string; children: N[]; textContent: string; href?: string; [k: string]: unknown };
    const mk = (tag: string): N => ({ tag, children: [], textContent: "", value: "", appendChild(c: N) { (this as N).children.push(c); return c; }, replaceChildren() { (this as N).children = []; }, addEventListener() {}, focus() {} });
    const log = mk("div");
    const byId: Record<string, N> = { log };
    const document = { getElementById: (id: string) => (byId[id] ??= mk(id)), createElement: mk, createTextNode: (t: string) => ({ tag: "#text", children: [], textContent: t }), addEventListener() {}, visibilityState: "visible" };
    const url = "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T";
    // The exact shape /charge writes: ticket, /t link, pay line ending with the URL, then the sentence on its own line.
    const text = `${F}\nSALDO                    $488.00\nMXN\n${F}\nTicket en PDF: https://furvet.test/t/x\nPagar saldo ($488.00 MXN): ${url}\nAl pagar recibirás el informe completo.`;
    const fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 1, direction: "outbound", text }], consent: null, payment_pending: true }) });
    new Function("document", "fetch", "localStorage", "setInterval", "clearInterval", js)(document, fetch, { getItem: () => "s", setItem() {} }, () => 0, () => {});
    await new Promise((r) => setTimeout(r, 0));
    const anchors = log.children[0]!.children.filter((c) => c.tag === "a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.href).toBe(url);
    expect(anchors[0]!.textContent).toBe("Pagar con PayPal (sandbox)");
  });
});
