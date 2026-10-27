/**
 * 「重启网关」冒烟 —— `POST /dsh-wb2api/restart` 背后的三条路径。
 *
 * 全部在**一次性端口 + 临时工作目录**上跑：
 *   - 不碰现场网关（7863），不写 `~/.dsh/wb2api`，不打上游；
 *   - 拉起的是随包自带的真实 `backend/bin/wb2a-server.exe`，走真实的 `/healthz`；
 *   - 只借用 `GatewaySupervisor` 的进程托管，sidecar 与二进制安装同步都打桩掉
 *     （否则测试会去动现场那份 exe / 往现场 data 目录写日志）。
 *
 * 三条路径：
 *   1. 正常重启 —— 先 graceful 停，再拉起，pid 变了、端口还是它；
 *   2. 孤儿网关 —— supervisor 丢了句柄（`external`），端口被上一个网关占着：
 *      必须按端口认出镜像名、强杀、再拉起（这是「抽风点一下就活」的关键路径）；
 *   3. 端口被**别的程序**占着 —— 必须报错、而且一个字都不许动那个进程。
 *
 * 用法：node tools/wb_restart_smoke.mjs
 */
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewaySupervisor, STATE } from '../lib/gw/proc.js'
import { gatewayLink } from '../lib/gw/link.js'
import {
  findListeningPids, isGatewayImage, processImageName, restartGateway,
} from '../lib/gw/restart.js'

const here = dirname(fileURLToPath(import.meta.url))
const BINARY = resolve(here, '..', 'backend', 'bin', process.platform === 'win32' ? 'wb2a-server.exe' : 'wb2a-server')

let pass = 0
const fail = []
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail.push(label + (detail === '' ? '' : ` —— ${detail}`))
    console.log(`  FAIL  ${label}${detail === '' ? '' : ' —— ' + detail}`)
  }
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

/** 端口空着吗（连不上 = 空着）。 */
function portOpen(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const finish = (open) => { clearTimeout(timer); socket.destroy(); done(open) }
    const timer = setTimeout(() => finish(false), 400)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

async function pickPort(from = 7901, to = 7940) {
  for (let port = from; port <= to; port += 1) {
    if (!(await portOpen(port))) return port
  }
  throw new Error('找不到空闲端口（7901-7940 全被占了）')
}

/**
 * dsh subprocess 服务的最小替身：`spawn()` 返回 proc.js 需要的那四个字段
 * （pid / stderr / done / terminate）。terminate 发 SIGTERM 并最多等 graceMs，
 * 与宿主侧语义一致 —— 这样「正常停」这条路测的是真代码。
 */
function makeSubprocess() {
  return {
    spawn({ argv, cwd, env, graceMs = 5000 }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stdout?.on('data', () => { /* 只是排空管道，不留 */ })
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
      const done = new Promise((doneResolve) => {
        child.once('exit', (code, signal) => doneResolve({ exitCode: code, signal }))
        child.once('error', (error) => doneResolve({ exitCode: -1, signal: String(error?.code ?? 'error') }))
      })
      return {
        pid: child.pid,
        stderr: child.stderr,
        done,
        terminate: async () => {
          child.kill('SIGTERM')
          await Promise.race([done, sleep(graceMs)])
        },
        raw: child,
      }
    },
  }
}

/** 一次性工作目录：网关的 config.json / auths / data 都在这里，与现场完全隔离。 */
function makeRuntime(port) {
  const root = mkdtempSync(join(tmpdir(), 'wb-restart-smoke-'))
  mkdirSync(join(root, 'auths'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'config.json'), `${JSON.stringify({
    admin: { enabled: true },
    auth_dir: './auths',
    state_file: './data/state.json',
    listen: `127.0.0.1:${port}`,
    api_key: 'smoke-key',
  }, null, 2)}\n`, 'utf8')
  return root
}

async function main() {
  if (!existsSync(BINARY)) {
    console.log(`SKIP  随包二进制不存在：${BINARY}`)
    return 0
  }
  const port = await pickPort()
  const root = makeRuntime(port)
  console.log(`端口=${port}  工作目录=${root}`)

  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    listenPort: port,
    apiKeyRef: 'WB2API_SMOKE_KEY',
    binaryPath: BINARY,
    repoPath: '',
    workingDir: root,
    autoStart: false,
    healthTimeoutSeconds: 1,
    graceMs: 3000,
    crashRestartLimit: 0,
    modelsTtlSeconds: 600,
    env: {},
  }
  const supervisor = new GatewaySupervisor({ config, subprocess: makeSubprocess(), logger: {} })
  // 两处打桩：都不影响被测逻辑，只是为了「测试不碰现场」。
  supervisor.installBinaryFromBundled = () => null
  supervisor.startSidecars = async () => undefined

  gatewayLink.config = config
  gatewayLink.supervisor = supervisor
  gatewayLink.catalog = { get: async () => [] }

  let foreignServer = null
  try {
    // ── 0) 底座：先让网关真起来 ────────────────────────────────────────────
    console.log('\n[0] 起点：拉起网关')
    const started = await supervisor.start()
    check('网关启动后 state 不是 failed', started.state !== STATE.FAILED, String(started.lastError ?? ''))
    const firstPid = started.pid
    check('拿到了 pid', Number.isInteger(firstPid) && firstPid > 0, String(firstPid))
    check('端口已监听', await portOpen(port))

    // ── 1) 正常重启：graceful 停 → 起，pid 必换、端口不变 ────────────────────
    console.log('\n[1] 正常重启（graceful）')
    const normal = await restartGateway()
    check('state 不是 failed', normal.state !== 'failed', String(normal.state))
    check('没有强杀（走的是 graceful）', normal.killed.length === 0, JSON.stringify(normal.killed))
    check('pid 变了', normal.pid !== firstPid, `${firstPid} → ${normal.pid}`)
    check('端口回到监听', await portOpen(port))
    check('拿到 health 快照', normal.health !== null && typeof normal.health === 'object', String(normal.health))
    check('步骤里带了「重新拉起」', normal.steps.some((s) => s.includes('重新拉起')), normal.steps.join(' | '))

    // ── 2) 孤儿网关：supervisor 丢了句柄，端口被上一个网关占着 ────────────────
    console.log('\n[2] 孤儿网关（supervisor 眼里是 external）')
    const orphanPid = normal.pid
    supervisor.handle = null
    supervisor.state = STATE.EXTERNAL
    const rescued = await restartGateway()
    check('认出了占用者并强杀', rescued.killed.length === 1 && rescued.killed[0].pid === orphanPid,
      JSON.stringify(rescued.killed))
    check('镜像名判定为网关', isGatewayImage(rescued.killed[0]?.image ?? ''), String(rescued.killed[0]?.image))
    check('新 pid 不是被杀的那个', rescued.pid !== orphanPid, `${orphanPid} → ${rescued.pid}`)
    check('端口重新监听', await portOpen(port))

    // ── 3) 端口被别的程序占着：报错，但绝不杀它 ──────────────────────────────
    console.log('\n[3] 端口被非网关程序占用（必须不杀）')
    await supervisor.stop()
    foreignServer = http.createServer((req, res) => {
      // 故意不答 —— 「有监听但答非所问」正是端口被别的程序占着的形态。
      void req
      void res
    })
    // Windows 上刚被杀掉的监听端口偶尔还要一拍才允许重新 bind —— 重试三次。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await new Promise((done, reject) => {
          foreignServer.once('error', reject)
          foreignServer.listen(port, '127.0.0.1', () => { foreignServer.removeListener('error', reject); done() })
        })
        break
      } catch (error) {
        if (attempt >= 3) throw error
        await sleep(400)
      }
    }
    const foreignPids = await findListeningPids(port)
    const foreignImage = foreignPids.length > 0 ? await processImageName(foreignPids[0]) : ''
    check('端口上确实是别的进程', foreignPids.length > 0 && !isGatewayImage(foreignImage),
      `pids=${JSON.stringify(foreignPids)} image=${foreignImage || '?'}`)

    let refusal = ''
    try {
      await restartGateway()
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    check('拒绝重启并说明原因', refusal.includes('没动它') || refusal.includes('别的程序'), refusal)
    check('别的进程还活着（端口仍可连）', await portOpen(port))
    check('supervisor 没被留下 failed 状态', supervisor.state !== STATE.FAILED, String(supervisor.state))

    // ── 4) HTTP 路由 + 响应契约：面板按钮打的就是这条 ─────────────────────────
    // 用假 ctx 把父插件 apply 起来，抓它注册的路由 —— 不启 dsh、不监听端口。
    console.log('\n[4] POST /dsh-wb2api/restart 路由与响应契约')
    await new Promise((done) => { foreignServer === null ? done() : foreignServer.close(() => done()) })
    foreignServer = null

    const { apply } = await import('../lib/index.js')
    const routes = new Map()
    apply({
      logger: { info() {}, warn() {}, error() {} },
      inject(services, callback) {
        callback({
          effect(run) { run(); return () => {} },
          webServer: { register(definition) { routes.set(definition.path, definition.handler) } },
        })
      },
    }, {})

    const restartRoute = routes.get('/dsh-wb2api/restart')
    check('路由已注册', typeof restartRoute === 'function', `已注册 ${routes.size} 条`)

    const makeRes = () => ({
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(body) { this.body = body === undefined ? '' : String(body) },
    })

    const getRes = makeRes()
    await restartRoute({ method: 'GET', url: '/dsh-wb2api/restart' }, getRes)
    check('GET 被 405 挡住', getRes.status === 405, `status=${getRes.status}`)

    const postRes = makeRes()
    await restartRoute({ method: 'POST', url: '/dsh-wb2api/restart' }, postRes)
    const payload = (() => { try { return JSON.parse(postRes.body) } catch { return null } })()
    check('响应是 JSON 且 ok:true', payload !== null && payload.ok === true, postRes.body.slice(0, 200))
    const snapshot = payload?.restart
    check('带回重启快照（state / pid / tookMs）',
      snapshot !== undefined && snapshot.state !== 'failed'
        && Number.isInteger(snapshot.pid) && snapshot.tookMs >= 0,
      JSON.stringify(snapshot ?? null).slice(0, 240))
    check('快照里有步骤流水', Array.isArray(snapshot?.steps) && snapshot.steps.length >= 2,
      JSON.stringify(snapshot?.steps ?? null))
  } finally {
    await new Promise((done) => { foreignServer === null ? done() : foreignServer.close(() => done()) })
    await supervisor.stop().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n结果：PASS ${pass} / FAIL ${fail.length}`)
  if (fail.length > 0) {
    for (const item of fail) console.log(`  - ${item}`)
    return 1
  }
  return 0
}

main().then((code) => { process.exitCode = code }, (error) => {
  console.error(error)
  process.exitCode = 1
})
