/**
 * SSE（text/event-stream）帧解析 + 超时控制
 *
 * 面向的是 OpenAI 兼容网关的流式响应：每一帧就是一行 `data: {...}`。
 * 本模块只做"把 HTTP 字节流变成一帧帧 JSON"这一件事，不解释业务字段。
 *
 * 三个设计点：
 *   1. 按 `\n` 切行，不按 `\n\n` 切事件。标准 SSE 用空行分事件，但这个网关一帧一行，
 *      按空行切会把一整轮流式输出攒成一个巨大事件，首字延迟直接飞天。
 *   2. 首帧超时和帧间超时分开。首帧要等网关排队 + 上游冷启动（可能几十秒）；
 *      一旦模型开始吐字，再卡 5 分钟就基本是连接断了一半，两类等待的性质完全不同，
 *      共用一个值要么误杀慢请求，要么挂死不报。
 *   3. 超时按"可重试"抛出。流式中途超时=本次输出作废，重发一次请求通常能成；
 *      如果不标 retryable，上层会把它当终态错误直接抛给用户，白白浪费一次恢复机会。
 */

/** 默认首帧等待：网关要排队、上游可能冷启动，给得宽一些。 */
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120_000

/** 默认帧间等待：已经出字之后再停这么久，基本是连接半死。 */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000

/** 结束哨兵。 */
const DONE_SENTINEL = '[DONE]'

/**
 * 带超时竞速地读一次 chunk。
 *
 * 约定：超时**返回 null**，而不是抛错——抛错会把"已经读到的字节"这个事实一起抹掉，
 * 上层（iterateSse）才能决定是重试还是放弃，并负责把 reader 收干净。
 * 这里刻意不 cancel reader：读操作还在飞，数据不能被吞，处置权在上层。
 *
 * @param {ReadableStreamDefaultReader} reader
 * @param {number} ms 超时毫秒；非正数/非有限值表示不设超时
 * @param {AbortSignal} [signal] 外部取消信号
 * @returns {Promise<{done: boolean, value: Uint8Array}|null>} 超时返回 null
 */
export function readWithIdleTimeout (reader, ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null
    let onAbort = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      timer = null
      onAbort = null
    }
    const settle = (fn, value) => {
      cleanup()
      fn(value)
    }

    if (signal?.aborted) {
      settle(reject, abortError(signal))
      return
    }

    if (Number.isFinite(ms) && ms > 0) {
      timer = setTimeout(() => settle(resolve, null), ms)
    }
    if (signal) {
      onAbort = () => settle(reject, abortError(signal))
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // read() 的 rejection（流已 cancel / 底层出错）必须原样透出，不能当成超时
    reader.read().then(
      (chunk) => settle(resolve, chunk),
      (err) => settle(reject, err),
    )
  })
}

/**
 * 逐帧产出 SSE 里的 JSON 对象。
 *
 * 行为：
 *  - 非 `data:` 行（注释、event:、id:、空行、心跳）静默丢弃，不算错误；
 *  - `[DONE]` 正常结束，直接 return（生成器收尾）；
 *  - 非 JSON 的 data 帧跳过——网关偶尔会塞一行 probe/keepalive 文本；
 *  - 首帧用 firstTokenTimeoutMs，拿到第一帧后改用 idleTimeoutMs；
 *  - 超时 / 外部 abort 前先 cancel reader，把底层连接放掉，不留悬挂的 socket。
 *
 * @param {Response} response fetch 的响应（必须有 body）
 * @param {object} [options]
 * @param {number} [options.firstTokenTimeoutMs]
 * @param {number} [options.idleTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @yields {object} 每帧 JSON.parse 后的对象
 */
export async function* iterateSse (response, options = {}) {
  const firstTokenTimeoutMs = pickTimeout(options.firstTokenTimeoutMs, DEFAULT_FIRST_TOKEN_TIMEOUT_MS)
  const idleTimeoutMs = pickTimeout(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
  const signal = options.signal

  if (!response?.body) throw new Error('iterateSse 需要一个带 body 的 Response')

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let pending = '' // 跨 chunk 的半行：UTF-8 多字节字符和长帧都可能被 TCP 切断
  let waitMs = firstTokenTimeoutMs // 首帧更宽容，出字后换成帧间超时
  let finished = false

  try {
    while (true) {
      const chunk = await readWithIdleTimeout(reader, waitMs, signal)
      if (chunk === null) {
        // 超时：这一轮已经废了，retryable 让上层决定重发；抛之前先把连接收掉
        await cancelQuietly(reader)
        throw timeoutError(waitMs === firstTokenTimeoutMs ? '首帧等待超时' : '流式输出帧间超时')
      }
      if (chunk.done) {
        // 末尾可能留着一行没有换行符的帧，补处理一次再收尾
        for (const frame of flushLines(pending, true)) {
          const parsed = parseDataFrame(frame)
          if (parsed === undefined) continue
          if (parsed === DONE_SENTINEL) return
          yield parsed
        }
        finished = true
        return
      }

      pending += decoder.decode(chunk.value, { stream: true })
      const { lines, rest } = splitLines(pending)
      pending = rest

      for (const line of lines) {
        const parsed = parseDataFrame(line)
        if (parsed === undefined) continue // 非 data 行 / 非 JSON 帧
        if (parsed === DONE_SENTINEL) {
          finished = true
          return
        }
        yield parsed
        waitMs = idleTimeoutMs // 已经出过字，后续只认帧间超时
      }
    }
  } finally {
    // 被 break / throw / return 提前退出时，别把 reader 挂在流上
    if (!finished) await cancelQuietly(reader)
  }
}

/**
 * 判断工具调用的 arguments 是否残缺（流式分片丢失）。
 *
 * 为什么必须判成"可重试"而不是当成一次完整工具调用：arguments 是增量拼出来的字符串，
 * 中途断流时它多半停在半个 JSON 上。如果照原样交给执行层，要么解析失败炸掉整轮，
 * 要么更糟——恰好是合法 JSON 的残缺串（如 `{"a"` 不合法，但 `{"path":"/tmp` 之外
 * 的某些前缀可能被宽松解析器放过）导致工具被错误执行。
 *
 * 空串不算残缺：无参数工具调用本来就是 `{}` 或空串，是合法终态。
 *
 * @param {string} text 累积的 arguments 字符串
 * @returns {boolean} true = 残缺，应该重试
 */
export function isTruncatedArguments (text) {
  if (typeof text !== 'string' || text === '') return false
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

/** 按 `\n` 切出完整行，尾巴留在 rest 里。 */
function splitLines (buffer) {
  const lines = buffer.split('\n')
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] }
}

/** 收尾时用：把残留的一行也吐出来（带 '\r' 会一并清掉）。 */
function flushLines (buffer) {
  const tail = buffer.replace(/\r$/, '').trim()
  return tail ? [tail] : []
}

/**
 * 解析一行，产出三种结果：
 *  - undefined：丢弃（非 data 行、空载荷、非 JSON 帧）
 *  - '[DONE]'：结束哨兵
 *  - 其他：JSON 对象
 */
function parseDataFrame (line) {
  const text = line.replace(/\r$/, '')
  const trimmed = text.trim()
  if (!trimmed || !trimmed.startsWith('data:')) return undefined
  const payload = trimmed.slice(5).trim()
  if (!payload) return undefined
  if (payload === DONE_SENTINEL) return DONE_SENTINEL
  try {
    return JSON.parse(payload)
  } catch {
    return undefined // 心跳 / probe 文本，静默跳过
  }
}

/** 超时错误：带 retryable 与 code，供上层重试策略识别。 */
function timeoutError (message) {
  const err = new Error(message)
  err.code = 'TIMEOUT'
  err.retryable = true
  return err
}

/** abort 时统一成带 name 的 Error，方便上层 `err.name === 'AbortError'` 判断。 */
function abortError (signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const err = new Error(typeof reason === 'string' && reason ? reason : 'aborted')
  err.name = 'AbortError'
  return err
}

/** 参数可能是 0 / undefined / null，统一回落默认值；显式给 0 视为"不超时"。 */
function pickTimeout (value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** cancel 只是回收连接，失败（流已关闭）无所谓。 */
async function cancelQuietly (reader) {
  try {
    await reader.cancel()
  } catch {
    /* 流已关闭 */
  }
}
