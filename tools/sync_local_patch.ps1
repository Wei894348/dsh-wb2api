# 把本仓库的本地改动（界面 + 宿主补丁）覆盖回 DSH 的 profile 安装目录。
#
# 背景：插件从 npm 安装，插件市场/管理器升级会整包覆盖 node_modules 里的副本，
# 把 client/client.js（仪表盘界面）和 lib/index.js（签到/倍率/login-pending 补丁）冲掉。
# 这个脚本就是「冲掉之后再贴回去」的一键操作：只覆盖我们改过的文件，先备份被覆盖的原件。
#
# 用法：
#   pwsh -File tools\sync_local_patch.ps1            # 同步并校验
#   pwsh -File tools\sync_local_patch.ps1 -DryRun    # 只看会做什么
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$profiles = @('desktop', 'web') | ForEach-Object { "C:\Users\86157\.dsh\profiles\$_\node_modules\dsh-plugin-wb2api-ui" }

# 只同步这些（目录整体镜像，文件逐个覆盖）
$dirs = @('lib', 'client', 'engine', 'locale', 'backend')
$files = @('package.json', 'cordis.patch.yml')

function Hash($path) {
  if (-not (Test-Path -LiteralPath $path)) { return 'MISSING' }
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.Substring(0, 16)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ok = $true

foreach ($dest in $profiles) {
  if (-not (Test-Path -LiteralPath $dest)) {
    Write-Host "[skip] $dest（没有这个 profile）"
    continue
  }
  $backup = Join-Path $env:TEMP "wb2api-npmbak-$stamp-$(Split-Path $dest -Parent | Split-Path -Parent | Split-Path -Leaf)"
  Write-Host "=== $dest"
  Write-Host "  backup: $backup"

  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    foreach ($dir in $dirs) {
      $from = Join-Path $repo $dir
      if (-not (Test-Path -LiteralPath $from)) { continue }
      # 镜像：仓库没有的文件（npm 版本的残留）一并清掉，避免两版混着跑
      robocopy $from (Join-Path $dest $dir) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    foreach ($file in $files) {
      $target = Join-Path $dest $file
      if (Test-Path -LiteralPath $target) {
        Copy-Item -LiteralPath $target -Destination (Join-Path $backup $file) -Force
      }
      Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $target -Force
    }
  }

  foreach ($dir in $dirs) {
    $sample = switch ($dir) {
      'lib' { 'index.js' }
      'client' { 'client.js' }
      default { $null }
    }
    if ($null -eq $sample) { continue }
    $rel = Join-Path $dir $sample
    $a = Hash (Join-Path $repo $rel)
    $b = Hash (Join-Path $dest $rel)
    if ($a -ne $b) { $ok = $false }
    Write-Host ("  {0,-18} repo={1} inst={2} {3}" -f $rel, $a, $b, $(if ($a -eq $b) { 'OK' } else { 'MISMATCH' }))
  }
  foreach ($rel in @('lib\gw\link.js', 'lib\gw\restart.js', 'client\wbcompat-shim.js', 'client\vendor\ui-runtime.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo $rel))) { continue }
    $a = Hash (Join-Path $repo $rel)
    $b = Hash (Join-Path $dest $rel)
    if ($a -ne $b) { $ok = $false }
    Write-Host ("  {0,-54} repo={1} inst={2} {3}" -f $rel, $a, $b, $(if ($a -eq $b) { 'OK' } else { 'MISMATCH' }))
  }
  $pkg = Get-Content -LiteralPath (Join-Path $dest 'package.json') -Raw | ConvertFrom-Json
  Write-Host ("  version={0}  dsh.client.inject={1}" -f $pkg.version, ($pkg.dsh.client.inject | Measure-Object).Count)
}

Write-Host ''
Write-Host $(if ($ok) { '[OK] 两处 profile 与仓库一致 —— 重启 DSH 后生效' } else { '[FAIL] 有文件不一致，见上面的 MISMATCH' })
if ($DryRun) { Write-Host '(DryRun：没有写入任何文件)' }
