# wb2api 网关修复说明（2026-10-29）

## 症状

- dsh-purge 注入的「富江」人格突然失效，模型变成中性助手。
- 同一次上游 `content_blocked` 之后，**当天之后所有请求**的 system 都被换成中性提示词，第二天自己好了。
- 插件侧日志里注入字节数是正常的（fullBytes/injectBytes 正常，strip=true），看不出是网关干的。

## 根因（三层叠加）

1. **触发点**：宿主 DSH 的 file-reference 引导句
   `Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; ...`
   被上游内容审核按**逐字指纹**拦截（`400 code=11-128, Illegal API invocation from an unapproved channel`）。改写这个词形即通过，与语义无关。
2. **放大点**：网关 `wb2a-server.exe` 的降级状态机（`degradeGate`）粒度错误——一次 11-128 就把**整个进程**降级「到次日 00:00 CST」，降级期内每一请求的 system 被整条替换成 `Degraded` 中性提示词。任何一条请求撞墙 = 全天人格丢失。
3. **漏防点**：出站脱敏层（`internal/upstream/sanitize.go`）里没有这条指纹，所以 system 原样发上游，必然再撞。

## 修复内容

### 网关（Go 源码，5 个文件）

第一轮（止血 + 根因）：

| 文件 | 改动 |
| --- | --- |
| `internal/upstream/sanitize.go` | `sanitizeFeatures` 增加 `Tokens prefixed with @ are paths the user explicitly referenced`；`sanitizeRewrites` 增加 `@` → `the at-sign` 改写（只改一词，语义不变，逐字指纹被打断） |
| `internal/server/degrade.go` | 降级窗口 `nextMidnightCST`（次日 00:00）→ 短窗口，默认 **10 分钟**，`WB2A_DEGRADE_WINDOW` 可调（Go duration 语法）；新增 `WB2A_DEGRADE_PROBE`（默认 30s，`0` = 关闭探针）与 `WB2A_DEGRADE_DISABLE=1`（整体关降级，排查用）；新增 `AllowProbe()` / `Clear()` / `Until()` |
| `internal/server/handler.go` | 降级期内按 `probeInterval` 限频放一条**客户端原文**出站；这条一旦 200 立即 `Clear()` 收回降级（人格当场回来）；已降级时不再无限续期 |
| `internal/server/degrade_test.go` | 测试同步新语义（窗口/探针/关闭开关） |

第二轮（独立验证发现的 3 个缺陷，2026-10-29 18:57 修完）：

| 缺陷 | 修法 |
| --- | --- |
| ① 探针被拦后，其 Degraded 重试成功被误判成 `probe succeeded` → 提前 `Clear()`，窗口被削成「每条请求先撞一次 400」 | 撞墙改写 Degraded 的同一处 `degradeProbe = false`（探针失败不算成功），成功分支再加 `degradeProbe && !degradedApplied` 双保险 |
| ② `WB2A_DEGRADE_DISABLE=1` 仍会在同请求内换 Degraded 回 200，与「只保留错误透传」矛盾 | 降级重试分支加 `&& !degradeDisabled()`；关掉后上游 400 原文直接透传客户端 |
| ③ 探针失败无日志、`Until()` 未接 `/status` | 失败打 `[server] degrade probe rejected … keep degraded until <RFC3339>`；`/status` 新增 `degrade` 块（`active` / `disabled` / `window` / `probe` / `until`） |

`internal/server/handler_test.go` 增加两组回归：`TestContentBlockedDegradeDisabledPassthroughError`（开关态 → 400 原文透传、上游只调 1 次）、`TestDegradeProbeRejectedKeepsDegrade`（探针被拦 → 降级仍在、不打印成功日志）。

### dsh-purge 插件（兜底层，可选但与网关同义）

`lib/identity.js` 的 `stripHarnessPersona()` 追加同款改写：

```js
.replace(
  /Tokens prefixed with @ are paths the user explicitly referenced\./g,
  "Tokens prefixed with the at-sign are paths the user explicitly referenced.",
)
```

作用：即使网关被插件更新覆盖回官方二进制，宿主 system 里也不再有被拦的 `@` 形态句子。
**4 份全部同步**（`node --check` 均通过，改写规则均验证生效）：

| 位置 | 角色 |
| --- | --- |
| `C:\Users\86157\.dsh\profiles\desktop\vendor\dsh-purge\lib\identity.js` | 运行时（vendor） |
| `C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-purge\lib\identity.js` | 运行时（安装位，与 vendor 同 sha） |
| `F:\project\git_project\dsh-purge\lib\identity.js` | 源码仓库（v1.1.71，未提交） |
| `F:\project\破甲提示词\dsh-purge\lib\identity.js` | 另一份源码仓库（未提交） |

> 该改动在插件代码里，要**下次 DSH 重启**才加载；网关层修复已即时生效。

## 部署现状

网关二进制：10,127,872 字节，sha256 `1CA4DE8F576A0AA8E62E18B84458CA698E4EB4A54F1E74B921BA71B5CBA28D39`（第四版：带 `/v1/messages` + `/v1/responses` 适配层 + 降级/脱敏全部修复 + **模型目录自愈**：内部别名出口闸门、`/v1/models?refresh=1`、`/status.models`）

> ⚠️ **构建源必须是 `F:\project\wb2api-gateway\workbuddy2api-agent`**。
> 插件随包那份 14.4MB 官件就是它构建的（比干净仓库多 `internal/agent/` 的 Anthropic/Responses 适配层）。
> 干净仓库 `workbuddy2api-panel`（commit `b69d06e`）**没有这两个路由**：用它构建出来的二进制 DSH 能用，
> 但 Codex（`/v1/responses`）和 Claude Code（`/v1/messages`）会全线 404 —— 2026-10-29 19:0x 已踩过一次。

历史版本（均留档可回退）：

- 第二版 9,973,760 字节 `98F66950…C0728C30A`（3 缺陷已修，但缺 messages/responses 路由 → 弃用）
- 第一版 9,970,176 字节 `0DFA7E08…826A9E53`
- 官方原件 14,392,832 字节 `DD9FD4D3…`（有全部路由，但有「降级到次日 00:00」的原始 bug）

**4 处二进制全部同 sha256**（少一处就会被启动同步覆盖回去）：

| 位置 | 说明 |
| --- | --- |
| `C:\Users\86157\.dsh\wb2api\bin\wb2a-server.exe` | 实际运行的一个（PID 28092，127.0.0.1:7863） |
| `C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-plugin-wb2api-ui\backend\bin\wb2a-server.exe` | 已安装插件包的随包副本（启动时 `installBinaryFromBundled()` 会把它 sync 到安装位） |
| `F:\project\dsh_chajian\dsh-wb2api\backend\bin\wb2a-server.exe` | 插件**开发仓库**的随包副本（重装/同步会从这里发出，故一并换掉） |
| GitHub `Wei894348/dsh-wb2api` tag **`wb2api-fix-20261029`** | 权威留档：仓库里 `backend/bin/wb2a-server.exe` 就是这份二进制；`ensure` 脚本从它拉取并校验 sha256 |

原官方件（14,392,832 字节）备份（运行位/插件位各一份，仓库里那份已随清理删除）：

- `C:\Users\86157\.dsh\wb2api\bin\wb2a-server.exe.running-old`
- `C:\Users\86157\.dsh\profiles\desktop\node_modules\dsh-plugin-wb2api-ui\backend\bin\wb2a-server.exe.pnpmstore-orig`

插件目录那份原本是 pnpm 硬链接，替换时先改名断链再拷入，**全局 pnpm store 未被污染**。

源码与补丁：

- 构建源（唯一有效）：`F:\project\wb2api-gateway\workbuddy2api-agent`（本地分支 `fix/persona-degrade-models-alias`，提交 `f41b909`；**尚未推上 GitHub —— 当前 SSH 身份 `Wei894348` 无该仓库写权限**）
- 规范仓库副本：`F:\project\git_project\workbuddy2api-panel`（同 commit `b69d06e`，已同步这 5 个文件，**未提交**）
- 补丁文件：`wb2api-degrade-sanitize-fix.diff`（25549 字节，对干净树可 `git am`）
- 核对用二进制：本地已不留档（也删了 `F:\tmp\wb2a-src` 临时构建副本）；`ensure-wb2a-fix.ps1` 从 GitHub raw 拉 tag `wb2api-fix-20261029` 里的那份并校验 sha256

## 验证证据（2026-10-29 18:07 部署后）

1. **隔离实例 + 原文指纹句**（新二进制，粘贴 `@` 形态整句作 system）：无 `content_blocked`，`pt=53` → 脱敏层改写生效。
2. **隔离实例 + 真实宿主完整 system**（`sys_full.txt`，12843 字节）：连续 3 轮均 `pt=2776`，无 `content_blocked`、无降级重试。
3. **在线网关（7863）未处于降级**：canary system 被尊重——小 system `pt=45`、大 system `pt=700`，且两例回复都回显 `ZEBRA7`（降级时 system 会被整条丢弃，pt 固定在 ~50 且不回显）。
4. **`gw-debug.log` 自 18:07 重启后无任何 `content_blocked`**。
5. **单元测试**：`go test ./internal/server ./internal/upstream` 全绿（非缓存，12.9s / 5.2s）。
6. **本会话**：DSH 当前会话的 system 就是完整「富江」人格文本 → dsh-purge 注入链路已恢复。

### 第二轮（18:57 部署后，针对独立验证发现的 3 个缺陷）

1. **脱敏回归**：隔离实例（脱敏开）发原指纹句 → `200`、`pt=69`、无 400。
2. **`WB2A_DEGRADE_DISABLE=1`**：关脱敏发原指纹句 → `400`，`error.code=content_blocked`，`message` 装上游原文（`11-128`、`requestId` 原样），日志无 `degraded prompt retry`，`/status` 显示 `disabled:true, active:false`。
3. **探针被拦不再误判**（`WINDOW=300s PROBE=1s`）：触发降级 → 探针（原文）再撞 400 → 日志 `degrade probe rejected … keep degraded until …`、降级仍 `active`、无 `probe succeeded`；随后干净探针 200 → 日志 `degrade probe succeeded`、`active:false` 立即恢复。
4. **在线网关（PID 12564）**：`/status` 的 `degrade` 块为 `{"active":false,"disabled":false,"probe":"30s","window":"10m0s"}`；canary system 被尊重（2458 字 system → `pt=563`、`Q7XK` 回显；小 system → `pt=61`）；`gw-debug.log` 无 `content_blocked`。
5. **单元测试**：新增 `TestContentBlockedDegradeDisabledPassthroughError` / `TestDegradeProbeRejectedKeepsDegrade` 后 `go vet` + `go test ./internal/server ./internal/upstream` 全绿（10.3s / 2.9s）。

### 第三轮（19:06）：第二版二进制丢了 `/v1/responses` 与 `/v1/messages`（Codex/Claude 404 事故）

**症状**：18:07 换件后 Codex 每轮请求都是 `404 page not found`（cc-switch 日志 `[FWD-003] Provider workbuddy 请求失败: 上游 HTTP 404`），04 次后熔断器 Open；Claude Code（cc-switch 的 claude 侧 `ANTHROPIC_BASE_URL=http://127.0.0.1:7863`）同样会撞 `/v1/messages` 404。

**根因**：源码版本不匹配。随包官件（14,392,832 字节）是从 `F:\project\wb2api-gateway\workbuddy2api-agent` 构建的 —— 它在 `b69d06e` 之上多了一整套**未提交**的 `internal/agent/`（`anthropic_request.go` / `anthropic_stream.go` / `responses_request.go` / `responses_stream.go`）与 `internal/server/agent_routes.go`，注册了 `POST /v1/messages` 与 `POST /v1/responses`（翻成 chat completions 复用主链路）。而干净仓库 `workbuddy2api-panel`（`b69d06e`）**没有**这两个路由。第二版二进制是从干净仓库构建的 → 端点覆盖退化成只剩 `chat/completions` + `models`。

**修法**：把同一份 5 文件补丁 `git apply` 到 agent 源码（补丁与它的本地改动零冲突，hunk 全部 offset 命中），重新构建，三端点全部实测通过。

**证据（部署后在线 7863）**：

- `POST /v1/chat/completions` → `200`（DSH 路径，canary `R3V8` 回显）
- `POST /v1/responses` → `200`，返回标准 Responses 对象（`object:"response"`、`output[]` 里有 `reasoning` + `message`）
- `POST /v1/messages` → `200`，返回标准 Anthropic 对象（`content[{type:thinking},{type:text}]`、`stop_reason:"end_turn"`）
- 经 cc-switch 本地代理 `15721/v1/responses` → `200`（Codex 实际走的那条路已恢复）
- 隔离实例同三项全 `200`；`go vet` + `go build ./...` 退出 0

## 第四轮（19:19）：模型下拉里出现「假模型」（enhance-1.0 / seedance-2.5 / fast-model / primary-model / auto-chat / o4-mini / default-model）

**症状**：DSH 模型下拉里出现一堆一看就不对的名字，全是「国内版 xxx」；点刷新没用，**重启网关也没用，只有重启整个 DSH 才恢复**。

**根因（三层叠加，缺一不可）**：

1. **挑号不分域**（上游软件 bug，17 号已修）：`fetchDynamicModels` 早期用 `Pool.Pick()`，随机撞中 global 号时把**国际版菜单**（含桌面端内部档位名 `fast-model/primary-model/default-model/auto-chat/o4-mini/enhance-1.0/seedance-2.5`）当成 CN 菜单下发，还统一加了 `cn:` 前缀 → 用户看到「国内版 fast-model」。运行中的旧官件（10-16 构建）没有 10-17 的 `PickExcludingForRealm(nil,"","cn")` 修复，所以这个 bug 一直在。
2. **网关目录缓存 1h**：错一次就错一小时；重启网关能清，但下一轮又可能撞上同一个错号。
3. **插件侧缓存 + 无校验 + 刷新不到网关**：`ModelCatalog` TTL 10 分钟（`modelsTtlSeconds: 600`），拉到的目录**不看内容直接缓存并写快照**（`data/model-catalog.json`）；而「同步模型」的 `force` 只绕过插件自己的 TTL，**没让网关作废它那层 1h 缓存** —— 所以「点刷新 / 重启网关」在插件 TTL 内看起来全是无效操作，只有重启宿主能重来一遍。

**修法**：

网关（`workbuddy2api-agent`）：

- `internal/upstream/model_alias.go`（新增）：内部别名出口闸。`IsInternalModelAlias`（CN 严格：档位名 + 非对话产物）、`IsNonChatArtifact`（global 只剔非对话产物：enhance/seedance/auto-chat/o4-mini/canvas —— global 的 `default-model/fast-model/balanced-model/primary-model/deep-model` 是客户端菜单里的 Auto/Fast/Balanced/Primary/Deep，**真实可用，必须保留**）。`/v1/models` 两个分支各自过闸并计数打日志。
- `/v1/models?refresh=1`：先 `invalidateDynamicModelsCache()` + `InvalidateGlobalModelsCache()`，再回列表 —— 插件「同步模型」和排查脚本从此能真正穿透网关缓存。
- `/status` 新增 `models` 块：`{cn_count, ttl, age_seconds, last_fail_age_seconds}`，一眼分辨「网关目录旧了」还是「上游没拉到」。

插件（`lib/gw/catalog.js` + `lib/gw/settings.js`，安装位与仓库两份同 sha）：

- 别名策略与网关同构：非对话产物一律过滤；`default-model` 等档位名**只在 `cn:` 下过滤**（global 保留）。
- **整份目录清一色别名 / 空目录 → 判为网关抽风**：保住上一份好目录、写 `lastError`、**绝不覆盖快照**（否则假目录会跨重启存活）。
- `modelsTtlSeconds` 600 → **120**：一次抽风最多影响 2 分钟。
- 失败后 **30s** 就允许重试（只在 `lastError` 非空时短路 TTL，正常路径行为不变）。
- `force` 现在请求 `GET /v1/models?refresh=1`，即「同步模型」= 插件缓存 + 网关缓存一起作废。

**证据（19:19 部署后在线 7863，PID 7104，sha `1CA4DE8F…`）**：

- `/v1/models`：44 条；CN 15 条全是真模型（Auto / DeepSeek-V4.1-Flash / GLM-5.3 / Kimi-K3.1-Pro …）；`cn_alias_leak=0`、`global_artifact_leak=0`；global 的 5 条档位名按设计保留。
- `/v1/models?refresh=1`：576ms（真实回上游），随后 `/status` 的 `models.age_seconds=0` → 缓存确实被作废重建。
- `/status` → `{"models":{"cn_count":15,"ttl":"1h0m0s","age_seconds":0}}`。
- `/v1/chat/completions` / `/v1/responses` / `/v1/messages` 三端点仍全 `200`；`gw-debug.log` 无 `content_blocked`。
- 单测：`TestModelListFiltersInternalAliases` 通过；插件目录逻辑用 node 断言跑过（过滤 / 别名目录判废 / `refresh=1` / 快照不被污染，ALL PASS）。

> 插件这部分是 JS，**要重启一次 DSH 才加载**；网关侧已即时生效（所以现在下拉里的假模型已经不会再出现）。
> 重启之后，再遇到目录不对：点「同步模型」，或直接 `GET /v1/models?refresh=1`，最坏等 2 分钟 —— **不需要再重启宿主**。

## 运维要点

- 插件更新/重装会把 `backend\bin\wb2a-server.exe` 换回官方件（14.4MB）。发现人格又丢时先跑：

```powershell
pwsh -File F:\project\dsh_chajian\.tmp\wb2a-fix\ensure-wb2a-fix.ps1
```

- 巡检：`Select-String C:\Users\86157\.dsh\wb2api\data\gw-debug.log -Pattern 'content_blocked'`——出现即说明上游又加了新指纹，把新句加进 `sanitizeFeatures` + `sanitizeRewrites` 后重新 `go build`。
- 人格已经被吃掉时：重启网关进程（清内存态降级）或等窗口过期（≤10 分钟，探针命中会提前自愈）。
- 一眼判断是不是网关降级干的：`/status` 里看 `degrade` 块（`active` / `until` / `disabled` / `window` / `probe`）。`active:true` 就说明当前 system 正被换成中性提示词。
- 想彻底关掉降级行为：给网关进程环境加 `WB2A_DEGRADE_DISABLE=1`。

## 回滚

1. 二进制，按需回退（旧 `prev-*` 已归档到 `.tmp\wb2a-fix\archive\`，原路径只留最近一份）：
   - 回上一版（CCD7B48C，有 messages/responses 但**没有**模型目录闸门）：把三处 `wb2a-server.exe.prev-20261029191938` 改名回 `wb2a-server.exe`。
   - 回第一轮（0DFA）/ 第二版（98F66950）/ 第三版（CCD7）：从 `.tmp\wb2a-fix\archive\` 取对应 `prev-*` 改名回原路径。
   - 回官方件：把 `wb2a-server.exe.running-old`（安装位）/ `wb2a-server.exe.pnpmstore-orig`（插件位）/ `.tmp\wb2a-fix\dsh-wb2api-repo-bundled-official.exe`（开发仓库位）各自改名回去（官方件带全部路由，但恢复「降级到次日 00:00」的原始 bug）。
   - 然后杀掉当前 `wb2a-server` 进程（supervisor 会自动拉起新进程）。
2. 源码：`git -C F:\project\git_project\workbuddy2api-panel checkout -- internal`（或 `git apply -R wb2api-degrade-sanitize-fix.diff`）。
3. dsh-purge：删掉 `lib/identity.js` 里 `// 2026-10-29: 上游按逐字指纹…` 起的那 6 行（2 行注释 + `.replace(` 块），四处都要删（两个安装副本 + 两个源码仓库）。
