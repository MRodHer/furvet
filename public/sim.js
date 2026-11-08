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
    // Fenced blocks (the account ticket) go verbatim into a <pre>; in the rest, sandbox PayPal URLs become
    // clickable. Everything is textContent/text nodes: never markup.
    text.split(/```\n?([\s\S]*?)\n?```\n?/g).forEach((chunk, i) => {
      if (i % 2) {
        const pre = document.createElement("pre");
        pre.textContent = chunk;
        div.appendChild(pre);
        return;
      }
      for (const part of chunk.split(/(https?:\/\/\S+)/g)) {
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
    });
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  // Only messages newer than the last one painted are appended: the log is never rebuilt, so a screen reader does not
  // re-read it, the scroll does not jump and the pay link is not recreated under a finger. A failed read just waits.
  let lastId = 0;
  async function load() {
    let data;
    try {
      const res = await fetch(`/api/v1/sim/${session}/messages`);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    for (const m of data.messages) if (m.id > lastId) { render(m.direction, m.text); lastId = m.id; }
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
    send.disabled = true;
    status.textContent = "Enviando…";
    // The text stays in the box until the server took it: a failure shows its real status and nothing to retype.
    try {
      const res = await fetch("/api/v1/sim/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, text }),
      });
      if (!res.ok) {
        status.textContent = res.status === 429 ? "Límite de la demo alcanzado por hoy." : `No se pudo enviar (${res.status}). Intenta de nuevo.`;
        return;
      }
      const data = await res.json();
      input.value = input.value.replace(text, "").trimStart(); // only what the server took leaves the box
      await load(); // paints the message and the reply from the server; a pay link starts the polling
      status.textContent = data.escalated || !data.reply ? "Un miembro de la clínica te atenderá." : "";
    } catch {
      status.textContent = "No se pudo enviar (sin conexión). Intenta de nuevo.";
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
