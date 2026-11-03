param([switch]$Foreground)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeDirectory = Join-Path $Root "runtime\node"
$NodeCommand = Join-Path $NodeDirectory "node.exe"
$NpmCommand = Join-Path $NodeDirectory "npm.cmd"
$CorepackCommand = Join-Path $NodeDirectory "corepack.cmd"
Set-Location $Root

if (-not (Test-Path ".env")) {
  throw "缺少 .env，请先完成本地环境初始化。"
}
if (-not (Test-Path $NodeCommand) -or -not (Test-Path $NpmCommand) -or -not (Test-Path $CorepackCommand)) {
  throw "缺少项目内 Node.js 运行时：$NodeDirectory"
}

$cacheDirectories = @(
  (Join-Path $Root ".cache\npm"),
  (Join-Path $Root ".cache\corepack"),
  (Join-Path $Root ".cache\pnpm-store"),
  (Join-Path $Root ".cache\pnpm-home"),
  (Join-Path $Root ".cache\pip"),
  (Join-Path $Root ".cache\temp"),
  (Join-Path $Root "logs")
)
New-Item -ItemType Directory -Force -Path $cacheDirectories | Out-Null
$env:Path = "$NodeDirectory;$env:Path"
$env:npm_config_cache = Join-Path $Root ".cache\npm"
$env:npm_config_userconfig = Join-Path $Root ".cache\npmrc"
$env:COREPACK_HOME = Join-Path $Root ".cache\corepack"
$env:PNPM_HOME = Join-Path $Root ".cache\pnpm-home"
$env:pnpm_config_store_dir = Join-Path $Root ".cache\pnpm-store"
$env:PIP_CACHE_DIR = Join-Path $Root ".cache\pip"
$env:TEMP = Join-Path $Root ".cache\temp"
$env:TMP = $env:TEMP

& $NpmCommand install
if ($LASTEXITCODE -ne 0) {
  throw "后端依赖安装失败。"
}

Push-Location frontend
try {
  & $CorepackCommand pnpm@10.4.1 install --frozen-lockfile --filter skyroc-admin...
  if ($LASTEXITCODE -ne 0) {
    throw "前端依赖安装失败。"
  }
  & $CorepackCommand pnpm@10.4.1 --filter skyroc-admin build
  if ($LASTEXITCODE -ne 0) {
    throw "前端构建失败。"
  }
} catch {
  Write-Warning "$($_.Exception.Message) 将继续使用 public 回退界面。"
} finally {
  Pop-Location
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  py -3.12 -m venv .venv
  if ($LASTEXITCODE -ne 0) {
    throw "Python 虚拟环境创建失败。"
  }
}
& ".venv\Scripts\python.exe" -m pip install -e ".\vendor\hidemyemail-generator"
if ($LASTEXITCODE -ne 0) {
  throw "Python 依赖安装失败。"
}

$env:PYTHON_COMMAND = (Resolve-Path ".venv\Scripts\python.exe").Path
if (-not $env:DATABASE_PATH) {
  $env:DATABASE_PATH = Join-Path $Root "data\workbench.db"
}
& (Join-Path $Root "stop.ps1")

if ($Foreground) {
  & $NodeCommand "src\server.mjs"
  exit $LASTEXITCODE
}

$serverLog = Join-Path $Root "logs\server.log"
$serverErrorLog = Join-Path $Root "logs\server-error.log"
Start-Process -FilePath $NodeCommand -ArgumentList "src/server.mjs" -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog
for ($attempt = 1; $attempt -le 10; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod "http://127.0.0.1:4173/api/health" | ConvertTo-Json -Compress
    break
  } catch {
    if ($attempt -eq 10) {
      throw
    }
  }
}
