import type { ConsentStatus, Person, SessionRecord } from "./types.js";

export const CONSENT_NOTICE_VERSION = "2026-11-01";

/**
 * This is the exact notice shown in Foundry and on the dashboard. Keep it in
 * one place so the consent record, UI, and module prompt cannot drift apart.
 */
export const CONSENT_NOTICE_TEXT = [
  "TableRecords records each Discord speaker separately for local tabletop note-taking.",
  "Audio is transcribed on the GM's machine. It is not shared off your local network and is not sent to any provider, cloud transcription service, or other third party.",
  "The optional local LLM is used only to summarize session notes. Recordings and transcripts are not used as training data.",
  "Consent is assumed unless you opt out. If you opt out, your voice is not recorded or processed, and the transcript notes that you did not want to be recorded."
].join(" ");

export function normalizeConsentStatus(value: unknown): ConsentStatus {
  return value === "opted_in" || value === "opted_out" ? value : "assumed";
}

/** Legacy records used only the boolean `consent`; false meant opted out. */
export function personConsentStatus(person: Person): ConsentStatus {
  if (person.consentStatus) return normalizeConsentStatus(person.consentStatus);
  return person.consent === false ? "opted_out" : "assumed";
}

export function personIsOptedOut(person: Person): boolean {
  return personConsentStatus(person) === "opted_out";
}

export function optedOutPeople(people: Person[]): Person[] {
  return people.filter(personIsOptedOut);
}

export function consentStatusLabel(status: ConsentStatus): string {
  if (status === "opted_out") return "opted out";
  if (status === "opted_in") return "opted in";
  return "consent assumed";
}

export function displayPerson(person: Person): string {
  const name = person.discordName ?? person.foundryUserName ?? person.discordUserId ?? "Unknown player";
  return person.character && person.character !== name ? `${name} (${person.character})` : name;
}

/** Markdown lines used by transcript/chronology/notes and the recent brief. */
export function optOutNoticeLines(people: Person[]): string[] {
  const optedOut = optedOutPeople(people);
  if (optedOut.length === 0) return [];
  return [
    `**Privacy note:** The following ${optedOut.length === 1 ? "player" : "players"} did not want to be recorded and are not included in this session record:`,
    "",
    ...optedOut.map((person) => `- ${displayPerson(person)} — *player did not want to be recorded*`),
    ""
  ];
}

export function consentMethodLabel(session: SessionRecord): string {
  if (!session.consent.confirmed) return "not confirmed";
  if (session.consent.method === "foundry") return "Foundry player prompt";
  if (session.consent.method === "gm_tick") return "GM confirmation";
  return session.consent.confirmedBy ?? "confirmed";
}
