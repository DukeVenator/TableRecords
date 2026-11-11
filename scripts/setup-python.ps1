param(
  [switch]$DownloadModel,
  [string]$Model = "large-v3-turbo"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
  Write-Host "Creating Python 3.12 virtual environment at .venv ..."
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    & py -3.12 -m venv .venv
  } else {
    & python -m venv .venv
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Python venv." }
}

Write-Host "Using $python"
& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed." }

Write-Host "Installing pinned STT dependencies (this can take several minutes) ..."
& $python -m pip install -r python\requirements.txt
if ($LASTEXITCODE -ne 0) { throw "STT dependency installation failed." }

Write-Host "Checking STT/CUDA health ..."
& $python python\stt_health.py --json --download-root models\faster-whisper --model $Model
if ($LASTEXITCODE -ne 0) { throw "stt_health.py failed." }

if ($DownloadModel) {
  Write-Host "Downloading model '$Model' into models\faster-whisper ..."
  & $python -c "from faster_whisper import WhisperModel; WhisperModel('$Model', device='cpu', compute_type='int8', download_root=r'models\faster-whisper'); print('model cached')"
  if ($LASTEXITCODE -ne 0) { throw "Model download failed." }
}

Write-Host ""
Write-Host "STT environment ready. The dashboard job runner will use: $python"
Write-Host "If CUDA validation showed zero devices or a DLL error, set STT_DEVICE=cpu and STT_COMPUTE_TYPE=int8 in .env."
