/**
 * 网关模型目录（catalog）
 *
 * 网关在 http://127.0.0.1:7863/v1 提供 OpenAI 兼容接口，GET /v1/models 返回
 *   { data: [ { id, context_length, max_output_tokens?, supports_images?,
 *              reasoning_supported_efforts?, reasoning_default_effort? } ] }
 * 模型 id 形如 `cn:deepseek-v4` / `global:claude-x` / 裸名 `deepseek-v4`。
 *
 * 本模块负责三件事：
 *   1. 解析 id 的 realm 前缀（cn / global / 裸名）；
 *   2. 把网关原始条目映射成 dsh 侧的模型描述对象（字段语义见 mapModel）；
 *   3. 带 TTL 的目录缓存，拉取失败时保住上一次的结果，不让 provider 断供。
 *
 * 只依赖 Node 标准库能力（globalThis.fetch），无第三方依赖。
 */

/** 网关认可的 realm 前缀。大小写敏感：只有恰好等于这两者才当前缀。 */
const REALM_PREFIXES = new Set(['cn', 'global'])

/** 没有前缀时的默认归属：裸名一律按 CN 处理（网关默认集合就是 CN）。 */
const DEFAULT_REALM = 'cn'

/** 目录缓存默认 5 分钟：网关会随账号池变化增减模型，太久不刷新会看到幽灵模型。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** context_length 缺失或非正数时的兜底窗口，宁可放大也不能让上游把长上下文截断。 */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

/**
 * 解析模型 id 的 realm 前缀。
 *
 * 规则：取第一个 `:`；前段必须恰好是 `cn` 或 `global` 才算 realm，否则整串视为裸名。
 * "恰好"是必须的：模型名本身可能带冒号（如 `global:claude-x:2025`），`CN:xxx` 也不是网关语义，
 * 误判会把请求打到错误的域集合上。
 *
 * @param {string} id 网关返回的模型 id
 * @returns {{ realm: string, bareId: string }}
 */
export function parseModelId (id) {
  const raw = typeof id === 'string' ? id : String(id ?? '')
  const sep = raw.indexOf(':')
  if (sep > 0) {
    const head = raw.slice(0, sep)
    const rest = raw.slice(sep + 1)
    // rest 为空说明是个 `xxx:` 悬空前缀，当成裸名交给调用方自己判错，比硬拆更安全
    if (rest && REALM_PREFIXES.has(head)) return { realm: head, bareId: rest }
  }
  return { realm: DEFAULT_REALM, bareId: raw }
}

/**
 * 还原成发给网关的 wire 形态：`<realm>:<bareId>`。
 *
 * 关键点：即使入参原本是裸名，也要补上 realm。网关的跨域粘性会话按完整 id 记账，
 * 裸名会被错误地钉回 CN 集合——global 模型会因此走错出口。所以发请求前一律过这一层。
 *
 * @param {{ realm?: string, bareId?: string }} model
 * @returns {string}
 */
export function toWireModel (model) {
  const realm = model?.realm || DEFAULT_REALM
  const bareId = model?.bareId ?? ''
  if (!bareId) return ''
  return `${realm}:${bareId}`
}

/**
 * 网关原始条目 → dsh 侧模型描述对象。
 *
 * 映射取舍：
 *  - `max_output_tokens` 缺失时**不声明** `defaultMaxTokens`：让网关按账号/套餐自行决定上限，
 *    硬填一个值会在换模型或换套餐时把输出砍短，属于我们不该替它做的决定。
 *  - `supports_images` 显式取反成 `['text']`，不写 unknown：多模态能力下游是当布尔用的，
 *    "未知"会让 UI 与路由逻辑各写一套兜底，不如在入口统一成确定值。
 *  - `reasoning` 整块要么完整声明（efforts 非空）要么完全不声明：只给档位默认值不给
 *    efforts 的话，UI 无法枚举档位，用户既改不了也看不懂当前档。
 *
 * @param {object} raw 网关 /v1/models 里的一条
 * @param {'keep'|'strip-cn'} [policy='keep'] 展示用的 id 策略
 * @returns {object|undefined} id 缺失时返回 undefined
 */
export function mapModel (raw, policy = 'keep') {
  const source = raw ?? {}
  if (!source.id) return undefined

  const { realm, bareId } = parseModelId(source.id)
  // strip-cn：CN 是绝大多数用户的默认集合，展示时省掉前缀更干净；
  // global 保留前缀，因为用户需要一眼看出这条要走海外出口。
  const visibleId = policy === 'strip-cn' && realm === 'cn' ? bareId : String(source.id)

  const model = {
    id: visibleId,
    name: visibleId,
    realm,
    bareId,
    context: { contextWindow: normalizePositiveInt(source.context_length, FALLBACK_CONTEXT_WINDOW) },
    // 显式否定，不给 unknown 留位置
    inputModalities: source.supports_images === true ? ['text', 'image'] : ['text'],
  }

  const maxOut = normalizePositiveInt(source.max_output_tokens, 0)
  if (maxOut > 0) model.defaultMaxTokens = maxOut

  const efforts = Array.isArray(source.reasoning_supported_efforts)
    ? source.reasoning_supported_efforts.filter((x) => typeof x === 'string' && x)
    : []
  if (efforts.length > 0) {
    const reasoning = { efforts }
    // 默认档必须落在 efforts 里，否则 dsh 会拿一个不存在的档位去发请求
    const want = source.reasoning_default_effort
    if (typeof want === 'string' && efforts.includes(want)) reasoning.defaultEffort = want
    model.reasoning = reasoning
  }

  return model
}

/**
 * 批量映射 + 去重。
 *
 * 网关偶尔会为同一 id 吐两条（一条带 max_output_tokens、一条不带，取决于探测时机）。
 * 重复时保留声明了 `defaultMaxTokens` 的那条（信息量更多的赢）；都没有就保留先出现的，
 * 保证顺序稳定，避免刷新目录时 UI 抖动重排。
 *
 * @param {Array<object>} list
 * @param {'keep'|'strip-cn'} [policy='keep']
 * @returns {Array<object>}
 */
export function mapModelCatalog (list, policy = 'keep') {
  const byId = new Map()
  for (const raw of Array.isArray(list) ? list : []) {
    const model = mapModel(raw, policy)
    if (!model) continue
    const prev = byId.get(model.id)
    if (!prev || (model.defaultMaxTokens && !prev.defaultMaxTokens)) byId.set(model.id, model)
  }
  return [...byId.values()]
}

/**
 * 目录缓存。
 *
 * 三个行为是刻意设计的：
 *  - 并发去重：冷启动时多个 provider 同时问目录，只发一次请求，其余共享同一个 Promise；
 *  - 失败保旧：返回空数组会让模型列表瞬间清空、用户选中项失效，所以失败时保留上一次的目录，
 *    只把错误挂到 lastError 上供 UI 提示；
 *  - force：设置页点"刷新"或账号池变更后强制绕过 TTL。
 */
export class ModelCatalog {
  /**
   * @param {object} [options]
   * @param {string} [options.baseURL] 形如 http://127.0.0.1:7863/v1
   * @param {string|(() => string|Promise<string>)} [options.apiKey]
   *   api_key 本体，或**返回它的函数**（异步也行）。密钥要走凭据库解析时传函数，
   *   每次请求现取，凭据轮换后不用重建 catalog。
   *   注意：传函数时**不能**直接拼进请求头 —— 必须 await 出字符串。
   * @param {number} [options.ttlMs]
   * @param {'keep'|'strip-cn'} [options.policy]
   * @param {typeof fetch} [options.fetchImpl] 便于测试注入
   */
  constructor (options = {}) {
    this.baseURL = options.baseURL || 'http://127.0.0.1:7863/v1'
    this.apiKey = options.apiKey ?? ''
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS
    this.policy = options.policy || 'keep'
    this.fetchImpl = options.fetchImpl || globalThis.fetch

    /** 最近一次拉取的错误（成功时置空），UI 可以直接读它渲染告警 */
    this.lastError = null

    this._cache = null // { at: number, models: object[], byId: Map, byBare: Map }
    this._pending = null // 进行中的请求，用于并发去重
  }

  /**
   * 把 `apiKey` 归一成字符串。
   *
   * 传函数就把函数调出来的值当密钥。**这里不能省** —— 直接把函数拼进
   * `Bearer ${fn}` 会得到 `Bearer () => resolveApiKey(...)`，网关按「密钥不对」
   * 回 401，而错误信息里只看得到 401，看不到密钥是谁，极难定位。
   */
  async _resolveApiKey () {
    const source = this.apiKey
    if (typeof source === 'function') {
      try {
        const value = await source()
        return typeof value === 'string' ? value : ''
      } catch {
        return ''
      }
    }
    return typeof source === 'string' ? source : ''
  }

  /** GET /v1/models 的完整地址；baseURL 带不带 /v1 都能吃。 */
  get endpoint () {
    const base = String(this.baseURL).replace(/\/+$/, '')
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
  }

  /** 缓存是否仍然新鲜（未过期）。 */
  get isFresh () {
    return !!this._cache && Date.now() - this._cache.at < this.ttlMs
  }

  /**
   * 取模型数组。
   * @param {boolean} [force=false] 跳过 TTL
   * @returns {Promise<object[]>}
   */
  async get (force = false) {
    if (!force && this.isFresh) return this._cache.models
    // 并发去重：同一时刻只发一次请求，其余调用方共享同一个 Promise
    if (this._pending) return this._pending

    const task = this._load().finally(() => {
      if (this._pending === task) this._pending = null
    })
    this._pending = task
    return task
  }

  /**
   * 按 id 或 bareId 查一条。只查已缓存的目录（同步），调用方通常先 await get()。
   * 两个入口都要支持：UI 拿到的可能是展示用的裸名，也可能是带 realm 的完整 id。
   * @param {string} idOrBareId
   * @returns {object|undefined} 找不到返回 undefined
   */
  find (idOrBareId) {
    if (!idOrBareId || !this._cache) return undefined
    const key = String(idOrBareId)
    return this._cache.byId.get(key) ?? this._cache.byBare.get(key)
  }

  async _load () {
    try {
      const key = await this._resolveApiKey()
      const headers = { accept: 'application/json' }
      if (key) headers.authorization = `Bearer ${key}`

      const res = await this.fetchImpl(this.endpoint, { method: 'GET', headers })
      if (!res.ok) throw new Error(`GET /v1/models 失败：HTTP ${res.status}`)

      const json = await res.json()
      const models = mapModelCatalog(json?.data, this.policy)

      const byId = new Map()
      const byBare = new Map()
      for (const m of models) {
        byId.set(m.id, m)
        if (!byBare.has(m.bareId)) byBare.set(m.bareId, m)
      }

      this._cache = { at: Date.now(), models, byId, byBare }
      this.lastError = null
      return models
    } catch (err) {
      this.lastError = err
      // 保住上一次的目录：宁可给用户一份可能过期的列表，也不要给空列表
      if (this._cache) return this._cache.models
      // 一次都没成功过，没有旧值可保，只能让调用方看到失败
      throw err
    }
  }
}

/** 取整正数，非数字/非正数返回兜底值。 */
function normalizePositiveInt (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export default ModelCatalog
