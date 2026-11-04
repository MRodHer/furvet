// Bill arithmetic in integer cents. Prices come from catalog_items rows the SERVER
// looked up; the approved body only carries catalog_item_id + quantity.

export interface CatalogRow {
  id: string;
  name: string;
  price_cents: number;
  active: number;
}

export interface BillLine {
  catalogItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  source: "ai_detected" | "doctor_added";
}

export interface Bill {
  lines: BillLine[];
  totalCents: number;
  depositCents: number;
  balanceCents: number;
}

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

/** Builds the snapshot lines. Unknown or inactive catalog ids are refused (ids come from the client). */
export function buildLines(
  wanted: { catalogItemId: string; quantity: number; source: BillLine["source"] }[],
  catalog: CatalogRow[],
): BillLine[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return wanted.map((w) => {
    const item = byId.get(w.catalogItemId);
    if (!item || item.active !== 1) throw new BillingError(`unknown catalog item ${w.catalogItemId}`);
    if (!Number.isInteger(w.quantity) || w.quantity < 1 || w.quantity > 100) throw new BillingError("invalid quantity");
    return {
      catalogItemId: item.id,
      name: item.name,
      quantity: w.quantity,
      unitPriceCents: item.price_cents,
      lineTotalCents: w.quantity * item.price_cents,
      source: w.source,
    };
  });
}

/** total = Σ line totals; balance = max(total − captured deposit, 0). All integers. */
export function computeBill(lines: BillLine[], depositCents: number): Bill {
  if (!Number.isSafeInteger(depositCents) || depositCents < 0) throw new BillingError("invalid deposit");
  const totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  return { lines, totalCents, depositCents, balanceCents: Math.max(totalCents - depositCents, 0) };
}
