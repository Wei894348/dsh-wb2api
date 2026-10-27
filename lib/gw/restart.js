/**
 * 「重启网关」—— 面板上那颗按钮的宿主实现。
 *
 * 为什么不能直接 `supervisor.restart()` 了事：
 *
 * 1. **僵死进程不等于没有进程。** 网关卡住时光听端口还在、`/healthz` 不答，
 *    于是 supervisor 的探活判「连不上」，接着拉一个新进程去抢同一个端口 ——
 *    新进程绑不上、健康检查必失败，面板上只看到 failed。真正要救的是
 *    「按端口找出那个僵死进程、确认镜像名是网关自己、强杀、等端口释放、再拉起」。
 * 2. **孤儿网关**（上一次 dsh 没退干净留下的 `wb2a-server.exe`）在 supervisor 眼里是
 *    `external`，而 `stop()` 按设计**不杀别人的进程** —— 于是「重启」等于什么都没做。
 *    这里补一条：确认镜像名之后才动手，别人的端口一个都不碰。
 * 3. **重启要能复检。** 拉起后把 state / health / 强杀记录一起还给面板，
 *    否则用户只能靠「界面像不像好了」猜。
 *
 * 强杀有硬边界：**只有镜像名在白名单里**才允许 kill（见 GATEWAY_IMAGES）。
 * 端口被 node.exe / nginx 之类占着时一律报错交回人类 —— 本插件没有资格替用户
 * 决定杀谁，那条「不抢别人的端口」的底线在这里同样成立。
 *
 * 2026-10-26 新增：面板「重启网关」按钮（`POST /dsh-wb2api/restart`）。
 */
import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { gatewayLink } from './link.js'
import { gatewayOrigin, gatewayPort } from './settings.js'

const run = promisify(execFile)

/** 网关自己的镜像名（含历史别名）。只有这些允许被强杀。 */
const GATEWAY_IMAGES = new Set([
  'wb2a-server.exe', 'wb2api-server.exe', 'wb2api.exe', 'wb2a.exe',
  'wb2a-server', 'wb2api-server', 'wb2api', 'wb2a',
])

/** 正常停进程后等端口释放的预算（terminate 已经在 stop() 里等过了）。 */
const PORT_RELEASE_MS = 2500

/** 强杀之后再等端口释放的预算。 */
const KILL_RELEASE_MS = 8000

/** 端口探测的节奏与单次超时。 */
const PORT_POLL_MS = 200
const PORT_PROBE_TIMEOUT_MS = 400

/**
 * 重启（去重）。连点两下只会有一次真实动作 —— 第二次直接复用同一个 promise，
 * 两个 HTTP 请求会一起等到同一个结果，不会互相踩。
 */
let inflight = null

export function restartGateway(options = {}) {
  if (inflight !== null) return inflight
  inflight = doRestart(options).finally(() => { inflight = null })
  return inflight
}

async function doRestart({ log } = {}) {
  const startedAt = Date.now()
  const supervisor = gatewayLink.supervisor
  if (supervisor === null || typeof supervisor !== 'object') {
    throw new Error('内置网关托管没挂上（lib/gw 未加载），没法重启。重启 dsh 后再点。')
  }

  const config = gatewayLink.config ?? {}
  const port = Number(supervisor.port ?? gatewayPort(config)) || gatewayPort(config)
  const origin = String(supervisor.origin ?? gatewayOrigin(config?.baseURL))
  const steps = []
  const killed = []

  // ── 1) 先走正常停止（快、干净；能停就不必强杀）─────────────────────────
  await supervisor.stop()
  steps.push('已停止网关进程（graceful）')

  // ── 2) 端口没释放 = 僵死进程 / 孤儿，按端口找出来验明正身再强杀 ─────────
  let free = await waitPortFree(port, PORT_RELEASE_MS)
  if (!free) {
    const pids = await findListeningPids(port)
    if (pids.length === 0) {
      // 查不到占用者（权限不足 / 工具缺失）时别急着下结论，再等一轮。
      free = await waitPortFree(port, PORT_RELEASE_MS)
      if (!free) {
        throw new Error(`端口 ${port} 一直被占着，但查不到是哪个进程（可能是权限问题）。手动结束占用 ${port} 的进程后再点重启。`)
      }
    } else {
      for (const pid of pids) {
        const image = await processImageName(pid)
        if (!isGatewayImage(image)) {
          throw new Error(`端口 ${port} 被别的程序占着（pid ${pid}${image === '' ? '' : ' · ' + image}），没动它。先关掉那个程序再点重启。`)
        }
        await forceKill(pid)
        killed.push({ pid, image })
        steps.push(`强杀僵死网关进程 pid=${pid}${image === '' ? '' : '（' + image + '）'}`)
      }
      free = await waitPortFree(port, KILL_RELEASE_MS)
    }
  }
  if (!free) throw new Error(`端口 ${port} 强杀后仍未释放，重启中止（有进程抓着它不放）。`)

  // ── 3) 重新拉起（崩溃计数清零：用户主动重启不该被历史崩溃拖累）──────────
  supervisor.restarts = 0
  const status = await supervisor.start()
  steps.push(`已重新拉起网关（state=${String(status?.state ?? '?')}）`)

  // 模型目录跟着刷一遍：重启后网关可能换了可用模型集合（账号池变了）。
  const catalog = gatewayLink.catalog
  if (catalog && typeof catalog.get === 'function') {
    await catalog.get(true).catch(() => undefined)
  }

  if (status?.state === 'failed') {
    throw new Error(`重启失败：${status.lastError ?? '未知原因'}（详情：${status.recentStderr ? String(status.recentStderr).slice(-300) : '无 stderr'}）`)
  }

  const payload = {
    state: status?.state ?? 'unknown',
    pid: status?.pid ?? null,
    port,
    origin,
    health: status?.health ?? null,
    killed,
    steps,
    tookMs: Date.now() - startedAt,
    lastError: status?.lastError ?? null,
  }
  log?.('info', `[wb2api] 网关已重启（state=${payload.state} pid=${payload.pid ?? '?'}`
    + `${killed.length > 0 ? ` 强杀=${killed.length}` : ''} 用时=${payload.tookMs}ms）`)
  return payload
}

// ── 端口 / 进程探查（Windows 走 netstat + tasklist，POSIX 走 lsof / ps）────

/** 端口上是否有人在听（连得上即算有人在听）。 */
export function portOpen(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const finish = (open) => {
      clearTimeout(timer)
      socket.destroy()
      done(open)
    }
    const timer = setTimeout(() => { finish(false) }, PORT_PROBE_TIMEOUT_MS)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

/** 等到端口没人听（或超时）。 */
export async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true
    await sleep(PORT_POLL_MS)
  }
  return !(await portOpen(port))
}

/** 查监听某个 TCP 端口的 PID 列表。查不到就返回空数组（不抛）。 */
export async function findListeningPids(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('netstat', ['-ano', '-p', 'tcp'], {
        windowsHide: true, timeout: 6000, maxBuffer: 4 * 1024 * 1024,
      })
      const pids = new Set()
      for (const line of String(stdout).split(/\r?\n/u)) {
        const cols = line.trim().split(/\s+/u)
        // 列：Proto Local Foreign State PID
        if (cols.length < 5) continue
        if (!/^LISTENING$/iu.test(cols[3])) continue
        const match = /:(\d+)$/u.exec(cols[1])
        if (match === null || Number(match[1]) !== port) continue
        const pid = Number(cols[4])
        if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
      }
      return [...pids]
    }
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 6000, maxBuffer: 1024 * 1024,
    })
    return parsePidList(stdout)
  } catch (error) {
    // lsof 没装 / 没有匹配时退出码非 0，两者都不该让重启失败。
    if (process.platform === 'win32') return []
    try {
      const { stdout } = await run('fuser', ['-n', 'tcp', String(port)], { timeout: 6000 })
      return parsePidList(stdout)
    } catch { return [] }
  }
}

function parsePidList(stdout) {
  const pids = new Set()
  for (const token of String(stdout).split(/\s+/u)) {
    const pid = Number(token)
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 进程的镜像名 / 可执行名（查不到返回空串）。 */
export async function processImageName(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024,
      })
      const line = String(stdout).split(/\r?\n/u).find((row) => row.trim().startsWith('"'))
      if (line === undefined) return ''
      return line.slice(0, line.indexOf('"', 1)).replace(/^"/u, '')
    }
    const { stdout } = await run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 6000 })
    const name = String(stdout).trim().split(/\r?\n/u)[0] ?? ''
    // Linux 的 comm 会截到 15 字符，取 basename 之后按前缀再匹配一次。
    return name
  } catch { return '' }
}

/** 镜像名是否属于网关自己（唯一允许强杀的白名单）。 */
export function isGatewayImage(image) {
  const name = String(image ?? '').trim().toLowerCase()
  if (name === '') return false
  if (GATEWAY_IMAGES.has(name)) return true
  // Linux 的 comm 最多 15 字符：wb2api-server 会被截成 wb2api-server（刚好）或更短。
  return name.startsWith('wb2a-server') || name.startsWith('wb2api-server')
}

/** 强杀一个已知是网关的进程。失败不抛 —— 由调用方用「端口是否释放」判定结果。 */
export async function forceKill(pid) {
  try {
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
      return true
    }
    process.kill(pid, 'SIGKILL')
    return true
  } catch { return false }
}

/**
 * 小睡。
 *
 * **刻意不 unref**：这里的等待是被 `await` 的，而 unref 的定时器不会让事件循环
 * 保持存活 —— 「只剩它在等」时进程会提前退出（宿主里不会，但冒烟脚本里会）。
 */
function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}
