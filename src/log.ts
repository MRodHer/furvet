// One structured line per event. Only ids, counts, enums and error TYPES — never
// bodies, tokens, names, emails or phone numbers (no PII in logs).
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}
