/**
 * WorkBuddy 反代（workbuddy2api）设置面板 —— node 半侧。
 *
 * ## 它做什么
 *
 * 三件事，全部围绕「让凭证进得了门」：
 *
 * 1. **读** —— 汇总 `~/.dsh/wb2api/` 下的网关配置、`auths/` 里的凭证清单、
 *    `/healthz` 的实时账号可用性、`/v1/models` 的模型目录。
 * 2. **写** —— OAuth 授权拿到的、或用户上传/粘贴的凭证，按网关契约落盘成
 *    `workbuddy-<uid>.json`（原子写）。
 * 3. **管** —— 凭证的启用 / 禁用 / 删除（启停即改文件名后缀，与网关的
 *    `.disabled` 约定一致）。
 *
 * ## 它不做什么
 *
 * 面板本身不直接管进程 —— 进程归 `lib/gw/` 的 supervisor（随 dsh 启停），
 * 面板只读状态、转发命令，不重复拉一个抢端口。
 *
 * ## 为什么不必重启网关
 *
 * 上游网关对 `auths/` 做 5 秒轮询热加载 —— 但**前提是该目录在网关启动时存在**，
 * 否则它跳过热加载且永不重试（启动日志原话：`auths 目录 ./auths 不可读，
 * 跳过热加载监听（加账号后需手动重启）`）。所以本模块在加载时就把 `auths/`
 * 建好，之后无论走 OAuth 还是上传 JSON，新账号 5 秒内自动进池，**不需要重启**。
 *
 * ## 安全边界
 *
 * 浏览器半侧永远拿不到 `accessToken` / `refreshToken` —— 凭证清单只回传
 * uid / 昵称 / 域 / 到期时间这类可展示字段。所有上游调用都在本进程内完成。
 *
 * @module dsh-plugin-wb2api-ui
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ── 后端服务（网关）的实现：内置在 lib/gw/ ─────────────────────────────────
// 网关托管 + provider 注册 + /wb2api-* 命令都在那边，作为子插件挂在本插件里，
// 装一个包就把「网关 + 面板 + 任务引擎」全带上。
//
// 刻意用**动态 import** 挂载（见文件末尾的 mountGateway）：现场那份插件目录万一只同步了
// lib/index.js、没有 lib/gw/，面板卡片与任务引擎照常可用，只少一个「自带网关托管」，
// 并在日志里说明原因 —— 静态 import 会让整个插件加载失败，那代价太大。

/**
 * 成长任务自动化引擎的入口文件。
 *
 * 解析顺序：`WB_TASKS_ENGINE` 环境变量 → **包内** `engine/wb_up/run.mjs`（打包发布后自带）。
 * 两者都没有时返回包内路径 —— 让 import 报一个明确的「文件不存在」而不是静默失败。
 */
function resolveTasksEngine() {
  const override = process.env.WB_TASKS_ENGINE
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const candidates = [
    fileURLToPath(new URL('../engine/wb_up/run.mjs', import.meta.url)),
  ]
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate } catch { /* 继续试下一个 */ }
  }
  return candidates[0]
}

/**
 * 挂上内置的「网关托管」子插件 —— 后端服务（上游网关）由本插件自己负责。
 *
 * 为什么用**动态** import 而不是顶部静态 import：
 * 现场那份插件目录可能只同步了 `lib/index.js` 而没同步 `lib/gw/`，或者用户手工删过目录。
 * 静态 import 会让**整块插件**加载失败（面板卡片 + 任务引擎一起挂掉）；动态挂载时缺的
 * 只是「自带网关托管」这一块，日志里说清楚，别的照常能跑。
 */
async function mountGateway(ctx, config) {
  try {
    const mod = await import('./gw/index.js')
    ctx.plugin(mod, config?.gateway ?? {})
    markDebug('mountGateway: gw 子插件已挂载')
  } catch (error) {
    markDebug(`mountGateway 失败：${error instanceof Error ? error.stack : String(error)}`)
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[wb2api] 内置网关托管未挂载（${message}）。`
      + '面板与任务引擎不受影响；要让本插件托管上游网关，请确认 lib/gw/ 已随包同步。')
  }
}

/**
 * 面板上显示的「网关可执行文件」路径。
 *
 * **优先包内自带的那份**（`backend/bin/`）—— 它才是本插件实际会拉起的东西（见
 * `lib/gw/proc.js` 的候选顺序）；`~/.dsh/wb2api/bin/` 里的下载件是历史兜底。
 * 不这么写的话，换一台干净的机器装完插件，卡片会报「二进制不存在、去跑 /wb2api-setup」，
 * 而包里那份其实好好的。
 */
function uiBinaryPath() {
  const name = process.platform === 'win32' ? 'wb2a-server.exe' : 'wb2a-server'
  try {
    const bundled = fileURLToPath(new URL(`../backend/bin/${name}`, import.meta.url))
    if (existsSync(bundled)) return bundled
  } catch { /* 包内没有就退回运行目录 */ }
  return join(RUNTIME_DIR, 'bin', name)
}

/** Cordis 插件名。 */
export const name = 'wb2api-ui'

/** 上游服务都在，本插件只借宿主的 webServer 挂路由。 */
export const inject = []

/** 网关运行时根目录（与 lib/gw 的 defaultRuntimeDir 同口径）。 */
const RUNTIME_DIR = join(homedir(), '.dsh', 'wb2api')

/**
 * 诊断留痕（临时无条件开启，定位「网关没被托管」后改回环境变量开关）。
 * dsh 的插件 logger 在 web 模式下不落盘，静默失败就完全无迹可循。
 */
function markDebug(message) {
  if (!process.env.WB2API_DEBUG_LOG) return
  try {
    const dir = join(RUNTIME_DIR, 'data')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'gw-debug.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* 诊断失败不影响主流程 */ }
}

/** 网关不可达时的兜底地址。 */
const DEFAULT_ORIGIN = 'http://127.0.0.1:7863'

/** 凭证文件名前缀（网关按 `workbuddy*.json` glob 扫描）。 */
const AUTH_PREFIX = 'workbuddy'

/** 禁用态文件后缀 —— 改后缀而非删文件，是网关自己的约定。 */
const DISABLED_SUFFIX = '.disabled'

/** 登录端点会看 UA，照抄上游 clientUA。 */
const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 请求体上限，防一手超大 JSON。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 单次上游调用超时。 */
const UPSTREAM_TIMEOUT_MS = 30_000

/** 国内版 / 国际版端点。CN 的 base 与 origin **不同域**，上游会校验 Origin。 */
const REALMS = {
  cn: { base: 'https://copilot.tencent.com', origin: 'https://www.codebuddy.cn' },
  global: { base: 'https://www.workbuddy.ai', origin: 'https://www.workbuddy.ai' },
}

/**
 * 积分（billing）端点 —— **与聊天端点不同域**，这是踩过的坑：
 * CN 聊天走 `copilot.tencent.com`，但计费面在 `www.codebuddy.cn`。
 */
const BILLING_BASES = { cn: 'https://www.codebuddy.cn', global: 'https://www.workbuddy.ai' }

/** 积分缓存的存活时间：面板反复重渲染不该反复打上游。 */
const CREDITS_TTL_MS = 60_000

/** 积分查询超时。比登录短 —— 展示用查询，慢了就下次再来。 */
const CREDITS_TIMEOUT_MS = 15_000

/**
 * 积分查询的并发上限。
 *
 * 账号池可能有几十个号，一次性全打上游既慢又容易被上游按「密集请求」计数
 * （付费上游限流是按次数累积的，一次面板刷新不该消耗配额）。
 */
const CREDITS_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// 路径与配置
// ---------------------------------------------------------------------------

/** 网关 config.json 的内容；读不到就是空对象。 */
function gatewayConfig() {
  const file = join(RUNTIME_DIR, 'config.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 凭证目录。
 *
 * 基准目录与网关的账号目录约定对齐：优先用网关
 * config.json 里的 `auth_dir`（相对路径按运行时根目录解析），缺省 `./auths`。
 */
function authDir() {
  const raw = gatewayConfig().auth_dir
  const sub = typeof raw === 'string' && raw !== '' ? raw : './auths'
  return resolve(RUNTIME_DIR, sub)
}

/** 网关 HTTP 根地址，从 config.json 的 `listen` 推出（只取端口，强制回环）。 */
function origin() {
  const listen = gatewayConfig().listen
  if (typeof listen !== 'string') return DEFAULT_ORIGIN
  const port = listen.slice(listen.lastIndexOf(':') + 1).trim()
  return /^\d+$/u.test(port) ? `http://127.0.0.1:${port}` : DEFAULT_ORIGIN
}

/** 网关要求的管理面凭据（`GET /v1/models` 要带）。 */
function gatewayApiKey() {
  const key = gatewayConfig().api_key
  return typeof key === 'string' && key !== '' ? key : undefined
}

/** 确保 auths/ 存在 —— 这一步决定了网关开不开热加载。 */
function ensureAuthDir() {
  const dir = authDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 凭证文件
// ---------------------------------------------------------------------------

/** 把一个文件名拆成 `{ 启用?, uid }`；不是凭证文件返回 undefined。 */
function parseAuthFileName(fileName) {
  if (!fileName.startsWith(AUTH_PREFIX)) return undefined
  const disabled = fileName.endsWith(DISABLED_SUFFIX)
  const stem = disabled ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName
  return stem.endsWith('.json') ? { disabled, uid: stem.slice(0, -'.json'.length) } : undefined
}

/**
 * 凭证清单 —— **不含任何 token**。
 *
 * 读不动的文件不抛错，标记成 `unreadable` 照样列出来：用户需要看到
 * 「这个文件坏了」而不是「它凭空消失」。
 */
function listAccounts() {
  const dir = authDir()
  if (!existsSync(dir)) return []
  const out = []
  for (const fileName of readdirSync(dir)) {
    const meta = parseAuthFileName(fileName)
    if (meta === undefined) continue
    const file = join(dir, fileName)
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    let document
    try {
      document = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      out.push({ file: fileName, uid: meta.uid, disabled: meta.disabled, unreadable: true, mtime: stat.mtimeMs })
      continue
    }
    const account = document?.account ?? {}
    const auth = document?.auth ?? {}
    const expiresAt = Number(auth.expiresAt)
    out.push({
      file: fileName,
      uid: typeof account.uid === 'string' && account.uid !== '' ? account.uid : meta.uid,
      nickname: typeof account.nickname === 'string' ? account.nickname : '',
      enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
      realm: inferRealm(auth.realm, typeof auth.domain === 'string' ? auth.domain : ''),
      domain: typeof auth.domain === 'string' ? auth.domain : '',
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      expired: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt * 1000 < Date.now() : false,
      disabled: meta.disabled,
      mtime: stat.mtimeMs,
    })
  }
  /**
   * **只按 uid 排，不按启用状态排。**
   *
   * 之前是「启用的在前、禁用的甩到最后」，理由是常用的排前面、好找。但它有个
   * 很糟的副作用：点一下「禁用」，那张卡**立刻飞到列表末尾** —— 看起来就是
   * 「样式乱跳」，刚点的东西跑没了，还得滚下去找。
   *
   * 顺序稳定比「启用的在前」重要：启用与否已经由灰化 + 徽章说清楚了，
   * 不需要再靠位置表达。而且 uid 是稳定的，列表不会因为任何操作重排。
   */
  out.sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
  return out
}

/** 归一化域：显式优先，其次按 domain 后缀（与网关 `Auth.Realm()` 同口径）。 */
function inferRealm(explicit, domain) {
  if (explicit === 'cn' || explicit === 'global') return explicit
  const d = String(domain ?? '').toLowerCase()
  return d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

/**
 * 毫秒 / 秒自适应阈值。
 *
 * Unix 秒时间戳要到公元 5138 年才破 1e11，所以「大于 1e11」必然是毫秒。
 */
const EPOCH_MS_THRESHOLD = 1e11

/** 取第一个非空字符串 —— 用于吃掉同义键名（snake_case / camelCase）。 */
function pickString(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 时间戳归一化成 Unix 秒；缺失或非法一律按 0（无到期信息）处理。 */
function toUnixSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n > EPOCH_MS_THRESHOLD ? n / 1000 : n)
}

/**
 * 校验并归一化一份凭证文档。
 *
 * 网关契约是嵌套 camelCase + Unix 秒，但外部导出（`workbuddy_accounts_*.json`
 * 之类）常见扁平 snake_case + 毫秒时间戳，这里做一层兼容，免得用户手改文件：
 *
 * ```jsonc
 * // 原生：嵌套 + camelCase + Unix 秒
 * { "account": { "uid": "..." }, "auth": { "accessToken": "...", "expiresAt": 1794480957 } }
 * // 导出：扁平 + snake_case + 毫秒
 * { "uid": "...", "access_token": "...", "expires_at": 1794480957832, "domain": "www.codebuddy.cn" }
 * ```
 *
 * `account` / `auth` 缺省时回落到输入对象自身，两种形态就自然统一了。
 * 顶层数组由调用方拆开后逐项传进来，不在这里处理。
 */
function normalizeDocument(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('凭证必须是一个 JSON 对象（形如 {"account":{...},"auth":{...}} 或带 uid/access_token 的扁平对象）。')
  }
  const account = input.account === undefined ? input : input.account
  const auth = input.auth === undefined ? input : input.auth
  if (account === null || typeof account !== 'object') throw new Error('account 段不是对象。')
  if (auth === null || typeof auth !== 'object') throw new Error('auth 段不是对象。')

  const uid = pickString(account, 'uid', 'id')
  if (uid === '') throw new Error('缺少 uid —— 网关按 workbuddy-<uid>.json 命名，缺它无法落盘。')
  const accessToken = pickString(auth, 'accessToken', 'access_token')
  if (accessToken === '') throw new Error('缺少 accessToken / access_token。')

  const domain = pickString(auth, 'domain')
  return {
    account: {
      uid,
      enterpriseId: pickString(account, 'enterpriseId', 'enterprise_id'),
      nickname: pickString(account, 'nickname'),
    },
    auth: {
      accessToken,
      refreshToken: pickString(auth, 'refreshToken', 'refresh_token'),
      // 网关契约是 Unix **秒**：写成毫秒会让它判成「永不过期」而永不刷新。
      expiresAt: toUnixSeconds(auth.expiresAt === undefined ? auth.expires_at : auth.expiresAt),
      domain,
      realm: inferRealm(pickString(auth, 'realm'), domain),
    },
  }
}

/** 原子落盘：先写 `.part` 再 rename，避免网关扫到半截文件。 */
function writeAuthDocument(document) {
  const dir = ensureAuthDir()
  const file = join(dir, `${AUTH_PREFIX}-${document.account.uid}.json`)
  const temp = `${file}.part`
  // indent: 1 与上游 login.sh 的 json.dump(..., indent=1) 一致，便于人工 diff。
  writeFileSync(temp, `${JSON.stringify(document, null, 1)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  return file
}

/** 定位某个凭证文件的绝对路径；不在 auths/ 里就抛错（防目录穿越）。 */
function resolveAuthFile(fileName) {
  if (typeof fileName !== 'string' || parseAuthFileName(fileName) === undefined) {
    throw new Error('凭证文件名不合法。')
  }
  const dir = authDir()
  const file = resolve(dir, fileName)
  if (resolve(file, '..') !== resolve(dir)) throw new Error('凭证文件名不合法。')
  if (!existsSync(file)) throw new Error(`凭证文件不存在：${fileName}`)
  return file
}

/** 启用 / 禁用：改后缀即可，网关按后缀跳过禁用的账号。 */
function setAccountEnabled(fileName, enabled) {
  const file = resolveAuthFile(fileName)
  const disabled = fileName.endsWith(DISABLED_SUFFIX)
  if (enabled === !disabled) return file
  const target = enabled ? file.slice(0, -DISABLED_SUFFIX.length) : `${file}${DISABLED_SUFFIX}`
  renameSync(file, target)
  return target
}

// ---------------------------------------------------------------------------
// 网关 admin API —— 热切换（不碰文件名）
// ---------------------------------------------------------------------------

/** config.json 里 admin 段是否开着（`admin.enabled: true`）。 */
function adminConfigured() {
  return gatewayConfig()?.admin?.enabled === true
}

/**
 * 调网关的 admin 账号接口：`POST /admin/accounts/{uid}/enable|disable|revive`。
 *
 * 这是网关**原生**的池管理入口（二进制里 `internal/server/admin.go`），
 * 鉴权与 `/v1/*` 同一把 api_key。进程内即时生效 —— 不改文件名、没有
 * 「网关把凭证写回旧路径」的竞态，账号也**仍在池里**（token 照常刷新），
 * 只是调度器不再把请求派给它。
 *
 * 任一层失败（admin 没开 → 404；网关没起 → 连接拒绝）都抛错，由调用方
 * 决定回退到改名机制。
 */
async function gatewayAdminAction(uid, action) {
  const base = origin()
  const key = gatewayApiKey()
  const response = await fetch(`${base}/admin/accounts/${encodeURIComponent(uid)}/${action}`, {
    method: 'POST',
    headers: { accept: 'application/json', ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`POST /admin/accounts/${uid}/${action} 返回 HTTP ${response.status}`)
  return response.json().catch(() => ({}))
}

/**
 * 把网关池状态里的 `manual_disabled` 合并进账号清单。
 *
 * admin API 切换**不落文件名**，所以 `listAccounts()` 读到的 `disabled`
 * 会一直是 false —— 池状态才是「参与不参与轮换」的真源，必须在这层合。
 * 合并后客户端逻辑不用改：`account.disabled` 在它眼里仍是「没在轮换」，
 * 只是这状态现在来自网关内存而不是文件后缀。
 */
function mergePoolIntoAccounts(accounts, pool) {
  if (pool === null) return accounts
  const byUid = new Map(pool.accounts.map((row) => [row.uid, row]))
  return accounts.map((account) => {
    const row = byUid.get(account.uid)
    if (row === undefined) return account
    return { ...account, disabled: account.disabled || row.manualDisabled, manualDisabled: row.manualDisabled }
  })
}

/** 账号清单（已并上网关侧轮换状态）。网关没起就只有文件名那一层。 */
async function listAccountsMerged() {
  const accounts = listAccounts()
  let pool = null
  try {
    pool = await fetchPoolStatus()
  } catch {
    pool = null
  }
  return mergePoolIntoAccounts(accounts, pool)
}

/**
 * 自适应启用 / 禁用：admin API 优先，旧网关回退改名。
 *
 * - **禁用**：admin disable 成功 → 文件名不动（token 继续刷新，这就是
 *   「热切换」相对改名的全部收益）。admin 不可用 → 回退改名。
 * - **启用**：文件若还挂着 `.disabled` 后缀必须先改回来 —— 网关只加载
 *   `workbuddy*.json`，池里根本没有的账号 enable 是 404。改完再 admin
 *   enable（清掉可能残留的 manual_disabled）。
 */
async function setAccountEnabledAdaptive(fileName, enabled) {
  const meta = parseAuthFileName(fileName)
  if (meta === undefined) throw new Error('凭证文件名不合法。')
  resolveAuthFile(fileName)
  // admin API 只认凭证内容里的裸 uid（与 /status、state.json 同口径）；文件名 stem
  // 带 `workbuddy-` 前缀，直接传会 404 "account not found"（2026-09-28 实测）。
  // 内容读不出时退回 stem，维持「先试 admin、失败再降级改名」的原路径。
  const uid = readCredential(fileName)?.uid ?? meta.uid
  const renamed = fileName.endsWith(DISABLED_SUFFIX)
  if (enabled === !renamed) {
    // 文件名层面已就位；admin 层可能有残留状态，顺手对齐一次。
    if (adminConfigured() && existsSync(join(RUNTIME_DIR, 'bin', process.platform === 'win32' ? 'wb2a-server.exe' : 'wb2a-server'))) {
      try { await gatewayAdminAction(uid, enabled ? 'enable' : 'disable') } catch { /* 网关没起就算了 */ }
    }
    return 'noop'
  }
  if (enabled) {
    if (renamed) renameSync(resolveAuthFile(fileName), resolveAuthFile(fileName).slice(0, -DISABLED_SUFFIX.length))
    try {
      await gatewayAdminAction(uid, 'enable')
      return 'admin'
    } catch {
      return 'file'
    }
  }
  if (!renamed && adminConfigured()) {
    try {
      await gatewayAdminAction(uid, 'disable')
      return 'admin'
    } catch {
      // admin 没开（旧配置）→ 落到改名。
    }
  }
  setAccountEnabled(fileName, false)
  return 'file'
}

// ---------------------------------------------------------------------------
// 上游 OAuth（begin → poll → account）
// ---------------------------------------------------------------------------

/** 上游登录请求头（`login.sh` 的 commonHeaders）。 */
function loginHeaders(realm, token) {
  const { origin: originHeader } = REALMS[realm]
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: originHeader,
    Referer: `${originHeader}/`,
    'User-Agent': LOGIN_UA,
    ...(token !== undefined && token !== '' ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** 登录尚未完成 —— 可重试，不是故障。 */
class LoginPendingError extends Error {
  constructor(message = '登录尚未完成。') {
    super(message)
    this.name = 'LoginPendingError'
    this.pending = true
  }
}

/** 发一次上游请求并拆 `{code,msg,data}` 信封。 */
async function upstreamCall(realm, url, init) {
  let response
  try {
    response = await fetch(url, {
      method: init.method,
      headers: loginHeaders(realm, init.token),
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`请求上游失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text().catch(() => '')
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`上游返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (envelope.code !== undefined && envelope.code !== 0) {
    const message = `code=${envelope.code} msg=${envelope.msg ?? ''}`
    // 上游「登录未完成」走 4xx + 非 0 code（实测 msg="login ing"）。
    if (response.status >= 400 && response.status < 500) throw new LoginPendingError(`登录尚未完成（${message}）`)
    throw new Error(message)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`)
  if (envelope.data === undefined) throw new Error(`上游响应缺少 data 字段：${text.slice(0, 200)}`)
  return envelope.data
}

/** 第一步：取授权链接（state 由服务端签发）。 */
async function loginBegin(realm) {
  const { base } = REALMS[realm]
  const data = await upstreamCall(realm, `${base}/v2/plugin/auth/state?platform=CLI`, { method: 'POST', body: '{}' })
  if (typeof data.state !== 'string' || data.state === '' || typeof data.authUrl !== 'string' || data.authUrl === '') {
    throw new Error('上游未返回 state 或 authUrl，登录无法继续。')
  }
  return { state: data.state, authUrl: data.authUrl }
}

/** 第二、三步：轮询 token + 取账号信息，成功后落盘。 */
async function loginPoll(realm, state) {
  const { base } = REALMS[realm]
  const token = await upstreamCall(realm, `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { method: 'GET' })
  if (typeof token.accessToken !== 'string' || token.accessToken === '') {
    throw new LoginPendingError('登录尚未完成：token 端点还没有返回 accessToken。')
  }
  const account = await upstreamCall(realm, `${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`, {
    method: 'GET',
    token: token.accessToken,
  })
  const document = normalizeDocument({
    account: { uid: account.uid, enterpriseId: account.enterpriseId, nickname: account.nickname },
    auth: {
      accessToken: token.accessToken,
      refreshToken: typeof token.refreshToken === 'string' ? token.refreshToken : '',
      // expiresIn 是秒，换算成本地时钟的绝对秒。上游没给时按 1 小时兜底，不能写 0 ——
      // 写 0 等于「落盘即过期」，网关会拿 refreshToken 空转；1 小时内网关刷新一次，
      // 就会用真实 expiresAt 把文件重写回来，自愈。
      expiresAt: Math.floor(Date.now() / 1000)
        + (typeof token.expiresIn === 'number' && token.expiresIn > 0 ? token.expiresIn : 3600),
      domain: typeof token.domain === 'string' ? token.domain : '',
      realm,
    },
  })
  const file = writeAuthDocument(document)
  return { file: basename(file), uid: document.account.uid, nickname: document.account.nickname, realm }
}

// ---------------------------------------------------------------------------
// 网关探测
// ---------------------------------------------------------------------------

/** 探活 `/healthz`。端口没监听返回 `{ running: false }`，不是错误。 */
async function probeGateway() {
  const base = origin()
  try {
    const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 200) }
    }
    return { running: response.ok, baseURL: base, status: response.status, health: body }
  } catch (error) {
    return { running: false, baseURL: base, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 拉账号池的**实时**状态 —— 冷却 / 熔断 / 在飞。
 *
 * ## 为什么必须接这个
 *
 * 计费面（余额、分段、今日用量）回答的是「还剩多少」，
 * 而 `/status` 回答的是「现在能不能用」。这是两件事，之前面板只有前者：
 *
 * - 某账号被上游限流时，面板上它照样写着「可用 1779.84」——**看着完全正常**；
 * - 用户遇到请求失败或账号被切走时，面板给不出任何线索；
 * - 今日用量曲线突然不动（请求被路由到别的账号了），也没有解释。
 *
 * ## 网关的三层保护（字段名都来自 `/status`）
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `cooling` + `until` | 该账号在冷却，`until` 之前不参与轮换 |
 * | `degrade_until` | 降级观察期（软失败后的试探窗口） |
 * | `breaker_fails` + `breaker_until` | 连续失败触发熔断，整个账号被摘出 |
 *
 * 期间网关会把请求**自动路由到池里其他可用账号** —— 这正是账号池的意义。
 * 但用户需要看得见，否则「为什么我的请求不是这个账号在跑」永远是个谜。
 *
 * 端点无需鉴权也能读，仍带 key 以保持一致。
 */
async function fetchPoolStatus() {
  const base = origin()
  const key = gatewayApiKey()
  const response = await fetch(`${base}/status`, {
    headers: { accept: 'application/json', ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`GET /status 返回 HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.accounts) ? body.accounts : []
  // 只挑渲染用得上的字段。`model_costs` 这类分析用数据不下发 —— 面板不展示它，
  // 传过去只是把响应撑大。
  const text = (value) => (typeof value === 'string' ? value : '')
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    total: count(body?.total) || rows.length,
    global: {
      cooling: count(body?.global?.cooling),
      disabled: count(body?.global?.disabled),
      healthy: count(body?.global?.healthy),
      inFlightFull: count(body?.global?.in_flight_full),
    },
    accounts: rows.map((row) => ({
      uid: text(row?.uid),
      nickname: text(row?.nickname),
      cooling: row?.cooling === true,
      until: text(row?.until),
      degradeUntil: text(row?.degrade_until),
      breakerFails: count(row?.breaker_fails),
      breakerUntil: text(row?.breaker_until),
      inFlight: count(row?.in_flight),
      consecutiveFails: count(row?.consecutive_fails),
      successCount: count(row?.success_count),
      lastSuccess: text(row?.last_success),
      lastErr: text(row?.last_err),
      disabled: row?.disabled === true,
      manualDisabled: row?.manual_disabled === true,
    })),
  }
}

// ---------------------------------------------------------------------------
// 每日签到 / 保持活跃
// ---------------------------------------------------------------------------

/**
 * 签到路径。**两个前缀都要试** —— 跟资源查询不一样（那个只在 `/v2`），
 * 签到这个接口在实测里两种前缀都存在，靠多域名 + 多路径兜底才稳。
 */
const CHECKIN_PATHS = ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin']

/** 签到结果文案特征。照抄 WorkDaddy 的 `checkin-result.js` —— 这些正则是从
 *  上游真实返回里长出来的，自己重写一遍只会漏掉「已过期」「重复签到」这类说法。 */
const CHECKIN_INACTIVE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/iu
const CHECKIN_ALREADY = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already/iu

/**
 * 判定签到结果。
 *
 * **HTTP 200 不等于签到成功** —— 网关可能回一个空的、或非 JSON 的 200。
 * 所以只认两种：
 *
 * 1. `code === 0` —— 明确成功；
 * 2. `code === 10001` 且文案证明「今天已经签过」—— 目的已达成，
 *    算成功不算失败（否则用户第二天看到一片红，会以为坏了）。
 */
function classifyCheckin(httpOk, code, message) {
  const numeric = Number(code)
  const text = String(message ?? '')
  const inactive = CHECKIN_INACTIVE.test(text)
  const already = numeric === 10001 && !inactive && CHECKIN_ALREADY.test(text)
  const ok = !inactive && ((numeric === 0 && httpOk) || already)
  return { ok, already, inactive, code: Number.isFinite(numeric) ? numeric : null, message: text }
}

/** 签到 / 活跃状态落盘在插件自己的 data/ 里 —— **不碰网关的 data/**，那是它的地盘。 */
const PLUGIN_DATA_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data')
// 允许覆盖路径：测试要写临时文件，不能污染真实的「今天签没签」状态。
const ACTIVITY_STATE_FILE = process.env.WB2API_ACTIVITY_FILE || join(PLUGIN_DATA_DIR, 'daily-activity.json')

/** 面板可能同时发好几个 `/state`，用这个挡住自动签到的重复触发。 */
let autoCheckinRunning = false

/** 读状态文件；坏文件当空的处理（这是可丢的缓存，不是数据源）。 */
function readActivityState() {
  try {
    const parsed = JSON.parse(readFileSync(ACTIVITY_STATE_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 当天自动签到的一次性守卫键 —— 记在状态顶层，不是日期记录，不参与 7 天裁剪。 */
const ACTIVITY_AUTO_KEY = '__auto'

/** 原子落盘，保留最近 7 天。 */
function writeActivityState(state) {
  try {
    mkdirSync(PLUGIN_DATA_DIR, { recursive: true })
    const days = Object.keys(state).filter((key) => key !== ACTIVITY_AUTO_KEY).sort().slice(-7)
    const pruned = {}
    if (state[ACTIVITY_AUTO_KEY] !== undefined) pruned[ACTIVITY_AUTO_KEY] = state[ACTIVITY_AUTO_KEY]
    for (const day of days) pruned[day] = state[day]
    const file = `${ACTIVITY_STATE_FILE}.part`
    writeFileSync(file, `${JSON.stringify(pruned, null, 1)}\n`, { mode: 0o600 })
    renameSync(file, ACTIVITY_STATE_FILE)
  } catch {
    // 状态只是"今天跑过没有"的备忘，写不进去不该让签到本身失败。
  }
}

/** 本地日期 `YYYY-MM-DD`。 */
function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 对一个账号签到（多域名 × 多路径兜底）。
 *
 * 端点顺序：**优先用 token 里 `iss` 声明的发行方** —— 跨域签名会被拒，
 * 猜错域名就是这个接口最常见的一种失败。拿不到 `iss` 才退到 realm 的域。
 *
 * 不抛错：返回结果对象。单账号失败不该中断整批签到。
 */
async function checkinAccount(credential) {
  const issuer = tokenIssuerOrigin(credential.accessToken)
  const hosts = []
  if (issuer !== null && /workbuddy|codebuddy/u.test(issuer)) hosts.push(issuer)
  const fallback = credential.realm === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  for (const host of [fallback, 'https://www.workbuddy.cn', 'https://www.workbuddy.ai']) {
    if (!hosts.includes(host)) hosts.push(host)
  }

  let lastMessage = '未知错误'
  let firstUnauthorized = null
  for (const host of hosts) {
    for (const path of CHECKIN_PATHS) {
      const url = `${host}${path}`
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            ...creditsHeaders(credential),
            'x-client-platform': 'web',
            origin: host,
            referer: `${host}/profile/plans-usage`,
            'user-agent': LOGIN_UA,
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error)
        continue
      }
      const text = await response.text().catch(() => '')
      let envelope = {}
      try { envelope = JSON.parse(text) } catch { /* 200 也可能是空体，交给 classify 判 */ }
      // 401 单独记：这几乎总是 token 失效，用户需要知道去重新授权，
      // 而不是看到一句裸的 "HTTP 401"。
      const message = envelope.msg || envelope.message || (response.ok ? 'ok' : `HTTP ${response.status}`)
      const verdict = classifyCheckin(response.ok, envelope.code, message)
      const result = { ...verdict, status: response.status, url }
      if (verdict.ok) return result
      if (response.status === 401) {
        if (firstUnauthorized === null) firstUnauthorized = { ...result, message: '登录身份过期' }
        lastMessage = message
        continue
      }
      // 非 404 的 4xx / 任何非 404 的成功响应都是明确答复，不用再换域名试了。
      if ((response.status >= 400 && response.status < 500 && response.status !== 404) || (response.ok && response.status !== 404)) {
        return result
      }
      lastMessage = message
    }
  }
  if (firstUnauthorized !== null) return firstUnauthorized
  return { ok: false, already: false, inactive: false, code: -1, message: lastMessage, url: null }
}

/** 从 token 的 `iss` 取发行方 origin —— 跨域签名会被拒，这个判断能省掉一堆试错。 */
function tokenIssuerOrigin(accessToken) {
  try {
    const part = String(accessToken ?? '').split('.')[1]
    if (part === undefined || part === '') return null
    const padded = part.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const origin = new URL(String(payload.iss ?? '')).origin.toLowerCase()
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * 「保持活跃」—— 用该账号发起一次云端会话。
 *
 * ## 为什么只做第一步
 *
 * WorkDaddy 的完整实现是 ACP 会话：建会话 → 建 SSE 长连接 → JSON-RPC 发消息，
 * 400 多行，还要在插件进程里维护长连接（半开、超时、并发会话都得处理）。
 * 而收益只是「多发一条消息」。
 *
 * 这里只走第一步 `POST /console/as/conversations/` —— 它本身就是一次真实的
 * 云端会话创建，会落到账号的活跃记录上。
 *
 * **⚠ 未实测**：没拿真实账号跑过（付费上游的纪律：能不打就不打）。
 * 它的效果与成本都还是推测，第一次用请留意额度变化。
 */
async function keepAliveAccount(credential) {
  const host = credential.realm === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn'
  const response = await fetch(`${host}/console/as/conversations/`, {
    method: 'POST',
    headers: {
      ...creditsHeaders(credential),
      'x-codebuddy-request': '1',
      'x-client-platform': 'web',
      origin: host,
      referer: `${host}/`,
      'user-agent': LOGIN_UA,
    },
    body: JSON.stringify({ prompt: '你好', model: 'deepseek-r1', plugins: [] }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text().catch(() => '')
  let envelope = {}
  try { envelope = JSON.parse(text) } catch { /* 非 JSON 也算失败 */ }
  const body = envelope?.data !== null && typeof envelope?.data === 'object' ? envelope.data : envelope
  const conversationId = String(body?.id ?? body?.conversationId ?? body?.info?.id ?? '')
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    const message = envelope.msg || envelope.message || `HTTP ${response.status}`
    return { ok: false, message: String(message) }
  }
  if (conversationId === '') return { ok: false, message: '会话已建立但响应里没有 conversation id' }
  return { ok: true, conversationId }
}

/**
 * 跑一轮签到 / 保活。
 *
 * **串行，不并发** —— 这是写操作，而且上游对密集请求会计数（付费上游的纪律：
 * 能不打的请求就不打，能少打就少打）。四个账号串行也就几秒，不值得为省两秒
 * 去踩风控。
 *
 * 幂等：同一天同一账号已经成功过就跳过。接口本身也幂等，但少打一次总是好的。
 */
async function runDailyActivity(kind, onlyUid = '') {
  const day = localDay()
  const state = readActivityState()
  const today = state[day] !== null && typeof state[day] === 'object' ? state[day] : {}
  const known = new Map(listAccounts().map((item) => [item.uid, item]))
  const dir = authDir()
  const results = []

  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    // 禁用的账号不参与 —— 网关根本不加载它们，签了也没意义。
    if (parseAuthFileName(file) === undefined || file.endsWith(DISABLED_SUFFIX)) continue
    const credential = readCredential(file)
    if (credential === undefined) continue
    if (onlyUid !== '' && credential.uid !== onlyUid) continue

    const key = `${kind}:${credential.uid}`
    const label = known.get(credential.uid)?.nickname || credential.uid.slice(0, 8)
    if (today[key]?.ok === true) {
      results.push({ uid: credential.uid, nickname: label, ok: true, skipped: true, message: '今天已经做过了' })
      continue
    }

    let outcome
    try {
      if (kind === 'checkin') outcome = await checkinAccount(credential)
      else if (kind === 'growth') outcome = await claimTasksFor(credential)
      else outcome = await keepAliveAccount(credential)
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const record = { ok: outcome.ok === true, message: String(outcome.message ?? ''), at: Date.now() }
    today[key] = record
    results.push({ uid: credential.uid, nickname: label, ...record, already: outcome.already === true })
  }

  state[day] = today
  writeActivityState(state)
  return { day, kind, results }
}

// ---------------------------------------------------------------------------
// 成长中心：任务列表 / 领取奖励 / 连续登录
// ---------------------------------------------------------------------------

/** 任务列表路径（两个前缀都试 —— 照 WorkDaddy 的 `fetchDailyProgress`）。 */
const GROWTH_TASK_PATHS = ['/v2/activity/growth/tasks', '/activity/growth/tasks']
/** 接取（领奖）路径。**只有不带 `/v2` 的那个**。 */
const GROWTH_ACCEPT_PATH = '/activity/growth/tasks/accept'
/** 连续登录天数。 */
const GROWTH_STREAK_PATHS = ['/activity/growth/streak', '/v2/activity/growth/streak']
/** 任务码格式 —— 上游会校验，本地先挡一道，省一次肯定失败的请求。 */
const TASK_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,96}$/u
/** 单次最多接取多少个（上游上限 20）。 */
const GROWTH_ACCEPT_LIMIT = 20

/**
 * 「可以自动完成」的任务码 —— 照抄 WorkDaddy 的白名单。
 *
 * ⚠ **它是标注，不是能力**。参考实现拿这份名单做的也只有一件事：把**不在**名单里
 * 且还没完成的任务标成「需要手动去做的」。真正把这些任务做出来需要在别的产品入口
 * 里操作（关注公众号、体验某个专家、夜间参与活动），插件层面够不着。
 *
 * 唯一能顺手推进的是 `chat_*` 那几个 —— 「保持活跃」发一条云会话就算一次对话。
 * 别把这份名单当成「点了就能全自动做完」。
 */
const AUTOMATABLE_TASK_CODES = new Set([
  'create_canvas', 'template_5', 'expert_5', 'Expert_team_use_3',
  'automation_1', 'playbook_prompt', 'Expert_lighthouse', 'Buddy_App',
  'Buddy_App_QQ', 'Hp_Appearance', 'chat_5', 'Model_chat_GLM5.2',
  'black_cat', 'Library_read',
])

/** 成长中心的请求头 —— referer 指到 growth-center 页。 */
function growthHeaders(credential, host) {
  return {
    ...creditsHeaders(credential),
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/growth-center`,
  }
}

/**
 * 依次试几个路径，返回第一个成功响应的 `data`。
 *
 * 上游同一个能力常常同时挂在 `/v2/...` 和 `/...` 下，但不保证两边都在线 ——
 * 试的代价是一次 404，比猜错好。
 */
async function fetchGrowthJson(credential, paths) {
  const host = BILLING_BASES[credential.realm] ?? BILLING_BASES.cn
  let lastError = null
  for (const path of paths) {
    let response
    try {
      response = await fetch(`${host}${path}`, {
        headers: { accept: 'application/json, text/plain, */*', ...growthHeaders(credential, host) },
        signal: AbortSignal.timeout(12_000),
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      continue
    }
    const text = await response.text().catch(() => '')
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      lastError = `HTTP ${response.status} 非 JSON`
      continue
    }
    if (!response.ok) {
      lastError = envelope.msg || `HTTP ${response.status}`
      continue
    }
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      lastError = envelope.msg || `code=${envelope.code}`
      continue
    }
    return envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : envelope
  }
  throw new Error(lastError ?? '所有候选路径都失败')
}

/**
 * 拉成长中心状态：任务清单 + 连续登录天数。
 *
 * 两个接口并行拉，各自 catch —— **任务列表是主体，连续天数只是锦上添花**，
 * 少一个数字不该让整块空掉。
 */
async function fetchGrowthStatus(credential) {
  const [taskData, streakData] = await Promise.all([
    fetchGrowthJson(credential, GROWTH_TASK_PATHS).catch(() => null),
    fetchGrowthJson(credential, GROWTH_STREAK_PATHS).catch(() => null),
  ])

  const list = Array.isArray(taskData?.tasks) ? taskData.tasks : []
  const tasks = []
  let completed = 0
  let pendingCredits = 0
  for (const task of list) {
    if (task === null || typeof task !== 'object') continue
    const status = String(task.accept_status ?? 'not_accepted')
    const progress = task.progress !== null && typeof task.progress === 'object' ? task.progress : {}
    const current = Math.max(0, Number(progress.current) || 0)
    const target = Math.max(1, Number(progress.target) || 1)
    const isComplete = status === 'completed' || status === 'claimed' || current >= target
    const state = status === 'claimed' ? 'claimed' : isComplete ? 'completed' : status === 'not_accepted' ? 'not_accepted' : 'in_progress'
    const code = TASK_CODE_PATTERN.test(String(task.task_code ?? '')) ? String(task.task_code) : ''
    const credits = Math.max(0, Number(task.reward_credit) || 0)
    // **只算真的完成了的**（已领 or 完成待领）。
    // 写成 `state !== 'not_accepted'` 会把 in_progress 也算进去 —— 实测跑出来
    // 「任务 19/19 完成」同时还列着一堆「进行中 0/1」，自相矛盾。
    if (state === 'completed' || state === 'claimed') completed += 1
    if (state === 'completed' && credits > 0) pendingCredits += credits
    tasks.push({
      code,
      title: String(task.title ?? task.task_desc ?? code ?? '未识别任务').slice(0, 80),
      state,
      current,
      target,
      credits,
      // 完成但没领的才是「点一下就有积分」的 —— 这是「领取积分」的全部目标。
      claimable: state === 'completed' && code !== '',
      // 标出「这个任务的完成方式可以自动化」——但能不能真自动，见白名单上的注释。
      auto: AUTOMATABLE_TASK_CODES.has(code),
    })
  }

  const streakDays = Number(streakData?.streak?.days)
  return {
    tasks,
    summary: {
      total: tasks.length,
      completed,
      claimable: tasks.filter((task) => task.claimable).length,
      pendingCredits,
    },
    streakDays: Number.isSafeInteger(streakDays) && streakDays >= 0 ? streakDays : null,
  }
}

/**
 * 领取已完成的成长任务奖励。
 *
 * **只领 `state === 'completed'` 的** —— 未完成的任务发过去会被上游拒，
 * 白白多打一次请求（而且四个账号乘下来就是四次）。
 *
 * 上游单次上限 20 个，超了分批。
 */
async function claimGrowthRewards(credential, codes) {
  const host = BILLING_BASES[credential.realm] ?? BILLING_BASES.cn
  const valid = [...new Set(codes.filter((code) => TASK_CODE_PATTERN.test(code)))].slice(0, GROWTH_ACCEPT_LIMIT)
  if (valid.length === 0) return { ok: true, claimed: 0, message: '没有可领的任务' }

  let response
  try {
    response = await fetch(`${host}${GROWTH_ACCEPT_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json', ...growthHeaders(credential, host) },
      body: JSON.stringify({ task_codes: valid }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { ok: false, claimed: 0, message: `领取请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text().catch(() => '')
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    return { ok: false, claimed: 0, message: `领取接口返回非 JSON（HTTP ${response.status}）` }
  }
  if (!response.ok || (typeof envelope.code === 'number' && envelope.code !== 0)) {
    return { ok: false, claimed: 0, message: String(envelope.msg || envelope.message || `HTTP ${response.status}`) }
  }
  // 响应里可能给了实发金额；拿不到就按"提交了几个"报，不编数字。
  const granted = Number(envelope.data?.total_credit ?? envelope.data?.credit ?? envelope.data?.reward_credit)
  return {
    ok: true,
    claimed: valid.length,
    credits: Number.isFinite(granted) ? granted : null,
    message: `已领取 ${valid.length} 个任务` + (Number.isFinite(granted) && granted > 0 ? `，+${granted} 积分` : ''),
  }
}

/** 成长状态缓存 —— 任务清单变得不快，60 秒足够；面板重渲染不该反复打上游。 */
const growthCache = new Map()

/** 拉全部启用账号的成长状态（含任务清单与连续天数）。 */
async function collectGrowth(options = {}) {
  const force = options.force === true
  const dir = authDir()
  const files = existsSync(dir)
    ? readdirSync(dir).filter((file) => parseAuthFileName(file) !== undefined && !file.endsWith(DISABLED_SUFFIX))
    : []
  const known = new Map(listAccounts().map((item) => [item.uid, item]))
  const rows = []

  const visit = async (file) => {
    const credential = readCredential(file)
    if (credential === undefined) return
    const nickname = known.get(credential.uid)?.nickname ?? ''
    const cached = growthCache.get(credential.uid)
    if (!force && cached !== undefined && Date.now() - cached.at < CREDITS_TTL_MS) {
      rows.push({ uid: credential.uid, nickname, ...cached.value, cached: true })
      return
    }
    try {
      const value = await fetchGrowthStatus(credential)
      growthCache.set(credential.uid, { at: Date.now(), value })
      rows.push({ uid: credential.uid, nickname, ...value, cached: false })
    } catch (error) {
      // 单个账号读不到就标出来，不冒充「没有任务」——那会让人以为任务都做完了。
      rows.push({ uid: credential.uid, nickname, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const queue = [...files]
  const workers = Array.from({ length: Math.max(1, Math.min(CREDITS_CONCURRENCY, queue.length)) }, async () => {
    while (queue.length > 0) await visit(queue.shift())
  })
  await Promise.all(workers)

  // 已删除账号的成长缓存条目一并清掉 —— 禁用账号仍在 known 里，缓存保留；
  // 只有彻底消失的 uid 才是垃圾。
  const liveUids = new Set(known.keys())
  for (const key of [...growthCache.keys()]) {
    if (!liveUids.has(key)) growthCache.delete(key)
  }

  // 与 collectCredits 同口径按 uid 排序输出 —— worker 池按**完成顺序** push，
  // 不排序的话两次请求的数组顺序会漂移（客户端按 uid 索引不受影响，
  // 但接口消费者不该看到顺序抖动）。
  rows.sort((a, b) => String(a.uid).localeCompare(String(b.uid)))

  let claimable = 0
  let pendingCredits = 0
  for (const row of rows) {
    if (row.summary === undefined) continue
    claimable += row.summary.claimable
    pendingCredits += row.summary.pendingCredits
  }
  return { accounts: rows, claimable, pendingCredits, ttlMs: CREDITS_TTL_MS }
}

/** 拉任务 → 领掉已完成的那些。给 `runDailyActivity` 用。 */
async function claimTasksFor(credential) {
  const status = await fetchGrowthStatus(credential)
  const codes = status.tasks.filter((task) => task.claimable).map((task) => task.code)
  if (codes.length === 0) {
    return { ok: true, message: status.summary.total === 0 ? '当前没有任务' : '可领的任务都领过了' }
  }
  return claimGrowthRewards(credential, codes)
}

/** 拉一次模型目录（host 侧持 api_key，密钥不下发浏览器）。 */
async function fetchModels() {
  const base = origin()
  const key = gatewayApiKey()
  const response = await fetch(`${base}/v1/models`, {
    headers: { accept: 'application/json', ...(key !== undefined ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`GET /v1/models 返回 HTTP ${response.status}`)
  const body = await response.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  return rows.map((row) => ({
    id: typeof row?.id === 'string' ? row.id : '',
    contextLength: Number(row?.context_length) || 0,
    maxOutputTokens: Number(row?.max_output_tokens) || 0,
    supportsImages: row?.supports_images === true,
  })).filter((row) => row.id !== '')
}

// ---------------------------------------------------------------------------
// 账号积分（上游计费面）
// ---------------------------------------------------------------------------

/**
 * 读一个凭证文件里的账号身份与令牌。
 *
 * **只在宿主侧用，绝不外发** —— 返回值含 accessToken，任何路由都必须先剥掉再下发。
 *
 * 返回 undefined 表示文件缺失 / 不可解析 / 无 accessToken。调用方据此报
 * 「凭证不可用」，而不是把故障渲染成「0 积分」—— 后者会让一个坏账号看起来
 * 像额度用完了，是最难查的那种错。
 */
function readCredential(fileName) {
  let file
  try {
    file = resolveAuthFile(fileName)
  } catch {
    return undefined
  }
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const account = document?.account ?? {}
  const auth = document?.auth ?? {}
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const domain = typeof auth.domain === 'string' ? auth.domain : ''
  return {
    uid: typeof account.uid === 'string' ? account.uid : '',
    enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
    domain,
    realm: inferRealm(auth.realm, domain),
    accessToken,
  }
}

/**
 * 尽量从文件内容取 account.uid（不要求 accessToken 存在）。
 * collectCredits 各分支的 uid 口径靠它与 listAccounts 对齐：能读到内容就用
 * 真 uid，读不出才退回文件名 stem（带 `workbuddy-` 前缀，仅作兜底）。
 */
function contentUid(fileName) {
  try {
    const document = JSON.parse(readFileSync(resolveAuthFile(fileName), 'utf8'))
    const uid = document?.account?.uid
    return typeof uid === 'string' && uid !== '' ? uid : undefined
  } catch {
    return undefined
  }
}

/** 计费请求头。账号身份只走 header，body 里不带任何身份信息。 */
function creditsHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** 上游要的 `YYYY-MM-DD HH:mm:ss`（本地时区，照抄官方调用）。 */
function billingStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 包明细里同一个语义有好几个字段名，而且**精确值单独占一个字段**。
 *
 * 候选顺序照抄 WorkDaddy 的 `credit-segments.js` —— 它在这个接口上迭代过，
 * 顺序本身就是经验：`SlicePeriod*`（切片周期）优先于 `Cycle*`，`*Precise`
 * 优先于整数版。实测我们的响应里没有 `Slice*`、有 `CycleCapacityRemainPrecise`
 * （字符串形式的数字），所以取到的是**周期口径的精确值** —— 与下面
 * 「数值口径」那节的结论一致。
 */
const SEGMENT_REMAIN_FIELDS = [
  'SlicePeriodCapacityRemainPrecise', 'SlicePeriodCapacityRemain',
  'CycleCapacityRemainPrecise', 'CycleCapacityRemain',
  'CapacityRemainPrecise', 'CapacityRemain',
  'RemainPrecise', 'Remain', 'Remaining', 'Balance',
]

const SEGMENT_TOTAL_FIELDS = [
  'SlicePeriodCapacitySizePrecise', 'SlicePeriodCapacitySize',
  'CycleCapacitySizePrecise', 'CycleCapacitySize',
  'CycleCapacityPrecise', 'CycleCapacity',
  'CapacityPrecise', 'Capacity',
  'TotalCapacityPrecise', 'TotalCapacity', 'PackageCapacity', 'Quota', 'Amount',
]

/** 过期时间。`DeductionEndTime` 优先于 `CycleEndTime` —— 前者才是可用期终点。 */
const SEGMENT_EXPIRY_FIELDS = [
  'DeductionEndTime', 'ExpiredTime', 'SlicePeriodEndTime', 'PackageEndTime',
  'EndTime', 'CycleEndTime', 'ExpireTime', 'ExpirationTime',
  'ValidEndTime', 'ValidPeriodEndTime', 'EndAt', 'ExpireAt',
]

/** 按候选顺序取第一个能解析成数字的字段。**数值字段可能是字符串**，一律 Number()。 */
function pickNumber(source, fields) {
  for (const field of fields) {
    const raw = source?.[field]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (Number.isFinite(value)) return value
  }
  return null
}

/** 时间戳归一化成**毫秒**：上游同一字段可能是秒、毫秒或 `YYYY-MM-DD HH:mm:ss`。 */
function pickTimestamp(source, fields) {
  for (const field of fields) {
    const raw = source?.[field]
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw === 'number' || /^\d+(?:\.\d+)?$/u.test(String(raw).trim())) {
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      // Unix 秒要到 5138 年才破 1e12，所以「大于 1e12」必然是毫秒。
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
    }
    const parsed = Date.parse(String(raw).replace(/^(\d{4}-\d\d-\d\d)\s+/u, '$1T'))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 把包明细折成「进度条上的每一段」。
 *
 * 两条规则都来自 WorkDaddy：
 *
 * 1. **按 `PackageCode` + 到期时间合并。** 同一批发放可能拆成几十条记录
 *    （它注释里的例子：十条 500 的记录在账号页上是一个 5000 的礼包额度），
 *    合并后才是用户认知里的「一个积分包」。
 * 2. **按到期时间升序**，先过期的排左边 —— 扫一眼就知道先没的是哪部分。
 *
 * 余量 <= 0 的包直接丢：它们在条上占不到宽度，留在 tooltip 里只会让人以为漏算。
 */
function extractSegments(rows) {
  const merged = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const remaining = pickNumber(row, SEGMENT_REMAIN_FIELDS)
    if (remaining === null || remaining <= 0) continue
    const rawTotal = pickNumber(row, SEGMENT_TOTAL_FIELDS)
    const size = rawTotal === null ? remaining : Math.max(rawTotal, remaining)
    const expiresAt = pickTimestamp(row, SEGMENT_EXPIRY_FIELDS)
    const packageCode = typeof row.PackageCode === 'string' ? row.PackageCode : ''
    const source = typeof row.PackageName === 'string' && row.PackageName !== '' ? row.PackageName : '积分'
    const key = `${packageCode || source}|${expiresAt ?? 'unknown'}`
    const previous = merged.get(key)
    if (previous === undefined) {
      merged.set(key, { remaining, total: size, expiresAt, source, packageCode })
    } else {
      previous.remaining += remaining
      previous.total += size
    }
  }
  return [...merged.values()]
    .map((segment) => ({
      ...segment,
      remaining: Number(segment.remaining.toFixed(2)),
      total: Number(segment.total.toFixed(2)),
    }))
    .sort((a, b) => {
      // 没有到期信息的排最后 —— 它们不会先失效，放前面会误导。
      if (a.expiresAt === null && b.expiresAt !== null) return 1
      if (a.expiresAt !== null && b.expiresAt === null) return -1
      return (a.expiresAt ?? 0) - (b.expiresAt ?? 0)
    })
}

/** 发一次计费请求并拆 `{code,msg,data}` 信封。 */
async function billingCall(credential, path, body) {
  const base = BILLING_BASES[credential.realm] ?? BILLING_BASES.cn
  let response
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: creditsHeaders(credential),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`请求计费接口失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text().catch(() => '')
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`计费接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
  }
  if (typeof envelope?.code === 'number' && envelope.code !== 0) {
    const message = typeof envelope.msg === 'string' ? envelope.msg : ''
    throw new Error(`计费接口 code=${envelope.code}${message === '' ? '' : ` msg=${message}`}`)
  }
  if (!response.ok) {
    // 401/403 单列一条提示 —— 这几乎总是 token 失效，用户需要知道去重新授权。
    const hint = response.status === 401 || response.status === 403 ? '（凭证可能已失效，需重新授权）' : ''
    throw new Error(`计费接口 HTTP ${response.status}${hint}`)
  }
  return envelope
}

/**
 * 个人号积分：`POST /v2/billing/meter/get-user-resource`，返回分包清单。
 *
 * ## 数值口径 —— **用周期，不用总量**（2026-09-27 被用户推翻重定，别改回去）
 *
 * 同一份响应里有三个「剩余」候选：
 *
 * | 口径 | 账号 A | 账号 B |
 * |---|---|---|
 * | Σ`CycleCapacityRemain`（周期余量） | **2,912** | **1,952** |
 * | Σ`CapacityRemain`（总量余量） | 3,412 | 2,452 |
 * | 上游自己的 `TotalDosage` | 3,412 | 2,452 |
 *
 * 我一开始判 `TotalDosage` 权威，理由是它跟 Σ`CapacityRemain` 一致、数字更大，
 * 看上去像「周期口径漏算了」。**用户对照官方客户端后指出：周期口径才是能用到的
 * 量，总量口径多报了。** 逐包 dump 之后确认他对 —— 差额全部来自同一个包：
 *
 * ```
 * CodeBuddy个人体验版  CapRemain=500/500  CycleRemain=0/500  CycleEnd=2026-09-30
 * ```
 *
 * 这个包本周期 500 已经用完（`CycleCapacityRemain=0`），`CapacityRemain` 却仍是
 * 500。两个账号的差额都正好是这 500。也就是说 **`CapacityRemain` 是「这个包
 * 一生中还没被消耗的总量」，不是「现在能用的量」**；`TotalDosage` 只是它的
 * 汇总，同样不代表可用。拿它当余额会系统性高估。
 *
 * ## 所以
 *
 * - `total` = Σ(有周期的包取 `CycleCapacityRemain`，无周期的包回落 `CapacityRemain`)
 *
 *   回落那一支是给「没有周期概念的一次性包」留的 —— 那种包 `CycleCapacitySize=0`，
 *   周期余量恒为 0，若一刀切按周期算会把它整包算没了（实测两个账号里没有这种包，
 *   但不写这道防线，将来出现就会静默少报）。
 *
 * - `capacityTotal`（进度条分母）与分子同维度，同样按包取周期容量或总量容量。
 *   分子分母混用两套口径，进度条比例就是错的。
 *
 * - 两个口径都随行下发：`sumCapacityRemain` 供 UI 解释「差额去哪了」，
 *   不然用户看到明细里某包写着 500 而总额里没算它，会以为程序漏加。
 */
async function fetchPersonalCredits(credential) {
  const now = new Date()
  const envelope = await billingCall(credential, '/v2/billing/meter/get-user-resource', {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: billingStamp(now),
    PackageEndTimeRangeEnd: billingStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
  })
  const wrapper = envelope?.data !== null && typeof envelope?.data === 'object' ? envelope.data : {}
  const responseNode = wrapper?.Response !== null && typeof wrapper?.Response === 'object' ? wrapper.Response : {}
  const inner = responseNode?.Data !== null && typeof responseNode?.Data === 'object' ? responseNode.Data : {}
  const rows = Array.isArray(inner?.Accounts) ? inner.Accounts : []

  const segments = extractSegments(rows)
  // 主数字与进度条**同源**：total 就是各段之和。分两处各算一遍迟早对不上，
  // 而「数字和条对不上」是最难解释的一种不准。
  const sumAvailable = Number(segments.reduce((sum, segment) => sum + segment.remaining, 0).toFixed(2))
  let sumCapacityRemain = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    sumCapacityRemain += Math.max(0, pickNumber(row, ['CapacityRemainPrecise', 'CapacityRemain']) ?? 0)
  }
  return {
    total: sumAvailable,
    // 进度条上的每一段（已合并同批发放、已按到期时间升序）。UI 只认这个数组。
    segments,
    // 总量口径，只用来解释「差额去哪了」，不参与任何求和。
    sumCapacityRemain: Number(sumCapacityRemain.toFixed(2)),
    packageCount: segments.length,
    unlimited: false,
  }
}

/**
 * CN 企业号积分：`POST /v2/billing/meter/get-enterprise-user-usage`。
 *
 * 企业账号在**个人端点**上会拿到空包列表，渲染成「0 积分」—— 一个看起来很正常的
 * 错数字。所以带 enterpriseId 的 CN 账号必须走这条路径。
 */
async function fetchEnterpriseCredits(credential) {
  const envelope = await billingCall(credential, '/v2/billing/meter/get-enterprise-user-usage', {})
  // 官方两个读取点对字段层级说法不一（`data.data` / `data` / 信封本身），全试一遍。
  const sources = []
  for (const candidate of [envelope?.data, envelope]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if (candidate.data !== null && typeof candidate.data === 'object' && !Array.isArray(candidate.data)) {
      sources.push(candidate.data)
    }
    sources.push(candidate)
  }
  for (const source of sources) {
    const limit = typeof source.limitNum === 'number'
      ? source.limitNum
      : (typeof source.limit_num === 'number' ? source.limit_num : undefined)
    if (limit === undefined) continue
    const used = (typeof source.credit === 'number' ? source.credit : undefined)
      ?? (typeof source.used_num === 'number' ? source.used_num : 0)
    // `-1` 是上游的「不限量」标记，不是余额。带显式旗标，任何渲染层都不该把它当数字。
    if (limit === -1) {
      return { total: 0, segments: [], sumCapacityRemain: 0, packageCount: 0, unlimited: true }
    }
    const remain = Number(Math.max(0, limit - used).toFixed(2))
    const resetAt = pickTimestamp(source, ['CycleResetTime', 'cycleResetTime', 'CycleResetTimeMs'])
    return {
      // 与个人号**同名同形** —— 渲染层只认这一组，不必再分账号类型。
      // 企业号本来就是「周期配额 - 已用」，天然是可用口径，与个人号一致。
      total: remain,
      segments: remain > 0
        ? [{ remaining: remain, total: Number(limit.toFixed(2)), expiresAt: resetAt, source: '企业配额', packageCode: '' }]
        : [],
      sumCapacityRemain: remain,
      packageCount: remain > 0 ? 1 : 0,
      unlimited: false,
    }
  }
  throw new Error('企业计费接口返回里没有可识别的配额字段（期望 limitNum / limit_num）。')
}

/** 按账号类型选端点。企业路径的区域阈值是实测得来的，别顺手统一成个人端点。 */
function fetchCreditsFor(credential) {
  if (credential.realm === 'cn' && credential.enterpriseId !== '') return fetchEnterpriseCredits(credential)
  return fetchPersonalCredits(credential)
}

/**
 * 今日已使用的积分。
 *
 * ## 端点前缀与资源查询**不一样**（这是实测出来的，别顺手统一）
 *
 * 资源查询是 `{base}/v2/billing/meter/get-user-resource`，
 * 逐笔用量是 `{base}/billing/meter/get-user-request-usage` —— **没有 `/v2`**。
 * 带 `/v2` 会 404 `Route Not Found`；不带才 200。
 *
 * ## 为什么不是"算出来的"
 *
 * 上游没有"今日消耗"这种聚合字段，它只给逐笔流水。所以只能拉当天的记录再相加 ——
 * WorkDaddy 也是这么做的（它更进一步，把记录落 SQLite 做历史，我们只需要今天）。
 *
 * 这是查询接口，不消耗额度。
 */
async function fetchTodayUsage(credential) {
  const base = BILLING_BASES[credential.realm] ?? BILLING_BASES.cn
  const now = new Date()
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const headers = creditsHeaders(credential)
  headers['x-client-platform'] = 'web'

  const rows = []
  let total = 0
  // 一天几百笔已经是重度使用；设上限免得异常数据把面板拖死。
  for (let pageNum = 1; pageNum <= 10; pageNum += 1) {
    let response
    try {
      response = await fetch(`${base}/billing/meter/get-user-request-usage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startTime: billingStamp(dayStart),
          endTime: billingStamp(now),
          pageNum,
          pageSize: 100,
        }),
        signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
      })
    } catch (error) {
      throw new Error(`请求用量接口失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text().catch(() => '')
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new Error(`用量接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
    }
    if (typeof envelope?.code === 'number' && envelope.code !== 0) {
      throw new Error(`用量接口 code=${envelope.code}${typeof envelope.msg === 'string' ? ` msg=${envelope.msg}` : ''}`)
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '（凭证可能已失效，需重新授权）' : ''
      throw new Error(`用量接口 HTTP ${response.status}${hint}`)
    }
    const page = envelope?.data
    if (page === null || typeof page !== 'object' || !Array.isArray(page.data)) break
    if (typeof page.total === 'number') total = page.total
    rows.push(...page.data)
    if (rows.length >= (Number.isFinite(total) ? total : 0) || page.data.length === 0) break
  }

  let used = 0
  for (const row of rows) {
    const credit = Number(row?.credit)
    if (Number.isFinite(credit) && credit > 0) used += credit
  }
  return {
    date: `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`,
    used: Number(used.toFixed(2)),
    count: rows.length,
  }
}

/** fileName → `{ at, value }`。只缓存成功结果 —— 失败必须下次重试。 */
const creditsCache = new Map()

/**
 * 收集所有账号的积分。
 *
 * 缓存策略：成功结果缓存 {@link CREDITS_TTL_MS}；**失败不缓存** —— 否则一次
 * 网络抖动会让错误文案在面板上挂整整一分钟。
 *
 * 禁用账号不发请求：网关根本不加载它们，查出来的数字只会误导。
 *
 * 并发上限 {@link CREDITS_CONCURRENCY}：几十个账号一次性全打上游会被上游按
 * 密集请求计数，而这个面板刷新并不该花用户的钱。
 */
async function collectCredits(options = {}) {
  const force = options.force === true
  const dir = authDir()
  const files = existsSync(dir)
    ? readdirSync(dir).filter((fileName) => parseAuthFileName(fileName) !== undefined)
    : []

  const rows = []
  let oldestFetch = 0

  // 已删除的凭证文件把缓存条目一并清掉 —— 缓存按文件名索引，文件没了条目就成了垃圾。
  const liveFiles = new Set(files)
  for (const key of [...creditsCache.keys()]) {
    if (!liveFiles.has(key)) creditsCache.delete(key)
  }

  const visit = async (fileName) => {
    const meta = parseAuthFileName(fileName)
    // uid 口径全分支统一（缓存命中 / 新鲜 / 不可读 / 出错）：能从内容读到真 uid
    // 就用（与 listAccounts 同口径），读不出才退 stem。原来缓存命中行报 stem、
    // 新鲜行报真 uid，两种格式混排。
    const credential = readCredential(fileName)
    const entry = { file: fileName, uid: credential?.uid || contentUid(fileName) || meta.uid, disabled: meta.disabled }
    /**
     * **禁用账号也查积分。**
     *
     * 这里原来有一句 early return，理由是「网关不加载禁用的账号，查出来的数字
     * 只会误导」—— 那个理由站不住：积分是**账号自己的属性**，跟网关加不加载无关，
     * 用户禁用某个账号之后照样想知道它还剩多少（判断要不要重新启用）。
     *
     * 真正的代价是我没预料到的：面板上禁用账号的卡片会**整块塌掉**（积分行、
     * 进度条、明细全没了），因为前端拿不到数据。而「切换账号」的副作用恰恰是
     * 把其余账号全禁用 —— 一点切换，三张卡同时塌成一行，看着就像坏了。
     *
     * 多打几次只读请求（有 60 秒缓存）换一个不会说谎的界面，值。
     */
    const cached = creditsCache.get(fileName)
    if (!force && cached !== undefined && Date.now() - cached.at < CREDITS_TTL_MS) {
      if (oldestFetch === 0 || cached.at < oldestFetch) oldestFetch = cached.at
      rows.push({ ...entry, state: 'ok', fetchedAt: cached.at, cached: true, todayUsage: cached.todayUsage ?? null, ...cached.value })
      return
    }
    if (credential === undefined) {
      rows.push({ ...entry, state: 'unreadable' })
      return
    }
    try {
      const value = await fetchCreditsFor(credential)
      // 今日用量是**另一条链路**，失败就留空 —— 一个附属数字不该把余额一起拖垮。
      const todayUsage = await fetchTodayUsage(credential).catch(() => null)
      const at = Date.now()
      creditsCache.set(fileName, { at, value, todayUsage })
      if (oldestFetch === 0 || at < oldestFetch) oldestFetch = at
      rows.push({ ...entry, state: 'ok', fetchedAt: at, cached: false, todayUsage, ...value })
    } catch (error) {
      creditsCache.delete(fileName)
      rows.push({ ...entry, state: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  // 简易工作池：保持 CREDITS_CONCURRENCY 个在飞，而不是一次放几十个。
  const queue = [...files]
  const workers = Array.from({ length: Math.max(1, Math.min(CREDITS_CONCURRENCY, queue.length)) }, async () => {
    while (queue.length > 0) await visit(queue.shift())
  })
  await Promise.all(workers)

  // 与 listAccounts **严格同序**（只按 uid）—— 两边规则不一致的话，
  // 卡片与积分数据会错位，那比「跳一下」更难查。
  rows.sort((a, b) => String(a.uid).localeCompare(String(b.uid)))

  let total = 0
  let todayUsed = 0
  let unlimited = 0
  const counts = { total: rows.length, ok: 0, error: 0, disabled: 0, unreadable: 0 }
  for (const row of rows) {
    // 「禁用」现在是**独立于查询结果**的一维：禁用的账号照样有余额，
    // 所以不再用 `state === 'disabled'` 表示它（那条路只在老 host 上还会出现）。
    if (row.disabled === true) counts.disabled += 1
    if (row.state === 'ok') {
      counts.ok += 1
      // 不限量的账号没有可加的数字，单独计数而不是当 0 —— 否则汇总会显得很低。
      if (row.unlimited) unlimited += 1
      else total += Number(row.total) || 0
      if (row.todayUsage !== null && row.todayUsage !== undefined) todayUsed += Number(row.todayUsage.used) || 0
    } else if (row.state === 'error') counts.error += 1
    else if (row.state !== 'disabled') counts.unreadable += 1
  }

  return {
    // 两位小数：上游给了 `*Precise` 字段，抹成整数会让面板跟自己算的对不上。
    total: Number(total.toFixed(2)),
    todayUsed: Number(todayUsed.toFixed(2)),
    unlimited,
    counts,
    oldestFetch,
    ttlMs: CREDITS_TTL_MS,
    accounts: rows,
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 挂上所有面板路由。
 *
 * 路径统一前缀 `/dsh-wb2api/`，只在本机 dsh 的 web 端口上监听 —— 页面本身
 * 已由 dsh 鉴权，这里不再重复造一套。
 */
export function apply(ctx, config) {
  // ── 后端服务（上游网关）由本插件自己托管 ──────────────────────────────
  // 这件事由内置在 lib/gw/ 的实现负责，
  // 以子插件形式挂载：进程生命周期（拉起 / 探活 / 崩溃重启 / 回收）、模型目录
  // 注册（llm provider）、/wb2api-* 命令全部由本插件负责 —— 装这一个就够了。
  // ⚠ 同一个 profile 里若还挂着注册同一 provider id 的插件，会撞 provider 注册（两个适配器
  //   抢同一个 provider id）。处理办法：移除其中一个后重启 dsh。
  void mountGateway(ctx, config)

  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const json = (res, status, payload) => {
        res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      }
      const readBody = async (req) => {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buf.length
          if (size > MAX_BODY_BYTES) throw new Error('请求体过大。')
          chunks.push(buf)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        return text === '' ? {} : JSON.parse(text)
      }
      /** 统一包裹：handler 抛错一律转成 `{ok:false,error}`，前端只认这一种失败。 */
      const route = (path, method, handler, label) => {
        host.webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== method) {
              res.writeHead(405, { allow: method })
              res.end()
              return
            }
            try {
              json(res, 200, { ok: true, ...(await handler(req)) })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              json(res, error?.pending === true ? 202 : 500, { ok: false, pending: error?.pending === true, error: message })
            }
          },
        }, label)
      }

      // 总状态：一次拿全，前端首屏只发这一个请求。
      route('/dsh-wb2api/state', 'GET', async () => {
        ensureAuthDir()
        const gateway = await probeGateway()
        // 网关没起来时不去打模型接口 —— 那只会得到一个连接拒绝，对用户没有信息量。
        const models = gateway.running ? await fetchModels().catch(() => null) : null
        // 账号池实时状态（冷却 / 熔断）。同理，网关没起来就没得问。
        // 单独 catch：读不到池状态不该让整个面板打不开 —— 余额那些还等着渲染。
        const pool = gateway.running ? await fetchPoolStatus().catch(() => null) : null

        // 今天的签到 / 保活状态。面板据此在卡片上打徽章。
        const activityState = readActivityState()
        const activity = activityState[localDay()] ?? {}

        /**
         * 每天第一次打开面板时自动签到一轮。
         *
         * 之所以选「打开面板」而不是 host 侧定时：定时器活不过 dsh 重启，
         * 而用户每天总会开一次面板看额度 —— 这个时机最接近他真正在意的那个。
         *
         * `__auto` 是当天的一次性守卫，记在状态**顶层**（不是某个日期对象里）。
         * 2026-09-28 修过一个作用域错位：守卫读的是当天记录对象、标记却写在
         * 顶层 —— 守卫永远不命中，每次 /state 都重新触发一轮（幂等跳过兜着，
         * 但签到失败过的账号会被整天反复重试）。
         *
         * 标记在**跑完之后**落盘：先写后跑的话，dsh 中途被杀当天就不再重试；
         * 跑完再写的最坏情况是重复跑一轮，而 runDailyActivity 对当天已成功的
         * 账号幂等。同一天面板并发多个 /state 由 autoCheckinRunning 进程内
         * 守卫挡住。后台跑，不阻塞首屏。
         */
        // `WB2API_NO_AUTO_ACTIVITY=1` 关掉自动签到 —— **测试必须设**：
        // 这是会真打上游的写操作，「测试里不该发生真实请求」这条纪律是拿额度换来的。
        if (process.env.WB2API_NO_AUTO_ACTIVITY !== '1'
          && activityState[ACTIVITY_AUTO_KEY] !== localDay()
          && !autoCheckinRunning) {
          autoCheckinRunning = true
          void (async () => {
            // 先签到（领额度）、再领任务奖励。顺序无所谓，但**串行** ——
            // 都是写操作，别在上游那边并发。
            await runDailyActivity('checkin').catch(() => {})
            await runDailyActivity('growth').catch(() => {})
          })().finally(() => {
            // 重读最新状态再写标记 —— 后台跑的 runDailyActivity 已写入了
            // 当天记录，直接复用旧对象会把它们冲掉。
            const state = readActivityState()
            state[ACTIVITY_AUTO_KEY] = localDay()
            writeActivityState(state)
            autoCheckinRunning = false
          })
        }

        return {
          runtimeDir: RUNTIME_DIR,
          authDir: authDir(),
          configured: existsSync(join(RUNTIME_DIR, 'config.json')),
          binary: {
            path: uiBinaryPath(),
            exists: existsSync(uiBinaryPath()),
          },
          gateway,
          accounts: await listAccountsMerged(),
          models,
          pool,
          // 网关 admin API 是否可用 —— 客户端据此决定切换语义的提示文案。
          admin: adminConfigured(),
          // 今天的签到 / 保活结果（键形如 `checkin:<uid>`）。空对象 = 今天还没跑。
          activity,
        }
      })

      // 仅刷新模型目录（网关在跑时才有意义）。
      route('/dsh-wb2api/models', 'GET', async () => ({ models: await fetchModels() }))

      // 手动签到 / 保活。body 里给 uid 就只跑那一个，否则跑全部（启用中的）。
      route('/dsh-wb2api/checkin', 'POST', async (req) => {
        const body = await readBody(req)
        return { result: await runDailyActivity('checkin', typeof body?.uid === 'string' ? body.uid : '') }
      })

      route('/dsh-wb2api/keepalive', 'POST', async (req) => {
        const body = await readBody(req)
        return { result: await runDailyActivity('keepalive', typeof body?.uid === 'string' ? body.uid : '') }
      })

      // 成长中心：任务清单 + 连续登录天数。`?force=1` 绕过 60 秒缓存。
      route('/dsh-wb2api/growth', 'GET', async (req) => {
        const force = /[?&]force=1(?:&|$)/u.test(String(req?.url ?? ''))
        return { growth: await collectGrowth({ force }) }
      })

      // 领取已完成的成长任务奖励。
      route('/dsh-wb2api/growth/claim', 'POST', async (req) => {
        const body = await readBody(req)
        return { result: await runDailyActivity('growth', typeof body?.uid === 'string' ? body.uid : '') }
      })

      // 每个账号的剩余积分。走 60 秒缓存；`?force=1` 绕过缓存直接打上游。
      route('/dsh-wb2api/credits', 'GET', async (req) => {
        const force = /[?&]force=1(?:&|$)/u.test(String(req?.url ?? ''))
        return { credits: await collectCredits({ force }) }
      })

      /**
       * 任务引擎路径与单轮运行状态。
       *
       * 引擎就是本项目（`engine/`，与 CLI 共用一份）里的 Node 模块 —— 动作表与编排
       * 都在那边，不在这里重写一份，免得两边逻辑分叉。
       * 路径可用环境变量 WB_TASKS_ENGINE 覆盖。
       *
       * 状态必须是 `let` 且挂在这一层：一轮运行跨多次客户端轮询，
       * 路由闭包共享同一个对象；用 `const` 改不了，用局部变量轮询就看不到了。
       */
      const TASKS_ENGINE = resolveTasksEngine()
      let taskRun = { running: false, startedAt: 0, finishedAt: 0, pending: null, summary: null, error: '', logs: [] }

      // ── 成长任务自动化：一键做任务（本项目内引擎，不在插件里重复实现）──────
      // 引擎路径：包内 engine/wb_up/run.mjs（Go 版 autotask 的移植）。
      // 流程严格按「确认 → 执行 → 自动领取」：先扫一遍有没有待办，没有就直接收工，
      // 有才跑动作（两轮：上游计分是异步的，第一轮上报、第二轮才落账领奖）。
      route('/dsh-wb2api/tasks/status', 'GET', async () => ({
        running: taskRun.running,
        startedAt: taskRun.startedAt,
        finishedAt: taskRun.finishedAt,
        pending: taskRun.pending,
        summary: taskRun.summary,
        error: taskRun.error,
        logs: taskRun.logs.slice(-120),
      }))

      route('/dsh-wb2api/tasks/run', 'POST', async (req) => {
        const body = await readBody(req)
        if (taskRun.running) return { started: false, running: true, message: '已有一轮任务在执行中，等它跑完再点。' }
        const uid = typeof body?.uid === 'string' ? body.uid : ''
        const only = Array.isArray(body?.only) ? body.only.filter((code) => typeof code === 'string') : []
        const passes = Number.isSafeInteger(body?.passes) && body.passes > 0 ? Math.min(4, body.passes) : 2
        const push = (line) => {
          taskRun.logs.push(String(line))
          if (taskRun.logs.length > 400) taskRun.logs.shift()
        }
        taskRun = { running: true, startedAt: Date.now(), finishedAt: 0, pending: null, summary: null, error: '', logs: [] }
        // 后台跑：宿主事件循环不能被一次几分钟的任务动作占住（fetch 全是异步的，不阻塞）。
        void (async () => {
          try {
            const engine = await import(pathToFileURL(TASKS_ENGINE).href)
            push('确认中：拉取各账号成长任务…')
            const scanned = await engine.scanPendingTasks({ selector: uid, includeAttempt: true, onLog: push })
            taskRun.pending = {
              total: scanned.total,
              accounts: scanned.accounts.map((row) => ({ uid: row.uid, nickname: row.nickname, pending: row.pending })),
            }
            if (scanned.total === 0) {
              push('确认结果：没有待办任务（该领的都已经领了）')
            } else {
              push(`确认结果：待办 ${scanned.total} 项，开始执行`)
              const summary = await engine.runAutomation({ selector: uid, only, passes, includeAttempt: true, onLog: push })
              taskRun.summary = {
                totals: summary.totals,
                accounts: summary.accounts.map((row) => ({
                  uid: row.uid,
                  nickname: row.nickname,
                  credit: row.credit,
                  energy: row.energy,
                  executed: row.executed,
                  claimed: row.claimed.map((item) => ({ code: item.code, credit: item.credit, energy: item.energy })),
                  errors: row.errors.map((item) => ({ code: item.code, message: item.message })),
                })),
              }
            }
          } catch (error) {
            taskRun.error = error instanceof Error ? error.message : String(error)
            push(`执行失败：${taskRun.error}`)
          } finally {
            taskRun.running = false
            taskRun.finishedAt = Date.now()
          }
        })()
        return { started: true, running: true }
      })

      // 申请授权链接。
      route('/dsh-wb2api/login/begin', 'POST', async (req) => {
        const body = await readBody(req)
        const realm = body?.realm === 'global' ? 'global' : 'cn'
        const state = await loginBegin(realm)
        ctx.logger?.info?.(`[wb2api-ui] 授权链接（${realm}）：${state.authUrl}`)
        return { realm, ...state }
      })

      // 轮询授权结果；上游没认账时返回 202 + pending。
      route('/dsh-wb2api/login/poll', 'POST', async (req) => {
        const body = await readBody(req)
        const realm = body?.realm === 'global' ? 'global' : 'cn'
        if (typeof body?.state !== 'string' || body.state === '') throw new Error('缺少 state。')
        return { account: await loginPoll(realm, body.state) }
      })

      // 上传 / 粘贴凭证 JSON（单个对象或对象数组）。
      route('/dsh-wb2api/import', 'POST', async (req) => {
        const body = await readBody(req)
        let parsed
        if (typeof body?.raw === 'string') {
          try {
            parsed = JSON.parse(body.raw)
          } catch (error) {
            throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
          }
        } else if (body?.document !== undefined) {
          parsed = body.document
        } else {
          throw new Error('需要 raw（JSON 文本）或 document（对象）。')
        }
        const items = Array.isArray(parsed) ? parsed : [parsed]
        if (items.length === 0) throw new Error('没有可导入的凭证。')
        const imported = []
        for (const item of items) {
          const document = normalizeDocument(item)
          const file = writeAuthDocument(document)
          imported.push({
            uid: document.account.uid,
            nickname: document.account.nickname,
            realm: document.auth.realm,
            file: basename(file),
          })
        }
        return { imported }
      })

      // 启用 / 禁用 —— admin API 优先（热切换，文件名不动），旧配置回退改名。
      route('/dsh-wb2api/account/toggle', 'POST', async (req) => {
        const body = await readBody(req)
        const mode = await setAccountEnabledAdaptive(String(body?.file ?? ''), body?.enabled === true)
        return { accounts: await listAccountsMerged(), mode }
      })

      /**
       * 「切换到某个账号」—— 只让它承接调用，其余暂停；`file` 传空串恢复全部。
       *
       * WorkDaddy 式热切换：**所有账号都留在池里**，被切走的只是
       * `manual_disabled`（网关调度器不派请求给它，但 token 照常刷新、
       * 文件名一个字节不动）。实现优先走网关原生 admin API
       * （`POST /admin/accounts/{uid}/enable|disable`，进程内即时生效，
       * 没有「网关把凭证写回旧路径」的改名竞态）；admin 不可用（旧配置 /
       * 网关没起）才回退到官方插件的改名机制。
       */
      route('/dsh-wb2api/account/only', 'POST', async (req) => {
        const body = await readBody(req)
        const keepFile = typeof body?.file === 'string' ? body.file : ''
        // 校验基准必须是池里的真 uid（裸 uuid）—— 文件名 stem 带 `workbuddy-` 前缀，
        // 拿它跟 account.uid 比会永远不等，切换成功也报「未确认」（2026-09-28 修）。
        const keepUid = keepFile === '' ? '' : readCredential(keepFile)?.uid ?? parseAuthFileName(keepFile)?.uid ?? ''

        const accounts = listAccounts()
        const modes = []
        for (const account of accounts) {
          const want = keepFile === '' || account.file === keepFile
          const mode = await setAccountEnabledAdaptive(account.file, want).catch(() => 'error')
          if (mode !== 'noop') modes.push(`${account.file}:${mode}`)
        }

        // 校验：admin 模式看池里的 manual_disabled，改名模式看文件后缀。
        let verified = true
        const warnings = []
        if (adminConfigured()) {
          try {
            const pool = await fetchPoolStatus()
            for (const account of accounts) {
              const row = pool.accounts.find((item) => item.uid === account.uid)
              if (row === undefined) continue
              const should = keepUid === '' || account.uid === keepUid
              if (row.manualDisabled === should) verified = false
            }
          } catch {
            // 池状态读不到就不校验 —— 切换动作本身已经发出去了。
          }
        }
        if (!verified) warnings.push('部分账号的轮换状态未确认（网关可能刚重启），刷新面板再看一眼。')

        return { accounts: await listAccountsMerged(), only: keepFile, verified, warnings, modes }
      })

      // 删除。
      route('/dsh-wb2api/account/delete', 'POST', async (req) => {
        const body = await readBody(req)
        rmSync(resolveAuthFile(body?.file), { force: true })
        return { accounts: listAccounts() }
      })

      ctx.logger?.info?.('[wb2api-ui] 面板路由已挂载：/dsh-wb2api/*')
    }, 'dsh-plugin-wb2api-ui: http routes')
  })
}

// ---------------------------------------------------------------------------
// 对外导出（供仓库内工具 / 测试复用）
// ---------------------------------------------------------------------------

/**
 * DSH 加载插件时只取 `name` / `inject` / `apply`，多导出的纯函数不影响加载。
 *
 * 单独导出是为了让 CLI 批量导入（`tools/import_wb2api_accounts.mjs`）走与设置
 * 面板**完全相同**的归一化和落盘逻辑 —— 两处各写一份迟早会漂移。
 */
export {
  normalizeDocument, toUnixSeconds, inferRealm, listAccounts, authDir, ensureAuthDir, writeAuthDocument,
  readCredential, fetchCreditsFor, collectCredits,
  fetchPoolStatus, runDailyActivity, checkinAccount, classifyCheckin, tokenIssuerOrigin, localDay,
  collectGrowth, fetchGrowthStatus, claimGrowthRewards,
}
