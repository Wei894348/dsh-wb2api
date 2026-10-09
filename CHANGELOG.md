# 变更记录

## 1.4.0（2026-10-09）

**内置网关托管与模型 provider 注册（一体化）**

- 新增 `lib/gw/`（12 个 .js）：网关托管 + provider 注册实现 —— 定位可执行文件、探活、
  拉子进程、崩溃重启、随 dsh 退出回收，并把网关的模型目录注册成 dsh 的 LLM provider。
  - `gateway-supervisor.js` 子进程托管（定位可执行文件 → `/healthz` 探活 → spawn → 崩溃重启 → dispose 回收）
  - `gateway-adapter.js` LlmAdapter（请求组装 + SSE → StreamChunk）、`models.js` 模型目录映射
  - `gateway-binary.js` 二进制下载 + SHA256 校验 + 运行目录准备、`accounts.js` 账号开关
  - `login.js` Node 版 OAuth 登录、`setup.js` `/wb2api-setup` 编排、`sse.js` / `zip.js` / `config.js` / `index.js`
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
- 自动下载时的 Release 仓库指向本仓库：`lib/gw/gateway-binary.js` 的 `DEFAULT_RELEASE_REPO` 与
  `lib/gw/config.js` 的 `binaryReleaseRepo` 都是 `Wei894348/dsh-wb2api`（自带二进制之后，下载只是兜底）。

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
