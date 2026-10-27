#!/usr/bin/env node
/**
 * 宿主两处新契约的冒烟：`/dsh-wb2api/models` 的倍率 / 显示名，以及
 * `/dsh-wb2api/checkin-status` 的签到行映射。
 *
 * 为什么不只是「读代码 + node --check」：
 * `fetchModels()` 没导出，但**整条路由**是可以通过 `apply()` 挂到一个假 webServer 上
 * 直接调的 —— 于是能拿一个真 HTTP 假网关（node:http，临时端口）把请求真发出去，
 * 断言字段是否原样透传。这比静态验证强得多，且不需要改动对外导出面。
 *
 * 两条纪律：
 *  1. **绝不写真实的 `~/.dsh`**。RUNTIME_DIR 由 homedir() 推出，所以本脚本把自己
 *     重跑一遍，子进程里 USERPROFILE / HOME 指向临时目录（自建自删）。
 *  2. 子进程带 `WB2API_NO_AUTO_ACTIVITY=1`：这是插件里「打开面板顺手签到」的开关，
 *     冒烟不该真打上游（付费上游的纪律）。
 *
 * 用法：node tools/wb_host_fields_smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const FAKE_PORT = 18999

// ── 父进程：把子进程的「家目录」换到临时目录 ─────────────────────────────────
// 子进程里 RUNTIME_DIR = join(homedir(), '.dsh', 'wb2api')，换掉 homedir 即隔离。
if (process.env.WB2API_SMOKE_HOME === undefined) {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'wb2api-smoke-'))
  const child = spawnSync(process.execPath, [SELF, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      USERPROFILE: sandboxHome,
      HOME: sandboxHome,
      WB2API_SMOKE_HOME: sandboxHome,
      WB2API_NO_AUTO_ACTIVITY: '1',
    },
  })
  rmSync(sandboxHome, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}

// ── 子进程：此时 homedir() 已经是临时目录 ───────────────────────────────────
const RUNTIME_DIR = join(homedir(), '.dsh', 'wb2api')
if (!RUNTIME_DIR.startsWith(process.env.WB2API_SMOKE_HOME ?? '\u0000')) {
  console.error(`拒绝运行：RUNTIME_DIR 不在沙箱内（${RUNTIME_DIR}）`)
  process.exit(2)
}
mkdirSync(join(RUNTIME_DIR, 'data'), { recursive: true })

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── 假网关：只实现 GET /v1/models ───────────────────────────────────────────
const MODEL_FIXTURE = [
  {
    id: 'cn:glm-5.0-turbo',
    name: '国内版 GLM-5.0 Turbo',
    description: '日常主力，中文最稳',
    credits_mult: '0.29x',
    context_length: 131072,
    max_output_tokens: 8192,
    supports_images: false,
  },
  {
    id: 'global:claude-x',
    name: 'Claude X (global)',
    description: '',
    credits_mult: '1.5x',
    context_length: 200000,
    max_output_tokens: 0,
    supports_images: true,
  },
]

let fixture = MODEL_FIXTURE
let seenAuth = null
let seenUrl = null
const gateway = createServer((req, res) => {
  seenAuth = req.headers.authorization ?? null
  seenUrl = req.url ?? null
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: fixture }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

/** 网关地址由 config.json 的 listen 推出（只取端口），所以先落一份配置。 */
writeFileSync(join(RUNTIME_DIR, 'config.json'), JSON.stringify({
  listen: `127.0.0.1:${FAKE_PORT}`,
  api_key: 'SMOKE-KEY',
}, null, 2), 'utf8')

await new Promise((done, fail) => {
  gateway.once('error', fail)
  gateway.listen(FAKE_PORT, '127.0.0.1', done)
})

// ── 把插件挂到一个假 webServer 上，拿到各路由的 handler ─────────────────────
const routes = new Map()
const host = {
  effect: (fn) => fn(),
  webServer: {
    register: (definition) => { routes.set(definition.path, definition) },
  },
}
const ctx = {
  inject: (_deps, callback) => callback(host),
  plugin: () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}

const plugin = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)
plugin.apply(ctx, {})
// mountGateway 是「发了就不等」的动态 import，给它一拍落地时间（失败也只是少挂网关托管）。
await new Promise((done) => setTimeout(done, 200))

/** 直接调路由 handler，模拟宿主 webServer 的 request/response。 */
async function call(path) {
  const definition = routes.get(path)
  if (definition === undefined) throw new Error(`路由未注册：${path}`)
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (chunk) => { if (chunk !== undefined) text = String(chunk) },
  }
  // GET 路由不读 body，但 handler 签名统一带 req，给一个可迭代的空体。
  const req = { method: 'GET', url: path, async *[Symbol.asyncIterator]() {} }
  await definition.handler(req, res)
  return { status, body: text === '' ? undefined : JSON.parse(text) }
}

console.log(`\n沙箱 RUNTIME_DIR = ${RUNTIME_DIR}\n`)

// ── 1. 路由注册面 ───────────────────────────────────────────────────────────
record('/dsh-wb2api/models 已注册', routes.has('/dsh-wb2api/models'))
record('/dsh-wb2api/checkin-status 已注册', routes.has('/dsh-wb2api/checkin-status'))
record('/dsh-wb2api/tasks/status 已注册', routes.has('/dsh-wb2api/tasks/status'))

// ── 2. /models：name / description / creditsMult 透传 ───────────────────────
{
  const { status, body } = await call('/dsh-wb2api/models')
  const models = body?.models ?? []
  record('/models 200', status === 200 && body?.ok === true, `status=${status}`)
  record('假网关收到 api_key（config.json 的 api_key）', seenAuth === 'Bearer SMOKE-KEY',
    `authorization=${JSON.stringify(seenAuth)} url=${seenUrl}`)
  record('/models 条数', models.length === 2, `${models.length} 条`)
  record('/models name 透传', models[0]?.name === '国内版 GLM-5.0 Turbo', JSON.stringify(models[0]?.name))
  record('/models displayName 兼容别名一致', models[0]?.displayName === models[0]?.name,
    JSON.stringify(models[0]?.displayName))
  record('/models description 透传', models[0]?.description === '日常主力，中文最稳',
    JSON.stringify(models[0]?.description))
  record('/models creditsMult 透传', models[0]?.creditsMult === '0.29x' && models[1]?.creditsMult === '1.5x',
    `${JSON.stringify(models[0]?.creditsMult)} / ${JSON.stringify(models[1]?.creditsMult)}`)
  record('/models 其余旧字段仍在', models[0]?.contextLength === 131072 && models[0]?.maxOutputTokens === 8192
    && models[0]?.supportsImages === false && models[1]?.supportsImages === true,
  `ctx=${models[0]?.contextLength} out=${models[0]?.maxOutputTokens} img=${models[1]?.supportsImages}`)
  // 空串也照原样透传（不把「网关明确给了空描述」改成 undefined）
  record('/models 空 description 原样透传', models[1]?.description === '',
    JSON.stringify(models[1]?.description))
}

// ── 3. /models：可选字段必须**缺键**，缺 id 的条目被滤掉 ────────────────────
{
  fixture = [
    { id: 'cn:no-mult', context_length: 1000 },
    { id: 'cn:empty-mult', credits_mult: '', name: 'x' },
    { id: '', name: '没有 id 的脏条目' },
    { credits_mult: '9x' },
  ]
  const { body } = await call('/dsh-wb2api/models')
  const models = body?.models ?? []
  record('无 credits_mult → 不带 creditsMult 键', models.length === 2 && !('creditsMult' in models[0]),
    `keys=${JSON.stringify(Object.keys(models[0] ?? {}))}`)
  record('credits_mult 为空串 → 也不带键', models.length === 2 && !('creditsMult' in models[1]))
  record('缺 id 的条目被滤掉', models.every((m) => m.id !== '') && models.length === 2, `${models.length} 条`)
  record('缺 name / description → 空串', models[0]?.name === '' && models[0]?.description === '')
}

// ── 4. /models：网关直接回裸数组时（现有行为，保持不动）────────────────────
// 说明：`fetchModels` 只认 `{data:[...]}`，裸数组会得到空目录 —— 这是既有实现，
// 本任务明确「保持」。这里把整条路由指到第二个假网关上实测一遍，把现状钉住，
// 免得将来有人以为是本次改动弄坏的。
{
  const bare = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(MODEL_FIXTURE))
  })
  await new Promise((done) => bare.listen(FAKE_PORT + 1, '127.0.0.1', done))
  writeFileSync(join(RUNTIME_DIR, 'config.json'), JSON.stringify({
    listen: `127.0.0.1:${FAKE_PORT + 1}`,
    api_key: 'SMOKE-KEY',
  }, null, 2), 'utf8')
  const { status, body } = await call('/dsh-wb2api/models')
  record('裸数组响应 → 200 + 空目录（记录现状，未改动）',
    status === 200 && body?.ok === true && Array.isArray(body?.models) && body.models.length === 0,
    `status=${status} models=${body?.models?.length}`)
  await new Promise((done) => bare.close(done))
  // 还原到主假网关，后面的用例还要用它。
  writeFileSync(join(RUNTIME_DIR, 'config.json'), JSON.stringify({
    listen: `127.0.0.1:${FAKE_PORT}`,
    api_key: 'SMOKE-KEY',
  }, null, 2), 'utf8')
  fixture = MODEL_FIXTURE
}

// ── 5. /checkin-status：真实样例 ────────────────────────────────────────────
const REAL_RECORD = {
  ok: true,
  result: {
    day: '2026-10-21',
    kind: 'checkin',
    results: [{
      uid: 'u-1f3c9a2b-real',
      nickname: 'Shantanu',
      ok: true,
      message: '今天已签到，请明天再来',
      at: 1792542601962,
      already: true,
    }],
  },
}
{
  writeFileSync(join(RUNTIME_DIR, 'data', 'autocheckin-last.json'), JSON.stringify(REAL_RECORD), 'utf8')
  const { status, body } = await call('/dsh-wb2api/checkin-status')
  record('/checkin-status 200 + ok', status === 200 && body?.ok === true, `status=${status}`)
  record('/checkin-status auto=true', body?.auto === true, JSON.stringify(body?.auto))
  record('/checkin-status day', body?.day === '2026-10-21', JSON.stringify(body?.day))
  const row = body?.rows?.[0]
  record('/checkin-status already → state=already', row?.state === 'already', JSON.stringify(row?.state))
  record('/checkin-status accountId 取 uid', row?.accountId === 'u-1f3c9a2b-real', JSON.stringify(row?.accountId))
  record('/checkin-status 行内 day / atMs / reason',
    row?.day === '2026-10-21' && row?.atMs === 1792542601962 && row?.reason === '今天已签到，请明天再来',
    `${row?.day} ${row?.atMs} ${JSON.stringify(row?.reason)}`)
}

// ── 6. /checkin-status：四种 state 的全量映射 ───────────────────────────────
{
  writeFileSync(join(RUNTIME_DIR, 'data', 'autocheckin-last.json'), JSON.stringify({
    ok: true,
    result: {
      day: '2026-10-22',
      kind: 'checkin',
      results: [
        { uid: 'A', ok: true, message: '签到成功', at: 1000 },
        { uid: 'B', ok: true, message: '今天已签到，请明天再来', at: 2000, already: true },
        { uid: 'C', ok: false, message: '活动未开启', at: 3000 },
        { uid: 'D', ok: false, message: '当前无进行中的活动', at: 4000 },
        { uid: 'E', ok: false, message: 'HTTP 500', at: 5000 },
        { uid: 'F', ok: false, message: '登录身份过期', at: 6000 },
        { nickname: '没有 uid', ok: true, message: 'x', at: 7000 },
        null,
      ],
    },
  }), 'utf8')
  const { body } = await call('/dsh-wb2api/checkin-status')
  const states = (body?.rows ?? []).map((row) => `${row.accountId}:${row.state}`).join(' ')
  record('ok=true → checked-in', body?.rows?.[0]?.state === 'checked-in', states)
  record('already=true 优先于 ok（即使 ok=false）',
    body?.rows?.[1]?.state === 'already' && body?.rows?.[1]?.reason === '今天已签到，请明天再来')
  record('未开启 / 无…活动 → skipped',
    body?.rows?.[2]?.state === 'skipped' && body?.rows?.[3]?.state === 'skipped', states)
  record('其它失败 → failed', body?.rows?.[4]?.state === 'failed' && body?.rows?.[5]?.state === 'failed', states)
  record('无 uid / 非对象行被跳过', body?.rows?.length === 6, `${body?.rows?.length} 行`)
}

// ── 7. /checkin-status：缺文件 / 坏 JSON 一律 200 + 空 rows ─────────────────
{
  rmSync(join(RUNTIME_DIR, 'data', 'autocheckin-last.json'), { force: true })
  const missing = await call('/dsh-wb2api/checkin-status')
  record('缺文件 → 200 + 空 rows',
    missing.status === 200 && Array.isArray(missing.body?.rows) && missing.body.rows.length === 0,
    `status=${missing.status} rows=${missing.body?.rows?.length}`)

  writeFileSync(join(RUNTIME_DIR, 'data', 'autocheckin-last.json'), '{ 这不是 JSON', 'utf8')
  const broken = await call('/dsh-wb2api/checkin-status')
  record('坏 JSON → 200 + 空 rows（绝不 500）',
    broken.status === 200 && broken.body?.ok === true && broken.body?.rows?.length === 0,
    `status=${broken.status}`)

  writeFileSync(join(RUNTIME_DIR, 'data', 'autocheckin-last.json'), 'null', 'utf8')
  const nulled = await call('/dsh-wb2api/checkin-status')
  record('内容为 null → 200 + 空 rows', nulled.status === 200 && nulled.body?.day === '', JSON.stringify(nulled.body))
}

// ── 8. 纯函数可独立断言（导出面只多这一个）─────────────────────────────────
{
  const mapped = plugin.checkinRowsFromRecord(REAL_RECORD)
  record('导出的 checkinRowsFromRecord 可直接调用', mapped.rows.length === 1 && mapped.auto === true)
  const empty = plugin.checkinRowsFromRecord(undefined)
  record('undefined 入参 → 空结果', empty.day === '' && empty.rows.length === 0 && empty.auto === true)
}

// ── 9. /tasks/status 仍带 logs ──────────────────────────────────────────────
{
  const { status, body } = await call('/dsh-wb2api/tasks/status')
  record('/tasks/status 200 且带 logs 字段',
    status === 200 && Array.isArray(body?.logs) && body?.running === false,
    `keys=${JSON.stringify(Object.keys(body ?? {}))}`)
}

// ── 10. 真实 ~/.dsh 未被写入（父进程隔离生效的自检）─────────────────────────
{
  const real = join(process.env.WB2API_SMOKE_HOME, '.dsh', 'wb2api', 'config.json')
  record('所有落盘都在沙箱里', existsSync(real) && readFileSync(real, 'utf8').includes('SMOKE-KEY'))
}

await new Promise((done) => gateway.close(done))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
// 刻意不用 process.exit()：Windows 上在句柄还没收尾时强退会踩 libuv 断言
// （`!(handle->flags & UV_HANDLE_CLOSING)`，async.c line 94）。那句话是在全部结果
// 输出**之后**才炸的，退出码却变成 1 —— 看起来像用例失败，实际是用例全过。
// 只设退出码，让事件循环自己走完。
process.exitCode = failed.length === 0 ? 0 : 1
