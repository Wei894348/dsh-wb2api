<#
  存档 ↔ 现场 同步（v2）

  现场（真源，活的那份）：
    ~/.dsh/profiles/<profile>/node_modules/dsh-plugin-wb2api-ui/   插件本体
      覆盖 desktop / web / wbtest 三个 profile（dsh 从各自的 node_modules 加载）
    ~/.dsh/wb2api/                                                 网关运行目录（config/auths/data）
    <工作区>/wb_up/*.mjs, <工作区>/wb_tasks.mjs                    任务引擎（插件宿主 WB_TASKS_ENGINE 默认指这里）
    <工作区>/wb_*.mjs                                              运维脚本

  本存档：<工作区>/dsh-wb2api/  （仓库根 = npm 包根，与 dsh 加载的那份布局一致）

  用法：
    pwsh -File sync.ps1                   # 默认 pull：现场 → 存档（刷新存档）
    pwsh -File sync.ps1 -Direction push   # push：存档 → 现场（插件宿主改动需重启 dsh 才生效）
    pwsh -File sync.ps1 -WhatIfOnly       # 只看会动哪些文件

  v2 变更（2026-10-10）：
    - 现场路径从已废弃的 ~/.dsh/plugins/<pkg> 改为 ~/.dsh/profiles/<p>/node_modules/<pkg>
    - 插件本体不再逐文件登记，改为按 package.json 的 files 白名单**全量同步**，
      由此覆盖 lib/gw/*（旧版遗漏，导致 catalog.js 之类改了推不过去）
    - 排除运行时目录 data/
    - 输出改用 Write-Output（可重定向/可捕获；Write-Host 在 PS 5.1 下无法落盘）

  安全：auths/ 里的凭证（accessToken/refreshToken）与网关 config.json 的 api_key
  **永不进存档**。runtime/config.example.json 里的密钥是掩码占位。
#>
[CmdletBinding()]
param(
  [ValidateSet('pull', 'push')][string]$Direction = 'pull',
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$Archive = $PSScriptRoot
$Workspace = Split-Path -Parent $Archive
$RuntimeLive = Join-Path $env:USERPROFILE '.dsh\wb2api'

# 插件包白名单（与 package.json 的 files 字段一致）
$PkgDirs  = @('lib', 'client', 'engine', 'locale', 'assets', 'backend', 'docs')
$PkgFiles = @('package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE')

# 现场加载点：每个 profile 各一份 node_modules 副本
$Profiles = @('desktop', 'web', 'wbtest')
$PluginLives = @()
foreach ($p in $Profiles) {
  $d = Join-Path $env:USERPROFILE ".dsh\profiles\$p\node_modules\dsh-plugin-wb2api-ui"
  if (Test-Path -LiteralPath $d) { $PluginLives += @{ Profile = $p; Live = $d } }
}

$script:copied = 0
$script:skipped = 0

function Sync-One {
  param([string]$From, [string]$To)
  if (-not (Test-Path -LiteralPath $From)) { $script:skipped++; return }
  $same = (Test-Path -LiteralPath $To) -and ((Get-FileHash -LiteralPath $From).Hash -eq (Get-FileHash -LiteralPath $To).Hash)
  if ($same) { $script:skipped++; return }
  Write-Output "  复制：$From -> $To"
  if (-not $WhatIfOnly) {
    $toDir = Split-Path -Parent $To
    New-Item -ItemType Directory -Force -Path $toDir | Out-Null
    Copy-Item -LiteralPath $From -Destination $To -Force
  }
  $script:copied++
}

if ($PluginLives.Count -eq 0) {
  Write-Output '警告：没找到任何 profile 下的插件现场目录（检查 ~/.dsh/profiles/*/node_modules/）'
}

foreach ($pl in $PluginLives) {
  Write-Output "=== 插件现场：$($pl.Profile) ==="
  if ($Direction -eq 'push') {
    foreach ($d in $PkgDirs) {
      $src = Join-Path $Archive $d
      if (-not (Test-Path -LiteralPath $src)) { continue }
      Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($Archive.Length + 1)
        Sync-One -From $_.FullName -To (Join-Path $pl.Live $rel)
      }
    }
    foreach ($f in $PkgFiles) { Sync-One -From (Join-Path $Archive $f) -To (Join-Path $pl.Live $f) }
  } else {
    foreach ($d in $PkgDirs) {
      $liveDir = Join-Path $pl.Live $d
      if (-not (Test-Path -LiteralPath $liveDir)) { continue }
      Get-ChildItem -LiteralPath $liveDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($pl.Live.Length + 1)
        if ($rel -like 'data*') { return }   # 运行时数据不回收
        Sync-One -From $_.FullName -To (Join-Path $Archive $rel)
      }
    }
    foreach ($f in $PkgFiles) { Sync-One -From (Join-Path $pl.Live $f) -To (Join-Path $Archive $f) }
  }
}

# 引擎 / 运维脚本 / runtime（工作区散落文件）
Write-Output '=== 工作区散件 ==='
$Map = @(
  @{ Live = "$Workspace\wb_tasks.mjs";        Store = 'engine\wb_tasks.mjs' }
  @{ Live = "$Workspace\wb_daily.mjs";        Store = 'tools\wb_daily.mjs' }
  @{ Live = "$Workspace\wb_import.mjs";       Store = 'tools\wb_import.mjs' }
  @{ Live = "$Workspace\wb_checkin.mjs";      Store = 'tools\wb_checkin.mjs' }
  @{ Live = "$Workspace\wb_pooltest.mjs";     Store = 'tools\wb_pooltest.mjs' }
  @{ Live = "$Workspace\wb_client_smoke.mjs"; Store = 'tools\wb_client_smoke.mjs' }
  @{ Live = "$RuntimeLive\anthropic_bridge.py"; Store = 'runtime\anthropic_bridge.py' }
)
# 注意：旧路线留下的 CLI 脚本 wb_panel.mjs **不入档** —— 那条线已经不跑，
# 而且里面硬编码了本机网关 api_key。
Get-ChildItem -Path (Join-Path $Workspace 'wb_up') -Filter '*.mjs' -File -ErrorAction SilentlyContinue | ForEach-Object {
  $Map += @{ Live = $_.FullName; Store = "engine\wb_up\$($_.Name)" }
}
foreach ($item in $Map) {
  $from = if ($Direction -eq 'pull') { $item.Live } else { Join-Path $Archive $item.Store }
  $to   = if ($Direction -eq 'pull') { Join-Path $Archive $item.Store } else { $item.Live }
  Sync-One -From $from -To $to
}

Write-Output ''
Write-Output "方向=$Direction  复制=$script:copied  未变/跳过=$script:skipped"
if ($Direction -eq 'push') { Write-Output '提示：插件宿主半侧（lib/index.js）改完必须重启 dsh 才生效。' }
