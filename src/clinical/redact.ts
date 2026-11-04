// Owner identity never reaches the model: the owner's name words and email are replaced by
// «el dueño» in the transcript text sent to Claude (D1 keeps the original). Matching ignores
// case and accents (NFD: each letter may be followed by combining marks).
const COMBINING = "[\\u0300-\\u036f]*";
const PLACEHOLDER = "el dueño";

function pattern(token: string): string {
  const base = token.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return Array.from(base, (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + COMBINING).join("");
}

export function redactOwner(text: string, owner: { name: string | null; email: string | null }): string {
  const parts: string[] = [];
  if (owner.email) parts.push(pattern(owner.email));
  // Word boundaries that understand letters and combining marks (\b is ASCII-only).
  for (const w of (owner.name ?? "").split(/\s+/)) if (w.length >= 3) parts.push(`(?<![\\p{L}\\p{M}])${pattern(w)}(?![\\p{L}\\p{M}])`);
  if (parts.length === 0) return text;
  const re = new RegExp(parts.join("|"), "giu");
  return text.normalize("NFD").replace(re, PLACEHOLDER).normalize("NFC");
}
