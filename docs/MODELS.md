# Local summary models

**Tested:** 2 Nov 2026 on the capture machine
**GPU:** NVIDIA GeForce RTX 3090, 24 GB (the card reports as a 3090, not a 3090 Ti; both have 24 GB)
**CPU / RAM:** Ryzen 7 9800X3D, 64 GB
**Ollama:** 0.40.13
**Dashboard context:** `LLM_CONTEXT_TOKENS=16384`

## Short answer

Use **`qwen3.5:27b-q4_K_M`** for session summaries. It is installed and selected in Setup now.

It uses 17.5 GB of VRAM, leaves about 2.5 GB free with the desktop running, and produced a useful whole-session summary in **2 min 45 s**. A 3-minute recap took **17.8 s**. Quality is a clear step up from the 0.8 B test model: names, deals, and open threads came through correctly.

If you want a model that stays loaded while you use the GPU for other things, use **`qwen3.5:9b`** at about 7.6 GB instead.

## Runtimes, context, and reasoning

TableRecords supports two local runtimes:

- **llama.cpp** (`llama-server`) — preferred when you need direct control of mmap, MoE CPU offload, context, and KV cache.
- **Ollama** — the compatibility path and the current 27B setup.

Both use the same summary prompts and the same session data. Only one is active at a time. For llama.cpp, set the provider to **llama.cpp**, use the server's `/v1` address, and enter the `--alias` as the model.

Context is now settable from **4,096 to 131,072 tokens**. Reasoning tokens share that window, so a thinking model needs more context than the same model with thinking off. The **Reasoning effort** setting is `off`, `low`, `medium`, or `high`; it maps to Ollama's `think` value and llama.cpp's `reasoning_effort`.

A whole four-hour session is split before synthesis. The split count now scales past the old 12-portion cap: the 3 h 51 m test session produced a 252,977-character brief, **7 portions**, and one synthesis call. That path completed in **20.4 s on the 0.8B model**; the 27B result was 165.5 s. The small model's output is not a quality reference, only proof that the long-session plumbing completes. If a session is larger than 64 portions, the brief is still capped; that is a deliberate safety limit, not a silent one.

For a 4-hour session with a thinking model, use 32k context or more and keep `LLM_MAX_INPUT_CHARS` at 40,000 so each portion stays inside the window. Raising the context without raising the input limit does not make a single 250k-character brief fit.

## What fits on 24 GB

| Model | Weights | 16k context | Measured speed | Verdict |
|---|---|---|---|---|
| `qwen3.5:27b-q4_K_M` | 17 GB | ~17.5 GB | 25.5 tok/s | Best quality that fits with the desktop running |
| `qwen3.5:35b-a3b-q4_K_M` | 21 GB + 0.9 GB projector | ~23 GB | ~101 tok/s on a 3090 per published tests | Faster, but needs almost the whole card |
| `qwen3.5:9b` | ~7.6 GB | ~8 GB | Not measured here | Good fast fallback, lots of headroom |
| 70B class at Q4 | ~40 GB | — | — | Does not fit |
| `qwen3.5:122b` | 81 GB | — | — | Does not fit |

The 35B MoE is the faster architecture. Published 3090 tests show about 101 tok/s generation and 2,121 tok/s prompt processing at 32k, against 31 tok/s and 848 tok/s for the 27B dense model. The catch is memory: 21 GB of weights plus a desktop using 5–6 GB does not fit in 24 GB. It can work if you close GPU-heavy apps, or accept some CPU offload.

![Setup with the 27B model selected](../screenshots/qa/27b-setup.png)

## Better models and RAM offload

Research on 10 Nov 2026. These are candidates, not local benchmarks.

The current 16k context is not the main quality limit. A 40,000-character brief is roughly 10,000 tokens, so 16k already holds the configured input plus output. Raising the context to 32k adds very little KV memory on Qwen3.5 because its hybrid attention keeps only a few full-attention layers. The real limit is model weights on a 24 GB card, especially when Foundry is open.

| Candidate | Download / weights | Context | Practical fit | Assessment |
|---|---|---|---|---|
| `qwen3.5:35b-a3b-q4_K_M` | 22 GB total, 21 GB weights | 256k | Near the whole card; needs 4–10 GB of RAM offload | The main MoE candidate. 34.7B total but about 3B active, so it is fast when resident and may tolerate partial CPU offload better than a dense model. |
| `qwen3.5:9b` | about 7.6 GB | 256k | Fits beside Foundry and the desktop | The practical live-play choice. Lower quality than 27B, but far better than 0.8B and leaves room for 32k context. |
| `qwen3:30b-a3b` | 19 GB | 32k native | Fits only with a small offload | Older Qwen3 MoE, 30.5B total and about 3B active. It is a cheaper offload experiment, not a clear upgrade over the 27B. |
| `gpt-oss:20b` | 14 GB | 131k | Fits beside Foundry | MoE with strong reasoning and configurable effort, but it is tuned for agent work and can be terse or analytical; quality for warm table recaps is unproven. |
| `gemma3:27b` | 17 GB | 128k | Similar to the 27B Qwen | Dense, older, and not an obvious summarization upgrade; 128k context is memory-hungry. |
| `mistral-small3.2:24b` | 15 GB | 128k | Fits with more headroom than 27B | Dense, strong instruction following, fewer repetition loops, but older and not proven better for this recap task. |
| `qwen3.5:122b` | 81 GB | 256k | Does not fit 24 GB + 64 GB RAM with Windows | 125B total; offloading most of it would be extremely slow. Not viable for interactive GM tools. |

### MoE verdict

MoE buys speed per active parameter, not a smaller download. Every expert still has to be resident somewhere, so a 22 GB model is still 22 GB. The 35B-A3B is attractive because only about 3B parameters are active per token, which makes a CPU-offloaded layer less painful than in the dense 27B. It is not free: the offloaded layers still stream weights through system RAM.

On the summary task, the 35B is not a proven accuracy upgrade. XSCT gives it **91.9** on multi-document summary, the same score as the 27B, and **87.8** on its report-summary case. The case for the 35B is speed and context headroom, not a guaranteed better recap. Its creative-roleplay score is high, but that is not the same task.

The older `qwen3:30b-a3b` is only 19 GB and could be tested with a smaller offload, but it is a generation behind. `gpt-oss:20b` fits comfortably but is reasoning-oriented; its summaries may read like analysis rather than a table recap. Neither is a safe default without a local A/B test.

### What RAM offload can and cannot do

Ollama automatically splits layers between VRAM and system RAM when a model does not fit, and `num_gpu` can cap how many layers go to the GPU. The 64 GB of system RAM is enough to hold the 35B's overflow, but CPU layers are much slower than GPU layers. The 3B active parameter count helps with compute, not with the cost of moving weights through the CPU.

A realistic test is the 35B at 32k context with roughly 4–8 GB offloaded, not the 122B. Even then, expect prompt processing and generation to be slower than the 27B. Published 3090 figures for the 35B assume it is fully resident and do not predict offloaded speed.

**Local llama.cpp result:** the 35B runs through `llama-server` with `--n-cpu-moe 20`, 16k context, 99 GPU layers, q8_0 KV cache, and flash attention. It loaded in **19.2 s**, used **16.6–20.8 GB VRAM**, produced a 3-minute recap in **16.3 s**, a 15-minute clue board in **23.1 s**, and completed the 3 h 51 m whole session in **474.2 s** with 3 portions at 64k context, a 3,640-character ledger, a 185-fact extracted index, and **12,882 characters** of sectioned notes (0 missing, 0 repairs, no Additional facts section). At 16k it needed 9 portions and 361.8 s. Earlier single-call runs took 231.1–284.6 s and produced about 3,500 characters. High reasoning took **37.2 s**, medium **31.5 s**, and low **82.0 s**. The Ollama attempt still fails with the Windows host-buffer error; the llama.cpp path is the working one. See [qa/AB-RUNTIMES.md](qa/AB-RUNTIMES.md).

The dashboard exposes context size, Ollama GPU layers, and the llama.cpp placement fields. For llama.cpp it now also owns the server process and maps those fields to launch arguments. Changing launch settings while the server is running marks it **restart required**; the restart button applies them. Changing the port updates the local llama.cpp address automatically. Executable and model paths are checked when saved, and Browse opens the local file picker.

### Recommendation

1. Use **35B-A3B on llama.cpp** with `--n-cpu-moe 20` when quality matters. It loaded in 19.2 s, recapped 3 minutes in 16.3 s, and completed the 3 h 51 m session in 284.6 s.
2. Keep **27B on Ollama at 16k** as the faster whole-session fallback: 182.9 s on one run, but another failed at 136.9 s when the runner stopped. Low/medium/high all complete after the 4,096-token thinking reserve, though low is slower.
3. Use **9B** for live play with Foundry open if the 35B is not running. It is the option that reliably leaves GPU headroom.
4. Do not pursue 122B or 70B on this machine for interactive use.

## Measured on this machine

The figures below are the earlier 27B-only measurements. The current 27B-vs-35B comparison is [qa/AB-RUNTIMES.md](qa/AB-RUNTIMES.md).

### 27B, one long portion

- Input: 36,000 characters of the real `notes-ready.md` brief
- Prompt tokens: 12,585
- Prompt processing: 27.4 s
- Output: 300 tokens in 11.8 s, **25.5 tok/s**
- Load time: 7.4 s
- VRAM: 17.48 GB model, 22.0 GB total with the desktop

### 27B, recent recap

- Input brief: 4,446 characters, about 1,112 tokens
- Request: GM prep, recent 3 minutes
- Wall time: **17.8 s**
- Output: structured situation, people, clues, open threads, and GM reminders

### 27B, structured clue board

- Input brief: 15,607 characters
- Request: clue board, recent 15 minutes
- Wall time: **16.3 s**
- Output: valid structured JSON with situation, NPCs, clues, threads, and reminders

### 27B, whole session

- Source: 3 h 51 m session, 4,947 clips, 2,478 timeline events
- Brief: 252,977 characters, about 63,245 tokens
- Chunking: 7 portions
- Wall time: **165.5 s**
- Output: one coherent set of GM notes covering the current situation, people, clues, open threads, and dice outcomes

The whole-session path is slower because it makes seven portion calls and one synthesis call. All calls stayed inside the 16k context and the 180 s per-request timeout.

![Clue board summary from the 27B model](../screenshots/qa/27b-summary-modal.png)

## Why this model

The 27B model is the best fit for the job the dashboard asks for: read a long, messy transcript, keep names and facts straight, and return structured prep notes.

- It is strong at long-context consistency and multi-document summary in third-party tests: 95.3 on long-text consistency and 91.9 on multi-document summary.
- It follows the fixed GM prep structure without much prompt fighting.
- It fits fully in VRAM at 16k context with the desktop running, so it does not crawl through CPU offload.
- It is a current model with an Apache 2.0 license.

**With Foundry open:** the 27B can fail to load. In the live GM-tools test, Ollama returned a `cudaMalloc` out-of-memory error because the Foundry client was also using the GPU. The UI test used `qwen3.5:0.8b` to complete, then the setting was restored to 27B. For live play with Foundry open, use the 9B model or a smaller one, or close GPU-heavy clients before a 27B summary. This is GPU memory contention, not a model or dashboard error.

The 35B MoE is the faster model on paper, and its roleplay score is high (92.1). Through llama.cpp with MoE expert offload, it is now a real upgrade on this machine: it completed the whole session and produced more detail than the 27B. Through Ollama alone, it is not usable on this card.

The 0.8 B model is still useful for a quick connection test. It is too small for a four-hour session: it loses detail and invents or mangles names.

## Install and switch

```powershell
ollama pull qwen3.5:27b-q4_K_M
```

Then open **Setup → AI summary**, press **Check models**, choose `qwen3.5:27b-q4_K_M`, and save. The current install already points at it.

For the 9B fallback:

```powershell
ollama pull qwen3.5:9b
```

For llama.cpp, choose **Setup → AI summary → Provider → llama.cpp on this computer**, fill in the executable, model file, and placement values, then press **Start server**. The dashboard spawns it with `shell: false`, keeps a bounded log, and stops it when the dashboard shuts down.

The same launch can be run outside the dashboard:

```powershell
.\scripts\start-llama-server.ps1 `
  -Exe C:\Tools\llama.cpp\llama-server.exe `
  -Model C:\Models\Qwen3.5-35B-A3B-Q4_K_M.gguf `
  -Context 32768 -GpuLayers 99 -CpuMoe 12 -KvCache q8_0
```

Use the server's `--alias` as the **Model** value. The dashboard calls the OpenAI-compatible `/v1` endpoint; it does not pass Ollama's `num_ctx` or `num_gpu` to it.

## Context and memory

Ollama defaults to a 32k context. At 32k the 27B needs about 18 GB, which leaves very little room beside the desktop. The dashboard sends `num_ctx` explicitly and defaults it to **16,384** tokens. That holds a full 40,000-character portion plus the output.

The settings in **Setup → AI summary** are:

- **Context window (tokens):** 4,096 to 131,072.
- **GPU layers:** blank lets Ollama choose; `0` runs on the processor only; a layer count moves the rest to system memory.
- **Reasoning effort:** off, low, medium, or high. Reasoning tokens count against the context window. Every non-off level reserves 4,096 completion tokens so the model can finish thinking and still emit an answer. Low and medium are tested; both complete, though low can be slower.
- **llama.cpp only:** MoE layers on the processor, KV cache type, and flash attention. These map to launch arguments.

The same values can be set in `.env`:

```dotenv
LLM_CONTEXT_TOKENS=16384
LLM_GPU_LAYERS=
LLM_THINKING_EFFORT=off
LLAMACPP_N_CPU_MOE=0
LLAMACPP_KV_CACHE=f16
LLAMACPP_FLASH_ATTN=1
```

The prompt budget is reduced automatically when thinking is on. With a 16k window and high reasoning, each prompt gets roughly 38,000 characters instead of the full 40,000. A 4k window with high reasoning gets about 7,000 characters, so a long session is split into more portions.

For a four-hour session, the dashboard splits the brief into as many portions as the budget requires, then reduces those summaries in rounds before the final preset. It does not silently drop the tail at 12 chunks. The 64-portion guard is only for pathological inputs. The trade is more model calls and a longer wait when the context is small.

Raise the context only if you also raise `LLM_MAX_INPUT_CHARS` and have checked the headroom. Above 32k is only practical on a cleared GPU or through llama.cpp with CPU offload. GPU layers are the Ollama override; llama.cpp takes its layer placement from its launch arguments.

## What to expect

- First request after a restart loads the model in about 7 s.
- A recent or scene recap takes roughly 15–30 s.
- A whole-session recap takes roughly 3 min for a four-hour session.
- The model still misreads transcription errors. Check proper nouns against the transcript before using a name in prep.
- The dashboard does not stream tokens yet. The button shows **Summarizing…** until the request finishes.

## Sources

- [Qwen3.5 27B Q4_K_M on Ollama](https://ollama.com/library/qwen3.5:27b-q4_K_M) — size and quantization
- [Qwen3.5 family on Ollama](https://registry.ollama.com/library/qwen3.5) — 0.8B to 122B, 256k context
- [Qwen3.5 35B-A3B Q4_K_M on Ollama](https://ollama.com/library/qwen3.5:35b-a3b-q4_K_M) — 34.7B total, 21 GB model, 256k
- [Qwen3.5 9B on Ollama](https://ollama.com/library/qwen3.5:9b) — about 7.6 GB, 256k
- [Qwen3 30B-A3B on Ollama](https://ollama.com/library/qwen3:30b-a3b) — older 30.5B MoE, 19 GB
- [GPT-OSS 20B on Ollama](https://ollama.com/library/gpt-oss:20b) — 20.9B MoE, 14 GB, 131k
- [Gemma 3 27B on Ollama](https://ollama.com/library/gemma3:27b) — 17 GB, 128k
- [Mistral Small 3.2 24B on Ollama](https://ollama.com/library/mistral-small3.2:24b) — 15 GB
- [Mistral Small 3.2 context configuration](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506/raw/main/config.json) — 131,072 positions
- [Ollama context length](https://docs.ollama.com/context-length) — 32k default at 24 GB, `ollama ps` offload split
- [Hardware Corner: Qwen3.5 27B and 35B hardware requirements](https://www.hardware-corner.net/qwen35-27b-35b-hardware-requirements/) — 3090 prompt and generation benchmarks, VRAM by context
- [XSCT: Qwen3.5 27B multi-document summary](https://xsctbench.com/testcase/l_sum_006/qwen3.5-27b?diff=basic) — 91.9/100
- [XSCT: Qwen3.5 35B-A3B multi-document summary](https://xsctbench.com/testcase/l_sum_006/qwen3.5-35b-a3b) — 91.9/100
- [XSCT: Qwen3.5 35B-A3B report summary](https://xsctbench.com/testcase/l_sum_004/qwen3.5-35b-a3b) — 87.8/100
- [XSCT: Qwen3.5 27B long-text consistency](https://xsctbench.com/testcase/l_ctx_007/qwen3.5-27b?diff=basic) — 95.3/100
- [XSCT: Qwen3.5 35B-A3B creative roleplay](https://www.xsctbench.com/testcase/l_role_011/qwen3.5-35b-a3b?diff=basic) — 92.1/100
