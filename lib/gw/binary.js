/**
 * 网关二进制（wb2a-server，一个 Go 写的本地 HTTP 服务）的定位与安装。
 *
 * 三条硬规矩：
 * - 先拿 SHA256SUMS.txt，拿不到校验和就不下载大文件 —— 宁可装不上，也不落一个来源不明的
 *   可执行文件到 ~/.dsh 下并 chmod +x；
 * - 只走 https，且主机白名单，避免被配置里的 URL 牵到任意站点；
 * - 原子落盘（.part → rename），中途失败不留半个可执行体，否则下次启动会 fork 一个残缺进程。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'

import { extractFile, listEntries } from './archive.js'
import { BINARY_CANDIDATES, binaryFileName, defaultInstallDir } from './runtime.js'

export { defaultInstallDir } from './runtime.js'

/** 默认仓库（owner/repo），releaseBase 未显式配置时用它在 github.com 上拼地址。 */
export const DEFAULT_RELEASE_REPO = 'Wei894348/dsh-wb2api'

/** 允许的下载主机。release assets 会 302 到 objects.githubusercontent.com，故一并放行。 */
const HOST_WHITELIST = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
])

const DEFAULT_TIMEOUT_MS = 60_000

/** release 里的资产名，与 CI 的 build 矩阵一致。 */
export function assetName() {
  const { goos, goarch } = currentTarget()
  return `wb2a-server-${goos}-${goarch}.zip`
}

/**
 * 当前平台对应的 Go 目标。
 *
 * 只覆盖官方 release 实际产出的 win32/darwin/linux × x64/arm64；
 * 其余组合（32 位、linux/arm、freebsd…）官方没有预编译包，明确抛错并给出自编译指引，
 * 而不是让用户下载到一个根本跑不起来的 amd64 包。
 */
export function currentTarget() {
  const goos = platform()
  const goarch = arch()
  const supported = { win32: ['x64', 'arm64'], darwin: ['x64', 'arm64'], linux: ['x64', 'arm64'] }
  if (!supported[goos]?.includes(goarch)) {
    throw new Error(
      `当前平台 ${goos}/${goarch} 没有预编译的网关二进制。\n` +
        '请自行编译：\n' +
        `  git clone https://github.com/${DEFAULT_RELEASE_REPO}.git\n` +
        '  cd dsh-wb2api/backend && go build -o wb2a-server .\n' +
        `  然后把 wb2a-server 放到 ${defaultInstallDir()} 下（Windows 用 .exe 后缀）。`,
    )
  }
  return { goos, goarch }
}

/**
 * 解析 SHA256SUMS.txt：`<64位hex>  <文件名>`。
 *
 * 剥 `./` 前缀是因为 CI 常用 `sha256sum ./*.zip`，产出的每一行都带 `./`；
 * 同时兼容 `hash *name`（binary 模式）与注释行。只按 basename 建索引，
 * 便于用资产名直接命中而不管发布时套了几层目录。
 */
export function parseChecksums(text) {
  const out = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64})\s+\*?(.*)$/.exec(trimmed)
    if (!m) continue
    const name = m[2].trim().replace(/^\.\//, '')
    if (!name) continue
    out.set(name.split(/[\\/]/).pop(), m[1].toLowerCase())
  }
  return out
}

/** 校验和：统一小写 hex，便于与 SHA256SUMS 直接字符串比对。 */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export class GatewayBinaryInstaller {
  constructor({ installDir, releaseRepo, releaseBase, fetchImpl, timeoutMs } = {}) {
    this.installDir = installDir || defaultInstallDir()
    this.releaseRepo = releaseRepo || DEFAULT_RELEASE_REPO
    // releaseBase 非空时以它为根（自建镜像 / 内网的场景），否则走 github releases
    this.base = String(releaseBase || `https://github.com/${this.releaseRepo}`).replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
    // 显式配了 releaseBase，就把它的主机加入白名单
    this.extraHost = releaseBase ? safeHostname(releaseBase) : null
  }

  /** `${base}/releases/latest/download/${asset}` —— latest 是 GitHub 的浮动别名，始终指向最新稳定版。 */
  releaseUrl(asset) {
    return `${this.base}/releases/latest/download/${encodeURIComponent(asset)}`
  }

  /** 已装则返回绝对路径，否则 null。 */
  installedPath() {
    for (const name of BINARY_CANDIDATES) {
      const p = join(this.installDir, name)
      if (existsSync(p)) return p
    }
    return null
  }

  /**
   * 确保二进制就位，返回 `{ path, downloaded }`。
   *
   * 顺序很重要：校验和 → 下载 → 比对 → 解压 → 落盘。先取校验和可以在命中不了资产时
   * 直接失败（省掉几十 MB 下载），也让「校验和不匹配就丢弃」有对照物。
   */
  async ensure(asset) {
    const name = asset || assetName()
    const wanted = binaryFileName()
    const target = join(this.installDir, wanted)

    const sums = parseChecksums(await this.#text(this.releaseUrl('SHA256SUMS.txt')))
    const expect = sums.get(name)
    if (!expect) {
      throw new Error(`SHA256SUMS.txt 里没有 ${name} 的校验和，拒绝安装（不下载未校验的二进制）`)
    }

    const zipBuf = await this.#bytes(this.releaseUrl(name))
    const actual = sha256(zipBuf)
    if (actual !== expect) {
      throw new Error(`校验和不匹配，已丢弃下载文件：期望 ${expect}，实际 ${actual}（${name}）`)
    }

    const data = extractBinary(zipBuf, wanted)
    return { path: writeAtomically(target, data), downloaded: true }
  }

  async #text(url) {
    const res = await this.#get(url)
    return res.text()
  }

  async #bytes(url) {
    const res = await this.#get(url)
    return Buffer.from(await res.arrayBuffer())
  }

  async #get(url) {
    assertSafeUrl(url, this.extraHost)
    const doFetch = this.fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw new Error('当前环境没有可用的 fetch，需要 Node >= 22（或注入 fetchImpl）')
    }
    // 网络必须带超时：安装卡在半开连接上时，用户只会看到「插件一直转圈」
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const res = await doFetch(url, { redirect: 'follow', signal: ac.signal })
      // 重定向后的最终地址也要查，防止 302 把下载牵去白名单外的主机
      if (res.url) assertSafeUrl(res.url, this.extraHost)
      if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText ?? ''}：${url}`.trim())
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 找出已安装的可执行文件。
 *
 * 顺序：显式配置 → 安装目录里的候选名。existsSync 做成入参是为了让调用方（或测试）
 * 换成自己的判断，而不必真的在磁盘上摆文件。
 */
export function resolveInstalledBinary({ config, installDir, existsSync: exists = existsSync } = {}) {
  const explicit = config?.binaryPath || config?.executablePath
  if (explicit && exists(explicit)) return explicit
  const dir = installDir || config?.installDir || defaultInstallDir()
  for (const name of BINARY_CANDIDATES) {
    const p = join(dir, name)
    if (exists(p)) return p
  }
  return null
}

/** 从 zip 里取可执行体：先按名字精确取，再按 basename 找（release 包里常带平台前缀目录）。 */
function extractBinary(zipBuf, wanted) {
  try {
    return extractFile(zipBuf, wanted)
  } catch (err) {
    const hit = listEntries(zipBuf).find((e) => e.name.split(/[\\/]/).pop() === wanted)
    if (!hit) throw new Error(`压缩包里找不到 ${wanted}：${err.message}`)
    return extractFile(zipBuf, hit.name)
  }
}

/**
 * 原子落盘：先写 `.part`，再 rename。
 *
 * rename 在同一分区内是原子的，能避免「进程正在下载时网关被拉起」读到半截文件；
 * Windows 上 rename 覆盖已存在文件可能被占用失败，但那也属于合理失败，直接抛出。
 * 非 Windows 必须先 chmod 0755 再改名，否则中间态文件不带可执行位。
 */
function writeAtomically(target, data) {
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.part`
  try {
    writeFileSync(part, data)
    if (platform() !== 'win32') chmodSync(part, 0o755)
    renameSync(part, target)
  } catch (err) {
    try { unlinkSync(part) } catch { /* 清理失败无所谓，别盖住原始错误 */ }
    throw err
  }
  return target
}

/** 只放行 https + 白名单主机；releaseBase 显式配置时额外放行它的主机。 */
function assertSafeUrl(raw, extraHost) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`下载地址非法：${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`拒绝非 https 下载（${url.protocol}）：${raw}`)
  }
  const host = url.hostname.toLowerCase()
  if (host !== extraHost && !HOST_WHITELIST.has(host)) {
    throw new Error(`下载主机不在白名单内：${host}（仅允许 github 系域名${extraHost ? ` 与 ${extraHost}` : ''}）`)
  }
  return url
}

function safeHostname(raw) {
  try {
    return new URL(String(raw)).hostname.toLowerCase()
  } catch {
    return null
  }
}
