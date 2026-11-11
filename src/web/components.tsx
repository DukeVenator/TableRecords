import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { Job, LlmSummaryResult, Marker, RecentContextResult, Speaker } from "./types";
import { MarkdownView } from "./markdown";
import {
  formatBytes,
  formatEta,
  formatLength,
  formatRelative,
  formatTime,
  jobLabel,
  jobStageLabel,
  jobStatusLabel,
  markerLabel,
  statusTone,
  summaryPresetLabel,
  summaryScopeLabel
} from "./format";

export function Pill({ tone = "idle", children }: { tone?: "ok" | "warn" | "bad" | "idle"; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Button({
  children,
  variant = "default",
  disabled,
  onClick,
  type = "button",
  title
}: {
  children: ReactNode;
  variant?: "default" | "primary" | "danger" | "ghost" | "small" | "small danger" | "small primary" | "ghost small";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button type={type} className={`btn ${variant}`} disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = ""
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className = ""
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const direct = isValidElement(children) && typeof children.type === "string" && ["input", "select", "textarea"].includes(children.type);
  const control = direct
    ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, { "aria-label": label })
    : children;
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {control}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/** Progressive disclosure for the technical half of a screen. */
export function Disclosure({
  summary,
  children,
  className = "",
  open
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details className={`disclosure ${className}`} open={open}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Warnings({ warnings }: { warnings: Array<{ code: string; message: string }> }) {
  if (warnings.length === 0) return null;
  return (
    <div className="warnings">
      {warnings.slice(0, 8).map((warning, index) => (
        <div className="warning" key={`${warning.code}-${index}`} title={warning.code}>
          <span>{warning.message}</span>
        </div>
      ))}
    </div>
  );
}

export function SpeakerTable({ speakers }: { speakers: Speaker[] }) {
  if (speakers.length === 0) {
    return <Empty title="No one is speaking yet">Join a voice channel and have someone speak.</Empty>;
  }
  const showErrors = speakers.some((speaker) => speaker.decryptionFailures > 0);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Participant</th>
            <th>Character</th>
            <th>Recorded</th>
            <th>Clips</th>
            <th>Last heard</th>
            {showErrors && <th>Decrypt errors</th>}
          </tr>
        </thead>
        <tbody>
          {speakers.map((speaker) => (
            <tr key={speaker.discordUserId}>
              <td>
                <span className={`speaking-dot ${speaker.speaking ? "on" : ""}`} aria-hidden="true" />
                <strong>{speaker.displayName}</strong>
                {speaker.speaking && <span className="muted tiny"> speaking</span>}
              </td>
              <td>{speaker.character || <span className="muted">not set</span>}</td>
              <td>
                {formatLength(speaker.capturedMs)}
                <div className="muted tiny">{formatBytes(speaker.bytes)}</div>
              </td>
              <td>{speaker.utteranceCount}</td>
              <td>{formatRelative(speaker.lastUtteranceAtMs)}</td>
              {showErrors && (
                <td className={speaker.decryptionFailures ? "bad-text" : "muted"}>{speaker.decryptionFailures}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MarkerBar({
  onAdd,
  disabled,
  label,
  onLabelChange
}: {
  onAdd: (kind: string, mentalNote?: boolean) => void;
  disabled?: boolean;
  label: string;
  onLabelChange: (value: string) => void;
}) {
  return (
    <div className="marker-bar">
      <input
        value={label}
        placeholder="Label this moment (optional)"
        onChange={(event) => onLabelChange(event.target.value)}
        maxLength={500}
        aria-label="Moment label"
      />
      <div className="marker-buttons">
        {["scene", "break", "combat", "note"].map((kind) => (
          <Button key={kind} variant="small" disabled={disabled} onClick={() => onAdd(kind)}>
            {markerLabel(kind)}
          </Button>
        ))}
        <Button variant="small primary" disabled={disabled} onClick={() => onAdd("note", true)}>
          ★ Note to self
        </Button>
      </div>
    </div>
  );
}

export interface Moment {
  key: string;
  tsMs: number;
  label: string;
  detail?: string;
  tone: "ok" | "warn" | "bad" | "idle";
  markerId?: string;
}

/** Markers and spoken notes on one line of time. */
export function MomentList({
  moments,
  timeZone,
  onDelete,
  empty = "Nothing marked yet."
}: {
  moments: Moment[];
  timeZone?: string;
  onDelete?: (markerId: string) => void;
  empty?: string;
}) {
  if (moments.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <div className="marker-list">
      {moments.map((moment) => (
        <div className="marker" key={moment.key}>
          <Pill tone={moment.tone}>{moment.label}</Pill>
          <span className="marker-text">{moment.detail || "—"}</span>
          <span className="muted tiny mono marker-time" title={formatRelative(moment.tsMs)}>{formatTime(moment.tsMs, timeZone)}</span>
          {onDelete && moment.markerId && (
            <Button variant="ghost small" onClick={() => onDelete(moment.markerId!)} title="Remove this marker">
              ×
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function markersToMoments(markers: Marker[], _now = Date.now()): Moment[] {
  return [...markers]
    .sort((a, b) => b.tsMs - a.tsMs)
    .map((marker) => ({
      key: marker.markerId,
      tsMs: marker.tsMs,
      label: marker.mentalNote ? "Note to self" : markerLabel(marker.kind),
      detail: marker.label,
      tone: marker.mentalNote ? ("warn" as const) : ("idle" as const),
      markerId: marker.markerId
    }))
    .slice(0, 30);
}

export function JobPanel({
  jobs,
  canProcess,
  busy,
  onEnqueue,
  onCancel,
  onRetry,
  onLogs,
  mode = "build"
}: {
  jobs: Job[];
  canProcess: boolean;
  busy: string | null;
  onEnqueue: (type: string) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onLogs: (jobId: string) => void;
  mode?: "build" | "history";
}) {
  const order: Record<string, number> = { running: 0, queued: 1 };
  const sorted = [...jobs].sort(
    (a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || b.createdAtMs - a.createdAtMs
  );
  const latest = sorted[0] ?? null;
  const earlier = sorted.slice(1);
  return (
    <div className="build-panel">
      {mode === "build" && (
        <>
          <div className="button-row build-actions">
            <Button variant="primary" disabled={!canProcess || Boolean(busy)} onClick={() => onEnqueue("run_all")}>
              Build notes
            </Button>
            <Button variant="small" disabled={!canProcess || Boolean(busy)} onClick={() => onEnqueue("transcribe")}>
              Speech only
            </Button>
            <Button variant="small" disabled={!canProcess || Boolean(busy)} onClick={() => onEnqueue("merge")}>
              Rolls only
            </Button>
            <Button variant="small" disabled={!canProcess || Boolean(busy)} onClick={() => onEnqueue("render")}>
              Files only
            </Button>
          </div>
          <p className="muted tiny build-hint">
            Build notes runs all three in order. The single steps exist for redoing one part without touching the others.
          </p>
          {!canProcess && <p className="muted small">You can build notes once the recording is saved.</p>}
        </>
      )}
      {latest ? (
        <div className="job-list">
          <JobRow job={latest} busy={busy} onCancel={onCancel} onRetry={onRetry} onLogs={onLogs} />
        </div>
      ) : (
        <Empty title="Nothing built yet">
          {mode === "build" ? "Build notes after the recording is saved." : "No builds for this session."}
        </Empty>
      )}
      {earlier.length > 0 && (
        <Disclosure summary={`Earlier builds (${earlier.length})`}>
          <div className="job-list">
            {earlier.map((job) => (
              <JobRow key={job.jobId} job={job} busy={busy} onCancel={onCancel} onRetry={onRetry} onLogs={onLogs} />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function JobRow({
  job,
  busy,
  onCancel,
  onRetry,
  onLogs
}: {
  job: Job;
  busy: string | null;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onLogs: (jobId: string) => void;
}) {
  const active = job.status === "running" || job.status === "queued";
  const stages = job.type === "run_all" ? ["transcribe", "merge", "render"] : job.type === "context" ? ["transcribe", "context"] : [];
  const stageIndex =
    job.progress.stageIndex ??
    (stages.indexOf(job.progress.phase) >= 0 ? stages.indexOf(job.progress.phase) + 1 : 0);
  const detail =
    job.status === "done"
      ? `Finished ${formatRelative(job.finishedAtMs ?? job.createdAtMs)}`
      : job.status === "failed"
        ? (job.error?.message ?? "Build failed")
        : job.status === "cancelled"
          ? "Stopped"
          : (job.progress.detail ?? "Waiting…");
  return (
    <div className={`job ${active ? "job-active" : ""}`}>
      <div className="job-main">
        <div className="job-title">
          <strong>{jobLabel(job.type)}</strong>
          <Pill tone={statusTone(job.status)}>{jobStatusLabel(job.status)}</Pill>
          {job.status === "queued" && job.progress.queuePosition != null && (
            <span className="muted tiny">next</span>
          )}
          {job.status === "running" && <span className="muted tiny">{Math.round(job.progress.percent)}%</span>}
        </div>
        {stages.length > 1 && (
          <div className="job-stages">
            {stages.map((stage, index) => (
              <span
                key={stage}
                className={`job-stage ${job.status === "done" || index + 1 < stageIndex ? "done" : ""} ${
                  index + 1 === stageIndex && active ? "current" : ""
                }`}
              >
                {jobStageLabel(stage)}
              </span>
            ))}
          </div>
        )}
        <div className="job-detail">{detail}</div>
        {active && (
          <div className="progress">
            <span style={{ width: `${Math.max(0, Math.min(100, job.progress.percent || 0))}%` }} />
          </div>
        )}
        {job.status === "running" && job.progress.etaMs != null && (
          <div className="job-meta muted tiny">{formatEta(job.progress.etaMs)}</div>
        )}
      </div>
      <div className="job-actions">
        <Button variant="small" onClick={() => onLogs(job.jobId)}>
          Details
        </Button>
        {active && (
          <Button variant="small danger" disabled={Boolean(busy)} onClick={() => onCancel(job.jobId)}>
            Stop
          </Button>
        )}
        {["failed", "cancelled", "done"].includes(job.status) && (
          <Button variant="small" disabled={Boolean(busy)} onClick={() => onRetry(job.jobId)}>
            Run again
          </Button>
        )}
      </div>
    </div>
  );
}

let lastFocusedElement: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      if (event.target instanceof HTMLElement && event.target !== document.body) {
        lastFocusedElement = event.target;
      }
    },
    true
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : lastFocusedElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => element.offsetParent !== null);

    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected && !(previous instanceof HTMLButtonElement && previous.disabled)) {
        previous.focus();
      }
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function LogView({ lines }: { lines: Array<{ seq: number; tsMs: number; level: string; line: string }> }) {
  if (lines.length === 0) return <Empty title="No log lines yet" />;
  return (
    <pre className="log">
      {lines.map((line) => (
        <div key={line.seq} className={`log-line ${line.level.toLowerCase()}`}>
          <span className="log-seq">{line.seq}</span>
          <span className="log-level">{line.level}</span>
          <span>{line.line}</span>
        </div>
      ))}
    </pre>
  );
}

export function RecentContextModal({ result, onClose }: { result: RecentContextResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopyError("Clipboard access was blocked; select the text below and copy manually.");
    }
  };
  const download = () => {
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tablerecords-recent-${result.sessionId}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const transcription = result.transcription;
  return (
    <Modal title={`Session brief — ${result.window.label}`} onClose={onClose}>
      <div className="recent-context-meta">
        <span>{result.counts.events} moments</span>
        <span>{result.counts.speech} lines of speech</span>
        <span>{result.counts.rolls} rolls</span>
        <span>{result.counts.mentalNotes} notes</span>
        <span>{result.counts.rollsWithVoiceContext} rolls with speech</span>
        {(result.counts.optedOut ?? 0) > 0 && <span className="warn-text">{result.counts.optedOut} opted out / not recorded</span>}
        {transcription.transcribed > 0 && <span className="ok-text">+{transcription.transcribed} newly transcribed</span>}
        {transcription.failed > 0 && <span className="bad-text">{transcription.failed} failed</span>}
      </div>
      {transcription.skippedReason === "no_captured_audio" && (
        <p className="muted small">Nothing was recorded in this window yet. Wait for someone to speak, then try again.</p>
      )}
      {transcription.skippedReason === "silent_clips" && (
        <p className="muted small">Everything in this window was too quiet to transcribe.</p>
      )}
      {transcription.errors.length > 0 && (
        <div className="warnings">
          {transcription.errors.slice(0, 4).map((error, index) => (
            <div className="warning" key={index}>
              <span className="warning-code">speech</span>
              <span>{error}</span>
            </div>
          ))}
        </div>
      )}
      <div className="button-row">
        <Button variant="primary" onClick={() => void copy()}>
          {copied ? "Copied ✓" : "Copy for your AI assistant"}
        </Button>
        <Button onClick={download}>Download .md</Button>
      </div>
      {copyError && <p className="warn-text small">{copyError}</p>}
      <textarea className="recent-context-text" readOnly value={result.markdown} rows={22} onFocus={(event) => event.target.select()} />
    </Modal>
  );
}

export function LlmSummaryModal({ result, onClose }: { result: LlmSummaryResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.summary);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 3000);
    } catch {
      // The summary is selectable if the clipboard is blocked.
    }
  };
  const structured = result.structured as
    | {
        situation?: string;
        npcs?: Array<{ name: string; note: string }>;
        clues?: string[];
        threads?: string[];
        reminders?: string[];
      }
    | null;
  const provider = result.provider === "deepseek" ? "DeepSeek" : result.provider === "ollama" ? "Ollama" : result.provider === "llamacpp" ? "llama.cpp" : "Local model";
  return (
    <Modal title={`AI summary — ${result.window.label}`} onClose={onClose}>
      <p className="muted small">
        {summaryPresetLabel(result.preset)} · {provider} <span className="mono">{result.model}</span> ·{" "}
        {(result.elapsedMs / 1000).toFixed(1)}s · {result.estimatedTokens.toLocaleString()} estimated tokens
        {result.chunks > 1 ? ` · ${result.chunks} portions` : result.trimmed ? " · brief trimmed" : ""}
      </p>
      <p className="muted small">
        Scope: {summaryScopeLabel(result.scope)} · saved {formatRelative(result.createdAtMs)}. Check it before use.
      </p>
      {result.trimmed && (
        <p className="warn-text small">
          Some source material was trimmed to fit the model context
          {result.portionsTrimmed ? `, including ${result.portionsTrimmed} dense portion${result.portionsTrimmed === 1 ? "" : "s"}` : ""}.
          Later events or notes may be missing.
        </p>
      )}
      {(result.coverage?.missing.length ?? 0) > 0 && (
        <p className="warn-text small">
          The coverage check still could not find {result.coverage!.missing.length} required
          {result.coverage!.missing.length === 1 ? " fact" : " facts"}. Check the notes against the transcript.
        </p>
      )}
      <div className="button-row">
        <Button onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy summary"}</Button>
      </div>
      {structured ? (
        <div className="llm-structured">
          <h3>Current situation</h3>
          <p>{structured.situation || "No situation recorded."}</p>
          <h3>People</h3>
          {structured.npcs && structured.npcs.length > 0 ? (
            <ul>
              {structured.npcs.map((npc, index) => (
                <li key={`${npc.name}-${index}`}>
                  <strong>{npc.name}</strong>
                  {npc.note ? ` — ${npc.note}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No people listed.</p>
          )}
          {(["clues", "threads", "reminders"] as const).map((key) => (
            <div key={key}>
              <h3>{key === "clues" ? "Clues" : key === "threads" ? "Open threads" : "Reminders"}</h3>
              {structured[key] && structured[key]!.length > 0 ? (
                <ul>
                  {structured[key]!.map((item, index) => (
                    <li key={`${key}-${index}`}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Nothing listed.</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="llm-summary-rendered">
          <MarkdownView text={result.summary} />
        </div>
      )}
      <details className="disclosure">
        <summary>Raw model response</summary>
        <pre className="preview llm-summary">{result.summary}</pre>
      </details>
    </Modal>
  );
}
