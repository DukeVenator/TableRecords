#!/usr/bin/env python
"""TableRecords STT health report.

Prints one JSON object. This script is intentionally dependency-light at import
time so that missing CUDA DLLs are reported as data rather than a stack trace.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import site
import sys
from pathlib import Path

_DLL_HANDLES: list[object] = []


def _add_dll_dirs(download_root: str | None = None) -> list[str]:
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
    candidates.extend(
        [
            Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.5\bin"),
            Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\bin"),
            Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.4\bin"),
        ]
    )
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


def _model_present(root: Path) -> bool:
    if not root.is_dir():
        return False
    # faster-whisper/Hugging Face caches place model.bin under snapshots/<hash>.
    for current, _dirs, files in os.walk(root):
        if "model.bin" in files:
            return True
        # Avoid walking an enormous unrelated cache.
        if current.count(os.sep) - str(root).count(os.sep) > 5:
            _dirs[:] = []
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="accepted for compatibility; output is JSON")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--download-root", default=str(Path("models") / "faster-whisper"))
    args = parser.parse_args()

    root = Path(args.download_root).resolve()
    result: dict[str, object] = {
        "available": False,
        "pythonVersion": platform.python_version(),
        "pythonExecutable": sys.executable,
        "fasterWhisper": None,
        "ctranslate2": None,
        "cudaDeviceCount": None,
        "cudaComputeTypes": [],
        "model": args.model,
        "modelDir": str(root),
        "modelPresent": _model_present(root),
        "dllDirs": [],
        "error": None,
    }
    try:
        result["dllDirs"] = _add_dll_dirs(str(root))
        import faster_whisper  # noqa: PLC0415

        result["fasterWhisper"] = getattr(faster_whisper, "__version__", "unknown")

        import ctranslate2  # noqa: PLC0415

        result["ctranslate2"] = getattr(ctranslate2, "__version__", "unknown")
        try:
            result["cudaDeviceCount"] = int(ctranslate2.get_cuda_device_count())
        except Exception as exc:  # noqa: BLE001
            result["cudaDeviceCount"] = 0
            result["error"] = f"CUDA device query failed: {exc}"
        try:
            types = ctranslate2.get_supported_compute_types("cuda")
            result["cudaComputeTypes"] = sorted(str(item) for item in types)
        except Exception:
            result["cudaComputeTypes"] = []
        result["available"] = True
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["available"] = False

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
