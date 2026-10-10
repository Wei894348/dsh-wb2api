<#
  存档 ↔ 现场 同步。

  现场（真源，活的那份）：
    ~/.dsh/plugins/dsh-plugin-wb2api-ui/          插件本体（dsh 从这里加载）
    ~/.dsh/wb2api/                                 网关运行目录（config/auths/data）
    <工作区>/wb_up/*.mjs, <工作区>/wb_tasks.mjs     任务引擎（插件宿主 WB_TASKS_ENGINE 默认指这里）
    <工作区>/wb_*.mjs                              运维脚本

  本存档：<工作区>/dsh-wb2api/

  用法：
    pwsh -File sync.ps1              # 默认 pull：现场 → 存档（刷新存档）
    pwsh -File sync.ps1 -Direction push   # push：存档 → 现场（把存档里的改动推回去，需重启 dsh）
    pwsh -File sync.ps1 -WhatIfOnly       # 只看会动哪些文件

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
$PluginLive = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-plugin-wb2api-ui'
$RuntimeLive = Join-Path $env:USERPROFILE '.dsh\wb2api'

# 每一行：现场路径 → 存档内相对路径
$Map = @(
  # 插件本体（仓库根 = npm 包根，与 dsh 加载的那份布局一致）
  @{ Live = "$PluginLive\package.json";       Store = 'package.json' }
  @{ Live = "$PluginLive\cordis.patch.yml";   Store = 'cordis.patch.yml' }
  @{ Live = "$PluginLive\README.md";          Store = 'docs\PANEL.md' }
  @{ Live = "$PluginLive\lib\index.js";       Store = 'lib\index.js' }
  @{ Live = "$PluginLive\client\client.js";   Store = 'client\client.js' }
  # 引擎
  @{ Live = "$Workspace\wb_tasks.mjs";        Store = 'engine\wb_tasks.mjs' }
  # 运维脚本
  @{ Live = "$Workspace\wb_daily.mjs";        Store = 'tools\wb_daily.mjs' }
  @{ Live = "$Workspace\wb_import.mjs";       Store = 'tools\wb_import.mjs' }
  @{ Live = "$Workspace\wb_checkin.mjs";      Store = 'tools\wb_checkin.mjs' }
  @{ Live = "$Workspace\wb_pooltest.mjs";     Store = 'tools\wb_pooltest.mjs' }
  @{ Live = "$Workspace\wb_client_smoke.mjs"; Store = 'tools\wb_client_smoke.mjs' }
  # 注意：旧路线留下的 CLI 脚本 wb_panel.mjs **不入档** —— 那条线已经不跑，
  # 而且里面硬编码了本机网关 api_key。
  # 运行目录（只收配置模板，auths 与 api_key 绝不入库）
  @{ Live = "$RuntimeLive\anthropic_bridge.py"; Store = 'runtime\anthropic_bridge.py' }
)
# wb_up/ 整目录
Get-ChildItem -Path (Join-Path $Workspace 'wb_up') -Filter '*.mjs' -File | ForEach-Object {
  $Map += @{ Live = $_.FullName; Store = "engine\wb_up\$($_.Name)" }
}

$copied = 0
$skipped = 0
foreach ($item in $Map) {
  $from = if ($Direction -eq 'pull') { $item.Live } else { Join-Path $Archive $item.Store }
  $to   = if ($Direction -eq 'pull') { Join-Path $Archive $item.Store } else { $item.Live }
  if (-not (Test-Path -LiteralPath $from)) { Write-Host "  缺：$from（跳过）" -ForegroundColor DarkYellow; $skipped++; continue }
  $toDir = Split-Path -Parent $to
  if (-not $WhatIfOnly) { New-Item -ItemType Directory -Force -Path $toDir | Out-Null }
  $same = (Test-Path -LiteralPath $to) -and ((Get-FileHash -LiteralPath $from).Hash -eq (Get-FileHash -LiteralPath $to).Hash)
  if ($same) { Write-Host "  同：$($item.Store)" -ForegroundColor DarkGray; $skipped++; continue }
  Write-Host "  复制：$from`n     → $to" -ForegroundColor Cyan
  if (-not $WhatIfOnly) { Copy-Item -LiteralPath $from -Destination $to -Force }
  $copied++
}

Write-Host ""
Write-Host "方向=$Direction  复制=$copied  未变/跳过=$skipped" -ForegroundColor Green
if ($Direction -eq 'push') { Write-Host "提示：宿主半侧（plugin/lib/index.js）改完必须重启 dsh 才生效。" -ForegroundColor Yellow }
