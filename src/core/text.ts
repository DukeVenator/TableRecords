const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”"
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/** Convert Foundry chat HTML into compact plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string") return "";
  const withBreaks = html
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, " • ")
    .replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(withBreaks)
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function csvEscape(value: unknown): string {
  const text = value == null ? "" : String(value);
  // Spreadsheet apps treat a leading =, +, -, @, tab, or CR as a formula.
  // Prefix strings (not numbers) so a chat line like "=cmd|..." stays text.
  const guarded = typeof value === "string" && /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function markdownCell(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}
