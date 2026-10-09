# 延时触发 dsh 自重启（dshmarket 的一键重启路由），并在重启后回读新路由是否挂上。
# 由本项目的「一键做任务」按钮落地时使用：插件 host 半侧只在 dsh 启动时加载，
# 新路由必须重启一次才生效。脚本被 Start-Process 独立拉起，不随 dsh 退出而死。
# 日志落在临时目录，避免把仓库工作区写脏。
$log = Join-Path $env:TEMP 'wb-restart-check.log'
function Note($text) { "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -Append -Encoding utf8 $log }

Note '等待 15s，让当前这轮对话把话说完再重启…'
Start-Sleep -Seconds 15

try {
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3080/dsh-market/restart' `
    -Headers @{ Origin = 'http://127.0.0.1:3080' } -TimeoutSec 20
  Note ("trigger: " + ($r | ConvertTo-Json -Compress))
} catch {
  Note ("trigger failed: " + $_.Exception.Message)
  Note '（403 → dshmarket 的 allowRestart 被主管进程禁用；那就手点市场里的重启，或直接关掉 dsh 再开）'
  exit 0
}

Start-Sleep -Seconds 20
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  try {
    $s = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/dsh-wb2api/tasks/status' -TimeoutSec 5
    Note ("after restart: /dsh-wb2api/tasks/status OK -> " + ($s | ConvertTo-Json -Compress))
    $ok = $true
    break
  } catch {
    Start-Sleep -Seconds 5
  }
}
if (-not $ok) { Note 'after restart: 新路由仍不可达（404/405）—— host 半侧没重载，需完整关闭再启动 dsh' }
