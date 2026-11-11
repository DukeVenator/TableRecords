param(
  [Parameter(Mandatory = $true)]
  [string]$Model,
  [string]$Exe = "llama-server.exe",
  [int]$Port = 9931,
  [int]$Context = 32768,
  [int]$GpuLayers = 99,
  [int]$CpuMoe = 12,
  [ValidateSet("f16", "q8_0", "q4_0")]
  [string]$KvCache = "q8_0",
  [bool]$FlashAttn = $true,
  [string]$Alias = "qwen3.5-35b-a3b"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) {
  throw "Model file not found: $Model"
}

$serverArgs = @(
  "-m", (Resolve-Path -LiteralPath $Model).Path,
  "--load-mode", "mmap",
  "-ngl", "$GpuLayers",
  "-c", "$Context",
  "-ctk", $KvCache,
  "-ctv", $KvCache,
  "--host", "127.0.0.1",
  "--port", "$Port",
  "--alias", $Alias
)
if ($CpuMoe -gt 0) {
  $serverArgs += @("-ncmoe", "$CpuMoe")
}
$serverArgs += @("-fa", $(if ($FlashAttn) { "on" } else { "off" }))

Write-Host "Starting llama-server on http://127.0.0.1:$Port/v1"
Write-Host "Context $Context, GPU layers $GpuLayers, MoE layers on CPU $CpuMoe, KV $KvCache"
& $Exe @serverArgs
