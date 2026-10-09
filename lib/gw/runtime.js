/**
 * 路径与运行目录：一处定口径，别处都来这里取。
 *
 * 为什么值得单独一个文件：网关的 `config.json` / `auth_dir` / `state_file` 全是相对
 * **子进程 cwd** 解析的。凭证目录、工作目录、二进制目录只要有一处口径不一致，
 * 表现就是「命令说写入成功，网关那边毫无反应」—— 这类故障极难定位。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 运行目录根。 */
export function defaultRuntimeDir() {
  return join(homedir(), '.dsh', 'wb2api')
}

/** 可执行文件在本机上的名字。 */
export function binaryFileName() {
  return platform() === 'win32' ? 'wb2a-server.exe' : 'wb2a-server'
}

/** 下载件落到哪（与运行目录分开：这里的东西是缓存，可以随时删）。 */
export function defaultInstallDir() {
  return join(defaultRuntimeDir(), 'bin')
}

/**
 * 随包自带的二进制目录（包根 `backend/bin`）。
 *
 * 用 `import.meta.url` 推导而不是拿 process.cwd()，因为 cwd 是 dsh 的启动目录，
 * 跟插件装在哪毫无关系。本文件在 `<包根>/lib/gw/` 下，所以回两级就是包根。
 */
export function bundledBinaryDir() {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', 'bin')
  } catch {
    return null
  }
}

/** 子进程 cwd。优先级：显式配置 → 源码目录 → 运行目录（仅当已有 config.json）→ 二进制所在目录。 */
export function resolveWorkingDir(config, executablePath) {
  if (config?.workingDir) return resolve(config.workingDir)
  if (config?.repoPath) return resolve(config.repoPath)
  const runtime = defaultRuntimeDir()
  if (existsSync(join(runtime, 'config.json'))) return runtime
  return executablePath ? dirname(executablePath) : runtime
}

/**
 * 凭证目录。
 *
 * 先读网关自己的 `config.json` 的 `auth_dir`（缺省 `./auths`），因为用户可能改过；
 * 它是相对 cwd 的，所以必须先用同一个 cwd 解析。
 */
export function resolveAuthDir(config, executablePath) {
  const cwd = resolveWorkingDir(config, executablePath)
  const declared = readGatewayConfig(cwd, config)?.auth_dir
  const relative = typeof declared === 'string' && declared.trim() ? declared.trim() : './auths'
  return isAbsolute(relative) ? relative : resolve(cwd, relative)
}

/** 读网关侧配置。读不到 / 解析失败一律返回 null，不抛。 */
export function readGatewayConfig(cwd, config) {
  for (const base of candidateConfigDirs(cwd, config)) {
    try {
      const text = readFileSync(join(base, 'config.json'), 'utf8')
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* 换下一个候选 */ }
  }
  return null
}

function candidateConfigDirs(cwd, config) {
  const list = []
  if (config?.workingDir) list.push(resolve(config.workingDir))
  if (config?.repoPath) list.push(resolve(config.repoPath))
  list.push(defaultRuntimeDir())
  if (cwd) list.push(cwd)
  return [...new Set(list)]
}

/**
 * 建好运行目录骨架：`auths/` 与 `data/`。
 *
 * `auths/` 必须在**网关启动之前**存在：网关启动时会判断该目录可读才挂热加载监听，
 * 否则打一行「跳过热加载」并且此后永不重试 —— 之后加账号就只剩重启一条路。
 */
export function ensureRuntimeDir() {
  const root = defaultRuntimeDir()
  mkdirSync(join(root, 'auths'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  return root
}

/**
 * 首次部署时生成一份网关配置。已存在的**绝不覆盖**。
 *
 * 必须生成的原因不是洁癖：网关在「配置不存在就走默认值」这条兜底上用了
 * `os.IsNotExist(err)` 判断，但读文件的错误已经被 `fmt.Errorf("read config: %w")`
 * 包过一层，判据恒为 false，进程直接 `log.Fatalf` 退出（实测 4 秒内退，只留一行日志）。
 *
 * 两个安全取值：
 * - 绑 127.0.0.1：上游示例里的 `:7863` 会绑 0.0.0.0；
 * - 必带随机 api_key：为空时网关完全不鉴权，而 `/status` 会暴露账号与积分。
 */
export function writeDefaultGatewayConfig() {
  const root = ensureRuntimeDir()
  const target = join(root, 'config.json')
  if (existsSync(target)) return { path: target, created: false }
  const payload = {
    admin: { enabled: true },
    auth_dir: './auths',
    state_file: './data/state.json',
    listen: '127.0.0.1:7863',
    api_key: randomBytes(24).toString('hex'),
  }
  writeFileSync(target, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { path: target, created: true }
}

/** 候选可执行文件名（含历史用过的别名）。 */
export const BINARY_CANDIDATES = Object.freeze([
  'wb2a-server.exe', 'wb2api-server.exe', 'wb2api.exe', 'wb2a.exe',
  'wb2a-server', 'wb2api-server', 'wb2api', 'wb2a',
])
