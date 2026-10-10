/**
 * 后端服务（本地网关）的插件入口。
 *
 * 它做四件事：注册 LLM provider 路由、托管网关进程、注册六条 `/wb2api-*` 命令、
 * 并在插件卸载时把进程收干净。面板与任务引擎在父插件里，与本文件无关。
 */

import { appendFileSync, mkdirSync, renameSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import { PROVIDER, SETTINGS_NS, resolveConfig, settingsSchema, gatewayOrigin } from './settings.js'
import {
  defaultInstallDir, defaultRuntimeDir, ensureRuntimeDir, readGatewayConfig,
  resolveAuthDir, resolveWorkingDir, writeDefaultGatewayConfig,
} from './runtime.js'
import { GatewaySupervisor, STATE } from './proc.js'
import { ModelCatalog } from './catalog.js'
import { GatewayChat } from './chat.js'
import { CredentialStore, parseAccountSelector } from './credentials.js'
import { AuthorizePendingError, LoginClient, buildAuthFile, parseRealmArg, resolveRealmInput, writeAuthFile } from './authorize.js'
import { GatewayBinaryInstaller, resolveInstalledBinary } from './binary.js'
import { BootstrapRunner, renderBootstrapReport } from './bootstrap.js'
import { renderAccountSection, renderReadySummary, renderStatus, shortUid } from './render.js'

export const name = 'wb2api-gateway'

export const inject = ['llm', 'subprocess', 'commands']

const providerSettingsSchema = settingsSchema(Schema)

/**
 * 诊断留痕：设 `WB2API_DEBUG_LOG=1` 才写。
 * dsh 的插件 logger 在 web 模式下不落盘，静默失败完全无迹可循 —— 排查时把开关打开即可。
 */
function gwTrace(message) {
  if (!process.env.WB2API_DEBUG_LOG) return
  try {
    const dir = defaultRuntimeDir() + '/data'
    mkdirSync(dir, { recursive: true })
    appendFileSync(dir + '/gw-debug.log', `${new Date().toISOString()} [gw] ${message}\n`, 'utf8')
  } catch { /* 诊断失败不影响主流程 */ }
}

export function apply(ctx, rawConfig) {
  gwTrace('apply 进入')

  const config = resolveConfig(rawConfig)
  const log = ctx.logger ?? {}

  registerProviderSettings(ctx)

  const subprocess = ctx.get('subprocess')
  let supervisor = null
  if (subprocess && typeof subprocess.spawn === 'function') {
    supervisor = new GatewaySupervisor({ config, subprocess, logger: log })
    gwTrace('supervisor 已建，autoStart=' + config.autoStart)
  } else {
    gwTrace('subprocess 服务不可用（ctx.get 返回 ' + String(subprocess) + '）')
    log.error?.('[wb2api] subprocess 服务不可用，无法托管网关进程')
  }

  const accountStore = new CredentialStore({ authDir: resolveAuthDir(config, null) })
  const installer = new GatewayBinaryInstaller({
    installDir: defaultInstallDir(),
    releaseRepo: config.binaryReleaseRepo,
    releaseBase: config.binaryReleaseBase,
  })
  const loginClient = new LoginClient({})
  const catalog = new ModelCatalog({
    baseURL: config.baseURL,
    apiKey: () => resolveApiKey(ctx, config),
    ttlMs: config.modelsTtlSeconds * 1000,
    // CN 是绝大多数账号的默认集合，模型下拉里逐条重复 `cn:` 只是噪音。
    // 剥前缀只影响 dsh 侧的模型 id；发给网关前由 chat.js 过 toWireModel 还原
    // 成 `cn:xxx`（global 模型保留前缀，用户需要一眼看出它走海外出口）。
    policy: 'strip-cn',
  })

  let apiKeyResolver = () => resolveApiKey(ctx, config)
  const adapter = new GatewayChat({
    providerId: PROVIDER,
    baseURL: config.baseURL,
    apiKeyResolver: () => apiKeyResolver(),
    catalog,
    attachments: ctx.get('attachments'),
    config,
    logger: log,
  })

  let routeOwnedByOther = false
  try {
    ctx.llm.registerConfigurableProviders([{
      provider: PROVIDER,
      displayName: 'WorkBuddy (workbuddy2api 网关)',
      settingsNs: SETTINGS_NS,
      settingsPath: ['providers', PROVIDER],
      declared: false,
    }])
  } catch (error) {
    routeOwnedByOther = true
    logRouteConflict(ctx, 'provider 目录', error)
  }
  try {
    ctx.llm.registerAdapter([PROVIDER], adapter)
  } catch (error) {
    routeOwnedByOther = true
    logRouteConflict(ctx, '适配器', error)
  }
  if (routeOwnedByOther) {
    log.error?.(`[wb2api] provider 路由 "${PROVIDER}" 被外部配置占用：`
      + '删除 ~/.dsh/settings.yaml 里的 llm-pi-ai.providers.workbuddy2api 段后重启 dsh。'
      + 'provider id 不变，agent-default-model 等引用无需改动。')
  }

  registerCommands(ctx, {
    config, supervisor, accountStore, installer, loginClient, catalog, log,
    authDir: () => accountStore.authDir,
    apiKey: () => apiKeyResolver(),
    routeOwnedByOther,
  })

  // 清理函数必须由回调**返回**：ctx.effect 的约定是「回调在卸载时执行返回的函数」，
  // 直接 `ctx.effect(() => { dispose() })` 会在挂载瞬间就 dispose —— 网关刚建好就被
  // 标记为销毁，start() 只会返回 stopped（这个坑真踩过一次）。
  ctx.effect(() => () => { void supervisor?.dispose() }, 'wb2api-gateway: 网关进程生命周期')

  // 自动拉起放到下一个 tick：不阻塞 dsh 启动，网关没起也不影响别的插件。
  if (config.autoStart && supervisor) {
    const timer = setTimeout(() => {
      void bootGateway({ config, supervisor, installer, log })
    }, 0)
    timer.unref?.()
    ctx.effect(() => () => { clearTimeout(timer) }, 'wb2api-gateway: 自动启动定时器')
  }

  log.info?.(`[wb2api] 后端服务已注册（provider=${PROVIDER} origin=${gatewayOrigin(config.baseURL)}）`)
}

// ── 启动编排 ────────────────────────────────────────────────────────────────

async function bootGateway({ config, supervisor, installer, log }) {
  gwTrace('bootGateway 进入')
  try {
    await supervisor.resolveBinary()
    gwTrace('二进制已定位：' + (supervisor.executablePath ?? '?'))
  } catch (error) {
    // 静默返回过一次，结果「网关没起来」完全无迹可循 —— 至少要留一行原因。
    gwTrace('定位二进制失败：' + error.message)
    log.warn?.(`[wb2api] 未找到网关程序：${error.message}`)
    if (!config.autoDownloadBinary) return
    try {
      await installer.ensure()
    } catch (error) {
      log.error?.(`[wb2api] 网关程序获取失败：${error.message}`)
      return
    }
  }
  let status
  try {
    status = await supervisor.start()
  } catch (error) {
    gwTrace('supervisor.start() 抛错：' + (error instanceof Error ? error.stack : String(error)))
    log.error?.(`[wb2api] 网关启动异常：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  gwTrace('supervisor.start() 返回 state=' + status.state)
  if (status.state === STATE.FAILED) {
    log.error?.(`[wb2api] 网关启动失败：${status.lastError ?? '未知原因'}`)
    return
  }
  log.info?.(renderReadySummary(status))
  if (status.health && status.health.healthy === 0) log.warn?.('[wb2api] 网关已启动但没有可用账号，请先 /wb2api-login')
}

// ── 命令 ────────────────────────────────────────────────────────────────────

function registerCommands(ctx, deps) {
  const { config, supervisor, accountStore, installer, loginClient, catalog, log } = deps
  const unavailable = { kind: 'error', text: 'subprocess 服务不可用，无法托管网关进程。' }

  ctx.commands.register({
    name: 'wb2api-status',
    description: '显示网关状态、账号清单与可用性、模型数量',
    handler: async () => {
      if (!supervisor) return unavailable
      try {
        const status = await supervisor.statusWithHealth()
        const models = await catalog.get()
        const inventory = accountStore.list()
        const live = await fetchGatewayAccounts(config, deps.apiKey).catch(() => undefined)
        const modelLine = models.length > 0
          ? `\n模型目录: ${models.length} 个（示例: ${models.slice(0, 5).map((m) => m.id).join(', ')}${models.length > 5 ? ', …' : ''}）`
          : `\n模型目录: 拉取失败${catalog.lastError ? `（${catalog.lastError}）` : ''}`
        const accountLines = inventory.length > 0
          ? `\n\n${renderAccountSection(accountStore.root, inventory, live)}`
          : `\n\n账号文件: 0 个（${accountStore.root}）—— 先跑 /wb2api-login`
        const routeLine = deps.routeOwnedByOther
          ? `\n\n⚠ provider 路由 "${PROVIDER}" 未由本插件注册（被 settings.yaml 占用），`
            + '\n请删除 ~/.dsh/settings.yaml 里的 llm-pi-ai.providers.workbuddy2api 段后重启 dsh。'
          : ''
        return { kind: 'success', text: renderStatus({ status, accounts: inventory, models: models.length, authDir: accountStore.root }) + modelLine + accountLines + routeLine }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-start',
    description: '启动网关（幂等：已有健康网关在跑则直接复用）',
    handler: async () => {
      if (!supervisor) return unavailable
      try {
        const status = await supervisor.start()
        if (status.state === STATE.EXTERNAL) {
          return { kind: 'success', text: `端口 ${status.port} 上已有健康网关，直接复用（未新建进程）。` }
        }
        return status.state === STATE.FAILED
          ? { kind: 'error', text: `启动失败：${status.lastError ?? '未知原因'}` }
          : { kind: 'success', text: renderReadySummary(status) }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-restart',
    description: '重启网关并刷新模型目录',
    handler: async () => {
      if (!supervisor) return unavailable
      try {
        const status = await supervisor.restart()
        await catalog.get(true).catch(() => undefined)
        return status.state === STATE.FAILED
          ? { kind: 'error', text: `重启失败：${status.lastError ?? '未知原因'}` }
          : { kind: 'success', text: renderReadySummary(status) }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-setup',
    description: '一键就绪：运行目录 → 网关程序 → 账号 → 启动 → 同步模型',
    handler: async (args) => {
      if (!supervisor) return unavailable
      const realm = parseRealmArg(textOf(args))
      if (textOf(args).trim() && !realm) {
        return { kind: 'error', text: `无法识别的域参数：${textOf(args)}（只认 cn / global）` }
      }
      const runner = new BootstrapRunner({
        ensureRuntime: async () => {
          const root = ensureRuntimeDir()
          const result = writeDefaultGatewayConfig()
          return { root, configCreated: result.created, path: result.path }
        },
        ensureBinary: async ({ allowDownload }) => {
          try {
            const path = await supervisor.resolveBinary()
            return { path, downloaded: false }
          } catch {
            if (!allowDownload) throw new Error('缺少网关程序，且未允许下载')
            const result = await installer.ensure()
            return { path: result.path, downloaded: true }
          }
        },
        countAccounts: async () => accountStore.list().filter((item) => item.enabled).length,
        startGateway: async () => supervisor.start(),
        refreshCatalog: async () => ({ models: (await catalog.get(true)).length }),
        logger: log,
      })
      const result = await runner.run({ realm, allowDownload: true })
      const text = renderBootstrapReport(result)
        + (result.needLogin ? '\n\n还没有账号，执行 /wb2api-login 登录后再看状态。' : '')
      return { kind: result.ready ? 'success' : 'error', text }
    },
  })

  ctx.commands.register({
    name: 'wb2api-login',
    description: 'OAuth 授权登录并写入凭证（可带 cn / global）',
    handler: async (args) => {
      const realm = resolveRealmInput(textOf(args), config.defaultRealm)
      if (!realm) return { kind: 'error', text: '请指定域：/wb2api-login cn 或 /wb2api-login global' }
      try {
        const began = await loginClient.begin(realm)
        await notifyAuthorizeUrl(ctx, began.authUrl)
        const pending = await pollAuthorization(loginClient, realm, began.state)
        if (!pending) {
          return { kind: 'error', text: '等待授权超时（60 秒）。授权链接每次都会重新生成，请重跑本命令。' }
        }
        const doc = buildAuthFile({ ...pending, realm })
        const path = await writeAuthFile(accountStore.root, doc)
        if (supervisor) await supervisor.restart().catch(() => undefined)
        return { kind: 'success', text: `已写入凭证：${path}\n账号：${pending.nickname ?? shortUid(pending.uid)}（${realm}）` }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })

  ctx.commands.register({
    name: 'wb2api-account',
    description: '查看或切换账号：auto / 序号 / uid 前缀',
    handler: async (args) => {
      if (!supervisor) return unavailable
      const inventory = accountStore.list()
      if (inventory.length === 0) return { kind: 'error', text: `账号文件为 0（${accountStore.root}），先跑 /wb2api-login` }
      const input = textOf(args).trim()
      try {
        if (!input) {
          const lines = inventory.map((item, index) => {
            const label = item.nickname || shortUid(item.uid)
            return `${index + 1}. ${label}（${shortUid(item.uid)}）${item.enabled ? '' : ' [已禁用]'}`
          })
          return { kind: 'success', text: `当前账号：\n${lines.join('\n')}\n\n用法：/wb2api-account auto | <序号> | <uid 前缀>` }
        }
        const selection = parseAccountSelector(input, inventory)
        // 顺序必须是「停 → 改名 → 启」：网关运行中会按内存里的旧路径原子写回凭证，
        // 有可能把刚改名的文件重新创建出来（表现是切换成功、一分钟后又变回去）。
        await supervisor.stop()
        try {
          // applySelection 只算计划，执行在这里：先停网关再改名，顺序反了会被写回覆盖。
          for (const step of accountStore.applySelection(selection.uids)) renameSync(step.from, step.to)
        } catch (error) {
          await supervisor.start().catch(() => undefined)
          throw error
        }
        const status = await supervisor.start()
        await catalog.get(true).catch(() => undefined)
        return { kind: 'success', text: `已切换账号。\n${renderReadySummary(status)}` }
      } catch (error) {
        return { kind: 'error', text: errorMessage(error) }
      }
    },
  })
}

// ── 辅助 ────────────────────────────────────────────────────────────────────

/**
 * 注册 provider 的 settings namespace。
 *
 * 它存在的意义不是给用户填配置，而是给模型设置页一个合法地址：namespace 缺失时，
 * 设置页会在 `deriveKeyRef(provider)` 处崩。schema 必须是 `Schema.object({...})`——
 * 传裸函数会让 `describe()` 抛 `schema.toJSON is not a function`，连带主题、sidebar
 * 的 settings API 全部失败。
 */
function registerProviderSettings(ctx) {
  const settings = ctx.get('settings')
  if (!settings || typeof settings.register !== 'function') {
    ctx.logger?.warn?.('[wb2api] settings 服务不可用，provider namespace 未注册')
    return
  }
  try {
    settings.register(SETTINGS_NS, providerSettingsSchema)
  } catch (error) {
    ctx.logger?.warn?.(`[wb2api] settings namespace "${SETTINGS_NS}" 注册失败: ${String(error)}`)
    return
  }
  try {
    const namespaces = (settings.describe?.({ redactSecrets: true }) ?? []).map((item) => item.ns)
    if (!namespaces.includes(SETTINGS_NS)) ctx.logger?.warn?.(`[wb2api] provider namespace 未生效: ${SETTINGS_NS}`)
  } catch (error) {
    ctx.logger?.error?.(`[wb2api] settings.describe 失败：${errorMessage(error)}`)
  }
}

/**
 * api_key 三级解析：凭据库 → 同名环境变量 → 网关自己的 config.json。
 * 同机部署时第三级必中，所以最常见情形下零额外配置。
 */
async function resolveApiKey(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.get === 'function') {
    try {
      const fromStore = await credentials.get(config.apiKeyRef)
      if (typeof fromStore === 'string' && fromStore.length > 0) return fromStore
    } catch { /* 继续降级 */ }
  }
  const fromEnv = process.env[config.apiKeyRef]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const gatewayConfig = readGatewayConfig(resolveWorkingDir(config, null), config)
  const fromFile = gatewayConfig?.api_key
  if (typeof fromFile === 'string' && fromFile.length > 0) return fromFile
  return ''
}

/** `/status`（鉴权）拿账号实时字段。失败返回 undefined，不阻断调用方。 */
async function fetchGatewayAccounts(config, apiKey) {
  const key = await apiKey()
  if (!key) return undefined
  const response = await fetch(`${gatewayOrigin(config.baseURL)}/status`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(config.healthTimeoutSeconds * 1000),
  })
  if (!response.ok) return undefined
  const body = await response.json()
  return Array.isArray(body?.accounts) ? body.accounts : undefined
}

/** 授权链接：能弹窗就弹，不能就打日志让用户自己点。 */
async function notifyAuthorizeUrl(ctx, url) {
  ctx.logger?.info?.(`请在浏览器打开完成授权：\n${url}`)
  const questions = ctx.get('userQuestions')
  if (!questions || typeof questions.ask !== 'function') return
  try {
    await questions.ask({ prompt: `打开授权链接完成登录，然后点「已完成授权」：\n${url}`, options: ['已完成授权，继续'] })
  } catch { /* 弹不了就算了，链接已经打在日志里 */ }
}

/** 轮询授权结果：只有「还没点授权」才重试，其余错误立刻放弃。 */
async function pollAuthorization(client, realm, state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await client.complete(realm, state)
    } catch (error) {
      if (!(error instanceof AuthorizePendingError)) return undefined
      await new Promise((done) => setTimeout(done, 3000))
    }
  }
  return undefined
}

function logRouteConflict(ctx, what, error) {
  ctx.logger?.error?.(`[wb2api] ${what}注册冲突：${errorMessage(error)}`)
}

function textOf(args) {
  if (typeof args === 'string') return args
  if (Array.isArray(args)) return args.join(' ')
  if (args && typeof args === 'object') return String(args.args ?? args.text ?? args.input ?? args.raw ?? '')
  return ''
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// ── 复用出口 ────────────────────────────────────────────────────────────────

export { PROVIDER, SETTINGS_NS, resolveConfig } from './settings.js'
export { GatewaySupervisor, STATE } from './proc.js'
export { ModelCatalog, mapModel, mapModelCatalog, parseModelId, toWireModel } from './catalog.js'
export { GatewayChat, httpErrorCode, serializeMessages, toTokenUsage } from './chat.js'
export { CredentialStore, parseAccountSelector } from './credentials.js'
export { AuthorizePendingError, LoginClient, buildAuthFile, inferRealm, loginHeaders, parseRealmArg, realmEndpoints, resolveRealmInput, writeAuthFile } from './authorize.js'
export { GatewayBinaryInstaller, assetName, currentTarget, parseChecksums, resolveInstalledBinary } from './binary.js'
export { BootstrapRunner, renderBootstrapReport } from './bootstrap.js'
export { ZipError, extractFile, listEntries } from './archive.js'
export { ensureRuntimeDir, defaultRuntimeDir, resolveAuthDir, resolveWorkingDir, writeDefaultGatewayConfig } from './runtime.js'
