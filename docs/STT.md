# Speech to text (STT)

## Scope and boundary

TableRecords uses Python only for ML inference: per-utterance speech-to-text with
`faster-whisper` or NVIDIA **Parakeet** (`nemo-speech`). Python does **not**
control Discord, the dashboard, Foundry import, job sequencing, timestamps, or
the merge. Node/TypeScript owns all of that.

The STT input is the per-user WAVs produced by the Discord recorder plus the
utterance manifest. Foundry rolls are captured separately by the GM macro
export; STT never sees or parses Foundry data.

**No OBS or mixed-audio fallback exists.** STT consumes per-speaker Discord
recordings only. If Discord capture fails, there is no session audio to
transcribe and no safety recording to recover from. The capture test in
`OPERATIONS.md` must pass before a session starts.

## Runtime and pinned dependencies

- Windows, Python 3.12, NVIDIA RTX 3090 (24 GB), CUDA 12.x runtime.
- `faster-whisper==1.2.1`
- `ctranslate2==4.8.4`
- `av==16.0.1` (pinned; PyAV 19 removed `metadata_errors`, which faster-whisper 1.2.1 still passes to `av.open`)
- cuBLAS 12 from the installed CUDA 12.5 toolkit (already present).
- cuDNN 9, installed into the venv with `nvidia-cudnn-cu12==9.*`.
- PyAV is installed by `faster-whisper`; it bundles FFmpeg decoding, so no system
  FFmpeg is required for STT.
- Model files are cached locally; no audio or transcript leaves the machine.

**Verified in this checkout (2026-10-31):** Python 3.12.9 venv; faster-whisper
1.2.1; CTranslate2 4.8.4; PyAV 16.0.1; cuDNN 9.27 wheel; one CUDA device;
`float16` supported; `large-v3-turbo` cached (1.54 GB) and a SAPI test clip
transcribed correctly (3.3 s model load, 0.47 s inference). A Node `transcribe`
job also ran a three-utterance batch on `tiny.en` and wrote transcript records.

The Node server invokes `python\transcribe_jobs.py` through the venv interpreter
(`.venv\Scripts\python.exe`), streams JSON progress from stdout, and keeps
library logs on stderr.

The GM **recent context** action is now a queued `context` job: it appears in
**Processing jobs**, transcribes only manifest utterances overlapping the
selected window that have no transcript record, and merges the new records into
`stt/transcript.jsonl` by utterance ID. The full transcript is never replaced.
The job runner uses the same `runSttBatch` path as a full transcribe, so
`STT_ENGINE=parakeet` applies to both. A per-session transcription lock prevents
an inline request and a queued job from using the GPU concurrently; jobs wait
for the lock instead of failing.

## Parrot (NVIDIA NeMo-Speech.cpp), the default

**Parrot** is the dashboard name for the NVIDIA **Parakeet** TDT model served by
`nemo-speech`. It is the default engine; Whisper remains available per session
and can be selected in **Setup → Transcription** or the setup wizard. It does
not use the Python ML stack for inference; Python only orchestrates the native
CLI batch.

**Installed here (2026-11-01):**

```text
C:\Tools\NeMoSpeech\bin\nemo-speech.exe          # runtime 0.3.0, Windows CUDA
C:\Tools\NeMoSpeech\models\parakeet-tdt-0.6b-v3.q8_0.gguf  # 680.9 MB
```

Model: `nvidia/parakeet-tdt-0.6b-v3`, FastConformer-TDT 0.6B, 25 European
languages, CC-BY-4.0. SHA-256 checked against
`e3880d0aaaaf2c308ea2c35016b2b895c423eb3fda924c1b463d1c19b7f4d32e`.
Runtime: NVIDIA NeMo-Speech.cpp 0.3.0 (Apache-2.0), CUDA backend.

Configuration (the dashboard writes these to its database, so the UI is the
normal path; the `.env` values below are the fallback):

```dotenv
STT_ENGINE=parakeet   # Parrot, default
NEMO_SPEECH_PATH=C:\Tools\NeMoSpeech\bin\nemo-speech.exe
PARAKEET_MODEL=C:\Tools\NeMoSpeech\models\parakeet-tdt-0.6b-v3.q8_0.gguf
PARAKEET_DEVICE=cuda
PARAKEET_CONCURRENCY=4
STT_LANGUAGE=en
```

`python\transcribe_parakeet_jobs.py` copies the batch WAVs into a temporary
directory, runs:

```text
nemo-speech transcribe <temp-input> --model <gguf> --format json \
  --output-dir <temp-output> --concurrency 4 --device cuda --language en
```

then maps each `<utteranceId>.json` back into the normal
`tablerecords.transcript/v1` record. The native runtime downmixes/resamples the
48 kHz stereo WAVs to the model’s 16 kHz mono input.

**Measured on the live test clips:** 10 utterances, 10 transcripts, 0 errors,
**1.1 s** inference. The dashboard `transcribe` job completed in **1.2 s**.
`/api/status` reports `engine=parakeet`, the model, and `state=ready`.

**Caveats found in the A/B test:** Parakeet returns confidence `1.0` for every
word, so it cannot replace Whisper’s low-confidence/no-speech heuristics. Short
0.5 s clips produced more “Yeah/Okay” style guesses than Whisper. Capture now
gates those clips before STT using voiced energy, joins pauses shorter than
2.4 s into one utterance, and the merger marks short backchannel-only results
as `filler`. Longer clips remain comparable to Whisper, with stronger
punctuation. Parakeet is offline and non-streaming; it does not replace the live
Discord capture.

The Parakeet wrapper streams the native CLI’s `[N/M]` progress lines into the
same `progress` protocol as faster-whisper, so the dashboard advances during a
large batch instead of jumping from 0 to 100% at the end.

Switch engines in **Setup → Transcription** (or the setup wizard); the choice is
saved immediately and applies to the next transcription. Setting
`STT_ENGINE=faster-whisper` in `.env` and restarting is the fallback path. The
original Whisper model and cache are unchanged.

### Fine tuning

Whisper exposes model, device, precision, beam size, Silero VAD, no-speech,
log-probability, and compression-ratio thresholds in Setup. Parrot exposes the
runtime/model paths, device, concurrency, and shared language. **Extra hotwords**
apply to both engines; **Extra prompt** applies to Whisper. Both are appended to
the automatic system/vocabulary hints for the next batch.

## Setup

The first-run **setup wizard** and **Setup → Transcription** both offer the
engine choice. The doctor (`npm run doctor` or **Run checks**) reports both
engines separately and marks the active one, so a missing Parrot runtime can be
fixed by switching to Whisper without editing `.env`.

To install the Whisper stack, run from the project root in PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
.\.venv\Scripts\python.exe -m pip install "nvidia-cudnn-cu12==9.*"
```

`python\requirements.txt` must at minimum pin:

```text
faster-whisper==1.2.1
ctranslate2==4.8.4
av==16.0.1
nvidia-cudnn-cu12==9.*
```

`faster-whisper` resolves its remaining requirements (`av>=11`, `onnxruntime`,
`tokenizers`, `huggingface-hub`, `tqdm`). For reproducibility, record the
resolved versions in the project lock/notes after a working install.

The dashboard's health panel should report the same checks as
`python\stt_health.py`; a missing venv, import failure, or CUDA failure must be
visible before a session, not discovered after it.

## CUDA / cuDNN validation

CUDA 12.5 supplies cuBLAS DLLs under:

```text
C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.5\bin
```

cuDNN 9 is not installed system-wide. The Windows wheel installs its DLLs under
the venv, approximately:

```text
.venv\Lib\site-packages\nvidia\cudnn\bin
```

Before importing `ctranslate2` or `faster_whisper`, the Python entry point must
add both directories to the DLL search path. Use both `os.add_dll_directory`
(and keep the returned handles alive for the process lifetime) and a prepended
`PATH` entry; one without the other is a common source of "DLL load failed"
errors on Windows:

```python
import os, site
from pathlib import Path

packages = site.getsitepackages()
site_packages = Path(next(
    (item for item in packages if item.replace("\\", "/").endswith("site-packages")),
    packages[-1],
))
dll_dirs = [
    site_packages / "nvidia" / "cudnn" / "bin",
    site_packages / "nvidia" / "cublas" / "bin",
    Path(os.environ.get("CUDA_PATH", r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.5")) / "bin",
]
_handles = []
for directory in dll_dirs:
    if directory.is_dir():
        os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")
        _handles.append(os.add_dll_directory(str(directory)))

import ctranslate2  # noqa: E402  (must follow DLL setup)
from faster_whisper import WhisperModel  # noqa: E402
```

Do not use `site.getsitepackages()[0]` on Windows venvs: the first entry is the
venv root, not `Lib\site-packages`, so the cuDNN wheel DLLs are missed.

`os.add_dll_directory` must run before the native imports. Do not move this
setup into an import of a library that loads CTranslate2 earlier.

Health checks, run with the venv interpreter:

```powershell
.\.venv\Scripts\python.exe python\stt_health.py
.\.venv\Scripts\python.exe -c "import ctranslate2; print(ctranslate2.get_cuda_device_count()); print(ctranslate2.get_supported_compute_types('cuda'))"
```

Expected on the target machine:

- `get_cuda_device_count()` returns `1` (the RTX 3090).
- Supported CUDA compute types include `float16` and `int8_float16`.
- A short smoke transcription (5–15 s WAV) returns non-empty text and sensible
  word timestamps.

If CUDA import fails, inspect the exact missing DLL (`cublas64_12.dll`,
`cudnn64_9.dll`, `cudnn_ops_infer64_9.dll`, etc.), fix the DLL directories, and
retry. If GPU still fails, use the CPU fallback below; do not silently continue
with a GPU job that will fail after the session.

## Model choice, download, and offline cache

Default model: **`large-v3-turbo`**.

Choose by need:

| Model | Use |
| --- | --- |
| `large-v3-turbo` | Default on the RTX 3090. Best speed/quality balance for this machine. |
| `large-v3` | Slower; try when accents, background noise, or domain terms are consistently weak. |
| `medium.en` | CPU fallback or constrained VRAM. English only. |
| `small.en` | Fastest CPU fallback, lower accuracy. English only. |

Model files are downloaded once by `faster-whisper` from Hugging Face into a
project-local cache (`models/faster-whisper` by default) and then reused. The
download is a model artifact transfer only; no session audio is uploaded.

After the first successful download, run offline:

```powershell
$env:HF_HUB_OFFLINE = "1"
$env:TRANSFORMERS_OFFLINE = "1"
```

The transcribe script must accept `--download-root` and `--local-files-only`
and set `WhisperModel(..., download_root=..., local_files_only=...)`
accordingly. A missing model with offline mode enabled must fail fast with a
clear "model not cached" error, not a network timeout. The dashboard should show
the cache path and whether the default model is present.

The canonical field names and schemas are in
[DATA-FORMATS.md](DATA-FORMATS.md). The examples below are illustrative; if the
two files differ, DATA-FORMATS wins.

## Transcribe job contract

Node writes a JSONL job file (one object per line) after capture or from a
selected session. The Python process loads the model once and iterates the file.

Each job line:

```json
{
  "schema": "tablerecords.stt-job/v1",
  "sttJobId": "stt_01J9Z3N2AA",
  "batchJobId": "job_01J9Z3MZQ1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "utteranceId": "u_01J9Z3K7QF",
  "audioFile": "discord/audio/241234567890123456/1793430364128-u_01J9Z3K7QF.wav",
  "discordUserId": "241234567890123456",
  "speakerLabel": "Alice",
  "character": "Veyra Sol",
  "language": "en",
  "startMs": 1793430364128,
  "endMs": 1793430367050,
  "model": "large-v3-turbo",
  "device": "cuda",
  "computeType": "float16",
  "beamSize": 5,
  "wordTimestamps": true,
  "vadFilter": false,
  "prompt": "FFG narrative dice campaign: Veyra Sol, Korrin, Dr. Ix, Absalom Station.",
  "hotwords": ["Veyra Sol", "Korrin", "Dr. Ix", "Triumph", "Despair"]
}
```

`audioFile` is resolved under the session root and rejected if it escapes it.
`prompt`/`hotwords` may instead be omitted per job and supplied via CLI files;
per-job values win.

CLI shape:

```text
python\transcribe_jobs.py
  --jobs <jobs.jsonl>
  --out <transcript.jsonl>
  --errors <transcript-errors.jsonl>
  --model large-v3-turbo
  --device cuda
  --compute-type float16
  --language en
  --prompt-file <prompt.txt>
  --hotwords-file <hotwords.txt>
  --download-root models/faster-whisper
[--local-files-only]
```

Each transcript line:

```json
{
  "schema": "tablerecords.transcript/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "utteranceId": "u_01J9Z3K7QF",
  "sttJobId": "stt_01J9Z3N2AA",
  "batchJobId": "job_01J9Z3MZQ1",
  "discordUserId": "241234567890123456",
  "speaker": "Alice",
  "character": "Veyra Sol",
  "text": "I try the engineering check.",
  "rawText": "I try the engineering check.",
  "corrections": [],
  "startMs": 1793430364128,
  "endMs": 1793430367050,
  "words": [
    {"word": "I", "startMs": 1793430364300, "endMs": 1793430364420, "probability": 0.94}
  ],
  "stt": {
    "engine": "faster-whisper",
    "engineVersion": "1.2.1",
    "model": "large-v3-turbo",
    "device": "cuda",
    "computeType": "float16",
    "language": "en",
    "languageProbability": 0.99,
    "avgLogprob": -0.31,
    "noSpeechProb": 0.02
  },
  "flags": [],
  "createdAtMs": 1793430368000
}
```

Absolute times are `utterance.startMs + round(relative_seconds * 1000)`. Clamp
to the utterance bounds and keep monotonic ordering within the record. Python
writes `rawText` (model output) and an initial `text`; Node's deterministic
vocabulary pass may rewrite `text`, append `corrections`, and add
`vocabulary_corrected`, so the recognizer output remains auditable.

## Prompt and hotword strategy

Use `initial_prompt` for a short session/system context and `hotwords` for a
dense list of proper nouns. Keep the prompt compact (roughly 100–200 tokens);
long prompts consume decoder context and can destabilize short utterances.
Prompts are vocabulary hints, not instructions to invent plot or rules.

Example FFG narrative dice prompt (replace names with the real session values):

```text
FFG campaign. Player characters: Veyra Sol, Korrin,
Dr. Ix. NPCs: Slivv, Captain Rook. Terms: Destiny Points, Triumph, Despair,
Advantage, Threat, Force die, strain, wounds, astrogation, hyperdrive,
Outer Rim, Coronet, Black Sun. Transcribe table talk verbatim.
```

Example hotwords:

```text
Veyra Sol, Korrin, Dr. Ix, Slivv, Captain Rook, Destiny Points, Triumph,
Despair, Advantage, Threat, Force die, astrogation, hyperdrive
```

Build both from the session's people/character mapping and the system glossary.
Do not add common words; they crowd out the names. Keep a per-system vocabulary
file and a campaign-specific list. Node applies a final, logged replacement table
for recurring misspellings (for example "Veyra Soul" → "Veyra Sol"), preserving
the original text alongside the correction.

## Transcription settings and utterance rules

Recommended defaults:

- `language="en"` explicitly (all current campaigns are English).
- `beam_size=5`.
- `word_timestamps=True` for per-word alignment and quality checks.
- `vad_filter=False` for short Discord utterances. These files are already
  speech from a per-user stream; VAD can trim leading consonants and makes
  timestamps relative to trimmed audio. VAD is appropriate only for long
  combined blocks or an explicitly added recovery path; no mixed-audio recovery
  path exists in this plan.
- `condition_on_previous_text=False` to reduce repetition loops across short,
  isolated utterances.
- `no_speech_threshold=0.6`, `log_prob_threshold=-1.0`,
  `compression_ratio_threshold=2.4` as starting thresholds, then calibrate
  against real session data. These are editable in **Setup → Transcription →
  Whisper fine tuning**; the quality flags use the same values.
- Temperature fallback schedule is acceptable; record which temperature produced
  the final segment if exposed.
- Do not translate; always transcribe.
- Clip each decode to the manifest's `endMs - startMs` window. This prevents a
  replaced or reconstructed WAV from injecting audio past the utterance bound;
  real recorder WAVs already match the manifest.

Utterances under ~250 ms are usually noise, clicks, or a single backchannel.
Still write a record, but mark it for review; do not silently delete it. The
merger can exclude rejected records by default.

## Quality and hallucination filters

The Python side writes every attempt to the transcript, with quality signals in
the `flags` array. It must not silently drop failed transcripts. Suggested flags:

- Empty/whitespace text → `empty`.
- `noSpeechProb` above the configured no-speech threshold and `avgLogprob` below
  the configured log-probability threshold → `no_speech` (the standard silence
  condition; treat as likely non-speech).
- `compression_ratio` above the configured compression-ratio threshold →
  `repetitive`, possible loop.
- Very short audio (<250 ms) with low confidence → `short_low_confidence`.
- Non-monotonic or out-of-bounds word timestamps → `timestamp_suspicious`.
- Known Whisper boilerplate ("Thanks for watching", "Subscribe", "Subtitles
  by", etc.) only when it is short and low-confidence → `boilerplate`. Do not
  remove plausible in-character dialogue merely because it matches a phrase.

Node's merge excludes records carrying `empty`, `no_speech`, `repetitive`,
`filler`, `short_low_confidence`, `boilerplate`, or `timestamp_suspicious` by
default. `filler` is added by Node when a clip shorter than ~1.4 s contains only
backchannels ("Yeah.", "Okay. Right.") and is also applied after same-speaker
gap stitching. Keep raw model text, even when rejected.

## Progress and error protocol

To keep parsing unambiguous:

- **stdout is JSON Lines only**, one object per line:

```json
{"type":"start","total":42,"model":"large-v3-turbo","device":"cuda","computeType":"float16"}
{"type":"stage","stage":"loading-model"}
{"type":"progress","done":1,"total":42,"utteranceId":"u_01J9Z3K7QF"}
{"type":"error","utteranceId":"u_01J9Z3K7QF","code":"decode_failed","message":"..."}
{"type":"done","written":41,"errors":1}
```

- **stderr is human-readable library/runtime output**; Node writes it to the job
  log and never tries to parse it.
- A per-job failure writes an error record to `transcript-errors.jsonl` and
  continues with the next job. A process-level failure (model load, CUDA/DLL
  initialization) exits non-zero before the `done` line; Node marks the job
  failed and does not claim partial success.
- Progress must be flushable line-by-line so the dashboard updates during long
  sessions.

## CPU fallback

If CUDA is unavailable or fails validation:

```text
--device cpu --compute-type int8 --model small.en
```

or `medium.en` if acceptable for the session length. CPU decoding uses the same
job/transcript contract and records `device: "cpu"` in every STT metadata block.
Never switch device silently in the middle of a job run; the dashboard must show
the selected mode, and a failed GPU run must be explicitly retried on CPU. CPU
throughput on a 4-hour multi-speaker session can be substantial; document the
expected mode in the session notes.

## Privacy and offline behavior

- Audio, prompts, hotwords, transcripts, and errors remain under the session
  directory on the local machine.
- No audio, embeddings, transcripts, or telemetry are sent to a transcription
  service. The only network access is the initial one-time model download (and
  optional dependency installation); disable that after the cache is populated
  with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.
- No cloud STT endpoints, proxies, or remote servers. A future local provider is
  a code change, not a settings-only swap.
- The dashboard must not display or transmit the bot token while showing STT
  health.


