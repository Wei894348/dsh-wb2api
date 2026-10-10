#!/usr/bin/env node
/**
 * 请求体冒烟：盯两件「悄悄坏掉且不报错」的事 ——
 *   1. system（人格 / 指令）有没有进请求。丢了它，网关照常 200 回包，模型却不认人格，
 *      症状是"回答得不像"，而不是报错 —— 极易被当成模型问题而不是适配器问题。
 *   2. 展示用的裸模型名有没有被还原成网关认的 `realm:id`。
 *
 * 用法：node tools/wb_request_smoke.mjs
 */

import { GatewayChat, serializeMessages } from '../lib/gw/chat.js'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 目录桩：find 永远命中，realm 固定 cn。 */
const catalog = {
  find: async (id) => ({
    id,
    name: id,
    realm: 'cn',
    bareId: String(id).replace(/^cn:/, ''),
    context: { contextWindow: 1000 },
  }),
  get: async () => [],
}

function adapter () {
  return new GatewayChat({
    providerId: 'workbuddy2api',
    baseURL: 'http://127.0.0.1:7863/v1',
    apiKeyResolver: async () => 'KEY',
    catalog,
    config: { requestTimeoutSeconds: 5, firstTokenTimeoutSeconds: 5, idleTimeoutSeconds: 5 },
  })
}

/** dsh 的 createSystemMessage 形态：content 是 text block 数组。 */
const sysMsg = (text) => ({ role: 'system', id: 'sys-1', content: [{ type: 'text', text }] })
const userMsg = (text) => ({ role: 'user', id: 'u-1', content: [{ type: 'text', text }] })

const PERSONA = '你是麻衣学姐——学弟在这台机器上为你搭建的人。'
const EXTRA = '你的工作目录是 F:\\x。'

const build = (options, entry = null) =>
  adapter().buildRequestBody(options, serializeMessages(options.messages, new Map()), [], entry)

// 1. 历史里的 system（人格载体）必须进请求
{
  const messages = [sysMsg(PERSONA), userMsg('麻衣学姐')]
  const wire = serializeMessages(messages, new Map())
  const sys = wire.filter((m) => m.role === 'system')
  record('serializeMessages 保留 role:system（人格不再被丢）',
    sys.length === 1 && sys[0].content === PERSONA, `system 条数=${sys.length}`)
}

// 2. options.system 与历史 system 内容不同 → 两条都保留（官方是两处合并）
{
  const body = build({ model: 'glm-5.0-turbo', messages: [sysMsg(PERSONA), userMsg('hi')], system: EXTRA })
  const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content)
  record('options.system 与历史 system 并存',
    sys.length === 2 && sys.includes(PERSONA) && sys.includes(EXTRA), `system 条数=${sys.length}`)
}

// 3. 两处内容完全相同 → 去重，别把同一段发两遍
{
  const body = build({ model: 'glm-5.0-turbo', messages: [sysMsg(PERSONA), userMsg('hi')], system: PERSONA })
  const sys = body.messages.filter((m) => m.role === 'system')
  record('相同内容去重', sys.length === 1, `system 条数=${sys.length}`)
}

// 4. 只有 options.system → 仍然带上
{
  const body = build({ model: 'glm-5.0-turbo', messages: [userMsg('hi')], system: 'ONLY-OPTIONS' })
  const sys = body.messages.filter((m) => m.role === 'system')
  record('只有 options.system 时仍会带上',
    sys.length === 1 && sys[0].content === 'ONLY-OPTIONS', `system 条数=${sys.length}`)
}

// 5. 两处都没有 → 不凭空造 system
{
  const body = build({ model: 'glm-5.0-turbo', messages: [userMsg('hi')] })
  record('无 system 时不硬塞', body.messages.every((m) => m.role !== 'system'), '')
}

// 6. 展示裸名 → 网关 wire id
{
  const entry = await catalog.find('glm-5.0-turbo')
  const body = build({ model: 'glm-5.0-turbo', messages: [userMsg('hi')] }, entry)
  record('裸模型名还原成 cn:xxx', body.model === 'cn:glm-5.0-turbo', body.model)
}

// 7. 目录查不到 → 原样透传（交网关判错）
{
  const body = build({ model: 'mystery-model', messages: [userMsg('hi')] })
  record('目录未命中时原样透传', body.model === 'mystery-model', body.model)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
