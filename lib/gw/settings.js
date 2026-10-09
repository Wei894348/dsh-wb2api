/**
 * 后端服务的配置层：默认值、归一化、以及给「设置 → 模型」用的命名空间。
 *
 * 配置不是从 settings.yaml 读的，而是 cordis 组合层里插件行上的 config ——
 * 也就是 profile 补丁里 `- id: wb2api-gateway` 那一段。网关进程自己的
 * `~/.dsh/wb2api/config.json` 是另一套东西（网关侧权威），这里只管插件侧行为。
 */

/** LLM provider id。改名会让已有的模型预设和 settings 全部失联，不要动。 */
export const PROVIDER = 'workbuddy2api'

/** 注册给设置页的命名空间。模型设置页要求它真实存在，否则 provider 路由处会崩。 */
export const SETTINGS_NS = 'llm-workbuddy2api'

/** 网关 OpenAI 兼容端点根。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:7863/v1'

/** 预编译产物的发布仓库（只在本地缺二进制、且允许下载时才用到）。 */
const DEFAULT_RELEASE_REPO = 'Wei894348/dsh-wb2api'

export const DEFAULT_CONFIG = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  apiKeyRef: 'WORKBUDDY2API_API_KEY',
  binaryPath: '',
  repoPath: '',
  workingDir: '',
  listenPort: 7863,
  autoStart: true,
  realmPrefixPolicy: 'strip-cn',
  modelsTtlSeconds: 600,
  requestTimeoutSeconds: 600,
  idleTimeoutSeconds: 300,
  firstTokenTimeoutSeconds: 120,
  healthTimeoutSeconds: 3,
  graceMs: 5000,
  crashRestartLimit: 3,
  env: {},
  binaryReleaseRepo: DEFAULT_RELEASE_REPO,
  binaryReleaseBase: '',
  autoDownloadBinary: false,
  defaultRealm: '',
})

/**
 * 把组合层传进来的原始对象并到默认值上。
 *
 * 只接受「已声明且在默认值里有同名键」的字段：拼错的键静默生效是最难查的一类 bug，
 * 这里宁可忽略。数值字段做下限收敛，避免 0 / 负数把超时和预算算成「立刻超时」。
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULT_CONFIG }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in input)) continue
    const value = input[key]
    if (value === undefined || value === null) continue
    out[key] = value
  }
  out.baseURL = normalizeBaseURL(out.baseURL)
  out.listenPort = positiveInt(out.listenPort, DEFAULT_CONFIG.listenPort)
  out.modelsTtlSeconds = positiveInt(out.modelsTtlSeconds, DEFAULT_CONFIG.modelsTtlSeconds)
  out.requestTimeoutSeconds = positiveInt(out.requestTimeoutSeconds, DEFAULT_CONFIG.requestTimeoutSeconds)
  out.idleTimeoutSeconds = positiveInt(out.idleTimeoutSeconds, DEFAULT_CONFIG.idleTimeoutSeconds)
  out.firstTokenTimeoutSeconds = positiveInt(out.firstTokenTimeoutSeconds, DEFAULT_CONFIG.firstTokenTimeoutSeconds)
  out.healthTimeoutSeconds = positiveInt(out.healthTimeoutSeconds, DEFAULT_CONFIG.healthTimeoutSeconds)
  out.graceMs = positiveInt(out.graceMs, DEFAULT_CONFIG.graceMs)
  out.crashRestartLimit = Math.max(0, positiveInt(out.crashRestartLimit, DEFAULT_CONFIG.crashRestartLimit))
  out.env = out.env && typeof out.env === 'object' && !Array.isArray(out.env) ? { ...out.env } : {}
  out.realmPrefixPolicy = out.realmPrefixPolicy === 'keep' ? 'keep' : 'strip-cn'
  out.defaultRealm = String(out.defaultRealm ?? '').trim().toLowerCase()
  if (out.defaultRealm !== 'cn' && out.defaultRealm !== 'global') out.defaultRealm = ''
  return out
}

/** 去掉尾部斜杠，保证拼接端点时不会出现 `//v1`。 */
function normalizeBaseURL(value) {
  const text = String(value ?? '').trim()
  const trimmed = text.replace(/\/+$/, '')
  return trimmed || DEFAULT_BASE_URL
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** `/v1` 之外的那一层：健康检查打在这里。 */
export function gatewayOrigin(baseURL) {
  return String(baseURL ?? '').replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

/** 端口：显式配了用显式的，否则从 baseURL 里抠。 */
export function gatewayPort(config) {
  if (config?.listenPort) return config.listenPort
  const match = /:(\d+)(?:\/|$)/.exec(String(config?.baseURL ?? ''))
  return match ? Number(match[1]) : DEFAULT_CONFIG.listenPort
}

/**
 * 设置页命名空间的 schema。
 *
 * 两个坑（都是实测出来的）：
 * 1. 必须是 `Schema.object({...})`，传裸函数会让 `describe()` 抛
 *    `registration.schema.toJSON is not a function`，连带模型设置页、主题、sidebar 全挂；
 * 2. 不注册这个 namespace，模型设置页在 `deriveKeyRef(provider)` 处会
 *    `provider.toUpperCase is not a function`。
 *
 * 所以这里没有任何真正要用户填的东西 —— 它只是给设置页一个合法地址。
 */
export function settingsSchema(Schema) {
  return Schema.object({
    providers: Schema.dict(Schema.any()).default({}),
  })
}
