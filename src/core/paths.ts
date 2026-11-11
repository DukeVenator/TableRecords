import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class PathSafetyError extends Error {
  override name = "PathSafetyError";
}

/** Resolve a relative path under root, rejecting traversal and absolute escapes. */
export function resolveInside(root: string, relative: string): string {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new PathSafetyError("A non-empty relative path is required");
  }
  if (path.isAbsolute(relative)) {
    throw new PathSafetyError(`Absolute paths are not allowed: ${relative}`);
  }
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, relative);
  const rel = path.relative(rootAbs, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathSafetyError(`Path escapes its root: ${relative}`);
  }
  return target;
}

/** Validate an existing path, including symlink resolution, is inside root. */
export async function resolveExistingInside(root: string, relative: string): Promise<string> {
  const candidate = resolveInside(root, relative);
  const realRoot = await fsp.realpath(root);
  let realTarget: string;
  try {
    realTarget = await fsp.realpath(candidate);
  } catch (error) {
    throw new PathSafetyError(`Path does not exist: ${relative} (${(error as Error).message})`);
  }
  const rel = path.relative(realRoot, realTarget);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathSafetyError(`Resolved path escapes its root: ${relative}`);
  }
  return realTarget;
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, data);
  try {
    // Windows can briefly refuse to replace a file that the dashboard is
    // reading (EPERM/EBUSY/EACCES). Retry a few times before failing the job;
    // the original file is still intact while the temp file waits.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
      }
    }
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export interface JsonlReadResult<T> {
  items: T[];
  errors: Array<{ line: number; message: string }>;
}

export async function readJsonl<T = unknown>(file: string): Promise<JsonlReadResult<T>> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], errors: [] };
    throw error;
  }
  const items: T[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch (error) {
      errors.push({ line: i + 1, message: (error as Error).message });
    }
  }
  return { items, errors };
}

export async function writeJsonl(file: string, items: unknown[]): Promise<void> {
  const body = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFileAtomic(file, body ? `${body}\n` : "");
}

export async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
