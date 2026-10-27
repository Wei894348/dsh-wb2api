# 彻底重启 DeepSeek Harness（DSH）：结束宿主进程 → 重新启动桌面端。
#
# 为什么要这个脚本：DSH 桌面端关窗口不等于退出，托盘常驻的宿主进程会一直活着，
# 插件的新代码（lib/、client/）就不会被加载 —— 表现是「改了代码但现象一点没变」。
#
# 用法：pwsh -File tools\restart_dsh.ps1
#      pwsh -File tools\restart_dsh.ps1 -DryRun    # 只看会杀哪些进程

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 桌面端安装位置：优先环境变量，其次常见路径
$candidates = @(
  $env:DSH_DESKTOP_EXE,
  'F:\Softstore\deepseek harness\DeepSeek Harness.exe',
  'F:\Softstore\deepseek harness\DeepSeekHarness.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $candidates) {
  $root = 'F:\Softstore\deepseek harness'
  if (Test-Path -LiteralPath $root) {
    $candidates = @(Get-ChildItem -LiteralPath $root -Filter *.exe -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'elevate|default_app' } |
      Select-Object -ExpandProperty FullName)
  }
}

$exe = $candidates | Select-Object -First 1

# 宿主进程：node.exe 且命令行里带 dsh（不碰你自己的 node 项目）
$hosts = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' })

# 桌面端主进程
$app = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $exe -and $_.Path -eq $exe })

Write-Host '将要结束的进程：'
foreach ($p in $hosts) { Write-Host ("  node  PID={0}  {1}" -f $p.ProcessId, ($p.CommandLine -replace '\s+', ' ').Substring(0, [Math]::Min(110, $p.CommandLine.Length))) }
foreach ($p in $app) { Write-Host ("  app   PID={0}  {1}" -f $p.Id, $p.ProcessName) }
if (-not $hosts -and -not $app) { Write-Host '  （没有匹配的进程）' }
Write-Host ("启动目标：{0}" -f ($(if ($exe) { $exe } else { '未找到桌面端 exe，请用 -exe 指定' })))

if ($DryRun) { Write-Host '`n(DryRun：什么都没做)'; return }

foreach ($p in $app) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
foreach ($p in $hosts) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Seconds 2

$still = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh' })
if ($still.Count -gt 0) {
  Write-Host ("[warn] 仍有 {0} 个宿主进程未退出，再杀一次" -f $still.Count)
  foreach ($p in $still) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

if ($exe) {
  Start-Process -FilePath $exe
  Write-Host '[OK] 已重新启动 DSH —— 等界面出来后，看 ~/.dsh/wb2api/data/gw-debug.log 是否出现「apply 进入」'
} else {
  Write-Host '[FAIL] 没找到桌面端可执行文件：请手动启动 DSH'
}
