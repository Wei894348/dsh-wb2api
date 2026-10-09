/**
 * 网关进程托管：探活 → 拉起 → 盯崩溃 → 回收。
 *
 * 设计上有一条底线：**不抢别人的端口**。启动前必先探一次 `/healthz`，
 * 已经有健康网关在跑就直接复用（状态 `external`），既不拉进程也不杀别人的进程。
 * 端口被别的程序占了（有监听但答非所问）则明确报错，而不是把人家的服务顶掉。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gatewayOrigin, gatewayPort } from './settings.js'
import {
  BINARY_CANDIDATES, bundledBinaryDir, defaultInstallDir, defaultRuntimeDir, resolveAuthDir, resolveWorkingDir,
} from './runtime.js'

/**
 * 调试留痕。dsh 的插件 logger 在 web 模式下不落到磁盘（只进内存诊断），
 * 排查「网关没起来」这种只在宿主里发生的问题时看不到线索，于是留一个显式开关：
 * 设 `WB2API_DEBUG_LOG=1` 就把关键节点追加到 `<运行目录>/data/gw-debug.log`。
 * 默认关闭 —— 正常使用不该悄悄往用户盘里写文件。
 */
function debugLog(message) {
  if (!process.env.WB2API_DEBUG_LOG) return
  try {
    const dir = join(defaultRuntimeDir(), 'data')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'gw-debug.log'), `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch { /* 诊断失败不能影响主流程 */ }
}

/** 状态机。 */
export const STATE = Object.freeze({
  STOPPED: 'stopped',
  EXTERNAL: 'external',
  STARTING: 'starting',
  RUNNING: 'running',
  UNHEALTHY: 'unhealthy',
  FAILED: 'failed',
})

/** 就绪轮询间隔。 */
const PROBE_INTERVAL_MS = 250

/** 单轮退避上限。 */
const BACKOFF_CEILING_MS = 30_000

/** 保留给 `/wb2api-status` 看的 stderr 尾部长度。 */
const STDERR_TAIL_CHARS = 2000

export class GatewaySupervisor {
  /**
   * @param {object} options
   * @param {object} options.config       归一化后的插件配置
   * @param {object} options.subprocess   dsh 的 subprocess service（spawn / terminate）
   * @param {object} [options.logger]     { info, warn, error }
   * @param {AbortSignal} [options.signal]
   */
  constructor(options) {
    this.config = options.config
    this.subprocess = options.subprocess
    this.logger = options.logger ?? {}
    this.origin = gatewayOrigin(this.config.baseURL)
    this.port = gatewayPort(this.config)

    this.state = STATE.STOPPED
    this.pid = null
    this.health = null
    this.lastError = null
    this.restarts = 0
    this.recentStderr = ''
    this.executablePath = null
    this.workingDirectory = null

    // 并发去重：dsh 自动拉起和用户紧接着敲 /wb2api-setup 会撞车，
    // 第二次调用必须等同一轮启动，否则拿到的是「还没探活」的空壳快照。
    this.inFlight = null
    // 代数：stop() 递增，用于作废进行中的那轮启动（「停→改名→启」不能被旧启动夹住）。
    this.generation = 0
    this.stopping = false
    this.disposed = false
    this.restartTimer = null
    this.handle = null
  }

  /** 统一出口：给宿主 logger 的同时（可选）落盘，两边口径一致。 */
  trace(level, message) {
    this.logger?.[level]?.(message)
    debugLog(`[${level}] ${message}`)
  }

  // ── 二进制定位 ────────────────────────────────────────────────────────────

  /**
   * 找可执行文件。显式配置的 `binaryPath` 不存在就**直接报错**：
   * 配了路径说明用户有明确意图，悄悄回退到别处只会让人以为用的是自己那份。
   */
  async resolveBinary() {
    if (this.config.binaryPath) {
      const explicit = resolve(this.config.binaryPath)
      if (!existsSync(explicit)) throw new Error(`指定的网关程序不存在：${explicit}`)
      this.executablePath = explicit
      return explicit
    }
    // 顺序：显式源码目录 → 随包自带 → 下载缓存 → PATH。
    // 随包那份必须排在下载缓存前面：装完就该能跑，不该先逼用户去下载。
    const found = this.scanDirectory(this.config.repoPath)
      ?? this.scanDirectory(join(this.config.repoPath || '', 'bin'))
      ?? this.scanDirectory(bundledBinaryDir())
      ?? this.scanDirectory(defaultInstallDir())
      ?? this.lookupInPath()
    if (!found) throw new Error('找不到网关程序，请执行 /wb2api-setup')
    this.executablePath = found
    return found
  }

  scanDirectory(dir) {
    if (!dir) return null
    for (const name of BINARY_CANDIDATES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  lookupInPath() {
    const fn = this.subprocess?.resolveExecutable
    if (typeof fn !== 'function') return null
    for (const name of BINARY_CANDIDATES) {
      const hit = fn.call(this.subprocess, name)
      if (hit) return hit
    }
    return null
  }

  // ── 探活 ──────────────────────────────────────────────────────────────────

  /**
   * 打 `/healthz`（免鉴权）。
   * - 连不上 = 网关没起，返回 undefined（正常情况，不要当错误）；
   * - 有监听但答非所问 = 端口被别的程序占了，抛错。
   */
  async probe() {
    try {
      const response = await fetch(`${this.origin}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (!response.ok) throw new Error(`端口 ${this.port} 被其它程序占用（HTTP ${response.status}），网关无法监听`)
      const body = await response.json()
      return {
        healthy: Number(body?.healthy ?? 0),
        total: Number(body?.total ?? 0),
        service: typeof body?.service === 'string' ? body.service : '',
        realmServable: body?.realm_servable && typeof body.realm_servable === 'object' ? body.realm_servable : {},
      }
    } catch (error) {
      if (isConnectionFailure(error)) return undefined
      this.trace('error', `探活异常（非连接失败）：${error?.message ?? String(error)}`)
      throw error
    }
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  /**
   * 启动（幂等）。已在跑就返回当前状态；有外部健康网关则复用；否则拉进程等就绪。
   */
  async start() {
    if (this.disposed) return this.snapshot()
    if (this.state === STATE.RUNNING || this.state === STATE.EXTERNAL) return this.snapshot()
    if (this.inFlight) return this.inFlight

    this.inFlight = this.bringUp().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  async bringUp() {
    const mine = ++this.generation
    this.stopping = false
    this.state = STATE.STARTING
    this.lastError = null

    // 先复用，再谈启动。
    const existing = await this.probe()
    if (existing) {
      this.state = STATE.EXTERNAL
      this.health = existing
      this.trace('info', `网关已在 ${this.origin} 运行（healthy=${existing.healthy}），直接复用`)
      return this.snapshot()
    }

    let executable
    try {
      executable = await this.resolveBinary()
    } catch (error) {
      this.state = STATE.FAILED
      this.lastError = error.message
      this.trace('error', `网关启动失败：${error.message}`)
      return this.snapshot()
    }

    const cwd = resolveWorkingDir(this.config, executable)
    this.workingDirectory = cwd
    this.trace('info', `启动网关：${executable}（cwd=${cwd}）`)

    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [executable],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
          stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 4 * 1024 * 1024 } },
        },
        graceMs: this.config.graceMs,
        // 宿主环境变量会被 dsh 清洗，子进程要用的必须显式传。
        env: { ...this.config.env },
      })
    } catch (error) {
      this.state = STATE.FAILED
      this.lastError = `无法创建网关进程：${error.message}`
      this.trace('error', this.lastError)
      return this.snapshot()
    }

    this.handle = handle
    this.pid = handle.pid ?? null
    this.watchExit(handle)
    this.watchStderr(handle)

    const health = await this.waitForHealth(handle, mine)
    if (mine !== this.generation || this.stopping) return this.snapshot()

    if (!health) {
      this.state = STATE.FAILED
      this.lastError = this.recentStderr
        ? `网关启动后未通过健康检查：${tail(this.recentStderr, 300)}`
        : '网关启动后未通过健康检查'
      this.trace('error', this.lastError)
      return this.snapshot()
    }

    this.health = health
    this.state = health.healthy > 0 ? STATE.RUNNING : STATE.UNHEALTHY
    if (health.healthy === 0) this.trace('warn', '网关已启动，但没有可用账号（healthy=0）')
    this.trace('info', `网关就绪：${this.origin}（healthy=${health.healthy}/${health.total}）`)
    return this.snapshot()
  }

  /**
   * 等就绪。总预算 = healthTimeoutSeconds × 10（默认 30s）。
   * 用 `Promise.race` 把「进程已退出」也放进竞速：起了就退的进程不该让人干等满预算。
   */
  async waitForHealth(handle, generation) {
    const budget = this.config.healthTimeoutSeconds * 1000 * 10
    const deadline = Date.now() + budget
    const exited = handle?.done?.then(() => 'exited') ?? new Promise(() => {})
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.stopping) return null
      const health = await Promise.race([
        this.probe().catch(() => undefined),
        exited,
        sleep(PROBE_INTERVAL_MS).then(() => 'tick'),
      ])
      if (health === 'exited') return null
      if (health && typeof health === 'object') return health
    }
    return null
  }

  /** 崩溃重启：指数退避，超过上限就认定失败。 */
  watchExit(handle) {
    handle?.done?.then((info) => {
      if (this.disposed || this.stopping || this.handle !== handle) return
      this.pid = null
      this.handle = null
      const code = info?.exitCode ?? info?.code
      const signal = info?.signal ?? info?.signalCode
      this.lastError = `网关进程意外退出（exitCode=${code ?? '?'} signal=${signal ?? '?'}）`
      this.trace('warn', this.lastError)
      if (this.restarts >= this.config.crashRestartLimit) {
        this.state = STATE.FAILED
        this.trace('error', `网关连续崩溃 ${this.restarts} 次，停止自动重启`)
        return
      }
      this.restarts += 1
      const delay = Math.min(1000 * 2 ** (this.restarts - 1), BACKOFF_CEILING_MS)
      this.trace('info', `${Math.round(delay / 1000)}s 后第 ${this.restarts} 次重启网关`)
      this.state = STATE.STARTING
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.start().catch(() => undefined)
      }, delay)
      this.restartTimer?.unref?.()
    }).catch(() => undefined)
  }

  watchStderr(handle) {
    const stream = handle?.stderr
    if (!stream || typeof stream.on !== 'function') return
    stream.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      this.recentStderr = tail(this.recentStderr + text, STDERR_TAIL_CHARS)
    })
  }

  // ── 停止 / 重启 / 回收 ────────────────────────────────────────────────────

  /** 停止。外部网关（`external`）不去杀别人的进程，只解除复用关系。 */
  async stop() {
    this.generation += 1
    this.stopping = true
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    if (this.state === STATE.EXTERNAL) {
      this.state = STATE.STOPPED
      this.health = null
      return this.snapshot()
    }
    const handle = this.handle
    this.handle = null
    if (handle) {
      try { await handle.terminate?.() } catch { /* 已经没了 */ }
      await waitForExit(handle, this.config.graceMs + 5000)
    }
    this.pid = null
    this.health = null
    if (this.state !== STATE.FAILED) this.state = STATE.STOPPED
    return this.snapshot()
  }

  /** 重启：先停再起，并把崩溃计数清零（用户主动重启不该被历史崩溃拖累）。 */
  async restart() {
    await this.stop()
    this.restarts = 0
    return this.start()
  }

  /** 插件卸载：保证「先停网关，再卸服务」，并清掉待执行的重启定时器。 */
  async dispose() {
    this.disposed = true
    await this.stop()
  }

  /** 快照并顺带刷新一次健康数据（命令层要展示实时可用账号数）。 */
  async statusWithHealth() {
    const shot = this.snapshot()
    if (shot.state === STATE.RUNNING || shot.state === STATE.UNHEALTHY || shot.state === STATE.EXTERNAL) {
      const health = await this.probe().catch(() => undefined)
      if (health) { this.health = health; shot.health = health }
    }
    return shot
  }

  /** 凭证文件计数：给 `/wb2api-status` 判断「压根没登录过」。 */
  countAuthFiles() {
    const dir = resolveAuthDir(this.config, this.executablePath)
    try {
      const names = readdirSync(dir).filter((name) => name.startsWith('workbuddy') && name.endsWith('.json'))
      return { total: names.length, enabled: names.length }
    } catch {
      return { total: 0, enabled: 0 }
    }
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      origin: this.origin,
      port: this.port,
      executablePath: this.executablePath,
      workingDirectory: this.workingDirectory ?? resolveWorkingDir(this.config, this.executablePath),
      health: this.health,
      restarts: this.restarts,
      lastError: this.lastError,
      recentStderr: this.recentStderr,
    }
  }
}

function isConnectionFailure(error) {
  const code = error?.cause?.code ?? error?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND'
    || error?.name === 'TimeoutError' || error?.name === 'AbortError'
}

async function waitForExit(handle, timeoutMs) {
  if (!handle?.done) return
  await Promise.race([handle.done.catch(() => undefined), sleep(timeoutMs)])
}

function sleep(ms) {
  return new Promise((done) => { const t = setTimeout(done, ms); t?.unref?.() })
}

function tail(text, max) {
  return text.length > max ? text.slice(text.length - max) : text
}

/** 运行目录常量，给命令层拼提示文案用。 */
export const RUNTIME_HINT = defaultRuntimeDir
export const INSTALL_DIR_HINT = defaultInstallDir
export { dirname }
