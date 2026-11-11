import { randomUUID } from "node:crypto";

function token(length = 10): string {
  return randomUUID().replaceAll("-", "").slice(0, length).toUpperCase();
}

export function newUtteranceId(): string {
  return `u_${token()}`;
}

export function newSttJobId(): string {
  return `stt_${token()}`;
}

export function newJobId(): string {
  return `job_${token()}`;
}

export function newMarkerId(): string {
  return `m_${token()}`;
}

export function newPersonId(seed = ""): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  // person_id is globally unique in SQLite, so never derive it from a name alone.
  return `p_${slug ? `${slug}-` : ""}${token(4).toLowerCase()}`;
}

export function slugify(value: string, max = 48): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "session"
  );
}

export function localDateKey(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function makeSessionId(title: string, worldId: string, timeZone: string, nowMs = Date.now()): string {
  return `${localDateKey(nowMs, timeZone)}-${slugify(worldId, 28)}-${slugify(title, 28)}`.slice(0, 96);
}
