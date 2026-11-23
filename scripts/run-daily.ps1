# 抓取茅台批价，有变化就提交并推送
#
# 由 install-task.ps1 生成的计划任务调用；也可以手动跑。
# 因为没有变化时 fetch-moutai.js 不会写文件，这里的提交只在真有新数据时发生。
#
# 认证：走环境变量 AURUM_GIT_TOKEN（GitHub fine-grained PAT，需 repo contents:write）。
# 不写进 git config，也不打印到日志。缺这个变量时只提交不推送。

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logDir   = Join-Path $repoRoot '.tmp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile  = Join-Path $logDir 'moutai-fetch.log'

# 优先用 AURUM_GIT；否则依次找 PATH 里的 git、本机 PortableGit
$gitCandidates = @(
  $env:AURUM_GIT,
  (Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.tmp\PortableGit\cmd\git.exe')
)
$git = $gitCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

function Log([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

Log '==== 开始 ===='

# 1) 抓数据（这个脚本自己管好日志格式，直接追加输出）
$node = $env:AURUM_NODE
if (-not $node -or -not (Test-Path $node)) { Log "找不到 node（AURUM_NODE=$node）"; exit 1 }

$fetch = Join-Path $PSScriptRoot 'fetch-moutai.js'
$output = & $node $fetch $repoRoot 2>&1
$output | ForEach-Object { Log $_ }

# 2) 有没有产生改动？
if (-not $git) { Log '找不到 git（可用 AURUM_GIT 指定）'; exit 1 }

Push-Location $repoRoot
try {
  $dirty = & $git status --porcelain -- js/moutai-data.js index.html
  if (-not $dirty) {
    Log '数据无变化，不提交'
    exit 0
  }

  $date = Get-Date -Format 'yyyy-MM-dd'
  & $git add js/moutai-data.js index.html
  & $git -c user.name='aurum-bot' -c user.email='aurum-bot@local' `
        commit -q -m "chore(moutai): 每日更新茅台批价快照 $date" | Out-Null
  if ($LASTEXITCODE -ne 0) { Log '提交失败'; exit 1 }
  Log "已提交：每日更新茅台批价快照 $date"

  # 3) 推送（有 token 才推）
  if (-not $env:AURUM_GIT_TOKEN) {
    Log '没有 AURUM_GIT_TOKEN，跳过推送（改动已提交到本地）'
    exit 0
  }

  $b64  = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$($env:AURUM_GIT_TOKEN)"))
  $auth = "AUTHORIZATION: basic $b64"
  & $git -c http.sslBackend=openssl -c http.version=HTTP/1.1 `
        -c "http.https://github.com/.extraheader=$auth" push origin main 2>&1 |
    ForEach-Object { Log $_ }
  if ($LASTEXITCODE -eq 0) { Log '已推送到 origin/main' } else { Log "推送失败（exit $LASTEXITCODE）" }
}
finally {
  Pop-Location
  Log '==== 结束 ===='
}
