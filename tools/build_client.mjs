/**
 * 生成浏览器半侧：`client/client.js` = 界面运行时 + 数据适配层。
 *
 * 产物由两部分拼成：
 *   1. `client/vendor/ui-runtime.js` —— 界面运行时（React 组件、样式、槽位注册）；
 *   2. `client/wbcompat-shim.js` —— 数据适配层：把宿主 `/dsh-wb2api/*` 的数据按
 *      运行时认识的文档形状喂进去，并把界面上的写动作翻译回宿主路由。
 *
 * 本脚本只做三件事：统一模块身份、替换少量文案、把「网关 / 成长任务」两块
 * 注入设置页。改功能请改 shim，改生成物请重新跑：
 *
 *   node tools/build_client.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorPath = join(root, 'client', 'vendor', 'ui-runtime.js')
const shimPath = join(root, 'client', 'wbcompat-shim.js')
const outPath = join(root, 'client', 'client.js')

const PKG = 'dsh-plugin-wb2api-ui'

let bundle = readFileSync(vendorPath, 'utf8')

/**
 * 模块身份自检：运行时的模块 id 必须等于包名（DSH 按包名解析浏览器模块），
 * 名字对不上时加载器会重试同一份脚本并撞「重复注册」，整块界面直接不出现。
 */
const expectedId = `id: "${PKG}",`
if (!bundle.includes(expectedId)) throw new Error(`运行时的模块 id 不是 ${PKG}，检查 client/vendor/ui-runtime.js 首行`)

/**
 * 文案补丁（两处）：账号对话框的「令牌」模式同时收整份凭证 JSON —— 数据适配层
 * 会先看载荷，以 `{` 开头就当整份文档走 `/dsh-wb2api/import`，所以提示要写全。
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
  if (!bundle.includes(from)) throw new Error(`运行时里找不到待替换的文案：${from.slice(0, 48)}`)
  bundle = bundle.split(from).join(to)
}

/**
 * 账号行补一枚「今日已签到」胶囊。
 *
 * 数据侧（适配层）给账号对象挂 `checkinToday` —— 只有当天签到**成功**才挂。
 * 这里只在账号名后面加一个条件渲染的 span，不新增分组、不影响其它行。
 */
const CHIP_ANCHOR = 'children: account.name'
const chipAt = bundle.indexOf(CHIP_ANCHOR)
if (chipAt < 0) throw new Error('运行时里找不到账号行姓名字段')
const chipClose = bundle.indexOf('}),', chipAt)
if (chipClose < 0) throw new Error('运行时里找不到账号行姓名节点的结尾')
const CHIP = '\n\t\t\t\t\t\t\t\t\taccount.checkinToday === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {'
  + '\n\t\t\t\t\t\t\t\t\t\tclassName: "wbp-usagePlanStatus",'
  + '\n\t\t\t\t\t\t\t\t\t\tstyle: { color: "var(--dsw-alias-state-success-primary, #16a34a)" },'
  + '\n\t\t\t\t\t\t\t\t\t\tchildren: "今日已签到"'
  + '\n\t\t\t\t\t\t\t\t\t}) : null,'
bundle = bundle.slice(0, chipClose + 3) + CHIP + bundle.slice(chipClose + 3)

/**
 * 注入：把「网关 / 成长任务」两块折进设置页首屏。
 *
 * 做法是包住运行时导出的 `apply`：在它注册设置分区之前接管 `ctx.slots.register`，
 * 把那个分区的组件裹成「工具行 + 原页面」的 Fragment。于是导航里仍然只有一个
 * 条目，两块内容长在同一个页面的最上面，用的是运行时自己的行样式。
 *
 * 为什么不在 shim 里包 `window.__ModuleLoader__`：宿主 0.2.1 的浏览器加载器是
 * bootstrap facade 形态，替换它会把宿主加载器一起换坏（实测让 DSH 起不来）。
 */
const TOOLS_ANCHOR = '\t\texports.CARD_VARIANTS = CARD_VARIANTS;'
const TOOLS_INJECT = `		// --- wb2api: 网关 / 成长任务两块，折进设置页首屏 -------------------------
		const __wb2apiToolsFactory = typeof window !== "undefined" && typeof window.__wb2apiToolsFactory === "function"
			? window.__wb2apiToolsFactory
			: void 0;
		const __wb2apiNativeApply = apply;
		apply = function (ctx) {
			try {
				const __slots = ctx !== null && ctx !== void 0 ? ctx.slots : void 0;
				if (__wb2apiToolsFactory !== void 0 && __slots !== void 0 && typeof __slots.register === "function" && __slots.__wb2apiToolsMerged !== true) {
					__slots.__wb2apiToolsMerged = true;
					const __nativeRegister = __slots.register.bind(__slots);
					const __Tools = __wb2apiToolsFactory(react);
					__slots.register = function (desc, Component) {
						// 侧栏额度卡片按需求下线：这个挂载点整个跳过（不注册、不渲染）。
						// 中栏仪表盘保留 —— 设置页之外唯一能看到网关与额度总览的地方。
						if (desc !== null && desc !== void 0 && desc.name === "sidebar.footer.action") return function () {};
						const __target = desc !== null && desc !== void 0 && desc.name === "settings.section" && desc.id === "wb2api";
						if (!__target || typeof Component !== "function") return __nativeRegister(desc, Component);
						const __Wrapped = function (props) {
							return react.createElement(react.Fragment, null, react.createElement(__Tools, null), react.createElement(Component, props));
						};
						__Wrapped.displayName = "Wb2apiSettingsPage";
						return __nativeRegister(desc, __Wrapped);
					};
				}
			} catch (error) {
				console.warn("[wb2api] 工具块挂载失败", error);
			}
			return __wb2apiNativeApply.call(this, ctx);
		};`
if (!bundle.includes(TOOLS_ANCHOR)) throw new Error('运行时里找不到注入锚点：exports.CARD_VARIANTS')
bundle = bundle.replace(TOOLS_ANCHOR, `${TOOLS_INJECT}\n${TOOLS_ANCHOR}`)

const shim = readFileSync(shimPath, 'utf8')

const banner = `// workbuddy2api —— 浏览器半侧（设置面板 / 侧栏额度卡片 / 仪表盘）。
//
// 结构：界面运行时（client/vendor/ui-runtime.js）+ 数据适配层（client/wbcompat-shim.js）。
// 适配层在 window.fetch 上认领运行时自己的路由，转发到宿主 /dsh-wb2api/*，
// 因此 accessToken 永远不进浏览器。
//
// 本文件由 tools/build_client.mjs 生成，请勿手改。
`

const out = `${banner}\n${shim}\n\n${bundle}`
writeFileSync(outPath, out, 'utf8')

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`
console.log(`runtime ${kb(Buffer.byteLength(bundle))} + shim ${kb(Buffer.byteLength(shim))} → client.js ${kb(Buffer.byteLength(out))}`)
console.log(`identity: id=${PKG} name=${PKG}-client`)
