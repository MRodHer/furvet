// Doctor console. Vanilla JS, everything rendered with textContent (never innerHTML from data).
// Recording: MediaRecorder, one file at the end (webm chunks after the first carry no header),
// 32 kbps, hard stop at 30 min. The audio goes to the Worker and nowhere else.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  // Same zone and style as src/time.ts (clinic-local, never the browser zone); scripts/checks.sh keeps them in step.
  const clinicTime = (iso) => new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
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
  // Clinic subscription (card 0). The server decides; the console only reflects and disables.
  let subscription = { status: "none", required: true };
  async function loadSubscription() {
    const res = await fetch("/api/v1/subscription");
    if (!res.ok) { $("subState").textContent = `No se pudo leer la suscripción (${res.status}).`; return; }
    subscription = await res.json();
    const price = `${(subscription.price_cents / 100).toFixed(2)} ${subscription.currency}/mes`;
    const LABEL = { none: "Sin suscripción", approval_pending: "Pendiente de aprobar en PayPal", active: "Activa", suspended: "Suspendida (pago fallido)", cancelled: "Cancelada", expired: "Vencida" };
    const next = subscription.next_billing_at ? ` · próximo cobro ${clinicTime(subscription.next_billing_at)}` : "";
    $("subState").textContent = `${LABEL[subscription.status] || subscription.status} · ${price}${next}${subscription.required ? "" : " · candado de IA APAGADO (SUBSCRIPTION_REQUIRED=false)"}`;
    $("subBtn").classList.toggle("hidden", subscription.status === "active");
    $("subBtn").textContent = subscription.status === "approval_pending" ? "Continuar en PayPal" : "Suscribirme con PayPal";
  }
  const aiAllowed = () => !subscription.required || subscription.status === "active";
  $("subBtn").addEventListener("click", async () => {
    $("subBtn").disabled = true;
    const res = await fetch("/api/v1/subscription/start", { method: "POST", headers: { "Content-Type": "application/json" } });
    let data = {}; try { data = await res.json(); } catch (e) { data = { error: e.name }; }
    $("subBtn").disabled = false;
    if (!res.ok) { $("subState").textContent = `No se pudo iniciar (${res.status}): ${data.error || ""}`; return; }
    location.assign(data.approve_url); // host validated by the server (www.sandbox.paypal.com)
  });

  async function loadAppointments() {
    const { ok, data } = await api("/appointments");
    const sel = $("apptSel");
    sel.replaceChildren();
    if (!ok) { setStatus(`No se pudo cargar la lista (${data.error || ""})`, "err"); return; }
    for (const a of data) {
      const label = `${clinicTime(a.starts_at)} · ${a.pet_name} (${a.species}) · ${a.consult_status ? "consulta " + a.consult_status : "sin abrir"}`;
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
    $("ownerConsent").textContent = consult.owner_consent_at ? `aceptó el ${clinicTime(consult.owner_consent_at)} (texto ${consult.owner_consent_version})` : "NO ha aceptado en el chat";
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
    await renderDelivery();
  }

  // ---------- 6. delivery: explanation release + balance charge (both one-shot on the server) ----------
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  async function renderDelivery() {
    const { ok, data } = await api(`/${consultId}/delivery`);
    const show = ok && data.approved;
    $("deliveryCard").classList.toggle("hidden", !show);
    if (!show) return;
    $("explainText").textContent = data.explanation;
    $("explainSource").textContent = data.explanation_source === "ai" ? "(redactada por IA a partir de lo aprobado)" : "(plantilla fija, sin IA)";
    const sent = !!data.explanation_sent_at;
    $("sendExplainBtn").disabled = sent;
    $("sendExplainState").textContent = sent ? `Enviada el ${clinicTime(data.explanation_sent_at)}.` : "Aún no enviada.";
    renderBill($("billTable"), data);
    const charged = !!data.charge;
    $("chargeBtn").disabled = charged || data.balance_cents === 0;
    $("chargeState").textContent = data.balance_cents === 0 ? "Sin saldo: informe ya liberado." : charged ? `Liga enviada al dueño (estado: ${data.charge.status}).` : "La liga de pago aún no se ha generado.";
  }
  // The rx never goes to the owner's chat: the doctor opens it here (doctor credential), prints and signs it.
  $("printRxBtn").addEventListener("click", () => { window.open(`/api/v1/consults/${consultId}/rx.pdf`, "_blank", "noopener"); });
  $("sendExplainBtn").addEventListener("click", async () => {
    $("sendExplainBtn").disabled = true; $("sendExplainState").textContent = "Enviando…";
    const { ok, status, data } = await api(`/${consultId}/send-explanation`, { method: "POST" });
    if (!ok) $("sendExplainState").textContent = `No se envió (${status}): ${data.error || ""}`;
    await renderDelivery();
  });
  $("chargeBtn").addEventListener("click", async () => {
    $("chargeBtn").disabled = true; $("chargeState").textContent = "Generando…";
    const { ok, status, data } = await api(`/${consultId}/charge`, { method: "POST" });
    if (!ok) { $("chargeState").textContent = `No se generó (${status}): ${data.error || ""}`; $("chargeBtn").disabled = false; return; }
    await renderDelivery();
  });

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
      // Auto-draft: once per finished transcription, only when the clinic may use the AI (else the notice stays).
      if (consult.status === "transcribed" && aiAllowed()) await requestDraft();
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
    grid.append(catalogRow("med", i, m.catalog_item_id, true));
    box.append(grid);
    return box;
  }
  // Catalog concept + quantity to bill (the server prices it; 1–100 as in buildLines). Medications also get
  // «the owner buys it elsewhere»: prescribed, never billed. A quantity the draft grounded keeps its IA mark until edited.
  function catalogRow(kind, i, itemId, ownerOption) {
    const row = el("div", { class: "field" });
    const cat = el("select", { id: `${kind}-cat-${i}` });
    cat.append(el("option", { value: "", textContent: "No cobrar / no está en catálogo" }));
    for (const c of catalog) cat.append(el("option", { value: c.id, textContent: `${c.name} (${c.category})`, selected: c.id === itemId }));
    // A quantity the draft grounded is claimed by ONE block (never inherited twice); it loses its IA mark when edited or re-pointed.
    const draftQty = itemId && !claimedQty.has(itemId) ? (lastDraftBillable.find((b) => b.catalog_item_id === itemId) || {}).quantity : undefined;
    const qty = el("input", { id: `${kind}-qty-${i}`, type: "number", min: "1", max: "100", step: "1", value: draftQty ? String(draftQty.value) : "1" });
    const qtyLabel = el("label", { htmlFor: qty.id, textContent: "Cantidad a cobrar (1–100; el precio lo pone el catálogo del servidor)" });
    if (draftQty) {
      claimedQty.add(itemId);
      qty.dataset.ai = JSON.stringify({ ...draftQty, source: "ai" });
      const badge = el("span", { class: "badge", textContent: "IA", title: draftQty.quote });
      qtyLabel.append(badge);
      const own = () => { delete qty.dataset.ai; badge.remove(); };
      qty.addEventListener("input", own);
      cat.addEventListener("change", own);
    }
    row.append(el("label", { htmlFor: cat.id, textContent: "Concepto del catálogo" }), cat, qtyLabel, qty);
    if (ownerOption) {
      const own = el("input", { id: `${kind}-own-${i}`, type: "checkbox" });
      row.append(el("label", { htmlFor: own.id, class: "note" }, own, " El dueño lo consigue por su cuenta (no se cobra; la receta sí se emite)"));
    }
    return row;
  }
  // Breakdown table: what the server priced (preview) or what it snapshotted (after approval). Never computed here.
  function renderBill(table, data) {
    table.replaceChildren(el("tr", {}, ...["Concepto", "Cantidad", "Precio unitario", "Subtotal"].map((t) => el("th", { textContent: t }))));
    for (const l of data.lines) table.append(el("tr", {}, el("td", { textContent: l.name }), el("td", { textContent: String(l.quantity) }), el("td", { textContent: l.unit_price }), el("td", { textContent: money(l.line_total_cents) })));
    for (const [label, text] of [["Total", money(data.total_cents)], ["Anticipo capturado", `− ${money(data.deposit_cents)}`], ["Saldo a cobrar", money(data.balance_cents)]]) {
      table.append(el("tr", {}, el("th", { textContent: label, colSpan: 3 }), el("td", { textContent: text })));
    }
  }
  function renderDraft(draft) {
    const form = $("soap");
    form.replaceChildren();
    const body = draft ? draft.body : { subjective: {}, vitals: {}, physical_exam: {}, assessment: {}, plan: {}, prescription: [], vaccines: [], billable: [] };
    lastDraftBillable = body.billable;
    claimedQty.clear();
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
    body.vaccines.forEach((v, i) => form.append(el("div", { class: "vax" }, field(`vaccines[${i}].vacuna`, `Vacuna ${i + 1}`, "text", v.vacuna), catalogRow("vax", i, v.catalog_item_id, false))));
    // Draft billable rows that no medication/vaccine block claimed (lab, deworming, other…): still billable, still editable.
    const others = body.billable.filter((b) => !claimedQty.has(b.catalog_item_id));
    if (others.length) form.append(el("h3", { textContent: "Otros conceptos a cobrar" }));
    others.forEach((b, i) => form.append(el("div", { class: "oth" }, catalogRow("oth", i, b.catalog_item_id, false))));
    $("billPreview").replaceChildren();
    // Discarded panel: reason + quote, never pre-filled.
    const list = $("discarded");
    list.replaceChildren();
    const disc = draft ? draft.grounding.discarded : [];
    if (!disc.length) list.append(el("li", { class: "note", textContent: draft ? "Nada descartado." : "Nada todavía." }));
    for (const d of disc) list.append(el("li", {}, el("strong", { textContent: d.path }), `: ${REASON[d.reason] || d.reason} `, d.quote ? el("q", { textContent: d.quote }) : ""));
    $("fillState").textContent = draft ? `Borrador del ${clinicTime(draft.created_at)}. Revísalo y apruébalo; nada sale al dueño sin tu clic.` : "Sin borrador.";
    $("fillBtn").textContent = draft ? "Regenerar borrador con IA" : "Generar borrador con IA";
    if (!aiAllowed()) { $("fillBtn").disabled = true; $("fillState").textContent = "La IA está desactivada: la clínica no tiene suscripción activa (ver tarjeta 0)."; }
  }
  // One request per click or per finished transcription: no retry, no loop. The server's subscription
  // gate (402) is the authority; the console only avoids a call it knows will be refused.
  async function requestDraft() {
    $("fillBtn").disabled = true; $("fillState").textContent = "Pidiendo el borrador a la IA…";
    const { ok, status, data } = await api(`/${consultId}/fill`, { method: "POST" });
    $("fillBtn").disabled = false;
    if (status === 402) { await loadSubscription(); $("fillBtn").disabled = true; $("fillState").textContent = "La IA está desactivada: la clínica no tiene suscripción activa (ver tarjeta 0)."; return; }
    if (!ok) { $("fillState").textContent = `No se pudo generar (${data.error || ""}). Pulsa «Regenerar» para intentar de nuevo.`; return; }
    await refresh();
  }
  $("fillBtn").addEventListener("click", requestDraft);

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
    // Billable lines come from each medication/vaccine block: catalog concept + quantity, unless the owner buys it elsewhere.
    const bill = (kind, i, target) => {
      const cat = $(`${kind}-cat-${i}`).value;
      const own = kind === "med" && $(`med-own-${i}`).checked;
      if (!target || !cat) return;
      target.catalog_item_id = cat;
      if (own) { target.owner_sourced = true; return; }
      const qty = $(`${kind}-qty-${i}`);
      out.billable.push({ catalog_item_id: cat, quantity: qty.dataset.ai ? JSON.parse(qty.dataset.ai) : { value: Number(qty.value), source: "doctor" } });
    };
    document.querySelectorAll("#soap .med").forEach((_, i) => bill("med", i, out.prescription[i]));
    document.querySelectorAll("#soap .vax").forEach((_, i) => bill("vax", i, out.vaccines[i]));
    document.querySelectorAll("#soap .oth").forEach((_, i) => bill("oth", i, {}));
    out.prescription = out.prescription.filter(Boolean);
    out.vaccines = out.vaccines.filter(Boolean);
    if (out.plan.urgent_instructions) out.plan.urgent_instructions = out.plan.urgent_instructions.filter(Boolean);
    return out;
  }
  let lastDraftBillable = [];
  const claimedQty = new Set();
  $("previewBtn").addEventListener("click", async () => {
    $("previewState").textContent = "Calculando…";
    const { ok, status, data } = await api(`/${consultId}/bill-preview`, { method: "POST", body: JSON.stringify(collect()) });
    if (!ok) { $("billPreview").replaceChildren(); $("previewState").textContent = `No se pudo calcular (${status}): ${data.error || ""}${data.issues ? " · " + JSON.stringify(data.issues) : ""}`; return; }
    renderBill($("billPreview"), data);
    $("previewState").textContent = "Así se cobrará al aprobar (los precios vienen del catálogo del servidor).";
  });

  $("approveBtn").addEventListener("click", async () => {
    $("approveBtn").disabled = true; $("approveState").textContent = "Enviando…";
    const { ok, status, data } = await api(`/${consultId}/approve`, { method: "POST", body: JSON.stringify(collect()) });
    if (!ok) { $("approveState").textContent = `No se aprobó (${status}): ${data.error || ""}${data.issues ? " · " + JSON.stringify(data.issues) : ""}`; $("approveBtn").disabled = false; return; }
    $("approveState").textContent = "Aprobada. Receta enviada al dueño. Revise abajo la explicación y genere el cobro.";
    await refresh();
  });

  loadSubscription();
  loadAppointments();
})();
