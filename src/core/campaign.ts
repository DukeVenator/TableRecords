import type { SessionRecord } from "./types.js";

/**
 * Sessions are grouped by a game/campaign label. Newer sessions store it;
 * older ones fall back to the Foundry world title, or "Unsorted" when the
 * session was created without a world.
 */
export function sessionCampaign(session: Pick<SessionRecord, "campaign" | "world">): string {
  const explicit = session.campaign?.trim();
  if (explicit) return explicit;
  const world = session.world?.title?.trim();
  if (world && world !== "Unknown World") return world;
  return "Unsorted";
}
