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

import { ModelCatalog } from '../lib/gw/catalog.js'

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
