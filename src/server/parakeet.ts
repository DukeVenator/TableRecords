import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import { sanitizedChildEnv } from "./childEnv.js";

export interface ParakeetHealth {
  available: boolean;
  runtimePath: string;
  runtimePresent: boolean;
  version: string | null;
  modelPath: string;
  modelPresent: boolean;
  error: string | null;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd: undefined,
      windowsHide: true,
      env: sanitizedChildEnv({})
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Parakeet is served by NVIDIA's native NeMo-Speech runtime, not Python. Keep
 * the checks separate so a missing faster-whisper venv does not hide a working
 * Parakeet install (and vice versa).
 */
export async function checkParakeetHealth(config: AppConfig, timeoutMs = 10_000): Promise<ParakeetHealth> {
  const result: ParakeetHealth = {
    available: false,
    runtimePath: config.parakeetPath,
    runtimePresent: false,
    version: null,
    modelPath: config.parakeetModel,
    modelPresent: false,
    error: null
  };
  try {
    const isPath = path.isAbsolute(config.parakeetPath) || /[\\/]/.test(config.parakeetPath);
    if (isPath) {
      await fsp.access(config.parakeetPath);
      result.runtimePresent = true;
    } else {
      const probe = await run(config.parakeetPath, ["--version"], Math.min(timeoutMs, 5_000));
      if (probe.code !== 0) {
        result.error = probe.stderr.trim() || `nemo-speech not found on PATH (${config.parakeetPath})`;
        return result;
      }
      result.runtimePresent = true;
      result.version = probe.stdout.trim().split(/\r?\n/).at(-1) ?? null;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
  try {
    await fsp.access(config.parakeetModel);
    result.modelPresent = true;
  } catch {
    result.error = `Parakeet model not found: ${config.parakeetModel}`;
    return result;
  }
  if (result.runtimePresent && !result.version) {
    const probe = await run(config.parakeetPath, ["--version"], Math.min(timeoutMs, 5_000));
    if (probe.code === 0) result.version = probe.stdout.trim().split(/\r?\n/).at(-1) ?? null;
    else result.error = probe.stderr.trim() || `nemo-speech exited ${probe.code}`;
  }
  result.available = result.runtimePresent && result.modelPresent && !result.error;
  return result;
}
