# dsh-plugin-wb2api-ui

本插件给 WorkBuddy 反代配一块 **Web 设置面板**：dsh 设置里多一个「WorkBuddy 反代」分区，
可以在里面看状态、点授权登录、上传凭证 JSON、管理账号。

## 面板与网关的关系

| | 网关（`lib/gw/` + `backend/bin/`） | 面板（`client/client.js` + 宿主路由） |
|---|---|---|
| 职责 | 注册 provider 路由、托管网关进程、提供 `/wb2api-*` 斜杠命令 | 只加一块设置面板 |
| 进程 | 启停网关 | **不碰进程**，避免抢端口 |
| 凭证 | `/wb2api-login` 走 OAuth 落盘 | 面板里点按钮完成同一件事 |

两边同一个包、同一个 profile bundle 条目（`id: wb2api-ui`），装一次就有。

## 面板里有什么

- **状态行** —— 网关运行状态、账号启用数、`/healthz` 的可用账号数、**汇总剩余积分**、模型数、监听地址
- **添加账号 · 授权登录** —— 选国内版 / 国际版 → 生成授权链接并自动开窗 → 每 3 秒轮询上游，最多 60 秒
- **添加账号 · 上传凭证 JSON** —— 拖拽 / 选择文件 / 直接粘贴，支持单个对象或对象数组
- **账号列表** —— 昵称、uid、版本（国内/国际）、到期时间、**剩余积分**（可展开看每个包）；启用 / 禁用 / 删除（删除要二次确认）
- **可用模型** —— 从 `/v1/models` 实时拉，显示上下文窗口、输出上限、是否支持图片

### 剩余积分是怎么来的

宿主侧调上游**计费面**（与聊天面不同域）：

| 账号类型 | 端点 |
|---|---|
| CN 个人号 | `POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource` |
| CN 企业号（有 `enterpriseId`） | `POST https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage` |
| 国际号 | `POST https://www.workbuddy.ai/…`（同路径） |

**只读查询，不消耗额度**。规则：

- **60 秒缓存**：反复切设置页不会反复打上游；点「刷新积分」带 `?force=1` 绕过。
- **失败不缓存**：一次网络抖动不会让错误文案挂一分钟。
- **并发上限 4**：账号池几十个号时不会一次性全打出去（付费上游按密流累计计数）。
- **失败态分开显示**：`凭证读不了` / `积分获取失败` / `已禁用` 各有各的文案 ——
  统一显示成 `0` 会把故障伪装成「额度用完了」。

账号身份只走请求头（`X-User-Id` / `X-Enterprise-Id` / `X-Domain`），
token 依旧不出宿主进程；浏览器只拿到数字。

**没走面板也不要紧**（`lib/index.js` 是 host 半侧，改了要重启 dsh）：

```bash
node "<工具目录>/probe_wb2api_credits.mjs"          # 直接打上游查真实剩余
node "<工具目录>/probe_wb2api_credits.mjs" --raw    # 附带包明细
```

### 接受的凭证格式（两种都收）

```
① 网关原生：嵌套 + camelCase + Unix 秒
   { "account": { "uid": "…", "nickname": "…" },
     "auth":    { "accessToken": "…", "refreshToken": "…",
                  "expiresAt": 1794480957, "domain": "codebuddy.cn", "realm": "cn" } }

② 外部导出：扁平 + snake_case + 毫秒   ← workbuddy_accounts_*.json 就是这种
   [ { "uid": "…", "nickname": "…",
       "access_token": "…", "refresh_token": "…",
       "expires_at": 1794480957832, "domain": "www.codebuddy.cn" } ]
```

归一化在 `normalizeDocument()`：`account` / `auth` 段缺省时回落到输入对象自身，
于是「嵌套」与「扁平」两种形态走同一条代码路径。具体规则：

| 处理 | 说明 |
|---|---|
| 键名同义 | `uid`/`id`、`accessToken`/`access_token`、`refreshToken`/`refresh_token`、`expiresAt`/`expires_at`、`enterpriseId`/`enterprise_id` |
| 时间戳单位 | 大于 `1e11` 视为毫秒并自动 `/1000`（Unix 秒要到 5138 年才破 1e11，判据安全） |
| realm 推断 | 显式 `realm` 优先；否则域名是 `workbuddy.ai` 系 → `global`，其余（含 `www.codebuddy.cn`）→ `cn` |
| 顶层数组 | 逐项导入，单个失败不影响其余，返回值里逐条列出成功项 |

**没走面板也不要紧**：`lib/index.js` 属于 host 半侧，改动要重启 dsh 才生效
（只有 `client/client.js` 享受 HMR）。所以配了同一条通道的 CLI：

```bash
node "<工具目录>/import_wb2api_accounts.mjs" "<账号导出>.json"            # 写入
node "<工具目录>/import_wb2api_accounts.mjs" "<账号导出>.json" --dry-run  # 只看结果
```

它 `import` 的是插件里**同一个** `normalizeDocument` + `writeAuthDocument`，
落盘结果与面板逐字节一致，但**不依赖 dsh 重启** —— 网关对 `auths/` 是 5 秒热加载，跑完即生效。

### 为什么加完账号不用重启网关

上游网关对 `auths/` 做 **5 秒轮询热加载**，但前提是该目录在网关启动时就存在
（否则它跳过热加载且永不重试）。本插件在加载时就把 `auths/` 建好，所以无论走
OAuth 还是上传 JSON，新账号 5 秒内自动进池。

### 安全边界

`accessToken` / `refreshToken` **永远不进浏览器**。凭证清单只回传 uid、昵称、域、
到期时间。所有上游调用都在 dsh 的 node 进程里完成，浏览器只跟
`/dsh-wb2api/*` 打交道。

## 安装位置

```
~/.dsh/plugins/dsh-plugin-wb2api-ui/     ← 源码（本目录）
  ├─ package.json           dsh.bundle.patch + dsh.client.platform=web
  ├─ cordis.patch.yml       把自己的 host 行插进 profile
  ├─ lib/index.js           node 半侧：/dsh-wb2api/* 路由
  └─ client/
      └─ client.js          浏览器半侧：settings.section 面板
~/.dsh/profiles/web/node_modules/dsh-plugin-wb2api-ui   ← junction 指向上面的目录
```

## 重新安装 / 迁移到新机器

```bash
# 1) 装依赖（pnpm 会把 link: 记进 lockfile，但**不会**在 hoisted 布局下建 node_modules 条目）
dsh plugin --profile web add "link:../../plugins/dsh-plugin-wb2api-ui"

# 2) 手工补 junction（这一步 pnpm 不做）
powershell -NoProfile -Command "New-Item -ItemType Junction \
  -Path \"$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-wb2api-ui\" \
  -Target \"$env:USERPROFILE\.dsh\plugins\dsh-plugin-wb2api-ui\""

# 3) 把包名加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
#    （数组末尾）

# 4) 验证：组合树里应出现 `- id: wb2api-ui`，且无 broken
dsh --profile web --dump-config | grep -A2 wb2api-ui
```

装完**重启 dsh**（新增/移除插件会改启动图，必须重启才生效），设置里就会出现「WorkBuddy 反代」。

> **但改本插件的 `client/client.js` 不用重启**：组合里有 `@deepseek-ai/dsh-client-hmr`，
> 它每 500ms `stat` 一次每个插件的 client bundle，文件一变就重算 rev 并通过
> `/plugins/events` SSE 让浏览器原地重挂本插件 —— 存盘等半秒即可，不刷新页面、不丢会话。
> bundle 响应是 `cache-control: immutable`，被缓存挡住时用 `Ctrl+Shift+R`。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-wb2api-ui
rm -rf ~/.dsh/plugins/dsh-plugin-wb2api-ui
# 再从 package.json 的 bundles 里删掉这一行
```

## 自检

一个综合自检脚本，不碰付费上游、不写真 `auths/`、不启浏览器：

```bash
node "<工具目录>/check_wb2api_ui.mjs"
```

覆盖四层：

1. **宿主模块**：加载 `lib/index.js`，校验导出面（`name` / `inject` / `apply` 与可复用纯函数）。
2. **路由**：mock webServer 走真 `apply()`，13 条 `/dsh-wb2api/*` 全挂载；实测 `/state`
   全链路（只碰本机网关）、405 语义、写路由的「会拒绝」路径（路径穿越 / 缺 raw /
   坏 JSON / 缺 state）—— 只测「会拒绝」，不测「会写入」。
3. **纯函数**：`normalizeDocument` / `toUnixSeconds` / `inferRealm` / `classifyCheckin` /
   `tokenIssuerOrigin` / `localDay`。
4. **浏览器半侧**：stub react 把 Panel 从 loading 渲染到 ready，校验账号卡 / 徽章 /
   模型卡文案。`createElement` 带 type 校验（`h(样式对象, …)` 这类白屏元凶当场抛错），
   文案提取递归收集 `children` —— 旧冒烟测试「读 `props.children` 恒为空」的坑已修。

**测试永不真打上游**：脚本内置 `WB2API_NO_AUTO_ACTIVITY=1`；`/credits`、`/growth`、
`/checkin`、`/keepalive`、`/login/*` 这些会碰上游或真写凭证的路由一律不进用例 ——
接付费上游的项目里，默认必须是 mock，不能让「不花钱」需要显式开关。

## 踩坑记录

### 1. `h(ROW, …)` —— 把样式对象当组件类型传（白屏元凶）

```js
const ROW = { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" };
h(ROW, null, child)                        // ✗ 真 React: "Element type is invalid"，整页空白
h("div", { style: ROW }, child)            // ✓
```

导航里能看到「WorkBuddy 反代」，点进去右侧**全白** —— 注册和标签是好的，
崩的是 `Panel` 自己的 render。**教训**：自写渲染器必须在 `createElement` 里
校验 type 只能是 string / function（已补，见 `check_wb2api_ui.mjs` 的 createElement），
否则这类错误在测试里静默通过、只在真机白屏。

### 2. 主题 token 别想当然

`--dsw-alias-brand-primary` 在**暗色**主题下解析成 `bluish-50`（近白），不是蓝色。
主按钮必须用配对的两个 token：

```js
background: var(--dsw-alias-button-primary-fill)          // 暗色下是近白
color:      var(--dsw-alias-label-primary-foreground)     // 暗色下是近黑
```

用 `background: brand-primary` + 写死 `color:"#fff"` = **白底白字，按钮文字看不见**。
另外警告色是 `state-warn-primary`（不是 `state-warning-primary`），
链接强调色走 `--dsw-alias-link`（`deepseek-400`）。

已加静态断言：插件里出现的每个 `--dsw-alias-*` 都必须在
`dsh-client-ui-theme` 里真实存在，名字写错直接测试失败。

### 3. 测试脚本自己也会骗人

- 微型渲染器的 `texts()` 只看 `typeof node.type === "function"`，对象类型会被当宿主元素递归下去。
- 用 `react-test-renderer` 时，点完按钮必须**重新取 `renderer.toJSON()`**，
  否则断言读的是上一次渲染的快照（假失败/假通过都会发生）。
- 断言别写死 UI 文案格式：状态行在「全部启用」时会省略分母（`账号 4 启用` 而不是 `账号 4/4 启用`），
  写死格式会让测试在行为正确时报错。

### 4. client 半侧热替换，host 半侧不热替换

改 `client/client.js` 存盘半秒就被 HMR 送进浏览器（页面不刷新、会话不丢）；改 `lib/index.js`
**不会** —— host 半侧活在 dsh 的 node 进程里，只有重启 dsh 才重新加载。

这个不对称极易误判：host 逻辑改完，在面板上照旧操作走的还是旧代码，看起来像「修复没生效」。

**逃生通道**：把 host 侧逻辑写成可复用的纯函数并 `export`，再配个 CLI 脚本直接调它，
就绕开了重启（`tools/import_wb2api_accounts.mjs` 就是这么干的）。
多导出几个符号不影响插件加载 —— DSH 只取 `name` / `inject` / `apply`。

### 5. 上游有三个「剩余」，面板用周期口径（2026-09-27 用户推翻重定，别改回去）

同一份 billing 响应里能算出三个数，2026-09-27 在真实账号上实测对比过：

| 口径 | 值 | 说明 |
|---|---|---|
| Σ`CycleCapacityRemain`（周期余量） | 1980 | **面板用这个** |
| Σ`CapacityRemain`（总量余量） | 2480 | 比周期口径多 500 |
| 上游自己的 `TotalDosage` | 2480 | 只是总量口径的汇总 |

差的那 500 来自「本周期已用尽、总量尚有剩余」的包（`CycleCapacityRemain=0`
而 `CapacityRemain=500`）。逐包 dump 确认：**`CapacityRemain` 是这个包一生中
还没被消耗的量，不是现在能用的量**；`TotalDosage` 是它的汇总，同样不代表可用。
拿总量口径当余额会系统性高估 —— 用户对照官方客户端核实过，**周期口径才是
真能用到的量**。这里曾按「总量口径权威」实现过一版，被推翻了，别改回去。

`lib/index.js` 的 `fetchPersonalCredits()`：有周期的包取 `CycleCapacityRemain`，
无周期概念的一次性包（`CycleCapacitySize=0`）回落 `CapacityRemain`，防止整包
被算没；`total` 与进度条同源（都是各段之和），总量口径另以 `sumCapacityRemain`
下发，只用来解释「差额去哪了」。

> 同类陷阱：企业号在**个人端点**上会拿到空包列表，渲染成「0 积分」——
> 一个看起来很正常的错数字。所以有 `enterpriseId` 的 CN 账号必须走企业端点。

### 6. 状态行别把「账号池空」写成「可用 0/0」

`/healthz` 的 `healthy` 是**可用账号数**，不是存活标记。池子空时返回 `0`，
前端若原样渲染成「可用 0/0」，用户会读成「网关没运行」——2026-09-27 就吃了一次这个误会。
现在 `total === 0` 时显示「账号池为空」，语义不含糊。

## 已知限制

- **禁用账号也查积分**。积分是账号自己的属性，跟网关加不加载无关 —— 而且「切换
  账号」的副作用就是把其余账号全部禁用，不查的话那些卡会整块塌掉，看着像坏了。
  「没参与轮换」这一点由卡片上的徽章表达，不靠抽掉数据。
- **积分是实时数字，会跟着消耗掉**。实测两次查询之间掉了 8（在 dsh 里正常用模型就会扣）。
- 没有导出凭证功能（有意为之 —— 导出等于把 token 摊在浏览器里）。要备份直接拷
  `~/.dsh/wb2api/auths/`。
- 面板不能启停网关 —— 那归 `lib/gw/` 的 supervisor。网关没跑时面板会提示
  重启 dsh 或执行 `/wb2api-start`。
- `link:` 安装的 junction 若被 pnpm 清掉，按上面第 2 步补回来即可。
