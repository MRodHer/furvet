import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { approvedBody, assertNoPii, captureLogs, claudeToolFake, doctorEnv, doctorHeaders, makeApp, paypalFakes, seedConsult, uniqueOrderFake } from "./helpers";

const fakes = () => ({ ...paypalFakes({ captureValue: "881.00" }), ...uniqueOrderFake, ...claudeToolFake(["x"]) });
const raw = async (res: Response) => new TextDecoder("latin1").decode(await res.arrayBuffer());
const doc = (value: string) => ({ value, source: "doctor" });
const med = (medicamento: string, concentracion: string, forma_farmaceutica: string, dosis: string, frecuencia: string, duracion: string) => ({
  medicamento: doc(medicamento), concentracion: doc(concentracion), forma_farmaceutica: doc(forma_farmaceutica), dosis: doc(dosis), frecuencia: doc(frecuencia), duracion: doc(duracion), via_administracion: doc("oral"),
});
// Logical text of the PDF: the content of each `(...) Tj` literal, unescaped and de-indented, joined with a
// space so a sentence the narrow page wrapped across two literals reads back as one (wrapText breaks on spaces).
const flatten = (rawPdf: string) => [...rawPdf.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)].map((m) => (m[1] ?? "").replace(/\\([()\\])/g, "$1").trim()).join(" ");

describe("CALIF probe rx-vet-format (Val's usos-y-costumbres layout)", () => {
  it("each med prints «N. nombre (concentración) - forma - uso veterinario» + «Administrar …» sentence, food legend only for antibiotics/NSAIDs; half letter 396x612, 4 meds on ONE page, sizes 14/10.5/8; owner name not in logs", async () => {
    const seeded = await seedConsult();
    await env.DB.prepare("UPDATE contacts SET name = ?2 WHERE id = ?1").bind(seeded.conv, "Zutano Quirquincho").run();
    const { app } = makeApp(fakes());
    const body = approvedBody(seeded.ids);
    body.prescription = [
      med("Clindamicina", "220 mg", "tableta", "media tableta", "cada 24 horas", "7 días"),
      med("Meloxicam", "1 mg", "tableta", "una tableta", "cada 24 horas", "3 días"),
      med("Omeprazol", "10 mg", "capsula", "una cápsula", "cada 24 horas", "10 días"), // not an antibiotic/NSAID → NO food legend
      med("Enrofloxacina", "50 mg", "tableta", "una tableta", "cada 24 horas", "5 días"),
    ];
    const logs = captureLogs();
    try {
      const res = await app.request(`/api/v1/consults/${seeded.consult}/approve`, { method: "POST", headers: doctorHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }, doctorEnv());
      expect(res.status).toBe(201);
    } finally {
      logs.restore();
    }
    assertNoPii(logs.lines);
    expect(logs.lines.join("\n")).not.toContain("Zutano");
    const rx = await raw(await app.request(`/api/v1/consults/${seeded.consult}/rx.pdf`, { headers: doctorHeaders() }, doctorEnv()));
    console.log("PROBE rx MediaBox", [...new Set(rx.match(/\/MediaBox\s*\[[^\]]*\]/g))].join("|"), "Count", rx.match(/\/Count\s+(\d+)/)?.[1], "sizes", [...new Set([...rx.matchAll(/\/F\d\s+([\d.]+)\s+Tf/g)].map((m) => m[1]))].sort().join(","));
    expect(rx).toContain("/MediaBox [0 0 396 612]");
    expect(rx.match(/\/Count\s+(\d+)/)?.[1], "4 meds must fit on one half-letter page").toBe("1");
    const sizes = new Set([...rx.matchAll(/\/F\d\s+([\d.]+)\s+Tf/g)].map((m) => m[1]));
    expect([...sizes].sort(), "only three font sizes").toEqual(["10.5", "14", "8"]);

    const flat = flatten(rx);
    // Val's exact format: concentration in parens by the name, dose-per-take in the «Administrar» sentence.
    expect(flat).toContain("1. Clindamicina (220 mg) - tabletas - uso veterinario");
    expect(flat).toContain("Administrar vía oral media tableta cada 24 horas durante 7 días.");
    expect(flat).toContain("2. Meloxicam (1 mg) - tabletas - uso veterinario");
    expect(flat).toContain("Administrar vía oral una tableta cada 24 horas durante 3 días.");
    expect(flat).toContain("4. Enrofloxacina (50 mg) - tabletas - uso veterinario");
    // Food legend ONLY for the three classified drugs (clindamicina, meloxicam, enrofloxacina), NEVER omeprazol.
    expect((flat.match(/Con o después de alimentos\./g) ?? []).length, "legend on the 3 classified drugs only").toBe(3);
    expect(flat).toContain("3. Omeprazol (10 mg) - cápsulas - uso veterinario");
    expect(flat).not.toContain("Rp/"); // the «Rp/» header was removed by the doctor's request
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
