# 变更记录

## 1.4.4（2026-10-10）

**实测修复：网关托管此前根本没被挂载**

在真实 profile 里跑起来才暴露——面板正常、网关却始终不起。逐层定位到四个问题：

| 问题 | 现象 | 修法 |
|---|---|---|
| `@deepseek-ai/schemastery` 用了具名导入 | `SyntaxError: does not provide an export named 'Schema'` → 整个 `lib/gw/` 子插件挂载失败，面板照常、网关静默缺失 | 改回默认导入 `import Schema from ...` |
| `ctx.effect` 回调直接执行 dispose | `start()` 恒返回 `stopped`：网关刚建好就被标记销毁 | 改成返回清理函数 `ctx.effect(() => () => {…})` |
| 二进制定位漏了包内目录 | 装完插件却报「找不到网关程序」，逼用户去下载 | 新增 `bundledBinaryDir()`（按 `import.meta.url` 推导 `backend/bin`），排在下载缓存之前 |
| 启动失败无迹可循 | 找不到二进制时静默 `return`，日志空白 | 补 warn 日志 + `WB2API_DEBUG_LOG=1` 时把关键节点落盘到 `<运行目录>/data/gw-debug.log` |

顺带把 `backend/bin/wb2a-server.exe` 内嵌的 Go 包路径统一改为本仓库自己的命名（813 处等长字节替换，长度不变，改后起停与端到端请求均已复测）。

## 1.4.1（2026-10-09）

**后端逻辑重写（`lib/gw/` 全部换掉）**

按 1.4.0 的行为契约重新实现了一遍，模块划分与命名全部重来，不再沿用先前的文件组织：

| 新模块 | 职责 |
|---|---|
| `settings.js` | 配置归一化与默认值、provider settings namespace |
| `runtime.js` | 路径口径统一：运行目录 / 子进程 cwd / 凭证目录 / 网关 config 生成 |
| `proc.js` | 子进程托管：定位可执行文件 → 探活 → spawn → 崩溃指数退避重启 → 回收 |
| `chat.js` | LlmAdapter：消息序列化 + 发流 + SSE → StreamChunk |
| `stream.js` | SSE 帧解析与双超时（首帧 / 帧间） |
| `catalog.js` | `/v1/models` → dsh 模型目录（TTL 缓存、并发去重、失败保旧） |
| `binary.js` / `archive.js` | 二进制下载 + SHA256 校验 + 原子落盘；自带 ZIP 解压 |
| `credentials.js` | 账号开关（改 `auths/` 文件名后缀）与选择语法 |
| `authorize.js` | Node 版 OAuth 登录与凭证落盘 |
| `bootstrap.js` / `render.js` | `/wb2api-setup` 编排；状态与报告的纯函数渲染 |

对外契约不变：子插件名 `wb2api-gateway`、`inject` 三项、六条 `/wb2api-*` 命令、
LLM provider id 仍是 `workbuddy2api`。行为上保留的既有判据：启动前先探活复用外部网关、
工具结果展开为独立 `tool` 消息并丢弃孤儿、残缺工具参数判 `max-tokens` 而非 `tool-calls`、
只吐思考的空步判 `EMPTY_RESPONSE`、缓存命中 token 不计入 inputTokens、账号池空时显示
「账号池为空」而非「可用 0/0」。

## 1.4.0（2026-10-09）

**内置网关托管与模型 provider 注册（一体化）**

- 新增 `lib/gw/`（12 个 .js）：网关托管 + provider 注册实现 —— 定位可执行文件、探活、
  拉子进程、崩溃重启、随 dsh 退出回收，并把网关的模型目录注册成 dsh 的 LLM provider。
  - `proc.js` 子进程托管（定位可执行文件 → `/healthz` 探活 → spawn → 崩溃重启 → dispose 回收）
  - `chat.js` LlmAdapter（请求组装 + SSE → StreamChunk）、`catalog.js` 模型目录映射
  - `binary.js` 二进制下载 + SHA256 校验 + 运行目录准备、`credentials.js` 账号开关
  - `authorize.js` Node 版 OAuth 登录、`bootstrap.js` `/wb2api-setup` 编排、`stream.js` / `zip.js` / `settings.js` / `index.js`
- `lib/index.js` 把这份实现作为**子插件**挂载（`ctx.plugin(gatewayPlugin, config?.gateway ?? {})`），
  以下命令改由**本插件**注册：`/wb2api-setup`、`/wb2api-status`、`/wb2api-start`、
  `/wb2api-restart`、`/wb2api-login`、`/wb2api-account`。
- 子插件身份名改为 `wb2api-gateway`（`lib/gw/index.js` 的 `export const name`），
  但 **LLM provider 的 id 仍是 `workbuddy2api`**（`PROVIDER` 常量故意没改）——
  dsh 的 `agent-default-model.provider` 等设置引用它，改名会打断现有模型配置。

**内置网关二进制**

- 新增 `backend/bin/wb2a-server.exe`（Windows amd64，随包发布，
  SHA256 `505FA9747B64DD6C4C30CC966CE9A831811A18992510154C22072B454CFA4F74`），
  以及 `backend/build-gateway.ps1`（从网关 Go 源码 clone + `go build` 重建）与
  `backend/README.md`（校验值、重建方法）。
- `resolveBinary()` 候选目录新增**包内 `backend/bin/`**（`new URL('../../backend/bin', import.meta.url)` 解析），
  优先级高于 `~/.dsh/wb2api/bin`，所以 `npm pack` 出去装到哪都能找到自带二进制。
- 自动下载时的 Release 仓库指向本仓库：`lib/gw/binary.js` 的 `DEFAULT_RELEASE_REPO` 与
  `lib/gw/settings.js` 的 `binaryReleaseRepo` 都是 `Wei894348/dsh-wb2api`（自带二进制之后，下载只是兜底）。

**共存要求**

- 同一个 dsh profile 里**不能同时**挂两个注册同一 provider id（`workbuddy2api`）的插件 ——
  会撞成 `DUPLICATE_ADAPTER`，宿主起不来。移除其中一个后重启 dsh。

**打包**

- `package.json`：version `1.3.0` → `1.4.0`；`files` 增加 `"backend"`；
  新增 `peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-commands`、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/schemastery`，按 dsh 插件契约声明）；
  description 改为「一体化」（自托管网关 + 面板 + 任务引擎）。

## 1.3.0

**新增：成长任务自动化（18 个任务动作）接入面板**

- 面板账号区新增主色按钮「一键做任务」：点击后宿主后台 **确认待办 → 执行动作 → 达标自动领奖**，
  卡片内实时显示待办确认结果、执行日志尾巴与领奖汇总。
- 新增宿主路由：`GET /dsh-wb2api/tasks/status`、`POST /dsh-wb2api/tasks/run`。
- 包内自带任务引擎（`engine/`）：
  - `engine/wb_up/core.mjs` 三类客户端指纹（billing / desktop / web）与信封解析、连接重试
  - `engine/wb_up/events.mjs` 桌面事件链、web 上报、专家市场、真实 chat（SSE 取服务端 requestId）
  - `engine/wb_up/tasks.mjs` 任务清单 / 接受 / 领奖（含小程序口径 MP 变体）、夜猫子、连登
  - `engine/wb_up/actions.mjs` 18 个任务动作
  - `engine/wb_up/run.mjs` 编排层：扫描 → 账号内串行 / 账号间并发 → 两轮 → 自动领奖 + 单飞锁
  - `engine/wb_tasks.mjs` CLI：`list` / `scan` / `auto` / `credits`
- 引擎路径解析顺序：`WB_TASKS_ENGINE` → 包内 `engine/wb_up/run.mjs` → 开发机工作区路径（兼容旧装法）。

**打包**

- 仓库根即 npm 包根（`lib/` + `client.js` + `engine/` + `cordis.patch.yml`），可直接
  `dsh plugin --profile web add <tarball|目录>` 安装，无需构建步骤。

## 1.2.4

- 面板：网关状态 / 每账号剩余积分（可展开包明细）/ OAuth 授权登录 / 凭证导入 / 账号启停与删除。
- 宿主半侧：`/dsh-wb2api/*` 15 条路由；凭证只在本进程内流转，浏览器拿不到 token。
