# 网关源码快照（wb2api / workbuddy2api-panel）

本目录是 **wb2api 网关本体 `wb2a-server.exe` 的完整 Go 源码**，随插件仓库一起留档。
目的：换机器、本地目录被清、或要重新编译时，**不依赖任何本机副本**。

## 来源与差异

- 上游：`github.com/linguo2625469/workbuddy2api-panel`，基线提交 `b69d06e`（v1.11.1-panel）
- 本快照 = 基线 + 两条工作线合并后的树，导出提交 `f41b909`

### 相对上游多出的（上游 main 没有，删了会直接坏功能）

- `internal/agent/`：Anthropic Messages / OpenAI Responses 适配层
  （`anthropic_request.go` / `anthropic_stream.go` / `responses_request.go` / `responses_stream.go`）
- `internal/server/agent_handler.go` / `agent_resolve.go` / `agent_routes.go`
  → 注册 `POST /v1/messages` 与 `POST /v1/responses`，翻成 chat completions 复用主链路。
  **Codex（`/v1/responses`）与 Claude Code（`/v1/messages`）全靠这部分**；上游没有它，从上游重新构建会这两条路 404。

### 2026-10-29 修复（详见 `../fixes/2026-10-29/README-修复说明.md`）

| 文件 | 改动 |
| --- | --- |
| `internal/upstream/sanitize.go` | 新增 DSH file-reference 指纹改写（`@` → `the at-sign`）；上游 11-128 逐字拦截不再命中 |
| `internal/server/degrade.go` | 降级窗口「次日 00:00」→ 默认 10 分钟（`WB2A_DEGRADE_WINDOW`）；新增原文探针 `WB2A_DEGRADE_PROBE` 与总开关 `WB2A_DEGRADE_DISABLE`；`AllowProbe()` / `Clear()` / `Until()` |
| `internal/server/handler.go` | 降级期内限频放行客户端原文，成功即收回降级；探针被拦不再误判为成功；关闭开关时 400 原文透传；`/status` 增 `degrade` 与 `models` 观测块 |
| `internal/upstream/model_alias.go` | 新增模型内部别名出口闸：CN 严格剔除档位名，global 只剔非对话产物（enhance/seedance/auto-chat/o4-mini/canvas） |
| `internal/server/handler.go`（models） | `GET /v1/models?refresh=1` 作废网关侧模型缓存后再回列表 |
| `internal/server/degrade_test.go` / `handler_test.go` | 同步新语义 + 别名过滤回归 |

## 构建（Windows / PowerShell）

```powershell
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
go build -trimpath -ldflags '-s -w' -o wb2a-server.exe ./cmd/server
```

产物放回 `../backend/bin/wb2a-server.exe`，重启网关即生效。
注意：自己构建出来的 sha256 与仓库里那份**不会相同**（Go build id 不同属正常），行为一致即可；
插件启动时 `installBinaryFromBundled()` 只按哈希判断是否需要同步，所以**要么用仓库里那份，要么三处一起换**。

## 不要做的事

- 不要删 `internal/agent/`（删了 `/v1/messages`、`/v1/responses` 立刻 404）
- 不要把 `internal/upstream/model_alias.go` 的 CN 分支放宽（内部档位名会重新灌进模型下拉）
- 不要把 `degrade` 窗口改回「次日 00:00」（一次上游误杀 = 全天人格丢失）
