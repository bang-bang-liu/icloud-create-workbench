param([int]$Port = 0)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Port -le 0 -and (Test-Path (Join-Path $Root ".env"))) {
  $portLine = Get-Content (Join-Path $Root ".env") | Where-Object { $_ -match "^\s*PORT=(\d+)\s*$" } | Select-Object -First 1
  if ($portLine) {
    $Port = [int]([regex]::Match($portLine, "\d+").Value)
  }
}
if ($Port -le 0) {
  $Port = 4173
}

# 使用普通用户可调用的 netstat 获取监听进程，避免依赖 CIM 查询权限。
$listenerPattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
$processIds = @(netstat.exe -ano -p TCP | ForEach-Object {
  if ($_ -match $listenerPattern) {
    [int]$Matches[1]
  }
} | Sort-Object -Unique)
if (-not $processIds.Count) {
  Write-Output "服务未运行：端口 $Port 没有监听进程。"
  exit 0
}

$expectedNodePath = [System.IO.Path]::GetFullPath((Join-Path $Root "runtime\node\node.exe"))
foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction Stop
  $actualPath = [System.IO.Path]::GetFullPath($process.Path)
  if (-not [string]::Equals($actualPath, $expectedNodePath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "端口 $Port 由非本项目进程占用，已拒绝停止：PID $processId，路径 $actualPath"
  }
  Stop-Process -Id $processId -Force
  Write-Output "服务已停止：PID $processId，端口 $Port。"
}
