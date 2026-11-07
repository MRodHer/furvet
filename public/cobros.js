// Ledger board on AG Grid Community (CDN + SRI). Amounts arrive as strings
// ("881.00") and are formatted for display only; no arithmetic happens here.
(() => {
  const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  // Clinic zone, like the console (src/time.ts); short style so a phone column holds it.
  const when = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" });
  const whenNarrow = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const events = document.getElementById("events");
  // Phone width (< 640 px): four columns; the rest shows in the detail when a row is tapped.
  const narrow = matchMedia("(max-width: 639px)");
  const fmtWhen = (iso) => (narrow.matches ? whenNarrow : when).format(new Date(iso));
  const WIDE_ONLY = ["currency", "paypal_order_id", "appointment_id", "last_event_at"];

  function showEvents(row) {
    events.replaceChildren();
    if (!row) return;
    fetch(`/api/v1/charges/${encodeURIComponent(row.id)}/events`)
      .then((r) => r.json())
      .then((list) => {
        const h = document.createElement("h2");
        h.textContent = `Historial del cargo ${row.id}`;
        h.style.fontSize = "1rem";
        const meta = document.createElement("p");
        meta.className = "note";
        meta.textContent = `Moneda: ${row.currency} · Orden PayPal: ${row.paypal_order_id ?? "—"} · Cita: ${row.appointment_id ?? "—"} · Último evento: ${row.last_event_at ? when.format(new Date(row.last_event_at)) : "—"}`;
        const table = document.createElement("table");
        const head = table.createTHead().insertRow();
        for (const t of ["Fecha", "Estado", "Monto", "Captura PayPal"]) {
          const th = document.createElement("th");
          th.textContent = t;
          head.appendChild(th);
        }
        const body = table.createTBody();
        for (const e of list) {
          const tr = body.insertRow();
          for (const v of [fmtWhen(e.created_at), e.status, e.amount ? `${money.format(e.amount)}` : "", e.paypal_capture_id ?? ""]) {
            tr.insertCell().textContent = v;
          }
        }
        events.append(h, meta, table);
      });
  }

  const gridOptions = {
    theme: agGrid.themeQuartz.withParams({ spacing: narrow.matches ? 4 : 8 }),
    // enableClickSelection: since AG Grid 32.2 a tap on a row selects nothing unless this is on (the detail never opened).
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    defaultColDef: { sortable: true, filter: true, resizable: true },
    columnDefs: [
      { field: "created_at", headerName: "Creado", flex: 1.2, sort: "desc", valueFormatter: (p) => fmtWhen(p.value) },
      { field: "kind", headerName: "Tipo", flex: 0.7 },
      { field: "amount", headerName: "Monto", flex: 0.8, valueFormatter: (p) => money.format(p.value), type: "rightAligned" },
      { field: "currency", headerName: "Moneda", flex: 0.5, hide: narrow.matches },
      { field: "status", headerName: "Estado", flex: 0.9 },
      { field: "paypal_order_id", headerName: "Orden PayPal", flex: 1.1, hide: narrow.matches },
      { field: "appointment_id", headerName: "Cita", flex: 1.1, hide: narrow.matches },
      { field: "last_event_at", headerName: "Último evento", flex: 1.2, hide: narrow.matches, valueFormatter: (p) => (p.value ? fmtWhen(p.value) : "") },
    ],
    onRowSelected: (e) => {
      if (e.node.isSelected()) showEvents(e.data);
    },
  };
  const api = agGrid.createGrid(document.getElementById("grid"), gridOptions);
  narrow.addEventListener("change", (e) => { api.setColumnsVisible(WIDE_ONLY, !e.matches); api.refreshCells({ force: true }); });

  async function load() {
    const res = await fetch("/api/v1/charges?limit=200");
    api.setGridOption("rowData", res.ok ? await res.json() : []);
  }
  load();
  setInterval(load, 10000);
})();
