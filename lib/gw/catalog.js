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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 网关认可的 realm 前缀。大小写敏感：只有恰好等于这两者才当前缀。 */
const REALM_PREFIXES = new Set(['cn', 'global'])

/** 没有前缀时的默认归属：裸名一律按 CN 处理（网关默认集合就是 CN）。 */
const DEFAULT_REALM = 'cn'

/** 目录缓存默认 5 分钟：网关会随账号池变化增减模型，太久不刷新会看到幽灵模型。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** context_length 缺失或非正数时的兜底窗口，宁可放大也不能让上游把长上下文截断。 */
const FALLBACK_CONTEXT_WINDOW = 1_000_000

/**
 * 网关没给档位数组时的兜底阶梯。
 *
 * 依据是目录里 47 条**自带** `reasoning_supported_efforts` 的模型，绝大多数就是这三档；
 * 用它补齐「只报标量」的模型，是为了让配置里的 `reasoningEffort: high` 永远能在
 * 模型声明里找到落点 —— 找不到的后果不是报错可见，而是 dsh 静默换模型。
 */
const REASONING_EFFORT_LADDER = Object.freeze(['low', 'high', 'max'])

/** 供 chat.js 的「目录未命中」兜底复用同一条阶梯。 */
export const reasoningEffortLadder = () => [...REASONING_EFFORT_LADDER]

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
 * 模型是否接受图片输入。
 *
 * 网关这份目录对能力的写法不统一：布尔 `supports_images`、字符串 `"true"` / `"1"`、
 * 也可能只给 `input_modalities: ['text','image']`。只认严格的 `=== true` 会把能看图的
 * 模型判成纯文本 —— dsh 随即把图片从消息里摘掉，用户侧的表现是「图发出去了，
 * 模型完全没反应」。
 *
 * @param {object} source 网关原始条目
 * @returns {boolean}
 */
function acceptsImages (source) {
  const flag = source?.supports_images
  if (flag === true || flag === 1 || flag === 'true' || flag === '1') return true
  if (Array.isArray(source?.input_modalities)) return source.input_modalities.includes('image')
  if (Array.isArray(source?.inputModalities)) return source.inputModalities.includes('image')
  return false
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
    // 显式否定，不给 unknown 留位置。
    // 三种写法都要认：布尔 `true`、字符串 `"true"`（网关个别版本把它序列化成字符串）、
    // 以及 `input_modalities: ['text','image']` 这种数组形态。只认布尔时，一个字符串
    // `"true"` 就足以让 dsh 认为该模型是纯文本 —— 用户贴的图会在进适配器之前被丢掉，
    // 表现是「模型完全看不到图片」，而目录看起来完全正常。
    inputModalities: acceptsImages(source) ? ['text', 'image'] : ['text'],
    // 积分倍率（2026-10-21 修复回归）：网关 /v1/models 带 credits_mult（"0.29x"），
    // 模型下拉展示"国内版 名字 0.29x"靠它 —— 1.5.8 基线曾漏搬此字段。
    ...(typeof source.credits_mult === 'string' && source.credits_mult !== '' ? { creditsMult: source.credits_mult } : {}),
  }

  const maxOut = normalizePositiveInt(source.max_output_tokens, 0)
  if (maxOut > 0) model.defaultMaxTokens = maxOut

  // 网关上「思考档位」有两套写法：
  //   · 新探测：`reasoning_supported_efforts: ['low','high','max']`（可枚举，直接用）
  //   · 旧探测：只有标量 `reasoning_effort: "high"` / `reasoning_default_effort`（没有数组）
  // 只认数组会让后一类模型（实测 76 条里 29 条）在 dsh 侧**完全没有 reasoning 声明**，
  // dsh 随即认定该模型不支持配置里的 reasoningEffort 并抛 UNSUPPORTED_REASONING_EFFORT，
  // 整轮请求被静默换到别的模型 —— 表现是「人格层/系统提示莫名失效」，实为模型被换掉。
  // 所以标量形态必须补齐：有默认档就认它，没有就按目录里多数模型的档位阶梯兜底。
  let efforts = Array.isArray(source.reasoning_supported_efforts)
    ? source.reasoning_supported_efforts.filter((x) => typeof x === 'string' && x)
    : []
  let defaultEffort = source.reasoning_default_effort
  if (efforts.length === 0 && (source.supports_reasoning === true || source.only_reasoning === true)) {
    efforts = [...REASONING_EFFORT_LADDER]
    if (typeof defaultEffort !== 'string' || !efforts.includes(defaultEffort)) {
      defaultEffort = typeof source.reasoning_effort === 'string' && efforts.includes(source.reasoning_effort)
        ? source.reasoning_effort
        : 'high'
    }
  }
  if (efforts.length > 0) {
    const reasoning = { efforts }
    // 默认档必须落在 efforts 里，否则 dsh 会拿一个不存在的档位去发请求
    if (typeof defaultEffort === 'string' && efforts.includes(defaultEffort)) {
      reasoning.defaultEffort = defaultEffort
    }
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
/**
 * 先规整网关的原始条目，再交给 mapModel。
 *
 * 两个真实事故都出在这一步（2026-10-27 排查「国际模型跑到国内版里 / 模型少了 /
 * 下拉点不动」）：
 *
 *  1. 网关对**只有单一 realm 可用**的模型会吐裸名（没有 `cn:` / `global:` 前缀）。
 *     裸名一律按 CN 处理，于是国际模型被标成「国内版」。
 *  2. 同一模型既有带前缀条目、又有裸名条目时（两次探测时机不同），裸名会与
 *     `cn:<同名>` 撞进同一个 id，去重后**少一条** —— 用户看到的是「模型没有了」。
 *
 * 所以：带前缀的条目是权威；裸名若与 `cn:` 同名就丢弃，只有与 `global:` 同名
 * 才归到国际版。
 *
 * @param {Array<object>} list 网关 /v1/models 的 data
 * @returns {Array<object>} 每条都带 `realm:bareId` 形态的 id
 */
export function normalizeRawCatalog (list) {
  const rows = Array.isArray(list) ? list : []
  const prefixed = new Set()
  for (const raw of rows) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    if (!id) continue
    const { realm, bareId } = parseModelId(id)
    if (bareId !== id) prefixed.add(`${realm}:${bareId}`)
  }
  const out = []
  for (const raw of rows) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    if (!id) continue
    const { bareId } = parseModelId(id)
    if (bareId !== id) {
      out.push(raw)
      continue
    }
    const hasCn = prefixed.has(`cn:${bareId}`)
    const hasGlobal = prefixed.has(`global:${bareId}`)
    // 只要**任一带前缀的同名条目**已经存在，裸名就是同一模型的重复上报，丢掉：
    // 留着它只会让同一个 id 出现两次（字段还会随探测时机抖动）。「裸名 + global
    // 同名」这一种正是国际模型被错标成国内版的来源。
    if (hasCn || hasGlobal) continue
    // 真正只有裸名的模型（网关没给前缀）：按 CN 归属，这是网关的默认集合。
    out.push({ ...raw, id: `${DEFAULT_REALM}:${bareId}` })
  }
  return out
}

export function mapModelCatalog (list, policy = 'keep') {
  const byId = new Map()
  for (const raw of normalizeRawCatalog(list)) {
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
    /** 落盘快照路径（可选）：冷启动先用它顶上，避免「下拉里一个模型都没有」。 */
    this.snapshotPath = options.snapshotPath || null

    /** 最近一次拉取的错误（成功时置空），UI 可以直接读它渲染告警 */
    this.lastError = null

    this._cache = null // { at: number, models: object[], byId: Map, byBare: Map, byRealmBare: Map }
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
    // 冷启动兜底：内存里一条都没有时，先用落盘快照顶上。否则网关还没起、
    // 或目录接口 401 的瞬间，listModels() 会拿到空列表 —— 表现就是
    // 「模型下拉一个都选不了，重启网关也没用」（宿主侧只会再抛一次）。
    if (!this._cache && this.snapshotPath) this._loadSnapshot()
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
   *
   * 两种名字都要能查到：展示用的裸名（`deepseek-v4.1-flash`），以及带 realm 的
   * 完整 id（`cn:deepseek-v4.1-flash` / `global:xxx`）—— 后者来自用户手填、
   * 老配置、脚本写入或别人给的配置片段，不能假设调用方一定用展示名。
   *
   * 关键：**strip-cn 策略下 byId 里存的也是裸名**，所以 `cn:xxx` 直接查一定落空。
   * 这条兜底不是可选项：`resolveModel()` 查不到时会返回一个**不带 reasoning
   * 字段**的兜底对象，dsh 的 `resolveCallWithInfo()` 随即认定"该模型不支持
   * reasoningEffort"并抛 `UNSUPPORTED_REASONING_EFFORT`，整轮请求被换到别的
   * 模型 —— 表面看像"系统提示/人格层莫名失效"，实为模型被换掉了。
   *
   * @param {string} idOrBareId
   * @returns {object|undefined} 找不到返回 undefined
   */
  find (idOrBareId) {
    if (!idOrBareId || !this._cache) return undefined
    const key = String(idOrBareId)
    const hit = this._cache.byId.get(key) ?? this._cache.byBare.get(key)
    if (hit) return hit
    // 归一化兜底：`cn:deepseek-v4.1-flash` → 裸名索引里那条**同 realm** 的。
    // 走 byRealmBare 而不是宽泛地按裸名找，避免 `cn:xxx` 误配到 `global:xxx`。
    const { realm, bareId } = parseModelId(key)
    if (!bareId || bareId === key) return undefined
    return this._cache.byRealmBare.get(`${realm}:${bareId}`)
  }

  /** 把模型数组建成三张索引 —— 线上拉取与落盘快照共用同一份逻辑。 */
  _index (models, at) {
    const byId = new Map()
    const byBare = new Map()
    const byRealmBare = new Map()
    for (const m of models) {
      if (!m || typeof m.id !== 'string' || m.id === '') continue
      byId.set(m.id, m)
      if (!byBare.has(m.bareId)) byBare.set(m.bareId, m)
      const realmKey = `${m.realm}:${m.bareId}`
      if (!byRealmBare.has(realmKey)) byRealmBare.set(realmKey, m)
    }
    return { at: Number.isFinite(at) ? at : Date.now(), models, byId, byBare, byRealmBare }
  }

  /**
   * 冷启动先读落盘快照。
   *
   * 为什么需要：网关没起来 / 目录接口 401 / dsh 比网关先启动时 `_load()` 会抛错，
   * `listModels()` 于是拿到空列表 —— 用户看到的是「模型下拉里一个都选不了，
   * 重启网关也没用」（宿主侧只是把同一次失败又抛了一遍，目录永远补不上）。
   * 快照只是兜底：真正拉到目录就整体覆盖。
   */
  _loadSnapshot () {
    try {
      const parsed = JSON.parse(readFileSync(this.snapshotPath, 'utf8'))
      const models = Array.isArray(parsed?.models) ? parsed.models : []
      if (models.length === 0) return
      this._cache = this._index(models, Number(parsed.at) || 0)
    } catch { /* 没有快照或已损坏：当作没有 */ }
  }

  /** 写落盘快照（原子替换）；失败不影响主流程。 */
  _writeSnapshot (models) {
    if (!this.snapshotPath) return
    try {
      mkdirSync(dirname(this.snapshotPath), { recursive: true })
      const tmp = `${this.snapshotPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ at: Date.now(), models }), 'utf8')
      renameSync(tmp, this.snapshotPath)
    } catch { /* 快照是可选的 */ }
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

      this._cache = this._index(models, Date.now())
      this._writeSnapshot(models)
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
