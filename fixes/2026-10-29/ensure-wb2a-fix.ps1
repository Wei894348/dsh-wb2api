# ensure-wb2a-fix.ps1 —— 校验 / 复原 wb2api 网关补丁 + 插件侧兜底（2026-10-29）
#
# 用法：
#   pwsh -File ensure-wb2a-fix.ps1                 # 自动：本地留档优先，没有就从 GitHub 拉
#   pwsh -File ensure-wb2a-fix.ps1 -Source github  # 强制从 GitHub 拉（本地被删/存疑时用）
#   pwsh -File ensure-wb2a-fix.ps1 -NoRestart      # 只换文件，不重启网关
#
# 为什么支持从 GitHub 拉：补丁版二进制整份在插件仓库里（backend/bin/wb2a-server.exe），
# 仓库公开、pin 死到提交 SHA，所以「本地什么都不剩」也能一条命令复原。
# 拉取地址钉死 SHA（不是分支），避免上游再推新提交时悄悄换掉我们验证过的构建。
[CmdletBinding()]
param(
  [switch]$NoRestart,
  [ValidateSet('auto', 'local', 'github')][string]$Source = 'auto'
)

$ErrorActionPreference = 'Stop'

# 2026-10-29 19:19 构建：/v1/messages + /v1/responses 适配层 + 降级窗口/探针/脱敏
# + 模型目录别名闸 + /v1/models?refresh=1 + /status models 块
$wantSha   = '1CA4DE8F576A0AA8E62E18B84458CA698E4EB4A54F1E74B921BA71B5CBA28D39'
# pin 到 tag（2026-10-29 实测：raw / codeload 对 **完整 commit SHA** 形式会 404，
# 对分支名和 tag 名都正常；tag 不漂，所以用 tag）。改动插件后要重新打 tag 并改这里。
$repoRef   = 'wb2api-fix-20261029'
$rawUrl    = "https://raw.githubusercontent.com/Wei894348/dsh-wb2api/$repoRef/backend/bin/wb2a-server.exe"
$rawUrlAlt = 'https://raw.githubusercontent.com/Wei894348/dsh-wb2api/main/backend/bin/wb2a-server.exe'
$localExe  = Join-Path $PSScriptRoot 'wb2a-server-verified.exe'
$cacheExe  = Join-Path $env:TEMP 'wb2a-server-verified.exe'

function Get-Sha256([string]$path) {
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

# ---- 1. 取一份哈希正确的补丁二进制 ----
$fixed = $null
if ($Source -ne 'github') {
  foreach ($cand in @($localExe, $cacheExe)) {
    if (Test-Path -LiteralPath $cand) {
      $h = Get-Sha256 $cand
      if ($h -eq $wantSha) { $fixed = $cand; "用本地留档  $cand"; break }
      Write-Warning "哈希不符，忽略：$cand ($h)"
    }
  }
  if (-not $fixed -and $Source -eq 'local') { throw "本地留档缺失或哈希不符：$localExe / $cacheExe" }
}

if (-not $fixed) {
  '从 GitHub 拉取补丁二进制…'
  $tmp = "$cacheExe.download"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  $lastErr = $null
  foreach ($u in @($rawUrl, $rawUrlAlt)) {
    "  $u"
    try {
      Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 300
      $lastErr = $null
      break
    } catch {
      $lastErr = $_
      Write-Warning ("拉取失败：{0}" -f $_.Exception.Message)
    }
  }
  if ($lastErr) { throw "GitHub 两个地址都拉不到补丁二进制：$($lastErr.Exception.Message)" }
  $h = Get-Sha256 $tmp
  if ($h -ne $wantSha) {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    throw "GitHub 拉下来的二进制哈希不符：$h != $wantSha（仓库被改写或 SHA 变了，先查 GitHub）"
  }
  Move-Item -LiteralPath $tmp -Destination $cacheExe -Force
  $fixed = $cacheExe
  "已缓存      $cacheExe"
}

if ((Get-Sha256 $fixed) -ne $wantSha) { throw "核对用二进制哈希不符（$fixed）" }

# ---- 2. 三处二进制对齐（运行位 / 插件随包位 / 插件开发仓库） ----
$targets = @(
  @{ Path = 'C:\Users\86157\.dsh\wb2api\bin\wb2a-server.exe'; Restart = $true }
  @{ Path = 'C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-plugin-wb2api-ui\backend\bin\wb2a-server.exe'; Restart = $true }
  @{ Path = 'F:\project\dsh_chajian\dsh-wb2api\backend\bin\wb2a-server.exe'; Restart = $false }
)

$needRestart = $false
foreach ($tg in $targets) {
  $t = $tg.Path
  $dir = Split-Path -Parent $t
  if (-not (Test-Path -LiteralPath $dir)) { Write-Warning "跳过（目录不存在）：$t"; continue }
  $cur = if (Test-Path -LiteralPath $t) { Get-Sha256 $t } else { '' }
  if ($cur -eq $wantSha) { "OK       $t"; continue }
  if ($cur) {
    $bakName = (Split-Path -Leaf $t) + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
    Rename-Item -LiteralPath $t -NewName $bakName -Force
    "备份     $bakName"
  }
  # 运行中的 exe 被进程占用：先改名再拷入（上面已改名；目录里没有同名文件了）
  Copy-Item -LiteralPath $fixed -Destination $t -Force
  "已替换   $t"
  if ($tg.Restart) { $needRestart = $true }
}

# ---- 3. dsh-purge：宿主 file-reference 引导句改写（人格不再被 11-128 降级吃掉） ----
$marker = 'Tokens prefixed with @ are paths the user explicitly referenced'
$idFiles = @(
  'C:\Users\86157\.dsh\profiles\desktop\vendor\dsh-purge\lib\identity.js'
  'C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-purge\lib\identity.js'
  'F:\project\git_project\dsh-purge\lib\identity.js'
  'F:\project\破甲提示词\dsh-purge\lib\identity.js'
)
foreach ($f in $idFiles) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Warning "跳过（不存在）：$f"; continue }
  if ((Get-Content -LiteralPath $f -Raw).Contains($marker)) { "OK       $f（插件侧改写规则在位）" }
  else {
    Write-Warning "插件侧改写规则缺失：$f"
    Write-Warning '按 README-修复说明.md「dsh-purge 侧兜底」补 .replace 块，重启 DSH 生效。'
  }
}

# ---- 4. wb2api 插件：模型目录自愈三件套（别名过滤 / ?refresh=1 / 120s TTL） ----
$pluginLibs = @(
  'C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-plugin-wb2api-ui\lib\gw'
  'F:\project\dsh_chajian\dsh-wb2api\lib\gw'
)
foreach ($lib in $pluginLibs) {
  $cat = Join-Path $lib 'catalog.js'
  $set = Join-Path $lib 'settings.js'
  if (-not (Test-Path -LiteralPath $cat)) { Write-Warning "跳过（不存在）：$cat"; continue }
  $catRaw = Get-Content -LiteralPath $cat -Raw
  $okAlias   = $catRaw.Contains('isInternalAliasModel')
  $okRefresh = $catRaw.Contains('refresh=1')
  $okTtl     = (Test-Path -LiteralPath $set) -and (Get-Content -LiteralPath $set -Raw).Contains('modelsTtlSeconds: 120')
  if ($okAlias -and $okRefresh -and $okTtl) { "OK       $lib（模型目录自愈三件套在位）" }
  else {
    Write-Warning ("模型目录自愈补丁不完整：{0}（别名过滤={1} 强制刷新={2} 短TTL={3}）" -f $lib, $okAlias, $okRefresh, $okTtl)
    Write-Warning '重装时用 profile 的 pin（github:Wei894348/dsh-wb2api#1195034f…）即可整份带回，见 README「模型下拉全是假模型」。'
  }
}

# ---- 5. 需要时重启网关（supervisor 会自动拉起） ----
if ($needRestart -and -not $NoRestart) {
  '--- 重启网关 ---'
  Get-Process -Name wb2a-server -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  Get-Process -Name wb2a-server -ErrorAction SilentlyContinue |
    Select-Object Id, StartTime, Path | Format-Table -AutoSize
}

"期望 sha256：$wantSha"
"来源      ：$fixed"
