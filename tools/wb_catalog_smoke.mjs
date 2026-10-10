#!/usr/bin/env node
/**
 * ModelCatalog 的离线冒烟：只盯一件事 —— **apiKey 传函数时，请求头是不是正确的字符串**。
 *
 * 背景：`lib/gw/index.js` 给 catalog 传的是 `() => resolveApiKey(ctx, config)`（有异步的
 * 凭据解析，只能传函数）。catalog 早期版本直接把 `options.apiKey` 拼进
 * `Bearer ${...}`，于是发出去的是 `Bearer () => resolveApiKey(...)`，网关按密钥不对
 * 回 401 —— 而 401 里看不出密钥是谁，排查代价很高。
 *
 * 用法：node tools/wb_catalog_smoke.mjs
 *       node tools/wb_catalog_smoke.mjs --live    # 顺带打一次真网关（只读 /v1/models）
 */

import { ModelCatalog, toWireModel } from '../lib/gw/catalog.js'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 抓一次请求，返回它实际带的 authorization 头。 */
async function captureHeader (apiKey) {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init?.headers?.authorization ?? null }
    return { ok: true, status: 200, json: async () => ({ data: [] }) }
  }
  const catalog = new ModelCatalog({ baseURL: 'http://127.0.0.1:7863/v1', apiKey, fetchImpl })
  await catalog.get(true)
  return seen
}

// 1. 传函数（真实调用形态）：必须解析出字符串，且不能把函数源码拼进去
{
  const seen = await captureHeader(async () => 'KEY-FROM-FN')
  const ok = seen.auth === 'Bearer KEY-FROM-FN'
  record('函数形 apiKey → Bearer <解析值>', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// 2. 函数返回 Promise（凭据库是异步的）
{
  const seen = await captureHeader(() => Promise.resolve('KEY-ASYNC'))
  const ok = seen.auth === 'Bearer KEY-ASYNC'
  record('函数返回 Promise → Bearer <解析值>', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// 3. 传字符串（老形态，必须继续可用）
{
  const seen = await captureHeader('KEY-PLAIN')
  const ok = seen.auth === 'Bearer KEY-PLAIN'
  record('字符串形 apiKey → Bearer <值>', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// 4. 空值：不发 authorization 头，而不是发一个空的 Bearer
{
  const seen = await captureHeader('')
  const ok = seen.auth === null
  record('空 apiKey → 不带 authorization 头', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// 5. 函数抛错：降级成不带密钥，不能把异常炸穿整个目录加载
{
  const seen = await captureHeader(() => { throw new Error('credentials unavailable') })
  const ok = seen.auth === null
  record('函数抛错 → 降级为不带密钥', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// 6. 函数返回非字符串：当作空，避免拼出 "[object Object]"
{
  const seen = await captureHeader(() => ({ nope: true }))
  const ok = seen.auth === null
  record('函数返回非字符串 → 不带 authorization 头', ok, `实际: ${JSON.stringify(seen.auth)}`)
}

// ── 7-9. 展示层剥 CN 前缀 + 出方向还原 wire id（1.5.4）────────────────────────
// 背景：dsh 的模型下拉直接读 catalog 的 id。原先 policy 缺省 'keep'，下拉里每条
// 都是 `cn:glm-5.0-turbo`；剥掉后更干净，但发请求前必须用 toWireModel 把 realm
// 前缀补回去（裸名会被网关钉回 CN 集合，global 模型会走错出口）。

const MODEL_FIXTURE = [
  { id: 'cn:glm-5.0-turbo', context_length: 131072 },
  { id: 'global:claude-x', context_length: 200000 },
  { id: 'deepseek-v4', context_length: 65536 },
]

function catalogWith (list, policy) {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: list }) })
  return new ModelCatalog({ baseURL: 'http://127.0.0.1:7863/v1', apiKey: 'k', policy, fetchImpl })
}

{
  const ids = (await catalogWith(MODEL_FIXTURE, 'strip-cn').get(true)).map((m) => m.id)
  const ok = ids.join(',') === 'glm-5.0-turbo,global:claude-x,deepseek-v4'
  record('strip-cn：剥掉 cn: 前缀，global: 保留', ok, ids.join(', '))
}

{
  const ids = (await catalogWith(MODEL_FIXTURE, 'keep').get(true)).map((m) => m.id)
  const ok = ids[0] === 'cn:glm-5.0-turbo'
  record('keep：旧策略仍可用（回滚保险）', ok, ids.join(', '))
}

{
  const c = catalogWith(MODEL_FIXTURE, 'strip-cn')
  await c.get(true)
  const cn = toWireModel(c.find('glm-5.0-turbo'))    // 展示裸名 → cn:xxx
  const gl = toWireModel(c.find('global:claude-x'))  // global 原样
  const bare = toWireModel(c.find('deepseek-v4'))    // 裸名 → 补默认 realm
  const ok = cn === 'cn:glm-5.0-turbo' && gl === 'global:claude-x' && bare === 'cn:deepseek-v4'
  record('toWireModel：展示裸名能还原成网关认的 wire id', ok, `${cn} / ${gl} / ${bare}`)
}

// ── 10-12. find() 对带 realm 前缀入参的归一化（1.5.5）──────────────────────
// 背景：strip-cn 后 byId 里存的是裸名，而调用方（profile patch / 手填配置 /
// 老配置片段）完全可能传 `cn:xxx`。查不到时 resolveModel() 会返回**不带
// reasoning 字段**的兜底对象，dsh 的 resolveCallWithInfo() 直接抛
// UNSUPPORTED_REASONING_EFFORT，整轮请求被换到别的模型 —— 表现成
// "系统提示 / 人格层莫名失效"，实际是模型被换掉了。

{
  const c = catalogWith(MODEL_FIXTURE, 'strip-cn')
  await c.get(true)
  const byPrefix = c.find('cn:glm-5.0-turbo')   // 带前缀入参
  const byBare = c.find('glm-5.0-turbo')        // 展示用裸名
  const ok = byPrefix !== undefined && byPrefix === byBare && byPrefix.realm === 'cn'
  record('find()：带 cn: 前缀的入参也能命中（strip-cn 目录）', ok,
    byPrefix ? `命中 id=${byPrefix.id}` : 'NOT FOUND')
}

{
  const c = catalogWith(MODEL_FIXTURE, 'strip-cn')
  await c.get(true)
  const wire = toWireModel(c.find('cn:glm-5.0-turbo'))
  const ok = wire === 'cn:glm-5.0-turbo'
  record('find()：归一化命中后仍能还原出正确的 wire id', ok, wire)
}

{
  // 同名跨域不能拿错 realm：目录里 cn:dup 与 global:dup 同时存在
  const DUP_FIXTURE = [
    { id: 'global:dup', context_length: 1000 },
    { id: 'cn:dup', context_length: 2000 },
  ]
  const c = catalogWith(DUP_FIXTURE, 'strip-cn')
  await c.get(true)
  const cn = c.find('cn:dup')
  const gl = c.find('global:dup')
  const miss = c.find('cn:nope')
  const ok = cn?.realm === 'cn' && gl?.realm === 'global' && miss === undefined
  record('find()：归一化按 realm 精确匹配，未知名仍返回 undefined', ok,
    `cn:dup→${cn?.realm} / global:dup→${gl?.realm} / cn:nope→${miss === undefined ? 'undefined' : 'hit'}`)
}

// 可选：真网关。只读 /v1/models，不打付费上游。
if (process.argv.includes('--live')) {
  const { readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.dsh', 'wb2api', 'config.json'), 'utf8'))
    const base = `http://127.0.0.1:${String(cfg.listen ?? '127.0.0.1:7863').split(':').pop()}/v1`
    const catalog = new ModelCatalog({ baseURL: base, apiKey: async () => cfg.api_key })
    const models = await catalog.get(true)
    record(`--live 真网关 ${base}/models`, models.length > 0, `${models.length} 个模型`)
  } catch (err) {
    record('--live 真网关', false, err.message)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
