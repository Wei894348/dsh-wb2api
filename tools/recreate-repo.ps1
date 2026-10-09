<#
  重建远端仓库：删旧库 → 建新库 → 推 main → 复验。

  ## 为什么需要脚本

  删仓库要 `delete_repo` scope，而本机 GCM 里那枚 `gho_` token 只有
  `gist, repo, workflow` —— 也就是**删不掉**（实测 DELETE /repos/... 返回 403）。
  所以流程拆成两段：

    1. 【人工，30 秒】在浏览器里删掉旧库：
       https://github.com/<owner>/<repo>/settings → 页面底部 Danger Zone →
       Delete this repository → 输入仓库名确认。
    2. 【本脚本】用现有 token 建同名新库（`repo` scope 够用）→ 推 main → 复验。

  如果你愿意给一枚带 `delete_repo` 的 classic PAT（环境变量 GH_DELETE_TOKEN），
  加 `-DeleteFirst` 就能连删除一起做掉。

  用法：
    pwsh -File tools/recreate-repo.ps1                     # 建库 + 推 + 复验
    pwsh -File tools/recreate-repo.ps1 -WhatIf             # 只看会做什么
    $env:GH_DELETE_TOKEN='ghp_xxx'
    pwsh -File tools/recreate-repo.ps1 -DeleteFirst        # 连删除一起做
#>
[CmdletBinding()]
param(
  [string]$Owner = 'Wei894348',
  [string]$Repo = 'dsh-wb2api',
  [switch]$DeleteFirst,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Api = 'https://api.github.com'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Ua = 'dsh-wb2api-recreate'

# ── token：优先环境变量，其次 Windows 凭据管理器里的 GitHub 凭据（只读，不打印）──
function Get-GitHubToken {
  if ($env:GH_TOKEN) { return $env:GH_TOKEN }
  try {
    $out = "protocol=https`nhost=github.com`n" | & git-credential-manager get 2>$null
    $pw = ($out | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
    if ($pw) { return $pw }
  } catch { }
  throw '拿不到 GitHub 凭据：设置 $env:GH_TOKEN，或先让 GCM 存一份。'
}

$token = Get-GitHubToken
$headers = @{ Authorization = "Bearer $token"; 'User-Agent' = $Ua; Accept = 'application/vnd.github+json' }

function Show-Scopes {
  $r = Invoke-WebRequest -Uri "$Api/user" -Headers $headers -Method Get
  "认证用户：$($r.Content | ConvertFrom-Json | Select-Object -ExpandProperty login)"
  "token scopes：$($r.Headers['X-OAuth-Scopes'])"
}

Show-Scopes

if ($WhatIf) {
  "会做：$(if ($DeleteFirst) { 'DELETE 旧库 → ' })POST /user/repos（$Owner/$Repo, public）→ git push -u origin main → 复验"
  return
}

if ($DeleteFirst) {
  $del = $env:GH_DELETE_TOKEN
  if (-not $del) { throw '-DeleteFirst 需要 $env:GH_DELETE_TOKEN（带 delete_repo 的 classic PAT）。' }
  $dh = @{ Authorization = "Bearer $del"; 'User-Agent' = $Ua; Accept = 'application/vnd.github+json' }
  try {
    Invoke-RestMethod -Uri "$Api/repos/$Owner/$Repo" -Headers $dh -Method Delete
    '旧库已删除'
  } catch {
    throw "删除失败：$($_.Exception.Message)。若为 403，说明该 token 没有 delete_repo。"
  }
}

# ── 建新库（仓库名已被占用时 GitHub 会报 422 —— 说明旧库还没删）──
try {
  $created = Invoke-RestMethod -Uri "$Api/user/repos" -Headers $headers -Method Post -Body (@{
      name        = $Repo
      private     = $false
      description = 'WorkBuddy 反代 dsh 插件（一体化：网关托管 + 面板卡片 + 任务自动化引擎）'
      has_issues  = $true
      has_wiki    = $false
    } | ConvertTo-Json)
  "新库已建：$($created.full_name)  ($($created.html_url))"
} catch {
  $msg = $_.ErrorDetails.Message
  if ($msg -like '*already exists*') {
    throw "仓库 $Owner/$Repo 仍存在 —— 先在浏览器里删掉，再跑本脚本。"
  }
  throw "建库失败：$($_.Exception.Message) $msg"
}

# ── 推 main ──
Push-Location $RepoRoot
try {
  if (-not (git remote | Select-String -SimpleMatch 'origin')) {
    git remote add origin "https://github.com/$Owner/$Repo.git"
  } else {
    git remote set-url origin "https://github.com/$Owner/$Repo.git"
  }
  # 本机 GCM 的 helper-selector 在 GIT_TERMINAL_PROMPT=0 下不出凭证，显式用 manager：
  git -c credential.helper=manager push -u origin main
  if ($LASTEXITCODE -ne 0) { throw "git push 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }

# ── 复验：远端 HEAD 与本地一致 ──
$local = (git -C $RepoRoot rev-parse HEAD).Trim()
$remote = (git -C $RepoRoot ls-remote origin refs/heads/main).Split("`t")[0].Trim()
"本地 HEAD：$local"
"远端 main：$remote"
if ($local -eq $remote) { '✅ 一致，重建完成。' } else { '❌ 不一致，检查 push 输出。' }
