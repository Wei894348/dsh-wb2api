/**
 * 组装浏览器半侧：shim + functy 上游 UI bundle → client/client.js
 *
 * 为什么要拼装而不是直接改 vendor：
 *   - vendor/dsh-workbuddy-connect-functy.client.js 保持与上游逐字节一致，
 *     升级只需重新拷贝一份，改 UI 的补丁永远只有 shim 一处。
 *   - DSH 的模块身份必须等于包名（`window.__ModuleLoader__.load({ id })`），
 *     所以只替换两处身份字符串，其余原样。
 *
 * 用法：node tools/build_client.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorPath = join(root, 'client', 'vendor', 'dsh-workbuddy-connect-functy.client.js')
const shimPath = join(root, 'client', 'wbcompat-shim.js')
const outPath = join(root, 'client', 'client.js')

const PKG = 'dsh-plugin-wb2api-ui'
const VENDOR_ID = 'dsh-workbuddy-connect-functy'

let bundle = readFileSync(vendorPath, 'utf8')

const replacements = [
  [`id: "${VENDOR_ID}",`, `id: "${PKG}",`],
  [`const name = "${VENDOR_ID}-client";`, `const name = "${PKG}-client";`],
]
for (const [from, to] of replacements) {
  if (!bundle.includes(from)) throw new Error(`vendor 里找不到待替换的身份字符串：${from}`)
  bundle = bundle.split(from).join(to)
}

/**
 * 文案补丁（仅两处，控件与流程不动）。
 *
 * 参考实现的「添加账号 → 令牌」模式现在也收整份凭证 JSON：shim 的 add-cookie
 * 分支会先看载荷，以 `{` 开头就当整份文档走 /dsh-wb2api/import。控件是同一个输入框，
 * 但原文案只写「以 eyJ 开头」，用户不会想到还能贴 JSON —— 所以把提示补全。
 */
const copyPatches = [
  [
    'accountTokenPlaceholder: "Paste the token here (it starts with eyJ…)"',
    'accountTokenPlaceholder: "Paste the token (eyJ…) or a credential JSON ({…)"',
  ],
  [
    'accountTokenBody: "Paste the sign-in token from the WorkBuddy web console. It is stored on this machine only, and it cannot renew itself — when it expires you paste a new one."',
    `accountTokenBody: "Paste the sign-in token from the WorkBuddy web console, or a whole credential JSON ({'account':…,'auth':…}). It is stored on this machine only; a token cannot renew itself — when it expires you paste a new one."`,
  ],
  [
    'accountTokenPlaceholder: "在此粘贴令牌（以 eyJ 开头）"',
    'accountTokenPlaceholder: "在此粘贴令牌（eyJ…）或凭证 JSON（{…）"',
  ],
  [
    'accountTokenBody: "粘贴 WorkBuddy 网页控制台里的登录令牌。它只保存在本机，且无法自动续期 —— 过期后重新粘贴一份即可。"',
    `accountTokenBody: "粘贴 WorkBuddy 网页控制台里的登录令牌，或整份凭证 JSON（{'account':…,'auth':…}）。只保存在本机；令牌无法自动续期，过期后重新粘贴一份即可。"`,
  ],
]
for (const [from, to] of copyPatches) {
  if (!bundle.includes(from)) throw new Error(`vendor 里找不到待替换的文案：${from.slice(0, 48)}`)
  bundle = bundle.split(from).join(to)
}

const shim = readFileSync(shimPath, 'utf8')

const banner = `// WorkBuddy 反代（workbuddy2api）设置面板 —— 浏览器半侧。
//
// 界面 = functy23/dsh-workbuddy-connect-functy 的 React 界面，逐字节取自
// client/vendor/，只把模块身份改成 ${PKG}（DSH 要求 id === 包名）。
//
// 数据面不走上游宿主：client/wbcompat-shim.js 在 window.fetch 上拦下
// /plugins/${VENDOR_ID}/* 六个路由，转成本插件宿主侧的 /dsh-wb2api/*
// 与账号池数据，再按上游的 WorkBuddyWebStatus 文档形状回给界面。
// 因此改本插件的功能只动 shim，不动 vendor。
//
// 重新生成：node tools/build_client.mjs
`

const out = `${banner}\n${shim}\n\n${bundle}`
writeFileSync(outPath, out, 'utf8')

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`
console.log(`vendor ${kb(Buffer.byteLength(bundle))} + shim ${kb(Buffer.byteLength(shim))} → client.js ${kb(Buffer.byteLength(out))}`)
console.log(`identity: id=${PKG} name=${PKG}-client`)

