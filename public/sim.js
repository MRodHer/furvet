// Chat simulator. Everything is rendered with textContent; the only anchors
// created are PayPal sandbox approval links (host allowlist).
(() => {
  const CONSENT_VERSION = "v1-2026-11-04";
  const PAYPAL_ALLOWED = "https://www.sandbox.paypal.com/";
  const log = document.getElementById("log");
  const form = document.getElementById("form");
  const input = document.getElementById("text");
  const send = document.getElementById("send");
  const status = document.getElementById("status");
  const consentBox = document.getElementById("consentBox");
  const consentBtn = document.getElementById("consentBtn");
  const consentState = document.getElementById("consentState");
  document.getElementById("consentVersion").textContent = CONSENT_VERSION;

  // While a payment is pending (server says so from the ledger) re-read the thread every few seconds, at most
  // 10 minutes per start and only while the tab is visible: the webhook's confirmation lands in `messages`.
  // Reads only; the daily message cap counts chat messages, not these.
  const POLL_MS = 5000;
  const POLL_MAX_MS = 10 * 60 * 1000;
  let poll = null;
  let pollStarted = 0;
  function setPolling(on) {
    if (on && !poll) pollStarted = Date.now();
    if (!on || document.visibilityState !== "visible" || Date.now() - pollStarted > POLL_MAX_MS) {
      clearInterval(poll);
      poll = null;
      return;
    }
    if (!poll) poll = setInterval(load, POLL_MS);
  }

  let session;
  try {
    session = localStorage.getItem("furvet.session");
    if (!session) {
      session = crypto.randomUUID();
      localStorage.setItem("furvet.session", session);
    }
  } catch {
    session = crypto.randomUUID();
  }

  function render(direction, text) {
    const div = document.createElement("div");
    div.className = `msg ${direction}`;
    // Split out sandbox PayPal URLs so they become clickable; everything else stays text.
    const parts = text.split(/(https?:\/\/\S+)/g);
    for (const part of parts) {
      if (part.startsWith(PAYPAL_ALLOWED)) {
        const a = document.createElement("a");
        a.href = part;
        a.textContent = "Pagar con PayPal (sandbox)";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        div.appendChild(a);
      } else {
        div.appendChild(document.createTextNode(part));
      }
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function load() {
    const res = await fetch(`/api/v1/sim/${session}/messages`);
    if (!res.ok) return;
    const data = await res.json();
    log.replaceChildren();
    for (const m of data.messages) render(m.direction, m.text);
    setPolling(data.payment_pending === true);
    if (data.consent && data.consent.owner_consent_at) {
      consentState.textContent = `Registrado ${data.consent.owner_consent_at}`;
      consentBox.checked = true;
      consentBox.disabled = true;
      consentBtn.disabled = true;
    }
  }

  consentBox.addEventListener("change", () => {
    consentBtn.disabled = !consentBox.checked;
  });
  consentBtn.addEventListener("click", async () => {
    consentBtn.disabled = true;
    const res = await fetch(`/api/v1/sim/${session}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: CONSENT_VERSION }),
    });
    consentState.textContent = res.ok ? "Consentimiento registrado." : "Envía un mensaje primero y vuelve a intentar.";
    if (!res.ok) consentBtn.disabled = false;
    else consentBox.disabled = true;
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    send.disabled = true;
    render("inbound", text);
    status.textContent = "Escribiendo…";
    try {
      const res = await fetch("/api/v1/sim/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, text }),
      });
      if (res.status === 429) {
        status.textContent = "Límite de la demo alcanzado por hoy.";
        return;
      }
      const data = await res.json();
      if (data.reply) render("outbound", data.reply);
      load(); // the reply may carry a pay link: the server decides whether to start polling
      status.textContent = data.escalated ? "Un miembro de la clínica te atenderá." : data.reply ? "" : "Un miembro de la clínica te atenderá.";
    } catch {
      status.textContent = "No se pudo enviar. Intenta de nuevo.";
    } finally {
      send.disabled = false;
      input.focus();
    }
  });

  load();
  // The payment happens in another tab: stop polling while hidden, re-read (and resume if still pending) on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
    else setPolling(false);
  });
})();
