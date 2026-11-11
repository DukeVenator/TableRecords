#!/usr/bin/env python
"""TableRecords Parakeet batch transcriber.

Uses NVIDIA's native nemo-speech CLI for one batch, so the 0.6B model is loaded
once. The stdout protocol is the same JSONL contract as transcribe_jobs.py.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from transcribe_jobs import clamp, emit, load_jobs, read_lines, resolve_audio


def run_version(binary: str) -> str:
    try:
        result = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=20)
        if result.returncode == 0:
            lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
            return lines[-1] if lines else "nemo-speech"
    except Exception:
        pass
    return "nemo-speech"


def parse_result(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if "text" in value or "words" in value:
            return value
        for key in ("result", "data", "transcription"):
            nested = value.get(key)
            if isinstance(nested, dict):
                return parse_result(nested)
    if isinstance(value, list) and value:
        return parse_result(value[0])
    return None


def record_for(job: dict[str, Any], data: dict[str, Any], model: str, device: str, version: str) -> dict[str, Any]:
    start_ms = int(job["startMs"])
    end_ms = int(job["endMs"])
    raw_text = str(data.get("text") or "").strip()
    words: list[dict[str, Any]] = []
    previous_end = start_ms
    clamped_any = False
    non_monotonic = False
    for item in data.get("words") or []:
        if not isinstance(item, dict):
            continue
        try:
            rel_start = int(round(float(item.get("start", 0)) * 1000))
            rel_end = int(round(float(item.get("end", 0)) * 1000))
        except (TypeError, ValueError):
            continue
        abs_start, clamped_start = clamp(start_ms + rel_start, start_ms, end_ms)
        abs_end, clamped_end = clamp(start_ms + rel_end, start_ms, end_ms)
        if clamped_start or clamped_end:
            clamped_any = True
        if abs_start < previous_end:
            non_monotonic = True
        previous_end = max(previous_end, abs_end)
        confidence = item.get("confidence")
        try:
            probability = round(float(confidence), 4) if confidence is not None else None
        except (TypeError, ValueError):
            probability = None
        words.append(
            {
                "word": str(item.get("word") or "").strip(),
                "startMs": abs_start,
                "endMs": abs_end,
                "probability": probability,
            }
        )
    flags: list[str] = []
    if not raw_text:
        flags.append("empty")
    if clamped_any:
        flags.append("offset_clamped")
    if non_monotonic:
        flags.append("timestamp_suspicious")
    language = str(data.get("language") or job.get("language") or "en")
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
            "engine": "parakeet",
            "engineVersion": version,
            "model": model,
            "device": device,
            "computeType": "q8_0",
            "language": language,
            "languageProbability": None,
            "avgLogprob": None,
            "noSpeechProb": None,
        },
        "flags": flags,
        "createdAtMs": int(time.time() * 1000),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--errors", required=True)
    parser.add_argument("--nemo-speech", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--language", default="en")
    parser.add_argument("--prompt-file")
    parser.add_argument("--hotwords-file")
    args = parser.parse_args()

    jobs_path = Path(args.jobs).resolve()
    session_root = jobs_path.parent.parent
    jobs = load_jobs(jobs_path)
    for job in jobs:
        job["_audio_path"] = str(resolve_audio(session_root, str(job["audioFile"])))
    hotwords = read_lines(args.hotwords_file)
    version = run_version(args.nemo_speech)
    emit({"type": "start", "total": len(jobs), "model": args.model, "device": args.device, "computeType": "q8_0", "engine": "parakeet"})

    if not Path(args.nemo_speech).is_file():
        print(f"nemo-speech not found: {args.nemo_speech}", file=sys.stderr, flush=True)
        return 2
    if not Path(args.model).is_file():
        print(f"Parakeet model not found: {args.model}", file=sys.stderr, flush=True)
        return 3

    out_path = Path(args.out)
    errors_path = Path(args.errors)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    errors_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    errors = 0

    with tempfile.TemporaryDirectory(prefix="tablerecords-parakeet-") as temp:
        work = Path(temp)
        input_dir = work / "input"
        output_dir = work / "output"
        input_dir.mkdir()
        output_dir.mkdir()
        for job in jobs:
            shutil.copy2(job["_audio_path"], input_dir / f"{job['utteranceId']}.wav")
        command = [
            args.nemo_speech,
            "transcribe",
            str(input_dir),
            "--model",
            args.model,
            "--format",
            "json",
            "--output-dir",
            str(output_dir),
            "--concurrency",
            str(max(1, args.concurrency)),
            "--device",
            args.device,
        ]
        if args.language:
            command.extend(["--language", args.language])
        for phrase in hotwords[:20]:
            command.extend(["--speech-context", phrase])
        emit({"type": "stage", "stage": "loading-model"})
        result = None
        result_stdout = ""
        returncode = -1
        timeout_timer: threading.Timer | None = None
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            current_done = 0
            progress_re = re.compile(r"\[(\d+)/(\d+)\]")
            stderr_tail: list[str] = []
            stdout_chunks: list[str] = []
            assert process.stderr is not None

            def drain_stdout() -> None:
                if process.stdout is not None:
                    stdout_chunks.append(process.stdout.read())

            stdout_thread = threading.Thread(target=drain_stdout, daemon=True)
            stdout_thread.start()
            timeout_timer = threading.Timer(1800, process.kill)
            timeout_timer.start()
            for line in process.stderr:
                line = line.rstrip()
                if not line:
                    continue
                match = progress_re.search(line)
                if match:
                    current_done = max(current_done, int(match.group(1)))
                    file_match = re.search(r"(u_[0-9A-Fa-f]+)\.wav", line)
                    emit(
                        {
                            "type": "progress",
                            "done": current_done,
                            "total": len(jobs),
                            "utteranceId": file_match.group(1) if file_match else None,
                        }
                    )
                else:
                    stderr_tail.append(line)
                    del stderr_tail[:-40]
                    if re.search(r"error|failed|warn|vad", line, re.IGNORECASE):
                        print(line, file=sys.stderr, flush=True)
            stdout_thread.join(timeout=60)
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            timeout_timer.cancel()
            result_stdout = "".join(stdout_chunks)
            returncode = process.returncode
            if returncode != 0:
                print(f"nemo-speech exited {returncode}", file=sys.stderr, flush=True)
                if stderr_tail:
                    print("\n".join(stderr_tail[-12:]), file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"Parakeet batch failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        finally:
            if timeout_timer is not None:
                timeout_timer.cancel()
            emit({"type": "stage", "stage": "collecting-results"})

        results: dict[str, dict[str, Any]] = {}
        if output_dir.is_dir():
            for path in output_dir.rglob("*.json"):
                try:
                    parsed = parse_result(json.loads(path.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    parsed = None
                if not parsed:
                    continue
                stem = path.name.split(".")[0]
                results[stem] = parsed
        if returncode == 0 and not results:
            try:
                parsed = parse_result(json.loads(result_stdout))
                if parsed and len(jobs) == 1:
                    results[jobs[0]["utteranceId"]] = parsed
            except json.JSONDecodeError:
                pass

        with out_path.open("w", encoding="utf-8", newline="\n") as out_handle, errors_path.open(
            "w", encoding="utf-8", newline="\n"
        ) as error_handle:
            for job in jobs:
                data = results.get(job["utteranceId"])
                if data is None:
                    errors += 1
                    message = "Parakeet produced no JSON result for this utterance"
                    if returncode != 0:
                        message = f"nemo-speech exited {returncode}"
                    error_record = {
                        "schema": "tablerecords.transcript-error/v1",
                        "sessionId": job.get("sessionId"),
                        "utteranceId": job.get("utteranceId"),
                        "sttJobId": job.get("sttJobId"),
                        "batchJobId": job.get("batchJobId"),
                        "code": "transcribe_failed",
                        "message": message,
                        "createdAtMs": int(time.time() * 1000),
                    }
                    error_handle.write(json.dumps(error_record, ensure_ascii=False) + "\n")
                    error_handle.flush()
                    emit({"type": "error", "utteranceId": job.get("utteranceId"), "code": "transcribe_failed", "message": message})
                else:
                    out_handle.write(json.dumps(record_for(job, data, args.model, args.device, version), ensure_ascii=False) + "\n")
                    out_handle.flush()
                    written += 1
    emit({"type": "progress", "done": len(jobs), "total": len(jobs)})
    emit({"type": "done", "written": written, "errors": errors})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
