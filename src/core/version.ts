/** Minimum module version that polls for dashboard commands (prompt-on-start). */
export const FOUNDRY_CONSENT_COMMAND_VERSION = "0.3.1";

export function versionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
  const actual = parse(version ?? "");
  const required = parse(minimum);
  if (actual.length === 0) return false;
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}
