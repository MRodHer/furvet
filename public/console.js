// Doctor console. Vanilla JS, everything rendered with textContent (never innerHTML from data).
// Recording: MediaRecorder, one file at the end (webm chunks after the first carry no header),
// 32 kbps, hard stop at 30 min. The audio goes to the Worker and nowhere else.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DOCTOR_CONSENT_VERSION = "doctor-v1-2026-11-04";
  const MAX_SECONDS = 30 * 60;
  const SPEAKERS = ["doctor", "owner", "unknown"];
  const SPEAKER_LABEL = { doctor: "Doctora", owner: "Dueño", unknown: "¿Quién?" };
  const REASON = {
    segment_unknown: "cita un segmento que no existe en esta consulta",
    quote_not_in_segments: "la frase citada no aparece literal en la transcripción",
    number_not_quoted: "el número no fue dicho con cifras en la frase citada",
    out_of_range: "fuera del rango fisiológico",
    catalog_item_unknown: "no corresponde a un concepto del catálogo",
  };
  // Field catalog (labels in Spanish; names port the clinical contract). type: text | num | enum.
  const SECTIONS = [
    ["subjective", "Subjetivo", [
      ["motivo_consulta", "Motivo de consulta"], ["historia_propietario", "Historia según el dueño"], ["comportamiento", "Comportamiento"],
      ["apetito", "Apetito", ["normal", "aumentado", "disminuido", "anorexia"]], ["actividad", "Actividad", ["normal", "aumentada", "disminuida", "letargia"]], ["cambios_recientes", "Cambios recientes"]]],
    ["vitals", "Signos vitales", [
      ["temperatura", "Temperatura (°C)", "num"], ["frecuencia_cardiaca", "Frecuencia cardiaca (lpm)", "num"], ["frecuencia_respiratoria", "Frecuencia respiratoria (rpm)", "num"],
      ["peso", "Peso (kg)", "num"], ["condicion_corporal", "Condición corporal (1-9)", "num"], ["estado_hidratacion", "Deshidratación", ["normal", "leve", "moderada", "severa"]], ["mucosas", "Mucosas"]]],
    ["assessment", "Evaluación", [["sintomas", "Síntomas"], ["diagnostico", "Diagnóstico"], ["pronostico", "Pronóstico", ["favorable", "reservado", "grave", "malo"]]]],
    ["plan", "Plan", [["tratamiento", "Tratamiento"], ["instrucciones_cliente", "Instrucciones al dueño"], ["procedimientos_realizados", "Procedimientos realizados"], ["procedimientos_recomendados", "Procedimientos recomendados"], ["proxima_cita", "Próxima cita"]]],
  ];
  const SYSTEMS = ["cardiovascular", "respiratorio", "digestivo", "nervioso", "musculoesqueletico", "tegumentario", "oftalmologico", "urinario", "reproductivo", "linfatico", "otico"];
  const MED_FIELDS = [["medicamento", "Medicamento"], ["dosis", "Dosis (número + unidad)"], ["frecuencia", "Frecuencia"], ["duracion", "Duración"], ["indicaciones", "Indicaciones"]];

  let consultId = null;
  let consult = null;
  let catalog = [];
  let recorder = null;
  let timerHandle = null;

  const setStatus = (text, kind = "") => { $("status").textContent = text; $("status").className = kind; };
  const api = async (path, init = {}) => {
    const res = await fetch(`/api/v1/consults${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    let data = null;
    try { data = await res.json(); } catch (e) { data = { error: `respuesta inválida (${e.name})` }; }
    return { ok: res.ok, status: res.status, data };
  };
  const el = (tag, props = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === "class") n.className = v; else if (k.startsWith("data-")) n.setAttribute(k, v); else n[k] = v; }
    for (const c of children) n.append(c);
    return n;
  };

  // ---------- 1. pick ----------
  async function loadAppointments() {
    const { ok, data } = await api("/appointments");
    const sel = $("apptSel");
    sel.replaceChildren();
    if (!ok) { setStatus(`No se pudo cargar la lista (${data.error || ""})`, "err"); return; }
    for (const a of data) {
      const label = `${new Date(a.starts_at).toLocaleString("es-MX")} · ${a.pet_name} (${a.species}) · ${a.consult_status ? "consulta " + a.consult_status : "sin abrir"}`;
      sel.append(el("option", { value: a.id, textContent: label, "data-consult": a.consult_id || "" }));
    }
  }
  $("reloadBtn").addEventListener("click", loadAppointments);
  $("openBtn").addEventListener("click", async () => {
    const opt = $("apptSel").selectedOptions[0];
    if (!opt) return;
    let id = opt.getAttribute("data-consult");
    if (!id) {
      const { ok, data } = await api("", { method: "POST", body: JSON.stringify({ appointment_id: opt.value }) });
      if (!ok) { setStatus(`No se pudo abrir: ${data.error}`, "err"); return; }
      id = data.id;
    }
    consultId = id;
    await refresh();
    loadAppointments();
  });

  async function refresh() {
    const { ok, data } = await api(`/${consultId}`);
    if (!ok) { setStatus(`Error al leer la consulta: ${data.error}`, "err"); return; }
    consult = data.consult;
    catalog = data.catalog;
    $("consultMeta").textContent = `Consulta ${consultId.slice(0, 8)} · ${data.pet.name} (${data.pet.species}${data.pet.breed ? ", " + data.pet.breed : ""}) · estado: ${consult.status}`;
    $("consentCard").classList.remove("hidden");
    $("ownerConsent").textContent = consult.owner_consent_at ? `aceptó el ${new Date(consult.owner_consent_at).toLocaleString("es-MX")} (texto ${consult.owner_consent_version})` : "NO ha aceptado en el chat";
    const doctorDone = !!consult.doctor_consent_at;
    $("doctorBox").checked = doctorDone; $("doctorBox").disabled = doctorDone; $("doctorConsentBtn").disabled = true;
    $("doctorConsentState").textContent = doctorDone ? "Registrada." : "";
    $("recCard").classList.remove("hidden");
    // Both layers, or the button stays off (the server refuses anyway: 409).
    $("recBtn").disabled = !(consult.owner_consent_at && doctorDone && consult.status === "recording");
    const hasTranscript = data.segments.length > 0;
    $("work").classList.toggle("hidden", !hasTranscript);
    if (hasTranscript) { renderTranscript(data.segments); renderDraft(data.draft); }
    $("approveBtn").disabled = !data.draft || consult.status !== "drafted";
    if (data.approved_version_id) $("approveState").textContent = "Ya aprobada.";
  }

  // ---------- 2. consent ----------
  $("doctorBox").addEventListener("change", () => { $("doctorConsentBtn").disabled = !$("doctorBox").checked; });
  $("doctorConsentBtn").addEventListener("click", async () => {
    const { ok, data } = await api(`/${consultId}/consent`, { method: "POST", body: JSON.stringify({ version: DOCTOR_CONSENT_VERSION }) });
    if (!ok) { $("doctorConsentState").textContent = `Error: ${data.error}`; return; }
    await refresh();
  });

  // ---------- 3. record ----------
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  function pickMime() {
    for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (MediaRecorder.isTypeSupported(m)) return m;
    return "";
  }
  $("recBtn").addEventListener("click", async () => {
    if (recorder && recorder.state === "recording") { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { setStatus(`Sin micrófono: ${e.name}`, "err"); return; }
    const mimeType = pickMime();
    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    const chunks = [];
    recorder.addEventListener("dataavailable", (ev) => { if (ev.data.size) chunks.push(ev.data); });
    recorder.addEventListener("stop", async () => {
      clearInterval(timerHandle);
      stream.getTracks().forEach((t) => t.stop());
      $("recDot").classList.remove("on"); $("recLabel").textContent = "Enviando…"; $("recBtn").disabled = true;
      const blob = new Blob(chunks, { type: mimeType.split(";")[0] || "audio/webm" });
      chunks.length = 0;
      setStatus("Transcribiendo (puede tardar un minuto)…");
      const res = await fetch(`/api/v1/consults/${consultId}/audio`, { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      let data = {};
      try { data = await res.json(); } catch (e) { data = { error: e.name }; }
      if (!res.ok) { setStatus(`No se pudo transcribir (${res.status}): ${data.error || ""}. Intenta de nuevo.`, "err"); $("recLabel").textContent = "Sin grabar"; $("recBtn").disabled = false; return; }
      setStatus(`Transcrito: ${data.segments} segmentos, ${data.seconds} s${data.labeled ? "" : " (hablantes sin etiquetar)"}.`, "ok");
      $("recLabel").textContent = "Listo";
      await refresh();
    });
    recorder.start();
    const startedAt = Date.now();
    $("recDot").classList.add("on"); $("recLabel").textContent = "Grabando"; $("recBtn").textContent = "Detener y enviar";
    setStatus("Grabando. Pulsa «Detener y enviar» al terminar.");
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      $("timer").textContent = fmt(s);
      if (s >= MAX_SECONDS && recorder.state === "recording") recorder.stop();
    }, 500);
  });

  // ---------- 4. transcript ----------
  function renderTranscript(segments) {
    const box = $("transcript");
    box.replaceChildren();
    for (const s of segments) {
      const who = el("button", { type: "button", class: `who ${s.speaker}`, textContent: SPEAKER_LABEL[s.speaker], title: "Cambiar quién habla" });
      who.addEventListener("click", async () => {
        const next = SPEAKERS[(SPEAKERS.indexOf(s.speaker) + 1) % SPEAKERS.length];
        const { ok } = await api(`/${consultId}/segments/${s.idx}`, { method: "PATCH", body: JSON.stringify({ speaker: next }) });
        if (ok) { s.speaker = next; who.textContent = SPEAKER_LABEL[next]; who.className = `who ${next}`; }
      });
      box.append(el("div", { class: "seg", id: `seg-${s.idx}` }, el("time", { textContent: fmt(Math.floor(s.start_ms / 1000)) }), who, el("span", { textContent: s.text })));
    }
  }
  function showQuote(ids) {
    document.querySelectorAll(".seg.hl").forEach((n) => n.classList.remove("hl"));
    ids.forEach((i, k) => { const n = $(`seg-${i}`); if (!n) return; n.classList.add("hl"); if (k === 0) n.scrollIntoView({ block: "center", behavior: "smooth" }); });
  }

  // ---------- 5. form ----------
  // One field = label + input + (IA badge + «ver frase») when it came grounded from the model.
  function field(path, label, kind, leaf) {
    const wrap = el("div", { class: "field", "data-path": path, "data-source": leaf ? "ai" : "doctor" });
    const id = `f-${path.replace(/[^a-z0-9_]/gi, "-")}`;
    const lab = el("label", { htmlFor: id, textContent: label });
    if (leaf) {
      lab.append(el("span", { class: "badge", textContent: "IA", title: "Lo propuso la IA a partir de la frase citada" }));
      const link = el("button", { type: "button", class: "link", textContent: "ver frase", title: leaf.quote });
      link.addEventListener("click", () => showQuote(leaf.segment_ids));
      lab.append(link);
    }
    let input;
    if (Array.isArray(kind)) {
      input = el("select", { id });
      input.append(el("option", { value: "", textContent: "—" }));
      for (const o of kind) input.append(el("option", { value: o, textContent: o }));
    } else if (kind === "num") input = el("input", { id, type: "number", step: "0.1" });
    else if (kind === "bool") input = el("input", { id, type: "checkbox" });
    else input = el("textarea", { id });
    if (leaf) { if (kind === "bool") input.checked = !!leaf.value; else input.value = String(leaf.value); }
    if (leaf) { wrap.dataset.segmentIds = JSON.stringify(leaf.segment_ids); wrap.dataset.quote = leaf.quote; }
    // Editing by hand removes the AI mark: from then on it is the doctor's entry.
    input.addEventListener("input", () => { wrap.dataset.source = "doctor"; });
    wrap.append(lab, input);
    return wrap;
  }
  function medBlock(i, m, incomplete) {
    const box = el("div", { class: "med", "data-med": String(i) });
    box.append(el("h3", { textContent: `Medicamento ${i + 1}` }));
    if (incomplete) box.append(el("p", { class: "warn", textContent: `Incompleto (falta ${incomplete.missing.join(", ")} con número y unidad dichos en consulta): bloquea la aprobación hasta completarlo.` }));
    const grid = el("div", { class: "grid2" });
    for (const [k, label] of MED_FIELDS) grid.append(field(`prescription[${i}].${k}`, label, "text", m[k]));
    const cat = el("select", { id: `med-cat-${i}` });
    cat.append(el("option", { value: "", textContent: "No cobrar / no está en catálogo" }));
    for (const c of catalog) cat.append(el("option", { value: c.id, textContent: `${c.name} (${c.category})`, selected: c.id === m.catalog_item_id }));
    grid.append(el("div", { class: "field" }, el("label", { htmlFor: `med-cat-${i}`, textContent: "Concepto del catálogo" }), cat));
    box.append(grid);
    return box;
  }
  function renderDraft(draft) {
    const form = $("soap");
    form.replaceChildren();
    const body = draft ? draft.body : { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [] };
    lastDraftBillable = body.billable;
    for (const [sec, title, fields] of SECTIONS) {
      form.append(el("h3", { textContent: title }));
      for (const [k, label, kind] of fields) form.append(field(`${sec}.${k}`, label, kind || "text", body[sec][k]));
    }
    form.append(el("h3", { textContent: "Instrucciones urgentes (se envían al dueño de inmediato al aprobar)" }));
    (body.plan.urgent_instructions || [null]).forEach((leaf, i) => form.append(field(`plan.urgent_instructions[${i}]`, `Urgente ${i + 1}`, "text", leaf)));
    form.append(el("h3", { textContent: "Examen físico por sistemas" }));
    for (const s of SYSTEMS) {
      const ex = body.physical_exam[s] || {};
      const row = el("div", { class: "sys" }, el("span", { textContent: s }));
      row.append(field(`physical_exam.${s}.evaluado`, "evaluado", "bool", ex.evaluado), field(`physical_exam.${s}.normal`, "normal", "bool", ex.normal), field(`physical_exam.${s}.hallazgos`, "hallazgos", "text", ex.hallazgos));
      form.append(row);
    }
    form.append(el("h3", { textContent: "Receta" }));
    const inc = draft ? draft.grounding.incomplete_medications : [];
    body.prescription.forEach((m, i) => form.append(medBlock(i, m, inc.find((x) => x.index === i))));
    const addMed = el("button", { type: "button", class: "secondary", textContent: "+ Medicamento" });
    addMed.addEventListener("click", () => addMed.before(medBlock(form.querySelectorAll(".med").length, {}, null)));
    form.append(addMed);
    form.append(el("h3", { textContent: "Vacunas aplicadas" }));
    body.vaccines.forEach((v, i) => form.append(field(`vaccines[${i}].vacuna`, `Vacuna ${i + 1}`, "text", v.vacuna)));
    form.append(el("h3", { textContent: "Conceptos a cobrar (cantidad; el precio lo pone el catálogo del servidor)" }));
    body.billable.forEach((b, i) => {
      const item = catalog.find((c) => c.id === b.catalog_item_id);
      form.append(field(`billable[${i}].quantity`, `${item ? item.name : b.catalog_item_id} × cantidad`, "num", b.quantity));
    });
    // Discarded panel: reason + quote, never pre-filled.
    const list = $("discarded");
    list.replaceChildren();
    const disc = draft ? draft.grounding.discarded : [];
    if (!disc.length) list.append(el("li", { class: "note", textContent: draft ? "Nada descartado." : "Nada todavía." }));
    for (const d of disc) list.append(el("li", {}, el("strong", { textContent: d.path }), `: ${REASON[d.reason] || d.reason} `, d.quote ? el("q", { textContent: d.quote }) : ""));
    $("fillState").textContent = draft ? `Borrador del ${new Date(draft.created_at).toLocaleString("es-MX")}` : "Sin borrador.";
  }
  $("fillBtn").addEventListener("click", async () => {
    $("fillBtn").disabled = true; $("fillState").textContent = "Pidiendo el borrador a la IA…";
    const { ok, data } = await api(`/${consultId}/fill`, { method: "POST" });
    $("fillBtn").disabled = false;
    if (!ok) { $("fillState").textContent = `No se pudo generar (${data.error || ""}). Intenta de nuevo.`; return; }
    await refresh();
  });

  // Approval body: every leaf tagged with its source (ai keeps the evidence; doctor is a plain entry).
  // The route /approve is served by the billing step; the server re-validates everything.
  function collect() {
    const out = { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [] };
    for (const w of document.querySelectorAll("#soap .field[data-path]")) {
      const input = w.querySelector("input, select, textarea");
      const raw = input.type === "checkbox" ? input.checked : input.value.trim();
      if (raw === "" || raw === false && !w.dataset.segmentIds) continue;
      const value = input.type === "number" ? Number(raw) : raw;
      const leaf = w.dataset.source === "ai" ? { value, source: "ai", segment_ids: JSON.parse(w.dataset.segmentIds), quote: w.dataset.quote } : { value, source: "doctor" };
      const parts = w.dataset.path.split(".");
      let node = out;
      parts.forEach((p, i) => {
        const m = p.match(/^(\w+)\[(\d+)\]$/);
        const key = m ? m[1] : p;
        const idx = m ? Number(m[2]) : null;
        const last = i === parts.length - 1;
        if (idx === null) { if (last) node[key] = leaf; else node = node[key] = node[key] || {}; return; }
        node[key] = node[key] || [];
        if (last) node[key][idx] = leaf; else node = node[key][idx] = node[key][idx] || {};
      });
    }
    document.querySelectorAll("#soap .med").forEach((m, i) => {
      const cat = m.querySelector("select").value;
      if (out.prescription[i] && cat) out.prescription[i].catalog_item_id = cat;
    });
    out.prescription = out.prescription.filter(Boolean);
    out.vaccines = out.vaccines.filter(Boolean);
    out.billable = out.billable.filter(Boolean).map((b, i) => ({ ...b, catalog_item_id: (consultDraftBillable()[i] || {}).catalog_item_id }));
    if (out.plan.urgent_instructions) out.plan.urgent_instructions = out.plan.urgent_instructions.filter(Boolean);
    return out;
  }
  let lastDraftBillable = [];
  const consultDraftBillable = () => lastDraftBillable;

  $("approveBtn").addEventListener("click", async () => {
    $("approveBtn").disabled = true; $("approveState").textContent = "Enviando…";
    const { ok, status, data } = await api(`/${consultId}/approve`, { method: "POST", body: JSON.stringify(collect()) });
    if (!ok) { $("approveState").textContent = `No se aprobó (${status}): ${data.error || ""}${data.issues ? " · " + JSON.stringify(data.issues) : ""}`; $("approveBtn").disabled = false; return; }
    $("approveState").textContent = "Aprobada. Receta enviada al dueño; informe al confirmarse el saldo.";
    await refresh();
  });

  loadAppointments();
})();
