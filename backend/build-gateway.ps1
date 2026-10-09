<#
  从 Go 源码构建网关二进制（可选：本仓库已自带 backend/bin/wb2a-server.exe）。

  为什么要有这个脚本：跑一遍就能自己验一份二进制 —— 从源码编译，再和包内那份比对
  SHA256；换了网关源码之后也用它重新出包。

  用法：
    pwsh -File build-gateway.ps1 -SourceRepo <源码仓库地址或本地路径>
                                                  # 克隆到 .build/ 并交叉编译到 backend/bin
    pwsh -File build-gateway.ps1 -SourceRepo <...> -OutDir .\dist   # 换个输出目录
    pwsh -File build-gateway.ps1 -SourceRepo <...> -KeepSource      # 保留源码目录（默认复用 .build/src）

  要求：Go 1.22+（`go version` 能看到即可）。首次会 git clone + 下载依赖，需要网络。
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'bin'),
  [string]$WorkDir = (Join-Path $PSScriptRoot '.build'),
  [string]$SourceRepo = '',
  [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'

if (-not $SourceRepo) { throw '需要 -SourceRepo <网关 Go 源码仓库地址或本地路径>。' }

# 1. 前置检查：有没有 go
$go = Get-Command go -ErrorAction SilentlyContinue
if (-not $go) { throw ' 没找到 go。装一个 Go 1.22+ 再跑（https://go.dev/dl/）。' }
Write-Host "go: $($go.Source)" -ForegroundColor Cyan
& go version

# 2. 取源码（复用已有克隆，只拉更新）
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$src = Join-Path $WorkDir 'src'
if (Test-Path (Join-Path $src '.git')) {
  Write-Host "复用已有源码：$src" -ForegroundColor DarkGray
  git -C $src fetch --depth 1 origin
  git -C $src reset --hard FETCH_HEAD
} else {
  Write-Host "克隆源码：$SourceRepo" -ForegroundColor Cyan
  git clone --depth 1 $SourceRepo $src
}

# 3. 交叉编译（与发布产物同口径：windows/amd64，CGO 关掉）
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir 'wb2a-server.exe'
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
Write-Host "构建 → $out" -ForegroundColor Cyan
# 网关主包入口在 cmd/server（若源码目录布局有变，改这一行即可）。
& go build -C $src -trimpath -ldflags '-s -w' -o $out ./cmd/server

# 4. 指纹 + 与自带那份比对
$hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
$size = [math]::Round((Get-Item -LiteralPath $out).Length / 1MB, 2)
Write-Host ""
Write-Host "构建完成：$out" -ForegroundColor Green
Write-Host "  SHA256: $hash"
Write-Host "  体积  : $size MB"
$bundled = Join-Path $PSScriptRoot 'bin\wb2a-server.exe'
if (Test-Path -LiteralPath $bundled) {
  $bundledHash = (Get-FileHash -LiteralPath $bundled -Algorithm SHA256).Hash
  if ($bundledHash -eq $hash) { Write-Host "  与自带那份一致 ✔" -ForegroundColor Green }
  else { Write-Host "  与自带那份不同（自带的 SHA256: $bundledHash）—— 源码可能有更新，或有构建差异" -ForegroundColor Yellow }
}

if (-not $KeepSource) { Write-Host "（源码留在 $src，想清理直接删该目录）" -ForegroundColor DarkGray }
