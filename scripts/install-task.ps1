# 每天抓取飞天茅台批价
#
# 为什么需要浏览器：数据源（聚金数据）用腾讯 EdgeOne 拦截，实测同一个出口 IP 下
# 有头浏览器能通过、无头浏览器被拦（见 HANDOVER 第 0 节）。所以脚本必须开一个
# 真实 Chrome 窗口，让它自己发请求，再用页面自己的 decryptAES() 解出明文。
#
# 用法（Windows 计划任务，每天 09:10）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1
#
# 卸载：
#   Unregister-ScheduledTask -TaskName 'AurumFetchMoutai' -Confirm:$false

param(
  [string]$TaskName = 'AurumFetchMoutai',
  [string]$Time = '09:10',
  [string]$NodePath = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已删除计划任务 $TaskName"
  exit 0
}

# 找一个能用的 node：优先参数，其次 DSH 自带运行时
if (-not $NodePath) {
  $candidates = @(
    "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  $NodePath = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $NodePath) {
  throw '找不到 node.exe，请用 -NodePath 指定'
}

$script = Join-Path $PSScriptRoot 'fetch-moutai.js'
if (-not (Test-Path $script)) { throw "找不到 $script" }

Write-Host "仓库：$repoRoot"
Write-Host "node：$NodePath"
Write-Host "脚本：$script"

# 包一层 cmd，顺便把输出记到日志，方便排查
$logDir = Join-Path $repoRoot '.tmp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'moutai-fetch.log'
$wrapper = Join-Path $logDir 'run-fetch-moutai.cmd'
$cmdLine = '@echo off' + "`r`n" +
           "echo. >> `"$logFile`"`r`n" +
           "echo ==== %DATE% %TIME% ==== >> `"$logFile`"`r`n" +
           "`"$NodePath`" `"$script`" `"$repoRoot`" >> `"$logFile`" 2>&1`r`n"
Set-Content -Path $wrapper -Value $cmdLine -Encoding ASCII

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description '每天抓取飞天茅台 500ml 散瓶批价到本仓库 js/moutai-data.js' `
  -Force | Out-Null

Write-Host ""
Write-Host "已注册计划任务 $TaskName，每天 $Time 执行"
Write-Host "日志：$logFile"
Write-Host "手动试跑：$wrapper"
