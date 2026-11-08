import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { approvedBody, assertNoPii, captureLogs, claudeToolFake, doctorEnv, doctorHeaders, makeApp, paypalFakes, seedConsult, uniqueOrderFake } from "./helpers";

const fakes = () => ({ ...paypalFakes({ captureValue: "881.00" }), ...uniqueOrderFake, ...claudeToolFake(["x"]) });
const raw = async (res: Response) => new TextDecoder("latin1").decode(await res.arrayBuffer());
const doc = (value: string) => ({ value, source: "doctor" });

describe("CALIF probe rx-legible", () => {
  it("rx.pdf is half letter 396x612, 1 page with 4 meds, only sizes 14/10.5/8, dose lines at 10.5; ticket stays A4; owner name not in logs", async () => {
    const seeded = await seedConsult();
    await env.DB.prepare("UPDATE contacts SET name = ?2 WHERE id = ?1").bind(seeded.conv, "Zutano Quirquincho").run();
    const { app } = makeApp(fakes());
    const body = approvedBody(seeded.ids);
    for (const n of ["bbb-omeprazol", "ccc-metronidazol", "ddd-meloxicam"]) body.prescription.push({ medicamento: doc(n), dosis: doc("10 mg"), frecuencia: doc("cada 24 h"), duracion: doc("5 días"), via_administracion: doc("oral"), indicaciones: doc("con alimento") });
    const logs = captureLogs();
    try {
      const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
      expect(res.status).toBe(201);
    } finally { logs.restore(); }
    assertNoPii(logs.lines);
    expect(logs.lines.join("\n")).not.toContain("Zutano");
    const rx = await raw(await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv()));
    console.log("PROBE rx MediaBox", [...new Set(rx.match(/\/MediaBox\s*\[[^\]]*\]/g))].join("|"), "Count", rx.match(/\/Count\s+(\d+)/)?.[1], "sizes", [...new Set([...rx.matchAll(/\/F\d\s+([\d.]+)\s+Tf/g)].map((m) => m[1]))].sort().join(","));
    expect(rx).toContain("/MediaBox [0 0 396 612]");
    expect(rx.match(/\/Count\s+(\d+)/)?.[1]).toBe("1");
    expect(rx).toContain("4. ddd-meloxicam");
    const sizes = new Set([...rx.matchAll(/\/F\d\s+([\d.]+)\s+Tf/g)].map((m) => m[1]));
    expect([...sizes].sort()).toEqual(["10.5", "14", "8"]);
    const dose = rx.match(/\/F1 ([\d.]+) Tf [^\n]*\(\s+250 mg/);
    expect(dose?.[1], "dose line size").toBe("10.5");
    // ticket.pdf has no doctor route (it is served at /t/<token>); read what approve.ts wrote to R2 to prove it stays A4.
    const bill = await env.DB.prepare("SELECT approval_id FROM consult_bills WHERE consult_id = ?1").bind(seeded.consult).first<{ approval_id: string }>();
    const tkObj = await env.FILES.get(`reports/${bill?.approval_id}/ticket.pdf`);
    const tk = new TextDecoder("latin1").decode(await (tkObj as R2ObjectBody).arrayBuffer());
    expect(tk).toContain("/MediaBox [0 0 595 842]");
    expect(rx).not.toContain("Visitante");
  });

  it("cols escapes parentheses in patient fields (breed with parens survives the content stream)", async () => {
    const seeded = await seedConsult();
    await env.DB.prepare("UPDATE pets SET breed = ?2 WHERE contact_id = ?1").bind(seeded.conv, "cruza (mediana)").run();
    const { app } = makeApp(fakes());
    const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(approvedBody(seeded.ids)) }, doctorEnv());
    expect(res.status).toBe(201);
    const rx = new TextDecoder("latin1").decode(await (await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv())).arrayBuffer());
    expect(rx).toContain("Raza: cruza \\(mediana\\)"); // parens escaped in the PDF literal
  });

});
