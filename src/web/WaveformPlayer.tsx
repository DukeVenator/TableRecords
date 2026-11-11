import { useEffect, useRef, useState, type MouseEvent } from "react";
import { humanMessage } from "./errors";

const HEIGHT = 82;

export interface WaveformSegment {
  startMs: number;
  endMs: number;
  color: string;
  label?: string;
}

export interface WaveformMarker {
  offsetMs: number;
  label: string;
  kind: string;
  color?: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function parseColor(value: string | undefined): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec((value ?? "").trim());
  if (!match) return [120, 140, 158];
  const number = Number.parseInt(match[1]!, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

export function WaveformPlayer(props: {
  src: string;
  label: string;
  detail: string;
  durationMs: number;
  color: string;
  waveformSrc?: string;
  segments?: WaveformSegment[];
  markers?: WaveformMarker[];
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, props.durationMs / 1000));
  const [width, setWidth] = useState(640);

  useEffect(() => {
    setImage(null);
    setImageError(null);
    if (!props.waveformSrc) return;
    let cancelled = false;
    const element = new Image();
    element.decoding = "async";
    element.onload = () => {
      if (!cancelled) setImage(element);
    };
    element.onerror = () => {
      if (!cancelled) setImageError("cached waveform unavailable");
    };
    element.src = props.waveformSrc;
    return () => {
      cancelled = true;
    };
  }, [props.waveformSrc]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 640;
      setWidth(Math.max(120, Math.round(next)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrent(audio.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Turn the cached white-on-black waveform into a coloured mask once per
  // width/segment change. The expensive decode happened in ffmpeg on the server.
  useEffect(() => {
    if (!image || duration <= 0 || width <= 0) {
      maskRef.current = null;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = Math.max(1, Math.round(width * dpr));
    const canvasHeight = Math.max(1, Math.round(HEIGHT * dpr));
    const mask = document.createElement("canvas");
    mask.width = canvasWidth;
    mask.height = canvasHeight;
    const context = mask.getContext("2d");
    if (!context) return;
    const source = document.createElement("canvas");
    source.width = canvasWidth;
    source.height = canvasHeight;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) return;
    sourceContext.drawImage(image, 0, 0, canvasWidth, canvasHeight);
    const pixels = sourceContext.getImageData(0, 0, canvasWidth, canvasHeight);
    const output = context.createImageData(canvasWidth, canvasHeight);
    const segments = [...(props.segments ?? [])].sort((a, b) => a.startMs - b.startMs);
    const base = parseColor(props.color);
    let segmentIndex = 0;
    let segmentColor = base;
    for (let x = 0; x < canvasWidth; x += 1) {
      const timeMs = (x / canvasWidth) * duration * 1000;
      while (segmentIndex < segments.length && segments[segmentIndex]!.endMs < timeMs) segmentIndex += 1;
      const active = segments[segmentIndex];
      segmentColor =
        active && timeMs >= active.startMs && timeMs <= active.endMs ? parseColor(active.color) : base;
      for (let y = 0; y < canvasHeight; y += 1) {
        const at = (y * canvasWidth + x) * 4;
        const luminance = (pixels.data[at]! + pixels.data[at + 1]! + pixels.data[at + 2]!) / 3;
        if (luminance < 10) continue;
        output.data[at] = segmentColor[0];
        output.data[at + 1] = segmentColor[1];
        output.data[at + 2] = segmentColor[2];
        output.data[at + 3] = Math.min(255, Math.max(90, Math.round(luminance * 1.35)));
      }
    }
    context.putImageData(output, 0, 0);
    maskRef.current = mask;
  }, [image, duration, width, props.segments, props.color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, HEIGHT);
    context.fillStyle = "#0b121a";
    context.fillRect(0, 0, width, HEIGHT);

    const mask = maskRef.current;
    const playedX = duration > 0 ? (current / duration) * width : 0;
    if (mask) {
      context.globalAlpha = 0.58;
      context.drawImage(mask, 0, 0, width, HEIGHT);
      context.save();
      context.beginPath();
      context.rect(0, 0, playedX, HEIGHT);
      context.clip();
      context.globalAlpha = 1;
      context.drawImage(mask, 0, 0, width, HEIGHT);
      context.restore();
      context.globalAlpha = 1;
    } else {
      context.fillStyle = "#1d2b38";
      context.fillRect(0, HEIGHT / 2 - 1, width, 2);
    }

    for (const marker of props.markers ?? []) {
      const x = duration > 0 ? (marker.offsetMs / 1000 / duration) * width : 0;
      if (x < 0 || x > width) continue;
      context.strokeStyle = marker.color ?? "#f5b942";
      context.globalAlpha = 0.9;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, HEIGHT);
      context.stroke();
      context.globalAlpha = 1;
    }

    if (playedX > 0) {
      context.fillStyle = "rgba(255,255,255,0.9)";
      context.fillRect(playedX, 0, 1, HEIGHT);
    }
  }, [image, current, duration, width, props.markers]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        setAudioError(null);
        await audio.play();
        setPlaying(true);
      } catch (error) {
        setPlaying(false);
        setAudioError(humanMessage(error, "The browser could not start playback"));
      }
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrent(audio.currentTime);
  };

  const seek = (event: MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    seekTo(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration);
  };

  return (
    <div className="waveform-player">
      <div className="waveform-head">
        <button className="btn small" type="button" onClick={() => void toggle()} aria-label={playing ? `Pause ${props.label}` : `Play ${props.label}`}>
          {playing ? "Pause" : "Play"}
        </button>
        <span className="waveform-time">{formatTime(current)} / {formatTime(duration)}</span>
        <span className="waveform-label">{props.label}</span>
        <span className="muted tiny">{props.detail}</span>
        {buffering && <span className="muted tiny">buffering…</span>}
      </div>
      <div className="waveform-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="waveform-canvas"
          onClick={seek}
          role="slider"
          aria-label={`${props.label} waveform`}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              seekTo(Math.min(duration, (audioRef.current?.currentTime ?? 0) + 5));
            } else if (event.key === "ArrowLeft") {
              seekTo(Math.max(0, (audioRef.current?.currentTime ?? 0) - 5));
            } else if (event.key === " ") {
              event.preventDefault();
              void toggle();
            }
          }}
        />
        <div className="waveform-times">
          <span>0:00</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
      {props.markers && props.markers.length > 0 && (
        <div className="waveform-bookmarks" aria-label="Session bookmarks">
          {props.markers.map((marker, index) => (
            <button
              key={`${marker.offsetMs}-${marker.label}-${index}`}
              type="button"
              onClick={() => seekTo(marker.offsetMs / 1000)}
              title={`Jump to ${marker.label}`}
            >
              <span style={{ background: marker.color ?? "#f5b942" }} />
              {formatTime(marker.offsetMs / 1000)} {marker.label}
            </button>
          ))}
        </div>
      )}
      {imageError ? (
        <p className="muted tiny">Waveform unavailable ({imageError}); audio still plays.</p>
      ) : !image ? (
        <p className="muted tiny">Building cached waveform… audio playback is ready.</p>
      ) : null}
      {audioError && (
        <p className="bad-text tiny">
          Playback error: {audioError}. <a href={props.src} download>Download the track</a> if the browser refuses it.
        </p>
      )}
      <audio
        ref={audioRef}
        src={props.src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onEnded={() => setPlaying(false)}
        onError={(event) => {
          const code = event.currentTarget.error?.code;
          const message = event.currentTarget.error?.message;
          setAudioError(message || (code === 4 ? "the audio source is not supported" : `media error ${code ?? "unknown"}`));
        }}
      />
    </div>
  );
}

