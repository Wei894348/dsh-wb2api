/**
 * 读 WorkBuddy 桌面端的登录态（`workbuddy-desktop*.info`），供宿主的
 * `POST /dsh-wb2api/adopt-desktop` 在面板里一键接管。
 *
 * 桌面端 5.6.0+ 把 accessToken / refreshToken / nickname 写成 `$wbEncrypted`
 * 信封（AES-256-GCM + 字段级 AAD）。字段密钥不是用户秘密：它是 Electron 原生
 * 模块 `electron_browser_workbuddy_storage` 的 `loggerGet()` 返回值，
 * key = sha256(atRestSecretKey 的 base64 字符串)，keyId = sha256(key).hex[:16]。
 *
 * 这份逻辑原来只在 `tools/wb_import.mjs` 里（CLI 用）。搬到 `lib/` 是因为
 * **`tools/` 不进 npm 包**（package.json 的 files 里没有它），装到 profile 里的
 * 副本根本没有那个脚本 —— 面板里的「桌面端」一档就没法自己跑。现在两边共用这一份：
 * 面板走宿主路由，CLI 仍可 `node tools/wb_import.mjs --write`。
 *
 * 安全边界：只读本机文件 + 只把结果交给调用方；不打印 token，不写日志。
 */
import { createHash, createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
const FRAMING_FIELD = 2
const FORMAT_FIELD = 'WBEV1'
const SCHEME = 'sym-v1'

const u32 = (value) => { const buffer = Buffer.allocUnsafe(4); buffer.writeUInt32BE(value); return buffer }
const lp = (value) => { const buffer = Buffer.from(value, 'utf8'); return Buffer.concat([u32(buffer.length), buffer]) }
const fieldAad = (keyId, suite) => Buffer.concat([
  AAD_DOMAIN, Buffer.from([1]), lp(FORMAT_FIELD), lp(SCHEME),
  u32(suite), lp(keyId), Buffer.from([FRAMING_FIELD]), Buffer.from([0]), Buffer.from([0]),
])
const keyIdOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16)
const isWrapper = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && value.$wbEncrypted === 1 && typeof value.envelope === 'string'

function deriveKey(payloadJson) {
  const payload = JSON.parse(payloadJson)
  if (typeof payload.atRestSecretKey !== 'string') throw new Error('payload 里没有 atRestSecretKey')
  return createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest()
}

function openField(field, key) {
  const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  const expect = keyIdOf(key)
  if (envelope.keyId !== expect) throw new Error(`keyId 不匹配：信封 ${envelope.keyId} ≠ 本机密钥 ${expect}`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(envelope.keyId, envelope.suite))
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

/** 深度解密：把所有 `$wbEncrypted` 信封就地换成明文。 */
function deepDecrypt(value, key) {
  if (isWrapper(value)) return openField(value, key)
  if (Array.isArray(value)) return value.map((item) => deepDecrypt(item, key))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [name, item] of Object.entries(value)) out[name] = deepDecrypt(item, key)
    return out
  }
  return value
}

/** 桌面端安装位置：先看环境变量，再看这台机器的两个常见路径。 */
export function desktopExeCandidates() {
  const fromEnv = typeof process.env.WB2API_DESKTOP_EXE === 'string' ? process.env.WB2API_DESKTOP_EXE.trim() : ''
  return [
    ...(fromEnv === '' ? [] : [fromEnv]),
    'F:\\Softstore\\WorkBuddy\\WorkBuddy.exe',
    'F:\\Softstore\\WorkBuddyAI\\WorkBuddyAI.exe',
  ].filter((path) => path !== '' && existsSync(path))
}

/** 桌面端把登录态落在这些目录（5.6.0+ 是 CodeBuddyExtension/Data/Public/auth）。 */
export function desktopAuthDirs() {
  const dirs = []
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  for (const root of [local, roaming]) {
    const dir = join(root, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    if (existsSync(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * 问桌面端要字段密钥载荷。
 *
 * `loggerGet()` 只有 Electron 原生模块能给，所以只能借桌面端自己的 exe 跑一小段
 * 脚本（`ELECTRON_RUN_AS_NODE=1`）。载荷不是凭据，但仍缓存到本机临时目录，
 * 免得每次点「桌面端」都起一次进程。
 */
export function desktopKeyPayload(cacheFile = join(tmpdir(), 'wb2api-wb-key.json')) {
  if (existsSync(cacheFile)) {
    try {
      const cached = readFileSync(cacheFile, 'utf8').trim()
      if (cached.includes('atRestSecretKey')) return cached
    } catch { /* 读不到就当没有缓存 */ }
  }
  const script = "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
  const tried = []
  for (const exe of desktopExeCandidates()) {
    tried.push(exe)
    try {
      const out = execFileSync(exe, ['-e', script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1 << 20,
      }).trim()
      if (out.includes('atRestSecretKey')) {
        try {
          mkdirSync(dirname(cacheFile), { recursive: true })
          writeFileSync(cacheFile, out, 'utf8')
        } catch { /* 缓存写不进去不影响本次 */ }
        return out
      }
    } catch { /* 换下一个候选 */ }
  }
  throw new Error(`没能从桌面端取到字段密钥（试过：${tried.join('、') || '无可用路径'}）`)
}

/**
 * 扫描桌面端登录态，按 uid 取"最好的一份"（live > 最近刷新 > 最长有效期）。
 *
 * @returns {Array<{uid:string,nickname:string,enterpriseId:string,domain:string,realm:'cn'|'global',
 *   expiresAt:number,lastRefresh:number,accessToken:string,refreshToken:string,live:boolean,source:string}>}
 */
export function readDesktopSessions(options = {}) {
  const cacheFile = options.cacheFile ?? join(tmpdir(), 'wb2api-wb-key.json')
  const key = deriveKey(desktopKeyPayload(cacheFile))
  const seen = new Map()
  for (const dir of desktopAuthDirs()) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.info')) continue
      let document
      try {
        document = deepDecrypt(JSON.parse(readFileSync(join(dir, name), 'utf8')), key)
      } catch { continue }
      const auth = document?.auth ?? document ?? {}
      const account = document?.account ?? document ?? {}
      if (typeof auth.accessToken !== 'string' || auth.accessToken === '') continue
      if (typeof account.uid !== 'string' || account.uid === '') continue
      const live = name === 'workbuddy-desktop.info' || name === 'workbuddy-desktop-ai.info'
      const domain = typeof auth.domain === 'string' ? auth.domain : ''
      const candidate = {
        uid: account.uid,
        nickname: typeof account.nickname === 'string' ? account.nickname : '',
        enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : '',
        domain,
        realm: /(^|\.)workbuddy\.ai$/u.test(domain.toLowerCase()) ? 'global' : 'cn',
        // 桌面端存毫秒，网关与账号池用秒 —— 必须归一化，否则会写出一个 5.6 万年后的过期时间。
        expiresAt: typeof auth.expiresAt === 'number'
          ? (auth.expiresAt > 1e12 ? Math.floor(auth.expiresAt / 1000) : auth.expiresAt)
          : 0,
        lastRefresh: typeof auth.lastRefreshTime === 'number' ? auth.lastRefreshTime : 0,
        accessToken: auth.accessToken,
        refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
        live,
        source: join(dir, name),
      }
      const previous = seen.get(candidate.uid)
      if (previous === undefined
        || (candidate.live && !previous.live)
        || (candidate.live === previous.live && candidate.lastRefresh > previous.lastRefresh)
        || (candidate.live === previous.live && candidate.lastRefresh === previous.lastRefresh && candidate.expiresAt > previous.expiresAt)) {
        seen.set(candidate.uid, candidate)
      }
    }
  }
  return [...seen.values()]
}
