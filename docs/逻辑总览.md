# 逻辑总览 · WorkBuddy 反代（自有部分逐条）

本文记录这套东西**实际怎么运作**：上游有哪几条通道、每个任务动作的判据是什么、
计分与领奖为什么必须两轮、凭证怎么解、账号池怎么切号、出错先看哪里。
全部结论来自本项目源码与 2026-10-09 的真机实测；标注「未实测」的都是没跑过的推测。

---

## 1. 上游四条通道（同一批账号，不同客户端指纹）

三类「域」在 CN 账号下**不是同一个域**，别顺手统一：

| 通道 | 基址（CN） | 指纹要点 | 用在哪 |
|---|---|---|---|
| billing | `https://www.codebuddy.cn` | `User-Agent: WorkBuddy/5.5.4`（单段）、`X-CodeBuddy-Request: 1`、`X-User-Id`、`X-Domain` | 签到、余额查询、CLI 域行为上报（`/v2/report` `chat_request_send`） |
| chat/desktop | `https://copilot.tencent.com` | `User-Agent: WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`、`X-Domain: copilot.tencent.com`、`X-Product: SaaS`；事件体带 `extName=workbuddy-desktop` | 真实对话（SSE）、专家市场、桌面行为链上报（`/v2/report`）、外观设置（`/v2/user-asset/appearance/set`） |
| web | `https://www.workbuddy.cn` | 浏览器 UA + `x-client-platform: web` + `Origin/Referer` | 网页行为类任务（`Library_read`：`/v2/report` 的 `web_element_click`）、成长任务列表/领奖 |
| mp（小程序口径） | `www.workbuddy.cn` + `X-Client-Platform: mp-weixin` 等四头 | `X-Platform: wechatmp`、`X-Client-Product: workbuddy-mp`、`X-Client-Version: 2.4.0` | 只有 `school_season` / `Sequential_Tasks_1` 两条任务需要 |

global 账号（`www.workbuddy.ai`）四类基址都指向该域；`Accept-Language` 也随之在 `zh-CN` / `en-US` 间切。

**请求头里两处「看着多余但不能少」**：
- `X-Machine-ID` / `X-Session-ID`：由 `sha256("wb2a:" + purpose + ":" + uid)` 派生的 36 hex，跨重启恒定、账号间互异 —— 让每个号看起来像一台固定设备。
- 桌面事件体的公共指纹（`ideName/ideType=WorkBuddy`、`machineId= sha256("machine:"+uid)[:36]`、`osVersion`、`cpuCores` 等）：少一个就可能不计分。

---

## 2. 任务自动化引擎

### 2.1 三个入口（`engine/wb_up/run.mjs`）

| 导出 | 作用 | 谁在用 |
|---|---|---|
| `scanPendingTasks({selector, includeAttempt, onLog})` | **确认待办**：逐账号遍历动作表，返回还有哪些没做完（含进度文本） | 面板按钮第一步 |
| `runAutomation({selector, only, passes, gapSec, concurrency, includeAttempt, forceAll, onLog})` | 接受未接受的任务 → 账号内串行/账号间并发执行 → 有界回读 → 达标即领奖 | 面板按钮第二步、CLI `auto` |
| `tasksOf(auth)` / `creditsOf(selector)` | 单账号任务清单 / 各账号剩余积分 | CLI `list` / `credits` |

### 2.2 为什么要「两轮」

上游计分是**异步**的：行为链上报之后，进度要数秒到数分钟才落账。
实测（2026-10-09，一个全新账号）：第一轮 14 个动作全部回报 `not_accepted`，第二轮同一批动作在
3–30 秒内陆续变 `1/1` 并**当场领奖**（该轮 +1750 分）。所以 `passes` 默认 2，且某一轮若「执行 0 项」
（全是已完成/无此任务）会直接短路，不再空跑后面的轮次。

### 2.3 动作表（19 条，`engine/wb_up/actions.mjs`）

| task_code | 判据（怎么点亮） | 消耗 |
|---|---|---|
| `chat_5` | 补报 5 条 CLI `chat_request_send`（`/v2/report`，billing 域） | 无对话 |
| `first_buddy` | 前置活跃上报 → `buddy/agreement` → `buddy/first`（+300 分） | 无对话 |
| `Model_chat_GLM5.2` | `accept` → **真实 glm-5.2 对话一次**（SSE）→ 对齐模型的上报 | 1 次短对话 |
| `RichMeow_Chat` | 桌面指纹 6 事件链（`agent_task_created` → `chat_message_response.isSuccessful=true` …） | 无对话 |
| `Buddy_App` / `Buddy_App_QQ` | buddyapp 五连事件（企鹅教师助手 `cb_y5Dy46tPQGGWtueMxXbe`） | 无对话 |
| `automation_1` | `automated_task_create_suc` 单事件 | 无对话 |
| `Library_read` | web 域 `web_element_click(elementId=library_doc_intro_click)` | 无对话 |
| `template_5` | 5 组 `agent_task_created_with_template` + `template_used`（各 JOIN 一条 chat 链） | 无对话 |
| `playbook_prompt` | `web_element_click(playbook_ctaClick)` + `playbook_cta_click` + `playbook_prompt_send` | 无对话 |
| `create_canvas` | `wbx_design_canvas_task_create` + `wbx_design_canvas_open`（+300 分） | 无对话 |
| `expert_5` / `Expert_team_use_3` | 真实专家市场列表（id 必须真实存在）→ 召唤链 → **真实 chat 拿服务端 requestId** → `expert_actual_use` | 5 / 3 次短对话 |
| `Hp_Appearance` | `appearance/set(theme-tkmw7j)` + `appearance_skin_apply` 事件 | 无对话 |
| `skill_1` | 真实对话 + `skill_info` 事件（`finishReason=tool_calls` 语义） | 1 次短对话 |
| `Expert_lighthouse` | 轻量云专家 `ex_2cvvUZQhDyeJ`：召唤链 + 真实 chat（`has_expert=true`）+ `expert_actual_use`（`mode=LOCAL`、`type=""`、`cost=0`） | 1 次短对话 |
| `black_cat`（尝试型） | **23:00–08:00 窗口内** glm-5.2 真实对话 + chat 事件；窗口外动作自身返回「不在窗口」并跳过 | 最多 3 次短对话 |
| `school_season` / `Sequential_Tasks_1`（mp 口径） | mp accept（带回读验证）→ mini `chat_request_send`（前者带 `activityId=school_open_day_2026`）→ 回读 → 领奖 | 无对话 |

节流：动作间 1.05s（只对**真的执行了**的项等），专家召唤链 6s，mp 动作 2s，领奖回读 4 次 × 3s。

### 2.4 领奖口径

- 普通任务：`POST {web 域}/activity/growth/tasks/<task_code>/claim`，无 body，`x-client-platform: web`；`already_claimed=true` 视为成功（0/0）。
- mp 任务：走 mp 变体（`X-Client-Platform: miniprogram` 一侧）；`claimRewardMP` 只在 **HTTP 400** 时降级重试。
- 「已完成」判定三处一致：`claimed`、或 `target>0 && current>=target`；`progress` 可能是平铺字段也可能是 `{current,target}` 对象 —— 两种都读。

### 2.5 单飞锁

`~/.dsh/wb2api/data/wb-tasks.lock`（JSON：`{at, pid}`），TTL 20 分钟。窗口内第二次调用直接报错并说清持有者，
防止「面板按钮」与「命令行/旧计划任务」同时开跑（专家链里有真实对话，重跑就是白烧额度）。进程被杀不会留死锁。

---

## 3. 凭证与账号池

- 池目录：`~/.dsh/wb2api/auths/`，一个账号一个文件 `workbuddy-<uid>.json`：
  `{"account":{uid,enterpriseId,nickname},"auth":{accessToken,refreshToken,expiresAt,domain,realm}}`
- **网关只加载匹配 `workbuddy*.json` 的文件** —— 所以「停用某号」= 改名加 `.json.disabled`，
  这也是插件 `/wb2api-account` 的实现方式（停网关 → 改名 → 启网关）。
- 桌面端 5.6.0 起把 `accessToken`/`refreshToken`/`nickname` 写成 `{"$wbEncrypted":1,"envelope":...}`：
  AES-256-GCM，字段级 AAD（`WB-AAD\0` + 格式 id `WBEV1` + scheme `sym-v1` + suite + keyId + framing + 两个 0 字节）。
  密钥是**构建期常量**：向已安装的桌面端要 `loggerGet()` 返回的 base64 字符串，
  `key = sha256(该字符串)`，`keyId = sha256(key).hex[:16]`。`tools/wb_import.mjs` 实现了整条导出（含 keyId 校验）。
- **凭证不进本存档**（含 token，等价于密码）。存档只放模板与说明。

---

## 4. 后端网关的托管与模型链路

网关（`wb2a-server`）由**本插件自己托管**：`lib/gw/` 是托管 + provider 注册实现，
在 `lib/index.js` 里以子插件形式挂载
（`ctx.plugin(gatewayPlugin, config?.gateway ?? {})`）。命令 `/wb2api-setup`、`/wb2api-status`、
`/wb2api-start`、`/wb2api-restart`、`/wb2api-login`、`/wb2api-account` 都由本插件注册。

网关对外路由：`/v1/chat/completions`、`/v1/models`、`/status`、`/healthz`（`/healthz` 免鉴权，只监听回环）。

### 4.1 子进程生命周期（`proc.js`）

```
start()
 ├─ 1 先探 /healthz
 │    ├─ 已有健康网关照用（state=external，不重复拉起、不抢端口）
 │    ├─ 端口无监听 → 继续
 │    └─ 有服务但 /healthz 非 2xx → 抛错（端口被别的程序占了）
 ├─ 2 resolveBinary() 定位可执行文件 → resolveWorkingDir() 定 cwd → subprocess.spawn
 └─ 3 轮询 /healthz 直到就绪或超时
```

- **并发去重**：同一时刻的第二次 `start()` 会 await 第一次那轮（`inFlightStart`），而不是返回
  「启动中」的空壳快照 —— dsh 启动时的自动拉起与紧接着的 `/wb2api-setup` 经常撞在一起。
- **崩溃重启**：子进程退出后按 `min(1000 × 2^(n-1), 30s)` 退避重启，`n` 是已重启次数；
  达到 `crashRestartLimit`（默认 3）后停止重启，并把原因写进 `lastError`。
- **回收**：dispose 时清掉待触发的重启定时器并停子进程，dsh 退出不留孤儿；`/wb2api-restart`
  会把重启计数清零后重新走一遍 `start()`。
- **二进制从哪来**（`resolveBinary()` 依次找，命中即用）：

  | 顺序 | 位置 | 说明 |
  |---|---|---|
  | 1 | 配置 `binaryPath` | 显式指定；文件不存在则**直接报错**，不继续往下找 |
  | 2 | 配置 `repoPath` 根目录及其 `bin/` | 用户自己有源码/构建产物时用 |
  | 3 | **包内 `backend/bin/`** | 随包发布的自带二进制，优先级高于运行目录里的下载件 |
  | 4 | `~/.dsh/wb2api/bin/` | 运行目录缓存（预留给按需下载/`go build` 的产物） |
  | 5 | `PATH` | 兜底，可能已全局安装 |

  全部落空才抛错，错误消息列出所有试过的路径。`autoDownloadBinary` 默认 `false`；
  真要下载时走 `binaryReleaseRepo`（已指向本仓库 `Wei894348/dsh-wb2api`），下载后校验 SHA256。
- **cwd 顺序**（`resolveWorkingDir()`）：配置 `workingDir` → 配置 `repoPath` → `~/.dsh/wb2api/`
  （存在 `config.json` 时）→ 可执行文件所在目录。网关的 `config.json` / `auth_dir` / `state_file`
  都是**相对 cwd** 的路径，cwd 指错就是「启动即退出」。

### 4.2 探活语义：启动 ≠ 可用

`/healthz` 的返回值只有一个数与一组字段，但「进程活着」和「能出模型」是两件事：

| 探活结果 | 含义 |
|---|---|
| 连接被拒 / 超时 | 端口上没有网关（未运行），不算错误 |
| HTTP 非 2xx | 端口被别人占了（占用的不是本网关），抛错 |
| 200 且 `healthy > 0` | 网关在跑，且至少有 `healthy` 个可用账号 |
| 200 但 `healthy = 0` | **进程活着但没有可用账号**（没登录 / 全被禁用 / 全在冷却） |

所以状态汇报里 `healthy/total` 才是「能不能出模型」的判据，只看「运行中」不够；
`healthy` 的账号数与该网关实际读到的 `auths/` 目录直接相关。

### 4.3 `/v1/models` → dsh 模型目录（`catalog.js`）

拉 `/v1/models` 后按 `modelsTtlSeconds`（默认 600s）缓存，把网关的**非标准扩展字段**翻成
dsh 的 `LlmModelInfo`。dsh 内置的 openai-completions 栈不认这些字段 —— 这正是过去必须在
`settings.yaml` 手写一长串模型元数据的根因。

| 网关字段 | dsh 侧 | 规则 |
|---|---|---|
| `id` | 模型 id | 形如 `cn:<名>` / `global:<名>`；按 `realmPrefixPolicy` 处理前缀 |
| `context_length` | `context.contextWindow` | 缺失/非正数时兜底 `1000000`（与网关四级查找的兜底同值） |
| `max_output_tokens` | `defaultMaxTokens` | 缺失就**不声明**，交给网关自己决定 |
| `supports_images` | `inputModalities` | 该键**仅在支持时出现**，故缺席即 `['text']`（显式「仅文本」，不是未知） |
| `reasoning_supported_efforts` | `reasoning.efforts` | 空则整个 `reasoning` 不声明 |
| `reasoning_default_effort` | `reasoning.defaultEffort` | **先校验它落在 efforts 之内**，否则不声明（防 dsh 拿非法档位发请求） |

realm 前缀：`parseModelId()` 取第一个 `:`，前段**恰为** `cn` / `global` 才算前缀，否则整串当裸名、realm 归 `cn`。
默认 `realmPrefixPolicy: strip-cn` —— 注册进 dsh 时剥掉 `cn:`、**保留 `global:`**（剥了国际版就路由不到）；
发请求前再由 `toWireModel()` 把无前缀 id 补成 `cn:`，让选号闭包正确过滤 realm 集合。

请求侧：`chat.js` 组装 OpenAI 兼容请求体，并把网关的 SSE 流翻成 dsh 的 `StreamChunk`。
超时三档：首 token `firstTokenTimeoutSeconds`（默认 120s）、整请求 `requestTimeoutSeconds`（600s）、
空闲 `idleTimeoutSeconds`（300s）。

### 4.4 账号启用 / 禁用：改文件名后缀

- 池目录 `~/.dsh/wb2api/auths/`，一个账号一个 `workbuddy-<uid>.json`。
- **网关只 glob `workbuddy*.json`** —— 所以「停用」= 把文件改名成 `workbuddy-<uid>.json.disabled`；
  `credentials.js` 的 `DISABLED_SUFFIX = '.disabled'`，**只改名、从不删除**，恢复 = 改回 `.json`。
- `/wb2api-account auto | <序号> | <uid 前缀>`；插件内部是「停网关 → 改名 → 启网关」，
  停网关期间探活结果会被作废（`startGeneration`），免得把已经决定停掉的进程标成 `external`。
- 改名前先停网关：网关会把旧路径的凭证**原子写回**，直接改名会被它撤销。
- 被禁用的账号不由网关加载，**期间 token 不刷新**。

### 4.5 运行目录里各是什么

| 路径 | 内容 |
|---|---|
| `~/.dsh/wb2api/config.json` | 网关配置：`listen` / `api_key` / `auth_dir` / `state_file`。**缺了网关直接退出**；由 `/wb2api-setup` 生成或手工放一份 |
| `~/.dsh/wb2api/auths/` | 账号凭证池（见上）。**必须在网关启动前存在**：网关只在启动时探测该目录，不存在就跳过热加载且永不重试 |
| `~/.dsh/wb2api/data/` | 网关状态与插件产物：`state.json`（每号 credits / cooling / success_count / manual_disabled …）、任务引擎单飞锁 `wb-tasks.lock` |
| `~/.dsh/wb2api/bin/` | 下载/构建出来的二进制缓存（包内 `backend/bin/` 那份优先级更高） |

dsh 的默认模型走这个网关（`settings` 里 `agent-default-model.provider = workbuddy2api`）——
**动网关会直接影响 dsh 本体**，改二进制/端口前先想清楚。provider id **故意保持 `workbuddy2api`**
不变（子插件身份名已改成 `wb2api-gateway`）：改名会打断现有模型配置。
同一个 profile 里也不能再挂另一个注册同一 provider id 的插件（会报 `DUPLICATE_ADAPTER`）。

---

## 5. 自动化开关现状（2026-10-09）

| 入口 | 状态 |
|---|---|
| 面板「一键做任务」按钮 | ✅ 唯一的手动入口（宿主路由 `/dsh-wb2api/tasks/run`） |
| 计划任务 `wb2api-tasks-night` / `-dawn` / `dsh-wb2api-daily` | ❌ 已删除（用户要求不自动跑） |
| 用户自有的签到计划任务（如每天 08:30 打 `/dsh-wb2api/checkin`） | 保留：只签到 + 领已完成任务，不碰任务引擎 |
| `wb_daily.mjs` | 保留但**默认不跑任务引擎**，要跑加 `--tasks` |

---

## 6. 故障排查

| 现象 | 先看哪里 |
|---|---|
| 点按钮提示「宿主半侧还没挂上这条路由」 | 插件 host 半侧**只在 dsh 启动时加载**；改了 `plugin/lib/index.js` 必须重启 dsh（client 半侧是 500ms 热替换，不用重启） |
| 「已有一轮任务在跑」 | 单飞锁生效：`~/.dsh/wb2api/data/wb-tasks.lock`（20 分钟自动失效；确认无进程后可手删） |
| 确认待办正常但「执行 0 项」 | 正常：动作已完成或 `black_cat` 不在 23:00–08:00 窗口 |
| 某项 `progress_after` 仍 `not_accepted` | 异步计分未落账：再跑一轮（第二次运行会跳过已领的，只补未落账的） |
| 401 / 「登录身份过期」 | 该号 accessToken 失效：桌面端重新登录后重跑 `tools/wb_import.mjs --write` |
| dsh 本体模型不可用 | 那是 7863 网关的事（`/healthz` 看 `healthy`），与任务引擎无关 |
| 状态显示网关「运行中」但发不出模型 | 探活只证端口通：看 `/healthz` 的 `healthy`，`healthy = 0` 就是没可用账号（`/wb2api-login` 加号或 `/wb2api-account auto` 恢复） |
| dsh 启动报 `DUPLICATE_ADAPTER` | 该 profile 里挂了两个注册同一 provider id 的插件：移除其中一个后重启 dsh |
