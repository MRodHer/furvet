// Ledger board on AG Grid Community (CDN + SRI). Amounts arrive as strings
// ("881.00") and are formatted for display only; no arithmetic happens here.
(() => {
  const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  const events = document.getElementById("events");

  function showEvents(row) {
    events.replaceChildren();
    if (!row) return;
    fetch(`/api/v1/charges/${encodeURIComponent(row.id)}/events`)
      .then((r) => r.json())
      .then((list) => {
        const h = document.createElement("h2");
        h.textContent = `Historial del cargo ${row.id}`;
        h.style.fontSize = "1rem";
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
          for (const v of [e.created_at, e.status, e.amount ? `${money.format(e.amount)}` : "", e.paypal_capture_id ?? ""]) {
            tr.insertCell().textContent = v;
          }
        }
        events.append(h, table);
      });
  }

  const gridOptions = {
    theme: agGrid.themeQuartz,
    rowSelection: { mode: "singleRow", checkboxes: false },
    defaultColDef: { sortable: true, filter: true, resizable: true },
    columnDefs: [
      { field: "created_at", headerName: "Creado", flex: 1.2, sort: "desc" },
      { field: "kind", headerName: "Tipo", flex: 0.7 },
      { field: "amount", headerName: "Monto", flex: 0.8, valueFormatter: (p) => money.format(p.value), type: "rightAligned" },
      { field: "currency", headerName: "Moneda", flex: 0.5 },
      { field: "status", headerName: "Estado", flex: 0.9 },
      { field: "paypal_order_id", headerName: "Orden PayPal", flex: 1.1 },
      { field: "appointment_id", headerName: "Cita", flex: 1.1 },
      { field: "last_event_at", headerName: "Último evento", flex: 1.2 },
    ],
    onRowSelected: (e) => {
      if (e.node.isSelected()) showEvents(e.data);
    },
  };
  const api = agGrid.createGrid(document.getElementById("grid"), gridOptions);

  async function load() {
    const res = await fetch("/api/v1/charges?limit=200");
    api.setGridOption("rowData", res.ok ? await res.json() : []);
  }
  load();
  setInterval(load, 10000);
})();
