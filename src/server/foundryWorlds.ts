import fsp from "node:fs/promises";
import path from "node:path";
import type { FoundryWorld } from "../core/types.js";
import { pathExists } from "../core/paths.js";

export interface FoundryWorldJson {
  id?: string;
  title?: string;
  system?: string;
  systemVersion?: string;
  coreVersion?: string;
  compatibility?: { verified?: string; minimum?: string; maximum?: string };
}

function candidateWorldsDirs(root: string): string[] {
  return [path.join(root, "worlds"), path.join(root, "Data", "worlds"), path.join(root, "data", "worlds")];
}

export async function findWorldsDir(root: string | null): Promise<string | null> {
  if (!root) return null;
  for (const candidate of candidateWorldsDirs(root)) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/** Resolve the modules directory next to the detected worlds directory. */
export async function findModulesDir(root: string | null): Promise<string | null> {
  if (!root) return null;
  const worldsDir = await findWorldsDir(root);
  const candidates = worldsDir
    ? [path.join(path.dirname(worldsDir), "modules")]
    : [path.join(root, "modules"), path.join(root, "Data", "modules"), path.join(root, "data", "modules")];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  // A Foundry install root has a Data/ directory even before any world exists.
  if (!worldsDir && (await pathExists(path.join(root, "Data")))) return path.join(root, "Data", "modules");
  if (!worldsDir && (await pathExists(path.join(root, "data")))) return path.join(root, "data", "modules");
  return candidates[0] ?? null;
}

export async function listFoundryWorlds(root: string | null): Promise<FoundryWorld[]> {
  const worldsDir = await findWorldsDir(root);
  if (!worldsDir) return [];
  const entries = await fsp.readdir(worldsDir, { withFileTypes: true }).catch(() => []);
  const worlds: FoundryWorld[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(worldsDir, entry.name);
    try {
      const raw = await fsp.readFile(path.join(dir, "world.json"), "utf8");
      const json = JSON.parse(raw) as FoundryWorldJson;
      worlds.push({
        id: typeof json.id === "string" && json.id ? json.id : entry.name,
        title: typeof json.title === "string" && json.title ? json.title : entry.name,
        system: typeof json.system === "string" && json.system ? json.system : "unknown",
        systemVersion: typeof json.systemVersion === "string" ? json.systemVersion : null,
        foundryVersion: typeof json.coreVersion === "string" ? json.coreVersion : null,
        path: dir
      });
    } catch {
      // skip malformed worlds, but keep scanning
    }
  }
  return worlds.sort((a, b) => a.title.localeCompare(b.title));
}

export function systemLabel(systemId: string): string {
  if (systemId === "starwarsffg") return "FFG narrative dice";
  if (systemId === "sfrpg") return "Starfinder (SFRPG)";
  return systemId;
}
