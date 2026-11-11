#!/usr/bin/env python
"""TableRecords faster-whisper batch transcriber.

stdout protocol is JSON Lines only:
  {"type":"start",...}
  {"type":"progress","done":N,"total":N,"utteranceId":...}
  {"type":"error","utteranceId":...,"code":...,"message":...}
  {"type":"done","written":N,"errors":N}

Library logs go to stderr. This process never controls Discord, Foundry, the
database, or job sequencing; it reads WAV jobs and writes transcript JSONL.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import site
import sys
import time
from pathlib import Path
from typing import Any

_DLL_HANDLES: list[object] = []


def add_dll_dirs() -> list[str]:
    candidates: list[Path] = []
    try:
        packages = site.getsitepackages()
        site_packages = next(
            (Path(item) for item in packages if item.replace("\\", "/").endswith("site-packages")),
            Path(packages[-1]),
        )
    except Exception:
        site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    for package_dir in ("cudnn", "cublas", "cuda_runtime"):
        candidates.append(site_packages / "nvidia" / package_dir / "bin")
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        candidates.append(Path(cuda_path) / "bin")
    for version in ("12.5", "12.6", "12.4", "12.3"):
        candidates.append(Path(rf"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v{version}\bin"))
    used: list[str] = []
    for directory in candidates:
        if not directory.is_dir():
            continue
        try:
            _DLL_HANDLES.append(os.add_dll_directory(str(directory)))
        except (AttributeError, OSError):
            pass
        os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
        used.append(str(directory))
    return used


def emit(obj: dict[str, Any]) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def clamp(value: int, low: int, high: int) -> tuple[int, bool]:
    if value < low:
        return low, True
    if value > high:
        return high, True
    return value, False


def read_lines(path: str | None) -> list[str]:
    if not path:
        return []
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError:
        return []
    return [line.strip() for line in raw.replace("\r", "\n").split("\n") if line.strip()]


def load_jobs(path: Path) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on jobs.jsonl line {line_number}: {exc}") from exc
            if item.get("schema") != "tablerecords.stt-job/v1":
                raise ValueError(f"Unsupported job schema on line {line_number}")
            jobs.append(item)
    return jobs


def resolve_audio(root: Path, audio_file: str) -> Path:
    if Path(audio_file).is_absolute():
        raise ValueError("audioFile must be relative to the session directory")
    candidate = (root / audio_file).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError("audioFile escapes the session directory") from exc
    return candidate


def transcribe_one(model: Any, job: dict[str, Any], prompt: str, hotwords: str) -> dict[str, Any]:
    audio_path = Path(job["_audio_path"])
    start_ms = int(job["startMs"])
    end_ms = int(job["endMs"])
    if end_ms <= start_ms:
        raise ValueError(f"Invalid utterance window: {start_ms}..{end_ms}")
    per_job_prompt = str(job.get("prompt") or prompt or "")
    job_hotwords = job.get("hotwords")
    if isinstance(job_hotwords, list):
        hotword_text = ", ".join(str(item) for item in job_hotwords if str(item).strip())
    else:
        hotword_text = hotwords
    no_speech_threshold = float(job.get("noSpeechThreshold", 0.6))
    log_prob_threshold = float(job.get("logProbThreshold", -1.0))
    compression_ratio_threshold = float(job.get("compressionRatioThreshold", 2.4))
    kwargs: dict[str, Any] = {
        "language": str(job.get("language") or "en"),
        "beam_size": int(job.get("beamSize") or 5),
        "word_timestamps": bool(job.get("wordTimestamps", True)),
        "vad_filter": bool(job.get("vadFilter", False)),
        "condition_on_previous_text": False,
        "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        "no_speech_threshold": no_speech_threshold,
        "log_prob_threshold": log_prob_threshold,
        "compression_ratio_threshold": compression_ratio_threshold,
    }
    duration_seconds = max(0.0, (end_ms - start_ms) / 1000)
    if duration_seconds > 0:
        # The WAV and manifest should agree. Clipping protects against trailing
        # bytes/silence if a file was reconstructed or replaced after capture.
        kwargs["clip_timestamps"] = f"0,{duration_seconds:.3f}"
    if per_job_prompt:
        kwargs["initial_prompt"] = per_job_prompt
    if hotword_text:
        kwargs["hotwords"] = hotword_text
    try:
        segments, info = model.transcribe(str(audio_path), **kwargs)
    except TypeError:
        # Older/newer faster-whisper variants may not accept hotwords.
        kwargs.pop("hotwords", None)
        segments, info = model.transcribe(str(audio_path), **kwargs)

    segment_list = list(segments)
    raw_text = " ".join(segment.text.strip() for segment in segment_list if segment.text).strip()
    flags: list[str] = []
    if not raw_text:
        flags.append("empty")

    avg_values = [float(segment.avg_logprob) for segment in segment_list if getattr(segment, "avg_logprob", None) is not None]
    no_speech_values = [
        float(segment.no_speech_prob) for segment in segment_list if getattr(segment, "no_speech_prob", None) is not None
    ]
    compression_values = [
        float(segment.compression_ratio)
        for segment in segment_list
        if getattr(segment, "compression_ratio", None) is not None
    ]
    avg_logprob = sum(avg_values) / len(avg_values) if avg_values else None
    no_speech_prob = max(no_speech_values) if no_speech_values else None
    compression_ratio = max(compression_values) if compression_values else None
    if no_speech_prob is not None and no_speech_prob > no_speech_threshold and avg_logprob is not None and avg_logprob < log_prob_threshold:
        flags.append("no_speech")
    if compression_ratio is not None and compression_ratio > compression_ratio_threshold:
        flags.append("repetitive")

    words: list[dict[str, Any]] = []
    previous_end = start_ms
    clamped_any = False
    non_monotonic = False
    for segment in segment_list:
        for word in getattr(segment, "words", None) or []:
            rel_start = int(round(float(word.start) * 1000))
            rel_end = int(round(float(word.end) * 1000))
            abs_start, clamped_start = clamp(start_ms + rel_start, start_ms, end_ms)
            abs_end, clamped_end = clamp(start_ms + rel_end, start_ms, end_ms)
            if clamped_start or clamped_end:
                clamped_any = True
            if abs_start < previous_end:
                non_monotonic = True
            previous_end = max(previous_end, abs_end)
            words.append(
                {
                    "word": str(word.word).strip(),
                    "startMs": abs_start,
                    "endMs": abs_end,
                    "probability": round(float(word.probability), 4) if word.probability is not None else None,
                }
            )
    if clamped_any:
        flags.append("offset_clamped")
    if non_monotonic:
        flags.append("timestamp_suspicious")

    duration_ms = max(0, end_ms - start_ms)
    if duration_ms < 250:
        if avg_logprob is None or avg_logprob < -0.8:
            flags.append("short_low_confidence")

    boilerplate = (
        "thanks for watching",
        "subscribe",
        "subtitles by",
        "amara.org",
        "please subscribe",
    )
    lowered = raw_text.lower()
    if raw_text and any(phrase in lowered for phrase in boilerplate):
        if len(raw_text.split()) <= 8 and (avg_logprob is None or avg_logprob < -0.5):
            flags.append("boilerplate")

    language = str(getattr(info, "language", None) or job.get("language") or "en")
    language_probability = getattr(info, "language_probability", None)
    return {
        "schema": "tablerecords.transcript/v1",
        "sessionId": job["sessionId"],
        "utteranceId": job["utteranceId"],
        "sttJobId": job["sttJobId"],
        "batchJobId": job["batchJobId"],
        "discordUserId": job["discordUserId"],
        "speaker": job.get("speakerLabel") or job["discordUserId"],
        "character": job.get("character"),
        "text": raw_text,
        "rawText": raw_text,
        "corrections": [],
        "startMs": start_ms,
        "endMs": end_ms,
        "words": words,
        "stt": {
            "engine": "faster-whisper",
            "engineVersion": getattr(__import__("faster_whisper"), "__version__", "unknown"),
            "model": str(job.get("model") or ""),
            "device": str(job.get("device") or ""),
            "computeType": str(job.get("computeType") or ""),
            "language": language,
            "languageProbability": round(float(language_probability), 4)
            if language_probability is not None
            else None,
            "avgLogprob": round(avg_logprob, 4) if avg_logprob is not None else None,
            "noSpeechProb": round(no_speech_prob, 4) if no_speech_prob is not None else None,
        },
        "flags": flags,
        "createdAtMs": int(time.time() * 1000),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--errors", required=True)
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--language", default="en")
    parser.add_argument("--prompt-file")
    parser.add_argument("--hotwords-file")
    parser.add_argument("--download-root", default=str(Path("models") / "faster-whisper"))
    parser.add_argument("--local-files-only", action="store_true")
    args = parser.parse_args()

    jobs_path = Path(args.jobs).resolve()
    session_root = jobs_path.parent.parent
    prompt_lines = read_lines(args.prompt_file)
    prompt = " ".join(prompt_lines)[:1200]
    hotwords = ", ".join(read_lines(args.hotwords_file))
    jobs = load_jobs(jobs_path)
    for job in jobs:
        job["_audio_path"] = str(resolve_audio(session_root, str(job["audioFile"])))

    emit(
        {
            "type": "start",
            "total": len(jobs),
            "model": args.model,
            "device": args.device,
            "computeType": args.compute_type,
            "dllDirs": add_dll_dirs(),
        }
    )

    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to import faster_whisper: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 2

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            download_root=str(Path(args.download_root).resolve()),
            local_files_only=bool(args.local_files_only),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to load model {args.model}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 3

    out_path = Path(args.out)
    errors_path = Path(args.errors)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    errors_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    errors = 0
    with out_path.open("w", encoding="utf-8", newline="\n") as out_handle, errors_path.open(
        "w", encoding="utf-8", newline="\n"
    ) as error_handle:
        for index, job in enumerate(jobs, start=1):
            try:
                audio_path = Path(job["_audio_path"])
                if not audio_path.is_file():
                    raise FileNotFoundError(f"Audio file not found: {audio_path.name}")
                record = transcribe_one(model, job, prompt, hotwords)
                out_handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                out_handle.flush()
                written += 1
                emit({"type": "progress", "done": index, "total": len(jobs), "utteranceId": job["utteranceId"]})
            except Exception as exc:  # noqa: BLE001
                errors += 1
                message = f"{type(exc).__name__}: {exc}"
                error_record = {
                    "schema": "tablerecords.transcript-error/v1",
                    "sessionId": job.get("sessionId"),
                    "utteranceId": job.get("utteranceId"),
                    "sttJobId": job.get("sttJobId"),
                    "batchJobId": job.get("batchJobId"),
                    "code": "audio_decode_failed" if "Audio" in message or "decode" in message.lower() else "transcribe_failed",
                    "message": message,
                    "createdAtMs": int(time.time() * 1000),
                }
                error_handle.write(json.dumps(error_record, ensure_ascii=False) + "\n")
                error_handle.flush()
                emit(
                    {
                        "type": "error",
                        "utteranceId": job.get("utteranceId"),
                        "code": error_record["code"],
                        "message": message,
                    }
                )
                emit({"type": "progress", "done": index, "total": len(jobs), "utteranceId": job.get("utteranceId")})
    emit({"type": "done", "written": written, "errors": errors})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
