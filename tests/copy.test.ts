import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const CALL = /(?:^|[^\w.$])(?:apiError|new\s+JobError|new\s+SessionError|new\s+ReviewAudioError|new\s+LlmError|new\s+PathSafetyError|new\s+FoundryImportError)\s*\(/g;
const PLAIN = /^"([^"\\]*)"$/;
const PROSE = [/\bmust be\b/, /^Cannot /, /^Invalid /];
const IDENTIFIER = /\b[a-z]+[A-Z][A-Za-z]*\b/;

function files(dir: string, extension: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...files(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") i += 1;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

function argument(source: string, open: number, index: number): string | null {
  let depth = 0;
  let count = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(source, i);
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return count === index ? source.slice(start, i).trim() : null;
    } else if (char === "," && depth === 1) {
      if (count === index) return source.slice(start, i).trim();
      count += 1;
      start = i + 1;
    }
  }
  return null;
}

function messages(source: string): string[] {
  const call = new RegExp(CALL.source, "g");
  const found: string[] = [];
  let match = call.exec(source);
  while (match) {
    const arg = argument(source, match.index + (match[0]?.length ?? 1) - 1, 1);
    const text = arg?.match(PLAIN)?.[1];
    if (text) found.push(text);
    match = call.exec(source);
  }
  return found;
}

function readsAsSentence(text: string): boolean {
  return /^[A-Z]/.test(text) && /[.!?]$/.test(text);
}

function labels(source: string): string[] {
  return Array.from(source.matchAll(/>\s*([A-Z][a-z]+ ){2,}[A-Z][a-z]+\s*</g), (match) => (match[0] ?? "").trim());
}

function exclamations(source: string): string[] {
  return Array.from(
    source.matchAll(/>[ \t]*[A-Za-z][A-Za-z0-9 ,.'"’‘“”!?…:-]*!</g),
    (match) => (match[0] ?? "").trim()
  );
}

describe("dashboard copy", () => {
  it("keeps field names and raw phrases out of server error messages", () => {
    let extracted = 0;
    let sentences = 0;
    const offenders: string[] = [];
    for (const file of files(join(root, "src", "server"), ".ts")) {
      const name = relative(root, file);
      for (const text of messages(readFileSync(file, "utf8"))) {
        extracted += 1;
        const sentence = readsAsSentence(text);
        if (sentence) sentences += 1;
        const raw = PROSE.some((rule) => rule.test(text)) || (sentence && IDENTIFIER.test(text));
        if (raw) offenders.push(`${name}: ${text}`);
      }
    }
    expect(extracted).toBeGreaterThan(10);
    expect(sentences).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it("keeps dashboard labels in sentence case", () => {
    const pages = files(join(root, "src", "web"), ".tsx");
    expect(pages.length).toBeGreaterThan(5);
    const offenders = pages.flatMap((file) =>
      labels(readFileSync(file, "utf8")).map((label) => `${relative(root, file)}: ${label}`)
    );
    expect(offenders).toEqual([]);
  });

  it("keeps exclamation marks out of dashboard text", () => {
    const pages = files(join(root, "src", "web"), ".tsx");
    expect(pages.length).toBeGreaterThan(5);
    const offenders = pages.flatMap((file) =>
      exclamations(readFileSync(file, "utf8")).map((hit) => `${relative(root, file)}: ${hit}`)
    );
    expect(offenders).toEqual([]);
  });
});
