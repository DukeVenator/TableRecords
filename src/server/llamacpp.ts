import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { AppConfig } from "./config.js";

export type LlamaCppState = "stopped" | "starting" | "running" | "external" | "error";

export interface LlamaCppStatus {
  state: LlamaCppState;
  managed: boolean;
  healthy: boolean;
  restartRequired: boolean;
  pid: number | null;
  port: number;
  exe: string;
  modelPath: string | null;
  autostart: boolean;
  lastError: string | null;
  logTail: string[];
}

interface LlamaCppLaunch {
  exe: string;
  modelPath: string;
  port: number;
  model: string;
  contextTokens: number;
  gpuLayers: number | null;
  ncpuMoe: number;
  kvCache: "f16" | "q8_0" | "q4_0";
  flashAttn: boolean;
}

export function buildLlamaCppArgs(
  config: Pick<
    AppConfig,
    | "llamacppModelPath"
    | "llmModel"
    | "llmContextTokens"
    | "llmGpuLayers"
    | "llamacppNcpuMoe"
    | "llamacppKvCache"
    | "llamacppFlashAttn"
    | "llamacppPort"
  >
): string[] {
  const modelPath = config.llamacppModelPath;
  if (!modelPath) throw new Error("Choose a model file for llama.cpp first.");
  const alias = config.llmModel?.trim();
  if (!alias) throw new Error("Choose a model alias for llama.cpp first.");
  const args = [
    "-m",
    path.resolve(modelPath),
    "--load-mode",
    "mmap",
    "-ngl",
    String(config.llmGpuLayers ?? 99),
    "-c",
    String(config.llmContextTokens),
    "-ctk",
    config.llamacppKvCache,
    "-ctv",
    config.llamacppKvCache,
    "-fa",
    config.llamacppFlashAttn ? "on" : "off",
    "--host",
    "127.0.0.1",
    "--port",
    String(config.llamacppPort),
    "--alias",
    alias
  ];
  if (config.llamacppNcpuMoe > 0) {
    args.push("--n-cpu-moe", String(config.llamacppNcpuMoe));
  }
  return args;
}

export class LlamaCppServer {
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private child: ChildProcess | null = null;
  private state: LlamaCppState = "stopped";
  private activeLaunch: LlamaCppLaunch | null = null;
  private lastError: string | null = null;
  private logTail: string[] = [];
  private stopping = false;

  constructor(config: AppConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private get logFile(): string {
    return path.join(this.config.dataDir, "llamacpp-server.log");
  }

  private get pidFile(): string {
    return path.join(this.config.dataDir, "llamacpp-server.pid");
  }

  private writePid(pid: number | undefined): void {
    if (pid == null) return;
    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      fs.writeFileSync(this.pidFile, String(pid), "utf8");
    } catch {
      // A missing PID file only affects stale-process cleanup.
    }
  }

  private removePid(): void {
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      // The file may already be gone.
    }
  }

  /**
   * A force-killed dashboard cannot run its close hook. On the next start,
   * stop only a process that still matches the configured executable, model,
   * and port, so a recycled PID is not killed by accident.
   */
  async cleanupStale(): Promise<void> {
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(this.pidFile, "utf8").trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      this.removePid();
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      this.removePid();
      return;
    }
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5_000
    });
    const commandLine = String(probe.stdout ?? "");
    const expected = this.config.llamacppModelPath ? path.resolve(this.config.llamacppModelPath) : "";
    const matches =
      commandLine.includes("llama-server") &&
      commandLine.includes(`--port ${this.config.llamacppPort}`) &&
      (expected ? commandLine.toLowerCase().includes(expected.toLowerCase()) : false);
    if (matches) {
      try {
        process.kill(pid);
      } catch {
        // The process may have exited between the probe and the kill.
      }
    }
    this.removePid();
  }

  private trimLog(): void {
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size > 512_000) {
        const text = fs.readFileSync(this.logFile, "utf8").slice(-256_000);
        fs.writeFileSync(this.logFile, text, "utf8");
      }
    } catch {
      // The log does not exist yet.
    }
  }

  private appendLog(chunk: Buffer | string): void {
    const text = String(chunk);
    this.logTail.push(...text.split(/\r?\n/).filter(Boolean));
    if (this.logTail.length > 30) this.logTail = this.logTail.slice(-30);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, text, "utf8");
    } catch {
      // A logging failure must not take down the server.
    }
  }

  private async isHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.config.llamacppPort}/health`, {
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async hasLlamaCppModelList(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${this.config.llamacppPort}/v1/models`, {
        signal: controller.signal
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { data?: unknown };
      return Array.isArray(payload.data);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private updateFromHealth(healthy: boolean): void {
    if (healthy) {
      this.state = this.child ? "running" : "external";
      this.lastError = null;
    } else if (this.state === "external" || this.state === "running") {
      this.state = this.child ? "error" : "stopped";
    }
  }

  async refresh(): Promise<LlamaCppStatus> {
    if (this.child && this.restartRequired()) {
      // The process is healthy on its old launch; probing the new port would
      // report a false failure until the operator restarts it.
      this.state = "running";
      return this.snapshot();
    }
    const healthy = this.child ? await this.isHealthy() : false;
    if (healthy) {
      this.state = "running";
      this.lastError = null;
    } else if (this.child) {
      this.state = "error";
    } else if (await this.hasLlamaCppModelList()) {
      this.state = "external";
      this.lastError = null;
    } else {
      this.state = "stopped";
    }
    return this.snapshot();
  }

  private launchConfig(): LlamaCppLaunch | null {
    const modelPath = this.config.llamacppModelPath;
    const model = this.config.llmModel?.trim();
    if (!modelPath || !model) return null;
    return {
      exe: this.config.llamacppExe,
      modelPath: path.resolve(modelPath),
      port: this.config.llamacppPort,
      model,
      contextTokens: this.config.llmContextTokens,
      gpuLayers: this.config.llmGpuLayers,
      ncpuMoe: this.config.llamacppNcpuMoe,
      kvCache: this.config.llamacppKvCache,
      flashAttn: this.config.llamacppFlashAttn
    };
  }

  private sameLaunch(a: LlamaCppLaunch, b: LlamaCppLaunch): boolean {
    return (
      a.exe === b.exe &&
      a.modelPath === b.modelPath &&
      a.port === b.port &&
      a.model === b.model &&
      a.contextTokens === b.contextTokens &&
      a.gpuLayers === b.gpuLayers &&
      a.ncpuMoe === b.ncpuMoe &&
      a.kvCache === b.kvCache &&
      a.flashAttn === b.flashAttn
    );
  }

  private restartRequired(): boolean {
    if (!this.child || !this.activeLaunch) return false;
    const next = this.launchConfig();
    return next == null || !this.sameLaunch(this.activeLaunch, next);
  }

  snapshot(): LlamaCppStatus {
    return {
      state: this.state,
      managed: Boolean(this.child),
      healthy: this.state === "running" || this.state === "external",
      restartRequired: this.restartRequired(),
      pid: this.child?.pid ?? null,
      port: this.config.llamacppPort,
      exe: this.config.llamacppExe,
      modelPath: this.config.llamacppModelPath,
      autostart: this.config.llamacppAutostart,
      lastError: this.lastError,
      logTail: this.logTail.slice(-12)
    };
  }

  private validatePaths(): void {
    if (!this.config.llamacppModelPath) throw new Error("Choose a model file for llama.cpp first.");
    if (!fs.existsSync(this.config.llamacppModelPath) || !fs.statSync(this.config.llamacppModelPath).isFile()) {
      throw new Error(`Model file not found: ${this.config.llamacppModelPath}`);
    }
    const exe = this.config.llamacppExe;
    if ((exe.includes("\\") || exe.includes("/")) && (!fs.existsSync(exe) || !fs.statSync(exe).isFile())) {
      throw new Error(`llama-server executable not found: ${exe}`);
    }
    if (!this.config.llmModel?.trim()) throw new Error("Choose a model alias for llama.cpp first.");
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return true;
      if (this.child?.exitCode != null) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  async start(): Promise<LlamaCppStatus> {
    if (this.child) return this.snapshot();
    if (await this.hasLlamaCppModelList()) {
      this.state = "external";
      this.lastError = null;
      return this.snapshot();
    }
    this.validatePaths();
    this.trimLog();
    this.state = "starting";
    this.lastError = null;
    this.logTail = [];
    const args = buildLlamaCppArgs(this.config);
    let child: ChildProcess;
    try {
      child = spawn(this.config.llamacppExe, args, {
        cwd: this.config.projectRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.child = child;
    this.writePid(child.pid);
    child.stdout?.on("data", (chunk: Buffer) => this.appendLog(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendLog(chunk));
    child.on("exit", (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      this.activeLaunch = null;
      this.removePid();
      this.stopping = false;
      if (wasStopping) {
        this.state = "stopped";
        return;
      }
      this.state = "error";
      this.lastError = `llama-server exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`;
    });
    const healthy = await this.waitForHealth(60_000);
    if (!healthy) {
      const message = this.lastError ?? "llama-server did not answer its health check within 60 seconds.";
      await this.stop().catch(() => undefined);
      this.state = "error";
      this.lastError = message;
      throw new Error(message);
    }
    this.state = "running";
    this.activeLaunch = this.launchConfig();
    return this.snapshot();
  }

  async stop(): Promise<LlamaCppStatus> {
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      return this.snapshot();
    }
    this.stopping = true;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.kill();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([exited, timeout]);
    if (this.child) {
      this.child.kill("SIGKILL");
      this.child = null;
    }
    this.state = "stopped";
    this.activeLaunch = null;
    this.removePid();
    this.lastError = null;
    this.stopping = false;
    return this.snapshot();
  }

  async restart(): Promise<LlamaCppStatus> {
    await this.stop();
    return this.start();
  }
}
