const LEADING_FILLER = /^(?:(?:okay|ok|so|right|alright|um|uh|well)[,;:\s]+)*/i;
const NOTE_PREFIX =
  /^(?:(?:gm|dm|game master|dungeon master)\s+)?(?:mental note|note to self|gm note|dm note|remind me(?: later)?(?: that| to)?)\b[:,;\s\-–—]*/i;

function clean(text: string): string {
  return text
    .trim()
    .replace(/^["'“”‘’]+/, "")
    .replace(/["'“”‘’]+$/, "")
    .replace(/^[\s,;:.\-–—]+/, "")
    .trim();
}

/**
 * Detect a deliberate spoken note marker at the start of an utterance.
 *
 * Only the opening counts, after a little filler. That keeps ordinary
 * mid-sentence uses like "I'm making a mental note" out of the notes file.
 * Returns the note body, or null.
 */
export function detectSpokenMentalNote(text: string): string | null {
  if (!text) return null;
  const normalized = text.replace(/^\s+/, "").replace(/^["'“”‘’]+/, "");
  const withoutFiller = normalized.replace(LEADING_FILLER, "");
  const match = NOTE_PREFIX.exec(withoutFiller);
  if (!match) return null;
  const body = clean(withoutFiller.slice(match[0].length));
  return body.length >= 3 ? body : null;
}

export function isMentalNoteMarker(value: { mentalNote?: boolean; kind?: string }): boolean {
  return value.mentalNote === true;
}
