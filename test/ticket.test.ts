import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
    // Minimal DOM stub: records the tree, throws on innerHTML.
    type N = { tag: string; children: N[]; textContent: string; [k: string]: unknown };
    const mk = (tag: string): N => {
      const n: N = {
        tag,
        children: [],
        textContent: "",
        value: "",
        appendChild(c: N) {
          n.children.push(c);
          return c;
        },
        replaceChildren() {
          n.children = [];
        },
        addEventListener() {},
        focus() {},
      };
      Object.defineProperty(n, "innerHTML", {
        set() {
          throw new Error("innerHTML assigned");
        },
      });
      return n;
    };
    const log = mk("div");
    const byId: Record<string, N> = { log };
    const document = {
      getElementById: (id: string) => (byId[id] ??= mk(id)),
      createElement: mk,
      createTextNode: (t: string) => ({ tag: "#text", children: [], textContent: t }),
      addEventListener() {},
      visibilityState: "visible",
    };
    const payload = `${F}\nConsulta <script>alert(1)</script>\n  1 x $1.00               $1.00\n${F}\nTicket en PDF: https://furvet.test/t/x`;
    const fetch = async () => ({ ok: true, json: async () => ({ messages: [{ direction: "outbound", text: payload }], consent: null, payment_pending: false }) });
    const localStorage = { getItem: () => "s", setItem() {} };
    new Function("document", "fetch", "localStorage", "setInterval", "clearInterval", js)(document, fetch, localStorage, () => 0, () => {});
    await new Promise((r) => setTimeout(r, 0)); // load(): fetch → json → render
    expect(log.children).toHaveLength(1);
    const msg = log.children[0]!;
    const pre = msg.children.filter((c) => c.tag === "pre");
    expect(pre).toHaveLength(1);
    expect(pre[0]!.textContent).toBe("Consulta <script>alert(1)</script>\n  1 x $1.00               $1.00");
    expect(msg.children.some((c) => c.tag === "script")).toBe(false);
    // Everything else is text nodes: no anchor for a non-PayPal URL, no element from the payload.
    expect(msg.children.filter((c) => c.tag !== "#text").map((c) => c.tag)).toEqual(["pre"]);
  });
});
