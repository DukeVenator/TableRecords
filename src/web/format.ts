export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":");
}

/** Human length for a whole recording: "48s", "12m 05s", "3h 51m". */
export function formatLength(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(ms ?? 0) / 1000));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Compact "how long ago" for live status. */
export function formatRelative(ms: number | null | undefined, nowMs = Date.now()): string {
  if (!ms) return "—";
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatTime(ms: number | null | undefined, timeZone?: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: timeZone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

export function formatDateTime(ms: number | null | undefined, timeZone?: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** Date only, for session headers where the time is noise. */
export function formatDate(ms: number | null | undefined, timeZone?: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit"
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

export function statusTone(status: string): "ok" | "warn" | "bad" | "idle" {
  if (["ready", "recording", "connected", "done", "ok", "saved"].includes(status)) return "ok";
  if (["processing", "joining", "running", "queued", "connecting", "captured", "stopping"].includes(status)) return "warn";
  if (["error", "failed", "disconnected"].includes(status)) return "bad";
  return "idle";
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "unknown";
  return status.replaceAll("_", " ");
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  draft: "Not started",
  joining: "Connecting",
  recording: "Recording",
  stopping: "Finishing",
  processing: "Processing",
  ready: "Saved",
  error: "Needs attention"
};

export function sessionStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return SESSION_STATUS_LABELS[status] ?? statusLabel(status);
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  done: "Finished",
  failed: "Failed",
  cancelled: "Stopped"
};

export function jobStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return JOB_STATUS_LABELS[status] ?? statusLabel(status);
}

export function systemName(id: string | null | undefined): string {
  if (id === "starwarsffg") return "FFG narrative dice";
  if (id === "sfrpg") return "Starfinder";
  return id || "Unknown system";
}

const JOB_LABELS: Record<string, string> = {
  run_all: "Build notes",
  transcribe: "Transcribe speech",
  merge: "Attach rolls to speech",
  render: "Write note files",
  context: "Session brief"
};

export function jobLabel(type: string): string {
  return JOB_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1).replaceAll("_", " ");
}

const STAGE_LABELS: Record<string, string> = {
  transcribe: "Speech",
  merge: "Rolls",
  render: "Files",
  context: "Brief"
};

export function jobStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? jobLabel(stage);
}

const MARKER_LABELS: Record<string, string> = {
  scene: "Scene",
  break: "Break",
  combat: "Combat",
  note: "Note",
  mental_note: "Note to self"
};

export function markerLabel(kind: string): string {
  return MARKER_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

const SUMMARY_PRESET_LABELS: Record<string, string> = {
  recap: "Session recap",
  "gm-prep": "GM prep",
  "clue-board": "Clue board",
  rules: "Rules log"
};

export function summaryPresetLabel(preset: string): string {
  return SUMMARY_PRESET_LABELS[preset] ?? preset.charAt(0).toUpperCase() + preset.slice(1);
}

const SUMMARY_SCOPE_LABELS: Record<string, string> = {
  recent: "Recent",
  scene: "Current scene",
  session: "Whole session"
};

export function summaryScopeLabel(scope: string): string {
  return SUMMARY_SCOPE_LABELS[scope] ?? scope.charAt(0).toUpperCase() + scope.slice(1);
}

export function formatEta(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `~${seconds}s left`;
  return `~${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s left`;
}

const STT_STATE_LABELS: Record<string, string> = {
  ready: "ready",
  error: "error",
  model_missing: "model missing",
  cpu_only: "CPU only",
  unavailable: "not available"
};

/** Prose for the engine state code. */
export function sttStateLabel(state: string | null | undefined): string {
  if (!state) return "unknown";
  return STT_STATE_LABELS[state] ?? state.replaceAll("_", " ");
}

