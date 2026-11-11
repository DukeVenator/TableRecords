import type { FfgCounts } from "./foundry/adapters.js";

export const SYSTEM_VOCABULARY: Record<string, { prompt: string; hotwords: string[] }> = {
  starwarsffg: {
    prompt:
      "FFG narrative-dice campaign. Terms: Destiny Points, Triumph, Despair, Advantage, Threat, " +
      "Force die, strain, wounds, soak, defense, Obligation, Duty, Morality.",
    hotwords: [
      "Destiny Points",
      "Triumph",
      "Despair",
      "Advantage",
      "Threat",
      "Force die"
    ]
  },
  sfrpg: {
    prompt:
      "Starfinder RPG. Terms: Stamina, Hit Points, Resolve Points, KAC, EAC, Starship, Drift, Absalom Station, " +
      "Pact Worlds, technomancer, operative, soldier, envoy, solarian.",
    hotwords: ["Absalom Station", "Pact Worlds", "Stamina", "Resolve Points", "KAC", "EAC", "Drift"]
  }
};

export function vocabularyFor(systemId: string, people: Array<{ character?: string | null; discordName?: string | null }>): {
  prompt: string;
  hotwords: string[];
} {
  const base = SYSTEM_VOCABULARY[systemId] ?? {
    prompt: "Tabletop RPG session. Transcribe table talk verbatim.",
    hotwords: []
  };
  const names = people
    .flatMap((person) => [person.character, person.discordName])
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim());
  const hotwords = [...new Set([...names, ...base.hotwords])].slice(0, 40);
  const prompt = names.length ? `${base.prompt} Names: ${[...new Set(names)].join(", ")}.` : base.prompt;
  return { prompt: prompt.slice(0, 1200), hotwords };
}

const FFG_KEYS: Array<keyof FfgCounts> = [
  "success",
  "failure",
  "advantage",
  "threat",
  "triumph",
  "despair",
  "light",
  "dark"
];

export function emptyFfg(): FfgCounts {
  return { success: 0, failure: 0, advantage: 0, threat: 0, triumph: 0, despair: 0, light: 0, dark: 0 };
}

export function addFfg(target: FfgCounts, source: Record<string, number> | null | undefined): void {
  if (!source) return;
  for (const key of FFG_KEYS) target[key] = (target[key] ?? 0) + Number(source[key] ?? 0);
}
