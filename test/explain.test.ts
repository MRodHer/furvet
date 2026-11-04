import { describe, expect, it } from "vitest";
import { ApprovedConsult } from "../src/clinical/schema";
import { approvedValues, explanationViolations, plainExplanation } from "../src/reports/explain";
import { approvedBody, claudeToolFake, fakeFetch, PP } from "./helpers";

const ids = { "MED-AMOXI": "m", "VAC-RABIA": "v" };
const body = ApprovedConsult.parse(approvedBody(ids));

describe("plain explanation (V14, V8)", () => {
  it("validator: numbers and doses must exist in the approved JSON", () => {
    const facts = approvedValues(body);
    expect(explanationViolations("Firulais tiene 39.5 grados; amoxicilina 250 mg cada 12 h por 7 días.", facts)).toBeNull();
    expect(explanationViolations("Dele 20 mg cada 8 horas.", facts)).toEqual(["20", "8", "20 mg", "cada 8 horas"]);
    expect(explanationViolations("dieta blanda 3 días", facts)).toBeNull(); // from the approved plan
    expect(explanationViolations("Pesa 12,4 kg", facts)).toBeNull(); // comma decimal normalised
    // M4: swapped frequency/duration, a dose that is only a substring, a drug that was never prescribed
    expect(explanationViolations("amoxicilina 250 mg cada 7 h por 12 días", facts)).toEqual(["cada 7 h", "12 días"]);
    expect(explanationViolations("tome 50 mg", facts)).toEqual(["50", "50 mg"]);
    expect(explanationViolations("también metronidazol como indicó", facts)).toEqual(["metronidazol"]);
    expect(JSON.stringify(facts)).not.toContain("catalog_item_id");
    // Length cap: the stored column is bounded, so an over-long text is a violation (→ retry → template).
    expect(explanationViolations("bien. ".repeat(260), facts)).toEqual(["too_long"]);
    expect(explanationViolations("bien. ".repeat(240), facts)).toBeNull();
  });

  it("V14: an invented dose → one retry → still bad → fixed template without AI (exactly 2 calls)", async () => {
    const ff = fakeFetch(claudeToolFake(["Dele 20 mg de amoxicilina.", "Dele 500 mg de amoxicilina."]));
    const out = await plainExplanation(ff.fetchImpl, "sk-test", body, "c1");
    expect(ff.count(PP.claude)).toBe(2);
    expect(out.source).toBe("template");
    expect(out.text).toContain("gastroenteritis leve");
    expect(out.text).toContain("amoxicilina, 250 mg, cada 12 h, 7 días");
    expect(explanationViolations(out.text, approvedValues(body))).toBeNull();
  });

  it("a grounded answer on the retry is accepted; the first bad text is sent back as context", async () => {
    const ff = fakeFetch(claudeToolFake(["Dele 20 mg.", "Su perro tiene gastroenteritis leve; amoxicilina 250 mg cada 12 h por 7 días."]));
    const out = await plainExplanation(ff.fetchImpl, "sk-test", body, "c1");
    expect(out.source).toBe("ai");
    expect(JSON.parse(ff.calls[1]!.body).messages).toHaveLength(3);
  });

  it("V8: Claude receives only approved values — no prices, no quotes, no segment ids", async () => {
    const ff = fakeFetch(claudeToolFake(["Su perro tiene gastroenteritis leve."]));
    await plainExplanation(ff.fetchImpl, "sk-test", body, "c1");
    const req = JSON.parse(ff.calls[0]!.body);
    const sent = JSON.stringify(req.messages);
    expect(sent).not.toMatch(/price|precio|cents|amount|\$/i);
    expect(sent).not.toContain("segment_ids");
    expect(sent).not.toContain("dicho en consulta");
    expect(req.tool_choice).toEqual({ type: "tool", name: "plain_explanation" });
  });

  it("without an API key or on a provider error → template, no retry loop", async () => {
    const none = fakeFetch({});
    expect((await plainExplanation(none.fetchImpl, undefined, body, "c1")).source).toBe("template");
    expect(none.calls).toHaveLength(0);
    const broken = fakeFetch({ [PP.claude]: () => new Response("nope", { status: 500 }) });
    expect((await plainExplanation(broken.fetchImpl, "sk-test", body, "c1")).source).toBe("template");
    expect(broken.count(PP.claude)).toBe(1);
  });
});
