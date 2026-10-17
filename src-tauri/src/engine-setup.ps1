# Orbis: install the descriptive-search engine into one folder, nothing outside it.
#   1. uv (a small Python manager) -> a private Python 3.12 + OpenVINO, tokenizers, numpy, pypdf
#   2. the language model (intfloat/multilingual-e5-small, ONNX, ~470 MB) from Hugging Face
#   3. a check of which AI devices OpenVINO sees (NPU / GPU / CPU)
# Progress lines for Orbis:  STEP <percent> <message>   DEVICES <json>   ERROR <message>
param([Parameter(Mandatory)][string]$Dir)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step($p, $m) { [Console]::Out.WriteLine("STEP $p $m"); [Console]::Out.Flush() }
try {
  New-Item -ItemType Directory -Force -Path $Dir, "$Dir\bin" | Out-Null
  $env:UV_PYTHON_INSTALL_DIR = "$Dir\python"; $env:UV_CACHE_DIR = "$Dir\uv-cache"; $env:UV_NO_PROGRESS = '1'
  $uv = "$Dir\bin\uv.exe"
  if (-not (Test-Path $uv)) {
    Step 5 'Downloading the Python manager'
    $zip = "$Dir\bin\uv.zip"
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath "$Dir\bin" -Force
    Remove-Item -LiteralPath $zip -Force
  }
  $py = "$Dir\.venv\Scripts\python.exe"
  if (-not (Test-Path $py)) {
    Step 15 'Setting up a private Python'
    & $uv venv --python 3.12 "$Dir\.venv" 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw 'could not create the Python environment' }
  }
  Step 30 'Installing OpenVINO and helpers'
  & $uv pip install --python $py openvino tokenizers numpy pypdf huggingface_hub 2>&1 | Out-Null
  if ($LASTEXITCODE) { throw 'could not install OpenVINO' }
  if (-not (Test-Path "$Dir\model\onnx\model.onnx")) {
    Step 55 'Downloading the language model (about 470 MB)'
    & $py -c "import sys; from huggingface_hub import hf_hub_download as d; [d('intfloat/multilingual-e5-small', f, local_dir=sys.argv[1]) for f in ('onnx/model.onnx', 'tokenizer.json', 'config.json')]" "$Dir\model" 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw 'could not download the language model' }
  }
  Step 90 'Checking the AI devices'
  $dev = & $py "$Dir\orbis_sem.py" devices 2>$null | Select-Object -Last 1
  [Console]::Out.WriteLine("DEVICES $dev")
  & $uv cache clean 2>&1 | Out-Null
  Step 100 'Ready'
} catch {
  [Console]::Out.WriteLine("ERROR $($_.Exception.Message)")
  exit 1
}
