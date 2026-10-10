/**
 * 请求链路：dsh 的 `GenerateOptions` → OpenAI chat-completions → 网关 → SSE → `StreamChunk`。
 *
 * 这层刻意做薄：协议适配、账号池、熔断、payload 改写全在 Go 网关里，
 * 这里只负责三件事 —— 消息序列化、发流、把 SSE 翻回 harness 的 chunk。
 */

import { createRequire } from 'node:module'
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isTruncatedArguments, iterateSse } from './stream.js'
import { reasoningEffortLadder, toWireModel } from './catalog.js'

/** 探针里自报版本：用来确认「跑起来的到底是哪一版」。 */
const PKG_VERSION = (() => {
  try { return createRequire(import.meta.url)('../../package.json').version } catch { return 'unknown' }
})()

/** 探针开关：默认开（排障期），显式置 `WB2API_DUMP=0` 关。 */
function probeEnabled() {
  return process.env.WB2API_DUMP !== '0'
}

/**
 * 出站探针：把本次请求的骨架写到运行时目录（`~/.dsh/wb2api/data/inflight*.json`）。
 * 默认开启；置 `WB2API_DUMP=0` 关闭。
 *
 * 专治「网关照常 200、模型却不认人格」这类静默故障 —— 只要看两件事：
 * 入参里 system 条目的长度，和出站 messages 的 role 序列。人格在半路被吃掉时，
 * 这两项会直接对不上，不用再去猜是模型还是提示词的问题。
 */
async function dumpProbe(options, body) {
  if (!probeEnabled()) return
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { homedir } = await import('node:os')
    const dir = process.env.WB2API_DUMP_DIR || join(homedir(), '.dsh', 'wb2api', 'data')
    mkdirSync(dir, { recursive: true })
    const summarize = (m) => {
      const raw = JSON.stringify(m?.content ?? '')
      return {
        role: m?.role,
        shape: Array.isArray(m?.content) ? 'array' : typeof m?.content,
        chars: raw.length,
        head: raw.slice(0, 100),
      }
    }
    const name = typeof options?.purpose === 'string' && options.purpose.length > 0
      ? `inflight-${options.purpose}.json`
      : 'inflight.json'
    writeFileSync(join(dir, name), JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      version: PKG_VERSION,
      purpose: options?.purpose ?? null,
      inbound: {
        model: options?.model,
        systemField: typeof options?.system,
        systemChars: typeof options?.system === 'string' ? options.system.length : null,
        toolCount: Array.isArray(options?.tools) ? options.tools.length : null,
        messages: (options?.messages ?? []).map(summarize),
      },
      outbound: {
        model: body.model,
        messages: (body.messages ?? []).map(summarize),
      },
    }, null, 2))
  } catch { /* 探针不能影响主流程 */ }
}

/** 模型没声明上下文窗口时的兜底。 */
export const CONTEXT_WINDOW_FALLBACK = 1_000_000

/** 工具参数为空串时补的对象（无参工具是合法的）。 */
const EMPTY_ARGUMENTS = '{}'

export class GatewayChat extends LlmAdapter {
  /**
   * @param {object} options
   * @param {string} options.providerId
   * @param {string} options.baseURL          形如 http://127.0.0.1:7863/v1
   * @param {() => (string|Promise<string>)} options.apiKeyResolver
   * @param {object} options.catalog          ModelCatalog 实例
   * @param {object} [options.attachments]    dsh 附件服务，提供 readImage()
   * @param {object} options.config           归一化配置（取超时用）
   * @param {typeof fetch} [options.fetchImpl]
   * @param {object} [options.logger]
   */
  constructor(options) {
    super()
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * provider 描述。dsh 会校验 `info.id === provider`，且模型设置页会对 id 调
   * `toUpperCase()` —— 所以这里对入参做防御性归一化，别让 undefined 漏出去。
   */
  providerInfo(provider) {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.options.providerId
    return { id, name: 'WorkBuddy (workbuddy2api 网关)' }
  }

  async listModels(_provider) {
    const models = await this.options.catalog.get()
    return models.map((model) => this.toModelInfo(model))
  }

  /**
   * 契约要求「不校验请求路由」：模型不在目录里也必须返回 identity，
   * 所以未命中时回退裸 id + 兜底窗口，不抛错。
   */
  async resolveModel(provider, model, _signal) {
    const found = await this.options.catalog.find(model)
    if (!found) {
      // 目录里没有这条（用户手填了模型名、目录还没拉到、账号池刚变更）。
      // 这里**必须**照样声明 reasoning 档位：漏掉它 dsh 的 resolveCallWithInfo() 会判
      // 「该模型不支持 reasoningEffort」并抛 UNSUPPORTED_REASONING_EFFORT，整轮请求被
      // 换到另一个模型 —— 用户看到的是「明明选的 X，答的却是别人，人格层像失效了」。
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: CONTEXT_WINDOW_FALLBACK },
        reasoning: {
          efforts: reasoningEffortLadder().map((id) => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId('high'),
        },
      }
    }
    const contextWindow = found.context?.contextWindow ?? CONTEXT_WINDOW_FALLBACK
    const resolved = { ...this.toModelInfo(found), context: { contextWindow } }
    if (found.defaultMaxTokens !== undefined) resolved.defaultMaxTokens = found.defaultMaxTokens
    // 思考档位是「思考强度」选择器出现在模型选择里的唯一入口。
    const efforts = found.reasoning?.efforts ?? []
    if (efforts.length > 0) {
      resolved.reasoning = {
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
        // defaultEffort 已在模型映射阶段校验过包含关系。
        ...(found.reasoning.defaultEffort !== undefined
          ? { defaultEffort: ReasoningEffortId(found.reasoning.defaultEffort) }
          : {}),
      }
    }
    return resolved
  }

  /** 兼容旧版 dsh-llm：基类没有 prepareCall 时会调适配器上的同名方法。 */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  toModelInfo(model) {
    return {
      provider: this.options.providerId,
      id: model.id,
      name: model.name,
      // 双域并存时同名模型要有区别，否则模型下拉里两行完全一样。
      ...(model.realm === 'global' ? { description: 'global realm（国际版账号）' } : {}),
      inputModalities: Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
        ? ['text', 'image']
        : ['text'],
    }
  }

  // ── 出方向 ────────────────────────────────────────────────────────────────

  async *stream(options) {
    const apiKey = await this.requireApiKey()
    const images = await this.resolveImages(options)
    const model = await this.options.catalog.find(options.model)
    const wire = serializeMessages(options.messages ?? [], images)
    const body = this.buildRequestBody(options, wire, model?.reasoning?.efforts ?? [], model)
    await dumpProbe(options, body)

    // 整体超时与调用方的 signal 合并，任一方触发都算数。
    const signals = [AbortSignal.timeout(this.options.config.requestTimeoutSeconds * 1000)]
    if (options?.signal) signals.push(options.signal)
    const signal = AbortSignal.any(signals)

    let response
    try {
      response = await this.fetchImpl(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw new LlmError(`workbuddy2api: 请求网关失败（${error?.message ?? error}）`, 'TRANSPORT')
    }

    if (!response.ok) {
      const detail = await safeText(response)
      throw new LlmError(`workbuddy2api: 网关返回 HTTP ${response.status} ${detail}`, httpErrorCode(response.status, detail))
    }

    const state = {
      nextIndex: 0,
      model: body.model,
      text: undefined,
      reasoning: undefined,
      toolCalls: new Map(),
      toolOrder: [],
      toolIds: new Map(),
      finishReason: undefined,
    }

    for await (const payload of iterateSse(response, {
      firstTokenTimeoutMs: this.options.config.firstTokenTimeoutSeconds * 1000,
      idleTimeoutMs: this.options.config.idleTimeoutSeconds * 1000,
      signal,
    })) {
      yield* consumeChunk(payload, state)
    }
    yield* this.finishStream(state)
  }

  buildRequestBody(options, wireMessages, efforts, modelEntry) {
    const messages = [...wireMessages]
    // system 不是独立字段，而是 messages 的第一条。
    // options.system 与历史里的 system 是两个来源（前者是 harness 追加段，后者是渲染好
    // 的完整 prompt 快照），两处都要保留；内容完全相同时去重，避免同一段发两遍。
    if (typeof options.system === 'string' && options.system.length > 0) {
      const duplicated = messages.some((m) => m.role === 'system' && m.content === options.system)
      if (!duplicated) messages.unshift({ role: 'system', content: options.system })
    }
    // catalog 的展示策略是 strip-cn，dsh 传回来的 `options.model` 是裸名
    // （`glm-5.0-turbo`）。裸名发给网关会被钉回 CN 集合，global 模型会走错出口，
    // 所以这里必须用目录里那一条把 realm 前缀还原成 `cn:xxx` / `global:xxx`。
    // 目录里查不到（用户手填了未知模型名）时原样透传，交由网关自己判错。
    const wireModelId = toWireModel(modelEntry) || options.model
    const body = {
      model: wireModelId,
      messages,
      stream: true,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
    // 空 tools 数组不要发：上游会当成「声明了零个工具」而拒绝带工具调用的后续轮次。
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }))
    }
    // 档位必须在模型声明的白名单里，否则上游会拒绝整个请求。
    if (options.reasoningEffort !== undefined && efforts.length > 0 && efforts.includes(options.reasoningEffort)) {
      body.reasoning_effort = options.reasoningEffort
    }
    return body
  }

  /** 图片附件 → data URL。读不到的图直接跳过：发一个空 URL 会触发上游 400。 */
  async resolveImages(options) {
    const readImage = this.options.attachments?.readImage
    const urls = new Map()
    if (typeof readImage !== 'function') return urls
    for (const message of options.messages ?? []) {
      for (const block of blocksOf(message)) {
        if (block?.type !== 'image' || !block.attachment) continue
        try {
          const dataUrl = await readImage.call(this.options.attachments, block.attachment)
          if (typeof dataUrl === 'string' && dataUrl.length > 0) urls.set(block.attachment, dataUrl)
        } catch { /* 读不到就当没这张图 */ }
      }
    }
    return urls
  }

  async requireApiKey() {
    const key = await this.options.apiKeyResolver?.()
    if (typeof key === 'string' && key.length > 0) return key
    throw new LlmError('workbuddy2api: 缺少网关 api_key（执行 /wb2api-setup 生成）', 'MISSING_CREDENTIAL')
  }

  // ── 入方向 ────────────────────────────────────────────────────────────────

  /**
   * 收尾：关闭所有块，发 `finish`。
   *
   * 空步兜底是实测出来的：上游有时只吐思考、不吐正文也不吐工具调用，却仍然给
   * `finish_reason='stop'`。原样上报 stop 时，harness 因「本步无 tool-call」
   * 把该步判为 completed 并结束整个回合 —— 表现就是「任务执行到一半自动停止」。
   * 这里改成可重试的空响应错误。
   */
  *finishStream(state) {
    if (state.finishReason !== 'length'
      && state.toolOrder.length === 0
      && state.text === undefined
      && state.reasoning !== undefined
      && state.reasoning.text !== '') {
      recordEmptyResponse(state)
      throw new LlmError('workbuddy2api: 上游只返回了思考内容（无正文、无工具调用），本步判定为不完整', 'EMPTY_RESPONSE')
    }

    for (const index of state.toolOrder) {
      const block = [...state.toolCalls.values()].find((candidate) => candidate.index === index)
      if (!block) continue
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId),
          name: block.name ?? '',
          // 只把「无参工具的空串」补成 {}；残缺参数**保持原样**交给下面的 max-tokens
          // 判定触发重试 —— 补成 {} 会伪造出合法外观，让 harness 报参数缺失而非重试。
          arguments: isTruncatedArguments(block.text) ? block.text : normalizeToolArguments(block.text),
        },
      }
    }
    if (state.text !== undefined) {
      yield { type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.text } }
    }
    if (state.reasoning !== undefined && state.reasoning.text !== '') {
      yield { type: 'block-end', index: state.reasoning.index, block: { type: 'reasoning', text: state.reasoning.text } }
    }

    // 三种「不完整」都必须报 max-tokens 而非 tool-calls，否则 harness 会执行残缺调用、
    // 报 INVALID_ARGS，并把脏参数持久化进会话历史。判为截断后 dsh 丢弃残缺调用并重试。
    const argsTruncated = [...state.toolCalls.values()].some((block) => isTruncatedArguments(block.text))
    const reason = state.finishReason === 'length'
      || (state.finishReason === undefined && state.toolOrder.length > 0)
      || argsTruncated
      ? { kind: 'max-tokens' }
      : state.finishReason === 'tool_calls' || state.toolOrder.length > 0
        ? { kind: 'tool-calls' }
        : { kind: 'stop' }
    yield { type: 'finish', reason }
  }
}

/**
 * EMPTY_RESPONSE 计数观测：上游「只吐思考就 stop」时记一条元数据
 * （时间 / 版本 / 模型 / finish_reason / 思考长度），不记任何正文。
 * 用于判断这是偶发抖动还是某模型的高频病 —— 高频就该在网关侧换重试策略。
 * 追加式列表，封顶 50 条；观测失败静默，不影响主流程。
 */
function recordEmptyResponse(state) {
  if (!probeEnabled()) return
  try {
    const req = createRequire(import.meta.url)
    const { writeFileSync, mkdirSync, readFileSync, existsSync } = req('node:fs')
    const { join } = req('node:path')
    const { homedir } = req('node:os')
    const dir = process.env.WB2API_DUMP_DIR || join(homedir(), '.dsh', 'wb2api', 'data')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'empty-response-stats.json')
    const list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
    list.push({
      at: new Date().toISOString(),
      version: PKG_VERSION,
      model: state.model ?? null,
      finishReason: state.finishReason ?? null,
      reasoningChars: state.reasoning?.text?.length ?? 0,
    })
    while (list.length > 50) list.shift()
    writeFileSync(file, JSON.stringify(list, null, 2))
  } catch { /* 观测不能影响主流程 */ }
}

/**
 * harness 消息 → OpenAI 线格式。
 *
 * 四条硬规则：
 *  1. **system 消息照原样保留** —— 人格 / 指令提示词就藏在里面，丢了模型就不认人格；
 *  2. user 消息里搭载的 tool-result 块必须展开成**独立的 `{role:'tool'}` 消息**；
 *  3. 孤儿 tool 结果（assistant 侧没声明过对应调用）丢弃；
 *  4. 纯工具结果的 user 消息**不产生** user 条目，否则会多出一条空消息。
 *
 * 破坏 2 或 3 的后果不对称：孤儿 tool_call 会让上游直接 400 且会话永久报废；
 * 而不展开 tool 结果会让上游按对话轮聚合的兜底键每个 step 漂移，用量明细静默碎片化
 * —— 网关照常回包不报错，只能事后对账才发现。
 */
export function serializeMessages(messages, imageUrls) {
  const { keep } = resolveToolPairing(messages)
  const wire = []
  for (const message of messages) {
    const role = message?.role
    // ⚠ 必须保留 system 消息：dsh 的 system prompt（人格 / 指令）就是靠它承载的 ——
    // `createSystemMessage()` 把渲染好的完整 prompt 放进这条 role:'system' 的历史消息，
    // 官方 adapter 也是「从 history 取出 system + options.system」两处合并。
    // 早先版本按「system 由 buildRequestBody 统一 unshift」把它 continue 掉，而
    // options.system 通常是空的，于是整份人格提示词根本没进请求：网关照常 200 回包，
    // 只是模型完全不认人格 —— 症状极隐蔽（不是报错，是"回答得不像"）。
    if (role === 'system') {
      const sysText = contentToText(message?.content)
      if (sysText.length > 0) wire.push({ role: 'system', content: sysText })
      continue
    }
    const list = blocksOf(message)
    const toolResults = list.filter((block) => block?.type === 'tool-result')
    const text = contentToText(message?.content)

    if (role === 'assistant') {
      const toolCalls = list.filter((block) => block?.type === 'tool-call').map((block) => ({
        id: String(block.id),
        type: 'function',
        function: { name: block.name, arguments: normalizeToolArguments(block.arguments) },
      }))
      const reasoningText = list.filter((block) => block?.type === 'reasoning').map((block) => String(block.text ?? '')).join('')
      const entry = { role: 'assistant' }
      // OpenAI 规范：正文为空且带工具调用时 content 必须是 null（不是空串）。
      entry.content = text.length > 0 ? text : (toolCalls.length > 0 ? null : '')
      if (toolCalls.length > 0) entry.tool_calls = toolCalls
      if (reasoningText.length > 0) entry.reasoning_content = reasoningText
      wire.push(entry)
      continue
    }

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        const id = String(result.toolCallId)
        if (!keep.has(id)) continue
        wire.push({ role: 'tool', tool_call_id: id, content: contentToText(result.content) || '(no output)' })
      }
    }
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: withImages(message, text, imageUrls) })
    }
  }
  return wire
}

/** 有图片时把 content 升级成多模态 parts。 */
function withImages(message, text, imageUrls) {
  const images = []
  for (const block of blocksOf(message)) {
    if (block?.type !== 'image') continue
    const url = imageUrls?.get(block.attachment)
    if (url) images.push({ type: 'image_url', image_url: { url } })
  }
  if (images.length === 0) return text
  return [{ type: 'text', text }, ...images]
}

/**
 * 计算「哪些工具结果的 id 是有效的」。
 * 只有 assistant 侧声明过的 tool-call id 才保留对应结果，其余是孤儿。
 */
export function resolveToolPairing(messages) {
  const declared = new Set()
  const answered = new Set()
  for (const message of messages ?? []) {
    for (const block of blocksOf(message)) {
      if (block?.type === 'tool-call') declared.add(String(block.id))
      if (block?.type === 'tool-result') answered.add(String(block.toolCallId))
    }
  }
  const keep = new Set([...answered].filter((id) => declared.has(id)))
  return { declared, answered, keep }
}

/** 内容块 → 纯文本。历史里存在 content 为纯字符串的条目，漏掉会让整条消息变空串。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

function blocksOf(message) {
  const content = message?.content
  if (Array.isArray(content)) return content
  return []
}

/** 空串是合法的无参工具；其余原样返回（解析与否由 isTruncatedArguments 决定）。 */
export function normalizeToolArguments(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.trim() === '') return EMPTY_ARGUMENTS
  return value
}

/**
 * HTTP 状态码 → dsh 错误码。
 * 503 要分两种：带限流/冷却语义的算 RATE_LIMIT，否则算 SERVER —— 混在一起会让
 * dsh 对「上游在冷却」这种可等待的情况做出和「上游挂了」一样的处理。
 */
export function httpErrorCode(status, detail = '') {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 503) return /rate.?limit|cooling|cooldown/i.test(detail) ? 'RATE_LIMIT' : 'SERVER'
  if (status >= 500) return 'SERVER'
  if (status === 400) return 'INVALID_REQUEST'
  return 'PROVIDER_ERROR'
}

/**
 * OpenAI usage → dsh TokenUsage。
 * 契约要求计数互斥：缓存命中的 token 不能同时算进 inputTokens，否则命中率会被算大。
 */
export function toTokenUsage(usage) {
  const promptTokens = usage?.prompt_tokens ?? 0
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: cachedTokens > 0 ? Math.max(0, promptTokens - cachedTokens) : promptTokens,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(usage?.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  }
}

/** 处理单条已解析的 SSE 帧，产出 delta 并更新累积状态。 */
export function* consumeChunk(chunk, state) {
  const choice = chunk?.choices?.[0]
  if (choice !== undefined) {
    if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
    const delta = choice.delta
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (state.text === undefined) {
        state.text = { index: state.nextIndex++, text: '' }
        yield { type: 'block-start', index: state.text.index, blockType: 'text' }
      }
      state.text.text += delta.content
      yield { type: 'text-delta', index: state.text.index, text: delta.content }
    }
    // 思考链：上游两种风格都认（DeepSeek 用 reasoning_content，另有实现用 reasoning）。
    const reasoningText = typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
      ? delta.reasoning_content
      : typeof delta?.reasoning === 'string' && delta.reasoning.length > 0 ? delta.reasoning : undefined
    if (reasoningText !== undefined) {
      if (state.reasoning === undefined) {
        state.reasoning = { index: state.nextIndex++, text: '' }
        yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
      }
      state.reasoning.text += reasoningText
      yield { type: 'reasoning-delta', index: state.reasoning.index, text: reasoningText }
    }
    for (const call of delta?.tool_calls ?? []) {
      // 用线格式的 call.index 做 Map 键，不是数组位置：并行工具调用时分片会交错，
      // 数组位置不稳定。
      const wireIndex = call.index ?? 0
      if (typeof call.id === 'string' && call.id.length > 0) state.toolIds.set(wireIndex, call.id)
      const callId = state.toolIds.get(wireIndex) ?? `call_${wireIndex}`
      let block = state.toolCalls.get(wireIndex)
      if (block === undefined) {
        block = { index: state.nextIndex++, text: '', callId }
        state.toolCalls.set(wireIndex, block)
        state.toolOrder.push(block.index)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      }
      block.callId = callId
      // 后续参数分片会带空的 function.name（""），它不是 undefined；直接覆盖会把首分片的
      // 真实工具名清空，导致 `unknown tool ""`。只有非空名字才更新。
      if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name
      const fragment = call.function?.arguments ?? ''
      block.text += fragment
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: ToolCallId(callId),
        ...(block.name !== undefined ? { name: block.name } : {}),
        argumentsDelta: fragment,
      }
    }
  }
  if (chunk?.usage !== undefined && chunk.usage !== null) {
    yield { type: 'usage', usage: toTokenUsage(chunk.usage) }
  }
}

async function safeText(response) {
  try {
    const text = await response.text()
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return ''
  }
}
