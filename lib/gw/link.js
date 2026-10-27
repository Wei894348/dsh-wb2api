/**
 * 宿主半侧与网关托管子插件之间的「握手点」。
 *
 * ## 为什么需要它
 *
 * 面板的所有 `/dsh-wb2api/*` 路由挂在**父插件**（`lib/index.js`），而 supervisor
 * （进程托管）实例只活在**子插件**（`lib/gw/index.js`）里 —— 父插件
 * `mountGateway()` 用 `ctx.plugin(mod, config)` 挂载，拿不到子插件 `apply()` 的
 * 返回值。于是「面板上点一下重启网关」这条链路天然断在这里。
 *
 * 两条可选路线：
 *
 * 1. 让子插件自己再挂一条 HTTP 路由 —— 路由表就被劈成两处，客户端 API 的面
 *    也跟着分家；
 * 2. 用一个模块级单例把两边接起来（本文件）—— 路由表仍然只有父插件那一份。
 *
 * 选 2。代价是一个模块级可变对象：它是**同一个进程里同一个模块实例**，
 * 两边 `import` 拿到的是同一个引用（ESM 模块缓存），子插件挂载时写入、
 * 卸载时清空，父插件只读。
 *
 * ## 什么时候是空的
 *
 * `lib/gw/` 没同步到现场、或网关托管挂载失败时，`supervisor` 是 null ——
 * 这时重启路由必须明确报错，而不是假装成功。
 */

export const gatewayLink = {
  /** GatewaySupervisor 实例（`lib/gw/proc.js`）。 */
  supervisor: null,
  /** ModelCatalog 实例 —— 重启后刷一次模型目录用。 */
  catalog: null,
  /** 二进制安装器（缺 exe 时才有用）。 */
  installer: null,
  /** 归一化后的插件配置（端口 / origin 的口径）。 */
  config: null,
  /** 写入时刻，排查「到底是哪一次挂载」时有用。 */
  mountedAt: 0,
}

/** 子插件 apply() 时写入。重复挂载（HMR / 重载）直接覆盖。 */
export function attachGateway(parts) {
  Object.assign(gatewayLink, parts, { mountedAt: Date.now() })
}

/** 子插件卸载时清空：之后任何重启请求都会得到「没挂上」而不是打到旧实例上。 */
export function detachGateway() {
  gatewayLink.supervisor = null
  gatewayLink.catalog = null
  gatewayLink.installer = null
  gatewayLink.config = null
  gatewayLink.mountedAt = 0
}
