// Money is integer cents end to end. PayPal receives text with two decimals.

export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`invalid cents: ${String(cents)}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Strict: "881.00" → 88100. Anything else (no decimals, sign, exponent, spaces) throws. */
export function valueToCents(value: string): number {
  const m = /^(\d{1,10})\.(\d{2})$/.exec(value);
  if (!m) throw new RangeError("invalid money value");
  return Number(m[1]) * 100 + Number(m[2]);
}

/** Human display, e.g. "$881.00 MXN". */
export function formatCents(cents: number, currency: string): string {
  return `$${centsToValue(cents)} ${currency}`;
}
