import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { sanitizedChildEnv } from "./childEnv.js";
import type { CaptureHealth } from "./recorder.js";

export interface PythonHealth {
  available: boolean;
  pythonPath: string;
  pythonVersion: string | null;
  fasterWhisper: string | null;
  ctranslate2: string | null;
  cudaDeviceCount: number | null;
  cudaComputeTypes: string[];
  modelDir: string;
  modelPresent: boolean;
  error: string | null;
}

export async function checkPythonHealth(config: AppConfig, timeoutMs = 20_000): Promise<PythonHealth> {
  const result: PythonHealth = {
    available: false,
    pythonPath: config.pythonPath,
    pythonVersion: null,
    fasterWhisper: null,
    ctranslate2: null,
    cudaDeviceCount: null,
    cudaComputeTypes: [],
    modelDir: config.sttModelDir,
    modelPresent: false,
    error: null
  };
  try {
    await fsp.access(config.pythonPath);
  } catch {
    result.error = `Python executable not found: ${config.pythonPath}. Run npm run setup:python.`;
    return result;
  }
  result.available = true;
  try {
    const healthScript = path.join(config.projectRoot, "python", "stt_health.py");
    const { spawn } = await import("node:child_process");
    const child = spawn(
      config.pythonPath,
      [healthScript, "--json", "--download-root", config.sttModelDir, "--model", config.sttModel],
      { cwd: config.projectRoot, windowsHide: true, env: sanitizedChildEnv({ PYTHONIOENCODING: "utf-8" }) }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(-1);
      }, timeoutMs);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode ?? -1);
      });
    });
    const line = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    if (line) {
      const parsed = JSON.parse(line) as Partial<PythonHealth> & { error?: string };
      result.pythonVersion = parsed.pythonVersion ?? null;
      result.fasterWhisper = parsed.fasterWhisper ?? null;
      result.ctranslate2 = parsed.ctranslate2 ?? null;
      result.cudaDeviceCount = parsed.cudaDeviceCount ?? null;
      result.cudaComputeTypes = Array.isArray(parsed.cudaComputeTypes) ? parsed.cudaComputeTypes : [];
      result.modelPresent = parsed.modelPresent === true;
      result.error = parsed.error ?? null;
    } else {
      result.error = code === -1 ? "stt_health.py timed out" : stderr.trim() || `stt_health.py exited ${code}`;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | "info";
  detail: string;
  hint?: string;
}

export function captureHealthLabel(health: CaptureHealth): HealthCheck["status"] {
  return health;
}
