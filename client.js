// WorkBuddy 反代（workbuddy2api）设置面板 —— 浏览器半侧。
//
// 设置 → 「WorkBuddy 反代」分区：网关状态 / 授权登录 / 凭证 JSON 上传 / 账号管理 / 模型目录。
// 手写 __ModuleLoader__ factory（无构建步骤），骨架对齐 @rain-kl/dsh-preset-plus。
//
// 所有上游调用都走宿主 node 半侧挂的 /dsh-wb2api/* 路由 —— accessToken 永远不进浏览器。
window.__ModuleLoader__.load({
	id: "dsh-plugin-wb2api-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const name = "dsh-plugin-wb2api-ui";
		const inject = ["slots"];

		/** 宿主路由前缀。 */
		const API = "/dsh-wb2api";
		/** 授权轮询节奏与上限（与 node 半侧的登录语义对齐：上游确认有延迟）。 */
		const POLL_INTERVAL_MS = 3000;
		const POLL_MAX = 20;

		// 主题 token 全部对齐 DSH 自己的 --dsw-alias-* 命名空间。
		// 注意两处**不要想当然**：
		//   1) brand-primary 在暗色下解析成 bluish-50(near-white)，不是蓝色。
		//      主按钮必须用 button-primary-fill + label-primary-foreground 配对，
		//      否则暗色下白底白字、按钮文字直接看不见。
		//   2) 警告色是 state-warn-primary，不是 state-warning-primary。
		//   3) **label-dimmed 不能当提示文字色** —— 它在暗色主题下解成 bluish-750
		//      (#43454a)，压在 bg-layer-3 (#353638) 上几乎没有对比度，提示等于没写。
		//      提示 / 标签统一用 label-caption（暗色 #81858c，亮色 #adb2b8）。
		const TOKENS = {
			ink: "var(--dsw-alias-label-primary, #e5e7eb)",
			secondary: "var(--dsw-alias-label-secondary, #cfd3d6)",
			muted: "var(--dsw-alias-label-tertiary, #9ca3af)",
			caption: "var(--dsw-alias-label-caption, #81858c)",
			border: "var(--dsw-alias-border-l2, rgba(128,128,128,.25))",
			// ⚠ 背景层**数字越大越亮**（暗色）：layer-1 #232324 < layer-2 #2c2c2e < layer-3 #353638。
			// 卡片底色就是 layer-3（最亮那层），所以 panel2 是比它**更暗**的一层 ——
			// 只能当"次一级表面"用，绝不能当"高亮"。要高亮请用下面的 `overlay`。
			panel: "var(--dsw-alias-bg-layer-3, rgba(255,255,255,.035))",
			panel2: "var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))",
			/**
			 * 「高亮一层」用的叠加色。
			 *
			 * **别用 `bg-layer-2` 当高亮** —— 暗色下层级是「数字越大越亮」：
			 * `layer-1 #232324 < layer-2 #2c2c2e < layer-3 #353638`，
			 * 而卡片底色就是 layer-3（最亮的那层）。拿 layer-2 做高亮等于**变暗**，
			 * 两者只差一档、在深色区几乎看不出 —— 表现就是「高亮没生效」。
			 *
			 * `interactive-bg-hover` 才是设计上给"浮起/悬停"用的叠加层
			 * （暗色 `#ffffff14` 白光、亮色 `#2631480f` 深色半透明），
			 * 且**必须叠在底色上**才有效果 —— 它是半透明的，单独铺会露出页面底色。
			 */
			overlay: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))",
			accent: "var(--dsw-alias-link, #4d93f8)",
			fill: "var(--dsw-alias-button-primary-fill, #4d93f8)",
			onFill: "var(--dsw-alias-label-primary-foreground, #ffffff)",
			danger: "var(--dsw-alias-state-error-primary, #ef6b73)",
			ok: "var(--dsw-alias-state-success-primary, #3fbf6f)",
			warn: "var(--dsw-alias-state-warn-primary, #e2a03f)",
			/**
			 * 积分条的紫。
			 *
			 * 主题里**没有紫色 token** —— `brand-primary` / `link` / `deepseek-450`
			 * 全是蓝（`#679efe` 一族）。这个值是从 WorkDaddy 账号页的条上取的。
			 * 留一个 CSS 变量入口：想换色调只需在主题里定义 `--dsw-wb2api-bar`，
			 * 不必回来改代码。
			 */
			bar: "var(--dsw-wb2api-bar, #a78bfa)",
		};

		// ---- 交互样式：hover / 过渡 / 动画 / 滚动条 ----------------------------------
		// 内联样式做不了 :hover / @keyframes，这里注入一次全局 <style>（幂等）。
		// 颜色全部走 --dsw-alias-* 主题变量并带兜底值，深浅主题都不会破。
		const CSS_TEXT = [
			".wb2ui-account{transition:box-shadow .15s ease,background .15s ease}",
			".wb2ui-account:hover{box-shadow:0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.28)),0 3px 14px rgba(0,0,0,.14)}",
			".wb2ui-icobtn{transition:background .15s ease,border-color .15s ease,color .15s ease}",
			".wb2ui-icobtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))!important;border-color:var(--dsw-alias-link,#4d93f8)!important;color:var(--dsw-alias-link,#4d93f8)!important}",
			".wb2ui-icobtn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,#ef6b73)!important;color:var(--dsw-alias-state-error-primary,#ef6b73)!important}",
			".wb2ui-btn{transition:filter .15s ease,transform .06s ease}",
			".wb2ui-btn:hover:not(:disabled){filter:brightness(1.09)}",
			".wb2ui-btn:active:not(:disabled){transform:translateY(1px)}",
			".wb2ui-ghost{transition:box-shadow .15s ease}",
			".wb2ui-ghost:hover:not(:disabled){box-shadow:inset 0 0 0 999px var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
			".wb2ui-tab{transition:color .15s ease,border-color .15s ease}",
			".wb2ui-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e5e7eb)!important}",
			".wb2ui-chip{transition:filter .15s ease}",
			".wb2ui-chip:hover{filter:brightness(1.15)}",
			".wb2ui-link:hover{text-decoration:underline}",
			".wb2ui-model{transition:box-shadow .15s ease}",
			".wb2ui-model:hover{box-shadow:0 0 0 1px var(--dsw-alias-border-l2,rgba(128,128,128,.28))}",
			".wb2ui-skel{animation:wb2ui-pulse 1.4s ease-in-out infinite}",
			"@keyframes wb2ui-pulse{0%,100%{opacity:.1}50%{opacity:.26}}",
			".wb2ui-pulsedot{animation:wb2ui-pulse-dot 1.1s ease-in-out infinite}",
			"@keyframes wb2ui-pulse-dot{0%,100%{opacity:.35}50%{opacity:1}}",
			".wb2ui-scroll::-webkit-scrollbar{width:8px}",
			".wb2ui-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:4px}",
			".wb2ui-scroll::-webkit-scrollbar-track{background:transparent}",
			".wb2ui-segrow{transition:background .12s ease;border-radius:6px;margin:0 -4px;padding:2px 4px}",
			".wb2ui-segrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}",
		].join("\n");
		/** 注入交互样式。apply 会被 HMR 反复触发，按 id 幂等。 */
		function injectStyles() {
			if (typeof document === "undefined") return;
			let tag = document.getElementById("wb2ui-styles");
			if (tag === null) {
				tag = document.createElement("style");
				tag.id = "wb2ui-styles";
				document.head.appendChild(tag);
			}
			tag.textContent = CSS_TEXT;
		}

		/** 头像色板：按 uid 稳定取色，白字在深浅主题下都可读。 */
		const AVATAR_COLORS = ["#4d93f8", "#a78bfa", "#3fbf6f", "#e2a03f", "#ef6b73", "#38bdf8", "#34d399", "#f472b6"];
		function avatarColor(uid) {
			let hash = 0;
			const s = String(uid || "");
			for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
			return AVATAR_COLORS[hash % AVATAR_COLORS.length];
		}

		const WRAP = { width: "100%", maxWidth: "920px", display: "flex", flexDirection: "column", gap: "16px", color: TOKENS.ink, fontFamily: "inherit" };
		const CARD = { border: "1px solid " + TOKENS.border, borderRadius: "16px", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "11px", background: TOKENS.panel };
		const ROW = { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" };
		const BTN = { padding: "8px 16px", borderRadius: "9px", border: "1px solid transparent", cursor: "pointer", fontSize: "13px", fontWeight: 600, background: TOKENS.fill, color: TOKENS.onFill };
		const GHOST = { padding: "7px 12px", borderRadius: "9px", border: "1px solid " + TOKENS.border, cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "transparent", color: TOKENS.ink };
		const SMALL = { padding: "5px 11px", borderRadius: "999px", border: "1px solid " + TOKENS.border, cursor: "pointer", fontSize: "11.5px", background: TOKENS.panel2, color: TOKENS.secondary };
		const INPUT = { width: "100%", padding: "8px 11px", fontSize: "12.5px", boxSizing: "border-box", background: TOKENS.panel2, color: TOKENS.ink, border: "1px solid " + TOKENS.border, borderRadius: "9px", outline: "none" };
		const TEXTAREA = Object.assign({}, INPUT, { minHeight: "96px", fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace", fontSize: "11.5px", lineHeight: 1.55, resize: "vertical" });
		const SELECT = { padding: "8px 12px", fontSize: "12.5px", borderRadius: "9px", border: "1px solid " + TOKENS.border, background: TOKENS.panel2, color: TOKENS.ink };
		const TITLE = { fontSize: "13.5px", fontWeight: 700, letterSpacing: ".3px" };
		const HINT = { fontSize: "11.5px", color: TOKENS.caption, lineHeight: 1.6 };

		/** 一次宿主调用；失败一律抛错，由调用方决定怎么显示。 */
		async function call(path, init) {
			const response = await fetch(API + path, Object.assign({ cache: "no-store" }, init || {}));
			let body;
			try {
				body = await response.json();
			} catch {
				body = { ok: false, error: "宿主返回了非 JSON 响应（HTTP " + response.status + "）" };
			}
			if (body && body.ok) return body;
			const error = new Error((body && body.error) || ("HTTP " + response.status));
			// 202 = 登录尚未完成，可重试；不是故障。
			error.pending = Boolean(body && body.pending) || response.status === 202;
			/**
			 * 404 = 这条路由根本没挂上，而不是请求内容有问题。
			 *
			 * 面板的 client 半侧由 dsh 每 500ms 热替换，host 半侧却只在启动时
			 * 加载一次。所以「改完 lib/index.js 还没重启」这段时间里，界面是新的、
			 * 路由是旧的 —— 新加的接口一律 404。不把这种情况单列出来，用户会
			 * 拿去查 token、查网络、查上游，而真正该做的是重启 dsh。
			 */
			error.missing = response.status === 404;
			throw error;
		}

		const postJson = (path, payload) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

		/** Unix 秒 → 本地日期；0 视为未知。 */
		function when(unixSeconds) {
			if (!unixSeconds) return "未知";
			const d = new Date(unixSeconds * 1000);
			const pad = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}

		/** 毫秒 → 本地日期。段数据的 `expiresAt` 是毫秒（上游 `DeductionEndTime` 就是毫秒）。 */
		function whenMs(ms) {
			if (!ms) return "未知";
			const d = new Date(Number(ms));
			if (Number.isNaN(d.getTime())) return "未知";
			const pad = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}

		/**
		 * 去掉模型 id 的区域前缀。
		 *
		 * 网关按 `{区域}:{模型}` 命名（`cn:auto`、`cn:fast-model`），区域由网关配置
		 * 决定、不随账号变 —— 在模型列表里逐个重复是没有信息量的噪音。
		 * 只剥一段冒号前缀，`cn:foo:bar` 这类仍保留后半段。
		 */
		function shortModelId(id) {
			return String(id).replace(/^[a-z]+:/u, "");
		}

		/** 上下文窗口的紧凑写法：131072 → 128k。 */
		function compact(n) {
			if (!n) return "—";
			if (n >= 1048576) return Math.round(n / 1048576) + "M";
			if (n >= 1024) return Math.round(n / 1024) + "k";
			return String(n);
		}

		/**
		 * 积分数值：千分位 + **最多两位小数**。
		 *
		 * 两位不是随手取的：上游的 `*Precise` 字段就是两位精度（`2912.08`），
		 * 只留一位会把 `.08` 抹成 `.1`，面板跟自己算的对不上。
		 */
		function formatCredits(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "—";
			return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
		}

		/**
		 * 积分健康度配色。
		 *
		 * 分档只表达「还剩多少可用」，不是额度预警线：0 一定是耗尽，低于 200
		 * 提示一下，其余按正常走。绝对值分档而非比例，因为每个包的容量差异太大
		 * （6 到 1500 都有），比例会让大包小包同样显示成「充足」。
		 */
		function creditsTone(row) {
			if (!row || row.state !== "ok") return null;
			if (row.unlimited) return TOKENS.accent;
			const n = Number(row.total) || 0;
			if (n <= 0) return TOKENS.danger;
			if (n < 200) return TOKENS.warn;
			return TOKENS.ok;
		}

		/** 毫秒时间戳 → 「N 秒前 / N 分钟前 / N 小时前」。 */
		function timeAgo(ms) {
			if (!ms) return "";
			const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (sec < 60) return sec + " 秒前";
			const min = Math.round(sec / 60);
			if (min < 60) return min + " 分钟前";
			return Math.round(min / 60) + " 小时前";
		}

		/** 状态行里的一个小徽章。 */
		function Chip(props) {
			// WorkDaddy 风格的**满色药丸**：彩色文字 + 同色淡底 + 同色细边，
			// 不再是"透明底 + 灰边框"——后者在深色主题下糊成一条线。
			// color-mix 把 token 色直接调成 13% 底 / 30% 边，不用手工配每档颜色。
			const toneInk = props.toneInk || TOKENS.muted;
			const tinted = props.tone !== undefined;
			return h("span", {
				className: "wb2ui-chip",
				// 可选 tooltip：失败原因这类细节不该挤进徽章文案，但也不能丢。
				title: props.title,
				// 可选点击：启用/禁用这类操作做成「点徽章」比再占一个按钮位省地方。
				onClick: props.onClick,
				style: {
					cursor: props.onClick === undefined ? "default" : "pointer",
					display: "inline-flex", alignItems: "center", gap: "4px",
					padding: "3px 10px", borderRadius: "999px", fontSize: "11.5px", fontWeight: 600,
					whiteSpace: "nowrap", lineHeight: 1.5, fontVariantNumeric: "tabular-nums",
					border: "1px solid " + (tinted ? "color-mix(in srgb, " + toneInk + " 30%, transparent)" : TOKENS.border),
					color: toneInk,
					background: tinted ? "color-mix(in srgb, " + toneInk + " 13%, transparent)" : TOKENS.panel2,
				},
			}, props.children);
		}

		/**
		 * 「标签 + 大数字」—— 参考图里「账号数 4」「总积分 9,433.24」就是这个结构。
		 *
		 * 数字用 `tabular-nums`（等宽数字）：额度是每 60 秒刷新一次的，
		 * 比例数字不跳字宽，刷新时不会左右抖动。
		 */
		function Stat(props) {
			return h("span", { style: { display: "inline-flex", alignItems: "baseline", gap: "7px", flexShrink: 0 } },
				h("span", { style: { fontSize: "13px", color: TOKENS.caption } }, props.label),
				h("b", {
					style: {
						fontSize: "17px", fontWeight: 700, lineHeight: 1.2,
						color: props.tone || TOKENS.ink, fontVariantNumeric: "tabular-nums",
					},
				}, props.value),
			);
		}

		/** 竖线分隔符 —— 参考图里「账号数」和「总积分」之间那根。 */
		function Divider() {
			return h("span", { style: { width: "1px", height: "15px", background: TOKENS.border, flexShrink: 0 } });
		}

		/**
		 * 网关给的 ISO 时间 → 「剩 3 分 20 秒」。
		 *
		 * 已过去 / 解析不出来都返回**空串**，调用方据此判断「这个状态已经结束了」。
		 * Go 的时间零值是 `0001-01-01T00:00:00Z`，`Date.parse` 把它解成很远的过去，
		 * 所以这条分支顺带把零值也处理掉了。
		 */
		function remainingText(iso) {
			const at = Date.parse(String(iso === undefined || iso === null ? "" : iso));
			if (!Number.isFinite(at)) return "";
			const seconds = Math.round((at - Date.now()) / 1000);
			if (seconds <= 0) return "";
			if (seconds >= 3600) return Math.floor(seconds / 3600) + " 小时 " + Math.round((seconds % 3600) / 60) + " 分";
			if (seconds >= 60) return Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒";
			return seconds + " 秒";
		}

		/**
		 * 网关侧对这个账号的实时判定 —— 「现在还轮不轮得到它」。
		 *
		 * 三种受限状态分开说，因为**下一步动作完全不同**：
		 *
		 * | 状态 | 含义 | 该做什么 |
		 * |---|---|---|
		 * | 熔断中 | 连续失败太多次，被摘出轮换 | 等，而且要去看日志 —— 可能不只是限流 |
		 * | 冷却中 | 通常是上游限流 | 什么都不用做，到点自动回来 |
		 * | 手动停用 | 是**你**主动关的 | 想恢复就去点启用 |
		 *
		 * 一切正常时**不渲染任何东西** —— 加个「可用」徽章只会让正常情况变吵，
		 * 而徽章的意义恰恰在于「出现即异常」。
		 */
		function poolBadge(live) {
			if (live === undefined || live === null) return null;
			if (live.manualDisabled === true) return h(Chip, { tone: TOKENS.warn, toneInk: TOKENS.warn }, "手动停用");
			const breakerLeft = remainingText(live.breakerUntil);
			if (breakerLeft !== "") return h(Chip, { tone: TOKENS.danger, toneInk: TOKENS.danger }, "熔断中 · 剩 " + breakerLeft);
			const coolingLeft = remainingText(live.until);
			if (live.cooling === true && coolingLeft !== "") {
				return h(Chip, { tone: TOKENS.warn, toneInk: TOKENS.warn }, "冷却中 · 剩 " + coolingLeft);
			}
			if (live.disabled === true) return h(Chip, { tone: TOKENS.warn, toneInk: TOKENS.warn }, "网关侧停用");
			return null;
		}

		/**
		 * 今日签到徽章。
		 *
		 * 三种状态分开渲染，因为它们对用户意味着不同的事：
		 * - **签到成功 / 今日已签到** —— 任务达成（`code 10001` 也是达成，不算失败，
		 *   否则第二天打开面板会看到一片红，以为坏了）；
		 * - **签到失败** —— 红色，失败原因放 tooltip（详情不该挤进徽章）；
		 * - **今天还没跑过** —— 什么都不显示。空白比「未签到」诚实：面板只有在
		 *   跑过之后才有发言权。
		 */
		function checkinBadge(record) {
			// 跑失败了要单独说 —— 「未签到」和「签了但失败」是两件事，
			// 后者用户得去看原因（token 失效之类），合起来就看不出来了。
			if (record !== undefined && record !== null && record.ok !== true) {
				return h(Chip, { tone: TOKENS.danger, toneInk: TOKENS.danger, title: record.message }, "签到失败");
			}
			const checked = Boolean(record && record.ok === true);
			return h(Chip,
				checked ? { tone: TOKENS.ok, toneInk: TOKENS.ok } : { tone: TOKENS.border, toneInk: TOKENS.caption },
				checked ? "今日已签到" : "今日未签到");
		}

		/**
		 * 连续登录天数。
		 *
		 * 读不到就**不显示**（而不是显示 0）—— 「还没读到」和「确实是 0 天」
		 * 对用户意味着完全不同的事。
		 */
		function streakLabel(row) {
			const days = row && row.streakDays;
			if (!Number.isSafeInteger(days) || days < 0) return null;
			// WorkDaddy 的熊猫徽章：满色药丸 + 🐼 图标，比裸文本醒目。
			return h(Chip, { tone: TOKENS.bar, toneInk: TOKENS.bar }, "🐼 连续登录 " + days + " 天");
		}

		/**
		 * 任务徽章 —— **只在有可领的时候出现**。
		 *
		 * 与签到不同：签到是每天都要回答的一个是非题，任务是「有没有便宜可占」。
		 * 没有可领的时候显示「0 个可领」只是噪音，还占着位置把真正要看的挤走。
		 */
		function taskBadge(row) {
			const summary = row && row.summary;
			if (summary === undefined) return null;
			if (summary.claimable > 0) {
				return h(Chip, { tone: TOKENS.bar, toneInk: TOKENS.bar, title: "可领 " + summary.pendingCredits + " 积分" },
					"可领 " + summary.claimable + " 个任务");
			}
			return null;
		}

		/**
		 * 凭证有效期的**三档语义** —— 照 WorkDaddy 的 `tokenState`。
		 *
		 * 只给一个日期是不够的：`2026-11-21` 到底是「还早」还是「快到了」，
		 * 用户得自己心算。分档之后**颜色本身就在说话** —— 快到期的会自己冒出来，
		 * 不用逐个读日期。
		 *
		 * | 剩余 | 文案 | 颜色 |
		 * |---|---|---|
		 * | 已过 | `已过期 <日期>` | 危险 |
		 * | < 24 小时 | `即将过期 <日期>` | 警告 |
		 * | < 7 天 | `<日期>` | 警告 |
		 * | 其余 | `<日期>` | 次级 |
		 *
		 * 注意有效期是**凭证的**（accessToken 的 `expiresAt`），不是积分包的 ——
		 * 后者在段明细里，两者差着量级，混起来会让人以为积分下个月才过期。
		 */
		function expiryState(seconds) {
			const at = Number(seconds);
			if (!Number.isFinite(at) || at <= 0) return { text: "未知", tone: TOKENS.caption };
			const label = when(at);
			const diff = at * 1000 - Date.now();
			if (diff < 0) return { text: "已过期 " + label, tone: TOKENS.danger };
			if (diff < 86400000) return { text: "即将过期 " + label, tone: TOKENS.warn };
			if (diff < 7 * 86400000) return { text: label, tone: TOKENS.warn };
			return { text: label, tone: TOKENS.secondary };
		}

		/**
		 * 「标签 值」—— 标签暗、值亮。
		 *
		 * 账号卡上凡是「元数据 + 数据」的位置都用它，卡片因此有统一的阅读节奏：
		 * 扫一眼标签定位，再读值。
		 */
		function Field(props) {
			return h("span", { style: { display: "inline-flex", alignItems: "baseline", gap: "6px", minWidth: 0 } },
				h("span", { style: { fontSize: "12px", color: TOKENS.caption, flexShrink: 0 } }, props.label),
				h("span", {
					style: Object.assign({
						fontSize: "12.5px", color: TOKENS.secondary,
						whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
					}, props.style || {}),
				}, props.value),
			);
		}

		/**
		 * 方形图标按钮 —— 卡片右上角的操作位。
		 *
		 * 昵称长度完全不受控，文字按钮会把长昵称挤到换行。图标把操作区锁成固定
		 * 宽度，昵称那边就可以安心用 `ellipsis`。代价是语义靠图标承载，所以
		 * `title` 与 `aria-label` 必须写全 —— 那既是 tooltip，也是可访问名。
		 */
		function IconButton(props) {
			const danger = props.danger === true;
			return h("button", {
				type: "button",
				className: "wb2ui-icobtn" + (props.danger === true ? " danger" : ""),
				title: props.title,
				"aria-label": props.title,
				disabled: props.disabled,
				onClick: props.onClick,
				style: {
					width: "32px", height: "32px", flexShrink: 0, padding: 0,
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "9px",
					border: "1px solid " + (danger ? TOKENS.danger : TOKENS.border),
					background: TOKENS.panel2,
					color: danger ? TOKENS.danger : TOKENS.muted,
					cursor: props.disabled ? "not-allowed" : "pointer",
					opacity: props.disabled ? 0.4 : 1,
				},
			}, props.children);
		}

		/** 图标公共属性。stroke 走 currentColor，颜色由按钮决定。 */
		const ICON = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
		/** 切换账号的双箭头。 */
		const ICON_SWAP = h("svg", ICON, h("path", { d: "M3 7h14l-4-4" }), h("path", { d: "M21 17H7l4 4" }));
		/** 删除的垃圾桶。 */
		const ICON_TRASH = h("svg", ICON, h("path", { d: "M3 6h18" }), h("path", { d: "M8 6V4h8v2" }), h("path", { d: "M6 6l1.5 14h9L18 6" }));
		/** 剩余额度前的闪电（实心，比描边在数字旁边更稳）。 */
		const ICON_BOLT = h("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M13 2 4 14h6l-1 8 9-12h-6z" }));
		/** 投放区里那个上传箭头。 */
		const ICON_UPLOAD = h("svg", Object.assign({}, ICON, { width: 20, height: 20 }),
			h("path", { d: "M12 15V3" }),
			h("path", { d: "m7 8 5-5 5 5" }),
			h("path", { d: "M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" }));

		/** 圆点：运行状态用。 */
		function Dot(props) {
			return h("span", {
				className: props.className,
				style: { width: "7px", height: "7px", borderRadius: "50%", background: props.color, display: "inline-block" },
			});
		}

		function Section(props) {
			return h("div", { style: CARD },
				h("div", { style: ROW },
					h("div", { style: TITLE }, props.title),
					props.extra || null,
				),
				props.children,
			);
		}

		/**
		 * 面板主体。
		 *
		 * 状态来源只有一个 `/state` 接口；登录与导入完成后重拉一次，不做本地拼接
		 * —— 磁盘才是真源，本地拼出来的清单迟早和网关看到的不一致。
		 */
		function Panel() {
			const [state, setState] = useState({ phase: "loading" });
			const [notice, setNotice] = useState({ kind: "idle", text: "" });
			const [busy, setBusy] = useState("");

			// 添加账号：授权登录
			const [realm, setRealm] = useState("cn");
			const [login, setLogin] = useState({ phase: "idle", authUrl: "", attempt: 0, error: "" });
			const pollTimer = useRef(null);

			// 添加账号：上传 JSON
			const [pasted, setPasted] = useState("");
			const [dragging, setDragging] = useState(false);

			/**
			 * 「添加账号」区当前用哪种方式。
			 *
			 * 授权登录和导入 JSON 是**做同一件事的两条路**，之前各占一个 Section
			 * 一路排下去，面板一打开是两整块空盒子。收成一个 Tab 区：
			 * 一次只做一件事，也少占一屏。
			 */
			const [addTab, setAddTab] = useState("login");

			/**
			 * 鼠标停着的那个昵称（uid）—— 决定显示哪张卡的任务浮层。
			 *
			 * 配一个**延时隐藏**：浮层在卡片外面、鼠标从昵称移到浮层上会先离开昵称，
			 * 立即隐藏的话浮层根本点不到。150ms 是「够移过去、又不显得粘」的值。
			 */
			const [taskUid, setTaskUid] = useState("");
			const hideTaskTimer = useRef(null);
			const showTaskFor = (uid) => {
				if (hideTaskTimer.current !== null) clearTimeout(hideTaskTimer.current);
				setTaskUid(uid);
			};
			const hideTaskSoon = () => {
				if (hideTaskTimer.current !== null) clearTimeout(hideTaskTimer.current);
				hideTaskTimer.current = setTimeout(() => setTaskUid(""), 160);
			};

			// 删除确认
			const [confirmFile, setConfirmFile] = useState("");

			// 每个账号的剩余积分 —— 宿主侧持 token 去打上游 billing，浏览器只拿数字。
			const [credits, setCredits] = useState({ phase: "idle", data: null, error: "" });
			/** 当前展开包明细的账号（空串 = 全收起）。 */
			const [expandedFile, setExpandedFile] = useState("");

			const load = useCallback(() => {
				return call("/state")
					.then((data) => setState({ phase: "ready", data }))
					.catch((error) => setState({ phase: "error", error: error.message }));
			}, []);

			/**
			 * 拉积分。
			 *
			 * **刻意与 `/state` 分开请求**：这条要打上游（首次约 0.5 秒），混进
			 * `/state` 会把整个面板的首屏一起拖慢。失败了也保留上一次的数字 ——
			 * 显示一个旧数字比显示一片空白有用。
			 */
			const loadCredits = useCallback((force) => {
				setCredits((prev) => ({ phase: "loading", data: prev.data, error: "" }));
				return call("/credits" + (force ? "?force=1" : ""))
					.then((result) => setCredits({ phase: "ready", data: result.credits, error: "" }))
					.catch((error) => setCredits((prev) => ({ phase: "error", data: prev.data, error: error.message, missing: Boolean(error.missing) })));
			}, []);

			/**
			 * 成长中心：任务清单 + 连续登录天数。
			 *
			 * 跟积分一样**单独一条请求** —— 每个账号要打两个接口，混进 `/state`
			 * 会把首屏一起拖慢（四个账号就是八个上游请求）。
			 */
			const [growth, setGrowth] = useState({ phase: "idle", data: null, error: "" });
			const loadGrowth = useCallback((force) => {
				setGrowth((prev) => ({ phase: "loading", data: prev.data, error: "" }));
				return call("/growth" + (force ? "?force=1" : ""))
					.then((result) => setGrowth({ phase: "ready", data: result.growth, error: "" }))
					.catch((error) => setGrowth((prev) => ({ phase: "error", data: prev.data, error: error.message })));
			}, []);

			useEffect(() => { load(); }, [load]);
			// 挂载时拉一次积分。宿主侧有 60 秒缓存，来回切设置页不会反复打上游。
			useEffect(() => { loadCredits(false); }, [loadCredits]);
			useEffect(() => { loadGrowth(false); }, [loadGrowth]);
			// 组件卸载时收掉轮询，避免离开设置页还在打上游。
			useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

			const data = state.phase === "ready" ? state.data : null;
			const accounts = (data && data.accounts) || [];
			/**
			 * 启用中的账号数。**「当前使用中」的判据是它等于 1** ——
			 * 池里只剩一个，网关没有别的可换，那才是名副其实的"当前在用"。
			 * 多个启用时是加权轮换，没有单一当前，就不该瞎指一个。
			 */
			const enabledAccountCount = accounts.filter((item) => !item.disabled).length;
			const gateway = (data && data.gateway) || {};
			const models = (data && data.models) || null;
			// 网关侧的实时池状态（冷却 / 熔断）。读不到就是 null —— 面板照常渲染，
			// 只是不带那层"现在能不能用"的信息。
			const pool = (data && data.pool) || null;
			/**
			 * 今天的签到 / 保活结果。键形如 `checkin:<uid>` —— 跟积分一样是
			 * **按 uid 索引**（网关和签到都只认 uid），跟 pool 用同一套。
			 */
			const activity = (data && data.activity) || {};

			/**
			 * 池状态按 **uid** 索引 —— 注意与积分那张表不同：
			 *
			 * | 索引 | 键 | 为什么 |
			 * |---|---|---|
			 * | 积分 | 文件名 | 文件损坏时 uid 可能缺失，但 file 永远在 |
			 * | 池状态 | uid | 网关只认 uid，它不知道文件叫什么 |
			 *
			 * 两边都不改口径，调用处各自降级：对不上就是「网关未上报」。
			 */
			const poolByUid = {};
			for (const row of (pool && pool.accounts) || []) poolByUid[row.uid] = row;

			// 成长状态也按 uid 索引（接口侧只有 uid 这一个身份）。
			const growthByUid = {};
			for (const row of (growth.data && growth.data.accounts) || []) growthByUid[row.uid] = row;

			/**
			 * 「正在／最近被使用的账号」—— 给可观察的证据，不猜。
			 *
			 * 网关是**按池轮询**的，不存在「当前唯一账号」这种东西，所以不硬造一个。
			 * 优先级：
			 *
			 * 1. `in_flight > 0` —— 有请求正压在它身上，这是最硬的证据；
			 * 2. 否则取 `last_success` 最新的那个；
			 * 3. 都没有（网关刚起来 / 一个请求还没发过）就是空串，**谁都不标**。
			 *
			 * 第 3 条是刻意的：猜一个「大概在用它」比不标更糟 —— 用户会拿它当事实。
			 */
			const activeUid = (() => {
				if (pool === null) return "";
				const rows = pool.accounts || [];
				const flying = rows.find((row) => Number(row.inFlight) > 0);
				if (flying !== undefined) return flying.uid;
				let best = "";
				let bestAt = 0;
				for (const row of rows) {
					const at = Date.parse(String(row.lastSuccess === undefined ? "" : row.lastSuccess));
					// Go 的时间零值解析成很远的过去，天然排不上；不用特判。
					if (Number.isFinite(at) && at > bestAt) {
						bestAt = at;
						best = row.uid;
					}
				}
				return best;
			})();

			// 积分按凭证文件名索引 —— 账号清单里 uid 可能缺失（文件损坏），file 永远在。
			const creditByFile = {};
			const creditsData = credits.data;
			for (const row of (creditsData && creditsData.accounts) || []) creditByFile[row.file] = row;
			const creditsReady = creditsData !== null && creditsData.counts.ok > 0;

			/** 登录轮询：每 3 秒问一次，pending 就继续。 */
			const pollOnce = useCallback((nextRealm, nextState, attempt) => {
				postJson("/login/poll", { realm: nextRealm, state: nextState })
					.then((result) => {
						setLogin({ phase: "done", authUrl: "", attempt, error: "" });
						setNotice({ kind: "ok", text: "登录成功：" + (result.account.nickname || result.account.uid) + "（" + result.account.realm + "）· 凭证已写入，网关 5 秒内自动加载" });
						setBusy("");
						load();
					})
					.catch((error) => {
						if (error.pending && attempt < POLL_MAX) {
							setLogin({ phase: "waiting", authUrl: "", attempt, error: "" });
							pollTimer.current = setTimeout(() => pollOnce(nextRealm, nextState, attempt + 1), POLL_INTERVAL_MS);
							return;
						}
						setLogin({ phase: "idle", authUrl: "", attempt: 0, error: "" });
						setNotice({ kind: "error", text: error.pending
							? "等待授权超时（" + Math.round((POLL_INTERVAL_MS * POLL_MAX) / 1000) + " 秒内上游始终未确认）。请确认浏览器里已完成授权后重试。"
							: "登录失败：" + error.message });
						setBusy("");
					});
			}, [load]);

			const beginLogin = useCallback(() => {
				if (pollTimer.current) clearTimeout(pollTimer.current);
				setBusy("login");
				setNotice({ kind: "idle", text: "" });
				setLogin({ phase: "starting", authUrl: "", attempt: 0, error: "" });
				postJson("/login/begin", { realm })
					.then((result) => {
						setLogin({ phase: "waiting", authUrl: result.authUrl, attempt: 1, error: "" });
						// 新窗口打开授权页；被拦时下面还有可点的链接。
						try { window.open(result.authUrl, "_blank", "noopener,noreferrer"); } catch { /* 被拦不影响流程 */ }
						pollTimer.current = setTimeout(() => pollOnce(realm, result.state, 1), POLL_INTERVAL_MS);
					})
					.catch((error) => {
						setLogin({ phase: "idle", authUrl: "", attempt: 0, error: "" });
						setNotice({ kind: "error", text: "申请授权链接失败：" + error.message });
						setBusy("");
					});
			}, [realm, pollOnce]);

			const cancelLogin = useCallback(() => {
				if (pollTimer.current) clearTimeout(pollTimer.current);
				setLogin({ phase: "idle", authUrl: "", attempt: 0, error: "" });
				setBusy("");
				setNotice({ kind: "idle", text: "已停止等待授权（上游的 state 会自行过期，凭据未写入）。" });
			}, []);

			const importRaw = useCallback((raw) => {
				const text = String(raw || "").trim();
				if (text === "") {
					setNotice({ kind: "error", text: "没有可导入的内容。" });
					return;
				}
				setBusy("import");
				setNotice({ kind: "idle", text: "" });
				postJson("/import", { raw: text })
					.then((result) => {
						const rows = result.imported || [];
						setNotice({ kind: "ok", text: "已导入 " + rows.length + " 个账号：" + rows.map((r) => r.nickname || r.uid).join("、") + " · 网关 5 秒内自动加载" });
						setPasted("");
						load();
						// 新账号的积分要重算（缓存里没有它们）。
						loadCredits(true);
					})
					.catch((error) => setNotice({ kind: "error", text: "导入失败：" + error.message }))
					.then(() => setBusy(""));
			}, [load, loadCredits]);

			const onPickFile = useCallback((event) => {
				const file = event.target.files && event.target.files[0];
				event.target.value = "";
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => importRaw(reader.result);
				reader.onerror = () => setNotice({ kind: "error", text: "读取文件失败。" });
				reader.readAsText(file);
			}, [importRaw]);

			const onDrop = useCallback((event) => {
				event.preventDefault();
				setDragging(false);
				const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = () => importRaw(reader.result);
				reader.readAsText(file);
			}, [importRaw]);

			/**
			 * 切换到某个账号 —— 只让它参与轮换；池里只剩它时再点则恢复全部。
			 *
			 * ## 为什么"切换"就是这个意思
			 *
			 * 网关只暴露四个路由（`/v1/chat/completions`、`/v1/models`、`/status`、
			 * `/healthz`），**选号是它内部按权重做的，没有任何接口能指定账号**。
			 * 官方插件的 `/wb2api-account` 用的也是同一套 —— README 原话「机制：
			 * 重命名凭证文件，不改网关一行代码」，**只改名、从不删除**。
			 *
			 * 所以这不是我发明的取巧，是这个网关里「切换账号」的**全部含义**。
			 *
			 * ⚠ 两点如实告知用户：被排除的账号不再刷新 token（长期排除可能失效）；
			 * 且"只用一个"不等于"优先用它" —— 它冷却时就真的没号可换了。
			 */
			const switchToAccount = useCallback((file, isCurrent) => {
				setBusy("switch:" + file);
				postJson("/account/only", { file: isCurrent ? "" : file })
					.then((result) => {
						setState((prev) => prev.phase === "ready" ? { phase: "ready", data: Object.assign({}, prev.data, { accounts: result.accounts }) } : prev);
						if (result.verified === false) {
							// 网关把凭证写回了旧路径 —— 不假装成功。
							setNotice({ kind: "error", text: "切换可能被网关写回，请再点一次；若反复如此说明网关正在刷新 token。" });
						} else {
							setNotice({ kind: "ok", text: result.only === "" ? "已恢复全部账号参与加权轮换" : "已切换为只用该账号（其余暂停参与）" });
						}
						loadCredits(true);
					})
					.catch((error) => setNotice({ kind: "error", text: "切换失败：" + error.message }))
					.then(() => setBusy(""));
			}, [loadCredits]);

			const toggleAccount = useCallback((file, enabled) => {
				setBusy("toggle:" + file);
				postJson("/account/toggle", { file, enabled })
					.then((result) => {
						setState((prev) => prev.phase === "ready" ? { phase: "ready", data: Object.assign({}, prev.data, { accounts: result.accounts }) } : prev);
						// 禁用账号不查积分（网关不加载它们），所以状态行汇总要跟着变。
						loadCredits(true);
					})
					.catch((error) => setNotice({ kind: "error", text: "操作失败：" + error.message }))
					.then(() => setBusy(""));
			}, [loadCredits]);

			const deleteAccount = useCallback((file) => {
				setBusy("delete:" + file);
				postJson("/account/delete", { file })
					.then((result) => {
						setConfirmFile("");
						setState((prev) => prev.phase === "ready" ? { phase: "ready", data: Object.assign({}, prev.data, { accounts: result.accounts }) } : prev);
						// 少了账号，汇总数字要跟着掉下来。
						loadCredits(true);
					})
					.catch((error) => setNotice({ kind: "error", text: "删除失败：" + error.message }))
					.then(() => setBusy(""));
			}, [loadCredits]);

			/**
			 * 手动跑一轮签到 / 保活。
			 *
			 * 跑完**重拉一次 `/state`** 而不是拿响应本地拼结果 —— 后端（和它落的盘）
			 * 才是真源，本地拼一份迟早跟它分叉，然后就会出现「面板说有、刷新一下没了」。
			 */
			const runActivity = useCallback((kind) => {
				const meta = kind === "checkin" ? { label: "签到", path: "/checkin" }
					: kind === "growth" ? { label: "领取任务积分", path: "/growth/claim" }
						: { label: "保活", path: "/keepalive" };
				setBusy(kind);
				postJson(meta.path, {})
					.then((result) => {
						const rows = result.result?.results || [];
						const okCount = rows.filter((row) => row.ok).length;
						setNotice({
							kind: rows.length > 0 && okCount === rows.length ? "ok" : "error",
							text: meta.label + "完成：" + okCount + "/" + rows.length + " 个账号成功"
								+ (rows.length === 0 ? "（没有启用中的账号）" : ""),
						});
						load();
						// 领完必须重拉任务列表，否则徽章还挂着「可领 N 个」——
						// 用户会以为没领成功，然后再点一次。
						if (kind === "growth") loadGrowth(true);
					})
					.catch((error) => setNotice({ kind: "error", text: meta.label + "失败：" + error.message }))
					.then(() => setBusy(""));
			}, [load, loadGrowth]);

			/**
			 * 「一键做任务」：先确认有无待办 → 执行动作 → 达标自动领奖。
			 *
			 * 真正跑在宿主那侧的后台任务里（一轮可能几分钟），这里只起跑 + 轮询状态：
			 * 进度与结果**一律以宿主返回的 status 为准** —— 本地拼一份进度迟早跟它分叉，
			 * 然后就是「面板说有、刷新一下没了」。宿主那侧调的是包内自带的任务引擎
			 * （`engine/wb_up/run.mjs`，随本包发布），动作实现不在本插件里重复一份。
			 */
			const [taskRun, setTaskRun] = useState({ running: false, logs: [], summary: null, pending: null, error: "" });
			const taskTimer = useRef(null);

			const stopTaskPoll = useCallback(() => {
				if (taskTimer.current) { clearTimeout(taskTimer.current); taskTimer.current = null; }
			}, []);

			const pollTasks = useCallback(() => {
				call("/tasks/status")
					.then((status) => {
						setTaskRun(status);
						if (status.running) {
							taskTimer.current = setTimeout(pollTasks, 2500);
							return;
						}
						stopTaskPoll();
						load();
						loadCredits(true);
						loadGrowth(true);
					})
					.catch((error) => {
						stopTaskPoll();
						setTaskRun((prev) => Object.assign({}, prev, { running: false, error: error.message, missing: error.missing === true }));
					});
			}, [load, loadCredits, loadGrowth, stopTaskPoll]);

			const runTasks = useCallback(() => {
				setBusy("tasks");
				postJson("/tasks/run", {})
					.then((result) => {
						if (result.started === false) {
							setNotice({ kind: "error", text: result.message || "已有一轮任务在执行中" });
							setBusy("");
							return;
						}
						setTaskRun({ running: true, logs: [], summary: null, pending: null, error: "" });
						setNotice({ kind: "ok", text: "已开始：确认待办 → 执行任务 → 自动领奖" });
						stopTaskPoll();
						taskTimer.current = setTimeout(pollTasks, 1500);
						setBusy("");
					})
					.catch((error) => {
						setBusy("");
						setNotice({
							kind: "error",
							// 404 单独说清楚：宿主半侧只在 dsh 启动时加载，改完 lib/index.js 必须重启 dsh。
							text: error.missing === true || /\b405\b/u.test(String(error.message))
								? "宿主半侧还没挂上这条路由：插件 host 只在 dsh 启动时加载，改动 lib/index.js 后需要重启 dsh 才生效。"
								: "启动失败：" + error.message,
						});
					});
			}, [pollTasks, stopTaskPoll]);

			// 刷新页面时若后台还在跑，把进度接回来。
			useEffect(() => {
				call("/tasks/status")
					.then((status) => {
						if (status && status.running) {
							setTaskRun(status);
							taskTimer.current = setTimeout(pollTasks, 2500);
						}
					})
					.catch(() => {});
				return stopTaskPoll;
			}, [pollTasks, stopTaskPoll]);

			const noticeColor = notice.kind === "error" ? TOKENS.danger : notice.kind === "ok" ? TOKENS.ok : TOKENS.muted;

			// ---- 状态行 ----
			const health = gateway.health || {};
			const healthy = typeof health.healthy === "number" ? health.healthy : null;
			const total = typeof health.total === "number" ? health.total : null;

			// 汇总积分。不限量账号没有可加的数字，单独计数；总数归零但有不限量账号时
			// 用强调色而不是危险色 —— 那是「没上限」不是「用光了」。
			const creditsTotalTone = !creditsReady
				? null
				: (creditsData.unlimited > 0 && creditsData.total <= 0)
					? TOKENS.accent
					: creditsTone({ state: "ok", total: creditsData.total });
			/**
			 * 顶部状态行 —— 照参考图的「标签 + 大数字」排。
			 *
			 * 刻意**不放刷新按钮**：账号区标题栏的「刷新积分」是唯一刷新入口，
			 * 顶部再放一个会让人以为要刷两处。模型数量同理 —— 下面「可用模型」区的
			 * 标题里已经带着数量了，这里再报一遍是重复。
			 *
			 * 网关状态降成小圆点 + 短文字：它是背景信息，不该跟账号数抢视觉重量。
			 * 但**不能省** —— 网关没起来时所有账号都不可用，那是第一诊断信息。
			 */
			const statusRow = h("div", { style: { display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" } },
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flexShrink: 0 } },
					Dot({ color: gateway.running ? TOKENS.ok : TOKENS.danger, className: gateway.running ? undefined : "wb2ui-pulsedot" }),
					h("span", { style: { fontSize: "12.5px", color: TOKENS.muted } }, gateway.running ? "网关运行中" : "网关未运行"),
				),
				Divider(),
				h(Stat, { label: "账号数", value: String(accounts.length) }),
				Divider(),
				creditsReady
					? h(Stat, { label: "总积分", value: formatCredits(creditsData.total), tone: creditsTotalTone })
					: h(Stat, { label: "总积分", value: credits.phase === "loading" ? "读取中…" : "—" }),
				// 两种「数字是 0」要分开说，它们的原因完全不同：
				// 一个是没有账号（去添加），一个是账号在但都不可用（去查凭证/网关）。
				accounts.length === 0
					? h("span", { style: HINT }, "还没有账号，用下面的任一种方式添加")
					: (healthy === 0 ? h("span", { style: Object.assign({}, HINT, { color: TOKENS.warn }) }, "网关可用账号数为 0 —— 凭证可能都过期了") : null),
				// 有人在冷却时点一句。这是「余额明明有、请求却不是它跑」的唯一解释，
				// 不说的话用户只能看着一堆正常数字猜。
				pool !== null && pool.global.cooling > 0
					? h("span", { style: Object.assign({}, HINT, { color: TOKENS.warn }) },
						pool.global.cooling + " 个账号冷却中 —— 请求会自动走池里其他账号")
					: null,
			);

			const headerNote = h("div", { style: HINT },
				"这里管理 workbuddy2api 的账号凭证。凭证只写在本机 " + ((data && data.authDir) || "~/.dsh/wb2api/auths") + "，"
				+ "浏览器永远拿不到 accessToken。网关由本插件托管，随 dsh 启停"
				// 监听地址从顶部搬到这里：它只在排查连通性时才有用，不该占状态行的位置。
				+ (gateway.baseURL ? "，监听 " + gateway.baseURL : "") + "。");

			// ---- 未就绪提示 ----
			if (state.phase === "error") {
				return h("div", { style: WRAP },
					Section({ title: "WorkBuddy 反代", children: h("div", { style: HINT }, "读取状态失败：" + state.error) }),
				);
			}
			if (!data) {
				return h("div", { style: WRAP }, Section({ title: "WorkBuddy 反代", children: h("div", { style: HINT }, "读取中…") }));
			}

			const binaryWarn = data.binary && !data.binary.exists
				? h("div", { style: HINT }, "网关可执行文件还没就位（" + data.binary.path + "）。在 dsh 里执行 /wb2api-setup 会自动下载并校验。")
				: null;
			const configWarn = !data.configured
				? h("div", { style: HINT }, "还没生成网关配置（~/.dsh/wb2api/config.json）。在 dsh 里执行 /wb2api-setup 完成初始化。")
				: null;
			const gatewayWarn = !gateway.running && data.configured && data.binary.exists
				? h("div", { style: HINT }, "网关当前没在监听。dsh 启动时会自动拉起；也可以手动执行 /wb2api-start。")
				: null;

			// ---- 授权登录区 ----
			const loginBody = login.phase === "waiting" || login.phase === "starting"
				? h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
					h("div", { style: ROW },
						Dot({ color: TOKENS.warn, className: "wb2ui-pulsedot" }),
						h("span", { style: { fontSize: "12.5px" } },
							login.phase === "starting" ? "正在申请授权链接…" : "等待授权中… 第 " + login.attempt + "/" + POLL_MAX + " 次检查"),
						h("button", { type: "button", className: "wb2ui-ghost", style: SMALL, onClick: cancelLogin }, "取消"),
					),
					login.authUrl
						? h("div", null,
							h("div", { style: HINT }, "窗口没弹出？手动打开这个链接完成授权："),
							h("a", { href: login.authUrl, target: "_blank", rel: "noopener noreferrer", className: "wb2ui-link", style: { fontSize: "11.5px", color: TOKENS.accent, wordBreak: "break-all" } }, login.authUrl),
						)
						: null,
					h("div", { style: HINT }, "授权完成后本页会自动确认（最多等 " + Math.round((POLL_INTERVAL_MS * POLL_MAX) / 1000) + " 秒）。"),
				)
				: h("div", { style: { display: "flex", flexDirection: "column", gap: "9px" } },
					h("div", { style: { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" } },
						// 标签用与账号卡 `Field` 同款的小字 —— 整个面板的「标签」是一种视觉语言，
						// 这里换成徽章或加粗都会让人以为它是另一个东西。
						h("span", { style: { fontSize: "12px", color: TOKENS.caption, flexShrink: 0 } }, "版本"),
						h("select", {
							style: Object.assign({}, SELECT, { minWidth: "210px" }),
							value: realm, onChange: (e) => setRealm(e.target.value), disabled: busy === "login",
						},
							h("option", { value: "cn" }, "国内版 · codebuddy.cn"),
							h("option", { value: "global" }, "国际版 · workbuddy.ai"),
						),
						// 按钮写**动作**（开始授权）、Tab 写**方式**（授权登录）。
						// 两处都叫「授权登录」的话，人会分不清哪个是入口哪个是标签
						// —— 测试里也真点错过。
						h("button", { type: "button", className: "wb2ui-btn", style: BTN, onClick: beginLogin, disabled: busy === "login" },
							busy === "login" ? "申请中…" : "开始授权"),
					),
					h("div", { style: HINT }, "国内外账号体系独立 —— 账号属于哪个版本就选哪一项，选错会拿到空账号信息。"),
				);

			// ---- 上传 JSON 区 ----
			const uploadBody = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
				// 投放区做成三级层次：图标 → 主文案 → 操作入口。
				// 之前是一整块居中的两行字，拖拽时除了边框变色没有任何反馈。
				h("div", {
					onDragOver: (e) => { e.preventDefault(); setDragging(true); },
					onDragLeave: () => setDragging(false),
					onDrop,
					style: {
						border: "1px dashed " + (dragging ? TOKENS.accent : TOKENS.border),
						borderRadius: "12px", padding: "16px 14px",
						background: dragging ? TOKENS.panel2 : "transparent",
						display: "flex", flexDirection: "column", alignItems: "center", gap: "7px",
						textAlign: "center",
					},
				},
					h("span", { style: { display: "inline-flex", color: dragging ? TOKENS.accent : TOKENS.caption } }, ICON_UPLOAD),
					h("div", { style: { fontSize: "12.5px", color: TOKENS.muted } }, "把凭证 / 账号导出 JSON 拖到这里"),
					h("label", { className: "wb2ui-link", style: { cursor: "pointer", fontSize: "12px", fontWeight: 600, color: TOKENS.accent } },
						"或点此选择文件",
						h("input", { type: "file", accept: ".json,application/json", style: { display: "none" }, onChange: onPickFile }),
					),
				),
				// 「或」分隔线：把两种入口的关系说清楚，而不是让它们各说各话。
				h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
					h("span", { style: { flex: "1 1 auto", height: "1px", background: TOKENS.border } }),
					h("span", { style: HINT }, "或直接粘贴"),
					h("span", { style: { flex: "1 1 auto", height: "1px", background: TOKENS.border } }),
				),
				h("textarea", {
					style: TEXTAREA,
					value: pasted,
					placeholder: '[\n {\n  "uid": "…", "nickname": "…",\n  "access_token": "…", "refresh_token": "…",\n  "expires_at": 1794480957832,   // 毫秒会自动换算成秒\n  "domain": "www.codebuddy.cn"   // 由此推断 cn / global\n }\n]',
					onChange: (e) => setPasted(e.target.value),
				}),
				h("div", { style: { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" } },
					h("button", { type: "button", className: "wb2ui-btn", style: BTN, onClick: () => importRaw(pasted), disabled: busy === "import" },
						busy === "import" ? "导入中…" : "导入"),
					h("button", { type: "button", className: "wb2ui-ghost", style: GHOST, onClick: () => setPasted("") }, "清空"),
					h("span", { style: HINT }, "两种格式都收：account + auth 两段式，或扁平 snake_case / camelCase（时间戳毫秒秒都认）。"),
				),
			);

			/**
			 * 「添加账号」区 —— 两条路共用一块地方，Tab 切换。
			 *
			 * 登录进行中（waiting / starting）时**强制留在登录页**：轮询还在跑，
			 * 切走会让用户以为授权被取消了，回来还得重新点。
			 */
			const loginBusy = login.phase === "waiting" || login.phase === "starting";
			const activeAddTab = loginBusy ? "login" : addTab;
			const addAccountBody = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
				// 下划线式 Tab：激活项用 2px 强调色底边，比描边盒子轻，hover 由 .wb2ui-tab 接管。
				h("div", { style: { display: "flex", gap: "16px", borderBottom: "1px solid " + TOKENS.border } },
					[["login", "授权登录"], ["import", "导入 JSON"]].map(([key, label]) => h("button", {
						key,
						type: "button",
						className: "wb2ui-tab",
						disabled: loginBusy && key !== "login",
						onClick: () => setAddTab(key),
						style: {
							padding: "6px 2px 9px",
							border: "none",
							borderBottom: "2px solid " + (activeAddTab === key ? TOKENS.accent : "transparent"),
							background: "transparent",
							color: activeAddTab === key ? TOKENS.ink : TOKENS.caption,
							fontSize: "12.5px", fontWeight: activeAddTab === key ? 600 : 500,
							cursor: loginBusy && key !== "login" ? "not-allowed" : "pointer",
							opacity: loginBusy && key !== "login" ? 0.45 : 1,
							marginBottom: "-1px",
						},
					}, label)),
				),
				activeAddTab === "login" ? loginBody : uploadBody,
			);

			// ---- 积分：单账号徽章 + 包明细 ----

			/**
			 * 「剩余」后面接的那个值。
			 *
			 * 五种状态分开渲染，因为它们对用户意味着完全不同的事：
			 * 「还没拉到」是等一下，「凭证读不了」是去修文件，「获取失败」是上游/网络，
			 * 「后端未加载」是去重启 dsh。（禁用账号现在也查积分，不再有「已禁用」态。）
			 * 统一显示成 0 会把前几种全伪装成最后一种。
			 *
			 * 好状态下返回的是**大号数字**（卡片上唯一的强调位），
			 * 其余状态一律退回 12.5px 的说明文字 —— 尺寸本身就在告诉用户
			 * 「这不是一个数字，是一条待处理的消息」。
			 */
			const creditValue = (row) => {
				const note = (text, tone, title) => h("span",
					Object.assign({ style: { fontSize: "12.5px", color: tone, lineHeight: 1.4 } }, title ? { title } : {}), text);
				if (!row) {
					if (credits.phase === "error") {
						// 路由 404 与「上游挂了」是两回事：前者改代码不动 dsh 就能修，后者只能等。
						return credits.missing
							? note("面板后端未加载 · 需重启 dsh", TOKENS.danger, credits.error)
							: note("获取失败", TOKENS.danger, credits.error);
					}
					// 读取中给**同尺寸**占位（17px 粗体）—— 用小字「读取中…」的话，
					// 积分一到、占位换数字，这一行凭空长高一截，整张卡跟着跳。
					if (credits.phase === "loading") {
						return h("span", { style: { fontSize: "17px", fontWeight: 700, lineHeight: 1.2, color: TOKENS.caption, fontVariantNumeric: "tabular-nums" } }, "—");
					}
					return note("未知", TOKENS.caption);
				}
				if (row.state === "unreadable") return note("凭证读不了", TOKENS.danger);
				if (row.state === "error") return note("获取失败", TOKENS.danger, row.error);
				const tone = creditsTone(row);
				if (row.unlimited) return h("span", { style: { fontSize: "16px", fontWeight: 700, color: TOKENS.accent, lineHeight: 1.2 } }, "不限量");
				return h("span", { style: { display: "inline-flex", alignItems: "center", gap: "5px", color: tone } },
					ICON_BOLT,
					h("span", { style: { fontSize: "17px", fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" } }, formatCredits(row.total)),
				);
			};

			/** 到期描述 —— 分档照 WorkDaddy（分钟 / 小时 / 天）。 */
			function expiryText(ms) {
				if (!ms) return "有效期未知";
				const diff = Number(ms) - Date.now();
				if (diff <= 0) return "已过期";
				const minute = 60000;
				const hour = 60 * minute;
				const day = 24 * hour;
				if (diff < hour) return "剩余 " + Math.max(1, Math.ceil(diff / minute)) + " 分钟";
				if (diff < day) return "剩余 " + Math.ceil(diff / hour) + " 小时";
				return "剩余 " + Math.ceil(diff / day) + " 天";
			}

			/**
			 * 一格的透明度 —— **越快到期的越淡**。
			 *
			 * 照 WorkDaddy 的 `creditOpacity`：剩余 >= 30 天算实心，1 天接近透明。
			 * 好处是不用逐个悬停，扫一眼就能看出条上哪部分快失效了。
			 * 到期时间未知的按实心（1）—— 它不会先没。
			 */
			function creditOpacity(days) {
				if (days === null || days === undefined || !Number.isFinite(Number(days))) return 1;
				return 0.05 + 0.95 * Math.max(0, Math.min(29, Number(days) - 1)) / 29;
			}

			/** 段剩余天数；未知返回 null。 */
			const daysLeft = (segment) => (segment && segment.expiresAt
				? (Number(segment.expiresAt) - Date.now()) / 86400000
				: null);

			/** 一格的悬停说明：来源 / 数量 / 到期。 */
			function segmentTip(segment) {
				return String(segment.source || "积分")
					+ "\n" + formatCredits(segment.remaining) + " 积分"
					+ "\n到期时间 " + (segment.expiresAt ? whenMs(segment.expiresAt) : "未知")
					+ "（" + expiryText(segment.expiresAt) + "）";
			}

			/**
			 * 占位积分条 —— 与真条同高。积分还在路上时先撑住版面，
			 * 数据落地换真条的那一刻卡片高度不变（治「打开面板全卡集体长高」）。
			 */
			function creditBarSkeleton() {
				return h("div", { style: { display: "flex", alignItems: "stretch", gap: "2px", width: "100%", height: "8px" } },
					h("span", { className: "wb2ui-skel", style: { flex: "1 1 auto", borderRadius: "3px", background: TOKENS.bar } }));
			}

			/**
			 * 积分条：**一格一个积分包**，宽度按各包占总额的比例分配。
			 *
			 * 两个细节照 WorkDaddy 学来，都是关键：
			 *
			 * 1. **按比例（flex 权重）而不是绝对值。** 绝对值会让 6 分的包在几百的
			 *    总额里缩成一个点、看着像没画。权重保底 0.008，小额段也能留一条缝。
			 * 2. **段间 2px 间隙 + 每段各自圆角**，一格一格看得出是独立的包，
			 *    而不是一条连续的实心条。
			 */
			function creditBar(row) {
				const segments = (row && Array.isArray(row.segments) ? row.segments : [])
					.filter((segment) => segment && Number(segment.remaining) > 0);
				if (segments.length === 0) return null;
				const sum = segments.reduce((acc, segment) => acc + (Number(segment.remaining) || 0), 0) || 1;
				return h("div", {
					// 外层是淡色轨道：段间 2px 缝隙露出轨道色，一格一格更分明，两端由轨道统一收圆。
					style: { display: "flex", alignItems: "stretch", gap: "2px", width: "100%", height: "8px", borderRadius: "4px", overflow: "hidden", background: "rgba(128,128,128,.14)" },
				}, segments.map((segment, index) => {
					const weight = Math.max(0.008, (Number(segment.remaining) || 0) / sum);
					return h("span", {
						key: index,
						title: segmentTip(segment),
						style: {
							flex: weight.toFixed(4) + " 1 0",
							minWidth: "3px",
							background: TOKENS.bar,
							opacity: creditOpacity(daysLeft(segment)).toFixed(3),
						},
					});
				}));
			}

			/**
			 * 展开后的分段明细 —— 与进度条**一一对应**（同一份 `segments`，同一顺序）。
			 *
			 * 左边那个小色块和条上的格子同透明度，用户能直接把"第几段"对回去。
			 */
			const segmentDetail = (row) => {
				const segments = Array.isArray(row.segments) ? row.segments : [];
				const gap = Number(row.sumCapacityRemain || 0) - (Number(row.total) || 0);
				return h("div", {
					className: "wb2ui-scroll",
					style: {
						border: "1px solid " + TOKENS.border, borderRadius: "9px", padding: "9px 11px",
						background: TOKENS.panel2, maxHeight: "230px", overflowY: "auto",
						display: "flex", flexDirection: "column", gap: "5px",
					},
				},
					h("div", { style: HINT }, "按到期时间排（先没的在前）· 共 " + segments.length + " 段，与上面的进度条一一对应"),
					segments.map((segment, index) => h("div", {
						key: index,
						className: "wb2ui-segrow",
						title: segmentTip(segment),
						style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11.5px" },
					},
						h("span", {
							style: {
								width: "8px", height: "8px", flexShrink: 0, borderRadius: "2px",
								background: TOKENS.bar, opacity: creditOpacity(daysLeft(segment)).toFixed(3),
							},
						}),
						h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: TOKENS.muted } }, segment.source || "积分"),
						h("span", { style: Object.assign({}, HINT, { flexShrink: 0 }) },
							segment.expiresAt ? whenMs(segment.expiresAt).slice(0, 10) : "无到期"),
						h("span", { style: { flexShrink: 0, fontWeight: 600, color: TOKENS.ink } }, formatCredits(segment.remaining)),
						segment.total ? h("span", { style: { flexShrink: 0, color: TOKENS.caption } }, "/ " + formatCredits(segment.total)) : null,
					)),
					// 明细与主数字同口径（都是可用）。差额单独说一句，否则用户拿上游的
					// 总量口径去核总数会对不上，反过来怀疑程序少加。
					gap > 0
						? h("div", { style: Object.assign({}, HINT, { borderTop: "1px solid " + TOKENS.border, paddingTop: "6px" }) },
							"另有 " + formatCredits(gap) + " 本周期已用尽（上游总量口径会把它算进去，实际用不到，不计入上表）")
						: null,
				);
			};

			// ---- 账号列表 ----

			/**
			 * 任务浮层 —— 鼠标停在昵称上时显示。
			 *
			 * 三段按「看这个浮层的目的」排序：**可领 → 进行中 → 已完成**。
			 * 反过来会让人先读一堆已经没有动作价值的条目，而真正想问的是
			 * 「有没有白拿的」。
			 *
			 * 已完成那段也要给：用户问的就是「已经做完的任务」，只列没做完的
			 * 等于没回答。
			 */
			const taskPanel = (row) => {
				const box = {
					position: "absolute", top: "calc(100% + 6px)", left: "14px", zIndex: 40,
					width: "330px", maxHeight: "300px", overflowY: "auto",
					border: "1px solid " + TOKENS.border, borderRadius: "10px",
					background: TOKENS.panel, boxShadow: "0 10px 28px rgba(0,0,0,.32)",
					padding: "10px 12px", display: "flex", flexDirection: "column", gap: "7px",
					cursor: "default",
				};
				// 鼠标从昵称移进浮层时，两边各自延时隐藏 —— 否则浮层刚出现就没了。
				const hoverProps = {
					onMouseEnter: () => showTaskFor(row === null || row === undefined ? "" : row.uid),
					onMouseLeave: hideTaskSoon,
				};
				if (row === undefined || row === null) {
					return h("div", Object.assign({ style: box }, hoverProps), h("div", { style: HINT }, "任务信息读取中…"));
				}
				if (row.error !== undefined) {
					return h("div", Object.assign({ style: box }, hoverProps),
						h("div", { style: Object.assign({}, HINT, { color: TOKENS.danger }) }, "任务读取失败：" + row.error));
				}

				const tasks = Array.isArray(row.tasks) ? row.tasks : [];
				const claimable = tasks.filter((item) => item.claimable);
				const running = tasks.filter((item) => item.state === "in_progress" || item.state === "not_accepted");
				const done = tasks.filter((item) => item.state === "claimed" || item.state === "completed");
				const summary = row.summary || { completed: 0, total: tasks.length, pendingCredits: 0 };
				const line = (item, tone, mark) => h("div", {
					key: item.code + "|" + item.title,
					style: { display: "flex", alignItems: "baseline", gap: "7px", fontSize: "11.5px", color: TOKENS.muted },
				},
					h("span", { style: { flexShrink: 0, width: "12px", color: tone } }, mark),
					h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.title),
					item.target > 1 ? h("span", { style: { flexShrink: 0, color: TOKENS.caption } }, item.current + "/" + item.target) : null,
					item.credits > 0 ? h("span", { style: { flexShrink: 0, color: TOKENS.caption } }, "+" + item.credits) : null,
					// 标出「完成方式可自动化」的任务（照 WorkDaddy 的白名单）。
					// 是**标注**不是按钮：这些任务的完成要靠别的产品入口，插件够不着。
					item.auto ? h("span", {
						style: { flexShrink: 0, fontSize: "10.5px", color: TOKENS.bar },
						title: "完成方式可自动化 —— 「保持活跃」发的云会话能推进 chat 类计数，其余要真实使用对应入口",
					}, "可自动") : null,
				);

				return h("div", Object.assign({ style: box }, hoverProps),
					h("div", { style: { display: "flex", alignItems: "baseline", gap: "9px", paddingBottom: "6px", borderBottom: "1px solid " + TOKENS.border } },
						h("b", { style: { fontSize: "12.5px" } }, "任务 " + summary.completed + "/" + summary.total),
						Number.isSafeInteger(row.streakDays) && row.streakDays >= 0
							? h("span", { style: HINT }, "连续登录 " + row.streakDays + " 天")
							: null,
					),
					claimable.length > 0
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							h("div", { style: Object.assign({}, HINT, { color: TOKENS.bar }) },
								"可领 " + claimable.length + " 个（" + summary.pendingCredits + " 积分）· 点上方「领取任务积分」"),
							claimable.slice(0, 8).map((item) => line(item, TOKENS.bar, "★")),
						)
						: null,
					running.length > 0
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							h("div", { style: HINT }, "进行中 " + running.length + " 个"),
							running.slice(0, 8).map((item) => line(item, TOKENS.caption, "○")),
						)
						: null,
					done.length > 0
						? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
							h("div", { style: HINT }, "已完成 " + done.length + " 个"),
							done.slice(0, 12).map((item) => line(item, TOKENS.ok, "✓")),
							done.length > 12 ? h("div", { style: HINT }, "……另有 " + (done.length - 12) + " 个已完成") : null,
						)
						: null,
				);
			};

			/** 两端对齐的一行「左边身份 …… 右边时效」，中间留白。挤在一起会变成一堵字墙。 */
			const justified = (left, right) => h("div", {
				style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", minWidth: 0 },
			}, left, right);

			/**
			 * 一张账号卡。
			 *
			 * 五行的信息层级（从上到下扫一眼就能读完）：
			 * ① 谁 —— 昵称 + 属性徽章 + 操作
			 * ② 什么身份 / 什么时候过期
			 * ③ 还剩多少
			 * ④ 条状占比
			 * ⑤ 包明细（要展开才出）
			 *
			 * 之前是一行「昵称 + 一串 run-on 文本 + 右侧三个文字按钮」，
			 * 昵称一长就把操作挤到换行，uid / 到期时间 / 文件名糊在同一行里分不出层级。
			 */
			const accountCard = (account) => {
				const credit = creditByFile[account.file];
				const expanded = expandedFile === account.file;
				const canExpand = Boolean(credit && credit.state === "ok" && (credit.segments || []).length > 0);
				const deleting = confirmFile === account.file;
				// 禁用账号**也显示积分行** —— 卡片塌掉（只剩第一行）比多一行数字糟得多，
				// 而「切换账号」的副作用正好是把其余账号全禁用：一点切换，几张卡同时塌，
				// 看起来像坏了。是不是参与轮换由顶部徽章表达，不靠抽掉内容。
				// 今日已使用：上游只给逐笔流水，host 侧按当天汇总好再下发。
				const todayUsed = credit && credit.todayUsage ? Number(credit.todayUsage.used) || 0 : 0;
				const live = poolByUid[account.uid];
				const expiry = expiryState(account.expiresAt);
				const working = Boolean(live && Number(live.inFlight) > 0);
				// （原来还有个 isActive，现在并进 isCurrent 了 —— 多账号时就是它。）
				/**
				 * 「当前使用中」= 池里只剩它一个启用 —— 网关没有别的可换，那才是
				 * 名副其实的"当前在用"。多个启用时是加权轮换，没有单一当前，
				 * **就不该瞎指一个**（猜错比不说更糟）。
				 *
				 * 它只在用户主动切换后出现，不会随后台请求自己变 —— 界面不该自己动。
				 */
				const soloCurrent = !account.disabled && enabledAccountCount === 1;
				/**
				 * 高亮的那个账号。**始终有一个** —— 不然"当前在用的是哪个"这个问题
				 * 就没答案了（用户要的就是这个）。两档依据：
				 *
				 * 1. 池里只剩一个启用 → 它就是（网关没别的可换，最硬的依据）；
				 * 2. 否则退到「最近使用」那个（`last_success` 最新 / 有请求在飞）。
				 *
				 * 都不满足（网关刚起来、一次请求还没发过）就谁都不高亮 —— 那种情况下
				 * 猜一个比不指更糟。
				 */
				const isCurrent = !account.disabled && (soloCurrent || account.uid === activeUid);

				/**
				 * WorkDaddy 卡片排版：
				 * - **无边框扁平卡** —— 深色面板里靠底色和留白分区，不画框线；
				 * - 行序：昵称+徽章行 → 「uid ｜ 有效期至」 → 「可用 ｜ 今日已使用」 → 通栏积分条贴底；
				 * - 当前使用的账号只做**背景提亮**，不动边框。
				 */
				return h("div", {
					key: account.file,
					className: "wb2ui-account",
					style: {
						borderRadius: "12px",
						padding: "14px 16px 12px",
						background: deleting
							? "linear-gradient(" + "color-mix(in srgb, " + TOKENS.danger + " 10%, transparent)" + ", " + "color-mix(in srgb, " + TOKENS.danger + " 10%, transparent)" + "), " + TOKENS.panel
							: (isCurrent ? "linear-gradient(" + TOKENS.overlay + ", " + TOKENS.overlay + "), " : "") + TOKENS.panel,
						// 任务浮层是这张卡的绝对定位子元素。
						position: "relative",
						display: "flex", flexDirection: "column", gap: "8px",
						// **不灰化**未参与轮换的卡片 —— 内容该完整，状态由徽章说。
					},
				},
					// ① 昵称 + 徽章 | 操作
					h("div", { style: { display: "flex", alignItems: "center", gap: "10px", minWidth: 0 } },
						h("span", {
							// 头像点：按 uid 稳定取色，一眼把卡片和账号对上，也让操作按钮的右侧有视觉锚。
							style: {
								width: "30px", height: "30px", flexShrink: 0, borderRadius: "50%",
								display: "inline-flex", alignItems: "center", justifyContent: "center",
								fontSize: "13px", fontWeight: 700, color: "#fff",
								background: avatarColor(account.uid),
							},
						}, (account.nickname || account.uid || "?").trim().slice(0, 1).toUpperCase() || "?"),
						h("span", {
							style: {
								fontSize: "16px", fontWeight: 700, letterSpacing: ".1px",
								// 独占剩余宽度、完整显示：超长自动折行（不断字），不再 ellipsis 截断。
								lineHeight: 1.3, flex: "1 1 auto", minWidth: 0,
								wordBreak: "break-word", overflowWrap: "anywhere",
								cursor: "help",
							},
							// 光标是 help、并且直说「悬停」—— 不然没人会去试那个交互。
							title: "悬停查看任务进度",
							onMouseEnter: () => showTaskFor(account.uid),
							onMouseLeave: hideTaskSoon,
						}, account.nickname || account.uid || "(无昵称)"),
						deleting
							? h("div", { style: { display: "flex", gap: "6px", marginLeft: "auto", flexShrink: 0 } },
								h("button", {
									type: "button",
									className: "wb2ui-ghost", style: Object.assign({}, SMALL, { borderColor: TOKENS.danger, color: TOKENS.danger }),
									disabled: busy === "delete:" + account.file,
									onClick: () => deleteAccount(account.file),
								}, busy === "delete:" + account.file ? "删除中…" : "确认删除"),
								h("button", { type: "button", className: "wb2ui-ghost", style: SMALL, onClick: () => setConfirmFile("") }, "取消"),
							)
							: h("div", { style: { display: "flex", gap: "7px", marginLeft: "auto", flexShrink: 0 } },
								h(IconButton, {
									title: isCurrent ? "恢复全部账号参与加权轮换" : "切换为只用这个账号（其余暂停参与，凭证不删）",
									disabled: busy === "switch:" + account.file,
									onClick: () => switchToAccount(account.file, isCurrent),
								}, ICON_SWAP),
								h(IconButton, {
									title: "删除该账号的凭证文件",
									danger: true,
									onClick: () => setConfirmFile(account.file),
							}, ICON_TRASH),
						),
					),
					// ①b 徽章行 —— 独立成行：不跟昵称抢宽度，怎么换行都不影响昵称与操作按钮。
					h("div", { style: { display: "flex", alignItems: "center", gap: "5px", flexWrap: "wrap" } },
						h(Chip, null, account.enterpriseId ? "企业版" : "个人版"),
						account.realm === "global" ? h(Chip, { tone: TOKENS.accent, toneInk: TOKENS.accent }, "国际版") : null,
						account.unreadable
							? h(Chip, { tone: TOKENS.danger, toneInk: TOKENS.danger }, "文件损坏")
							: h(Chip, {
								tone: account.disabled ? TOKENS.warn : TOKENS.ok,
								toneInk: account.disabled ? TOKENS.warn : TOKENS.ok,
								title: account.disabled ? "点一下让它重新参与轮换" : "点一下暂停它参与轮换（凭证不会被删）",
								onClick: () => toggleAccount(account.file, account.disabled),
							}, account.disabled ? "未参与轮换" : "已启用"),
						account.expired ? h(Chip, { tone: TOKENS.warn, toneInk: TOKENS.warn }, "凭证过期") : null,
						// 网关的实时判定（冷却 / 熔断）—— 最动态的信息放徽章行末尾。
						poolBadge(poolByUid[account.uid]),
						checkinBadge(activity["checkin:" + account.uid]),
						streakLabel(growthByUid[account.uid]),
						taskBadge(growthByUid[account.uid]),
					),
					// ② 「当前调用」徽章 + uid ｜ 有效期至 —— WorkDaddy 的「手机 ｜ 有效期至」行。
					justified(
						h("span", { style: { display: "inline-flex", alignItems: "center", gap: "8px", minWidth: 0 } },
							isCurrent
								? h(Chip, { tone: TOKENS.bar, toneInk: TOKENS.bar },
									working ? "正在处理" : (soloCurrent ? "当前使用中" : "最近使用"))
								: null,
							h(Field, {
								label: account.enterpriseId ? "企业" : "uid",
								value: account.enterpriseId || account.uid || "—",
								style: { fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace", fontSize: "11.5px", color: TOKENS.caption },
							}),
						),
						h(Field, { label: "有效期至", value: expiry.text, style: { color: expiry.tone } }),
					),
					// ③ 可用 ⚡x ｜ 今日已使用 ⚡x —— WorkDaddy 的「剩余 ｜ 今日已使用」行。
					h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px", minWidth: 0 } },
						h("span", { style: { display: "inline-flex", alignItems: "center", gap: "7px", minWidth: 0 } },
							h("span", { style: { fontSize: "12.5px", color: TOKENS.caption, flexShrink: 0 } }, "可用"),
							creditValue(credit),
						),
						todayUsed > 0
							? h("span", {
								style: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12.5px", color: TOKENS.caption, flexShrink: 0 },
								title: (credit.todayUsage && credit.todayUsage.count ? credit.todayUsage.count + " 笔请求" : "")
									+ (credit.todayUsage && credit.todayUsage.date ? " · " + credit.todayUsage.date : ""),
							},
								"今日已使用",
								ICON_BOLT,
								h("b", { style: { color: TOKENS.ink, fontWeight: 600, fontVariantNumeric: "tabular-nums" } }, formatCredits(todayUsed)),
							)
							: null,
					),
					// ④ 积分条：贴底通栏（WorkDaddy 的条是全卡宽），一格一个包，越快到期的越淡。
					// 积分还在加载时画同高占位条 —— 否则每张卡都在积分落地那一刻集体长高。
					credit && credit.state === "ok" && !credit.unlimited ? creditBar(credit)
						: (credit === undefined && credits.phase === "loading" ? creditBarSkeleton() : null),
					// ⑤ 分段明细开合。加载中放一个 visibility:hidden 的同款按钮占位，行高不跳。
					canExpand
						? h("button", {
							type: "button",
							style: {
								alignSelf: "flex-start", padding: "3px 10px", borderRadius: "999px",
								border: "1px solid " + TOKENS.border, background: "transparent",
								color: TOKENS.muted, fontSize: "11.5px", cursor: "pointer",
							},
							onClick: () => setExpandedFile(expanded ? "" : account.file),
						}, credit.packageCount + " 段 " + (expanded ? "▴" : "▾"))
						: (credit === undefined && credits.phase === "loading"
							? h("button", {
								type: "button",
								style: {
									visibility: "hidden", alignSelf: "flex-start", padding: "3px 10px", borderRadius: "999px",
									border: "1px solid transparent", background: "transparent",
									fontSize: "11.5px", cursor: "default",
								},
							}, "占位")
							: null),
					expanded && canExpand ? segmentDetail(credit) : null,
					// 鼠标停在昵称上时弹出。挂在卡片末尾 = 盖在后续内容之上（z-index 40）。
					taskUid === account.uid ? taskPanel(growthByUid[account.uid]) : null,
				);
			};

			const accountRows = accounts.length === 0
				? h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", padding: "24px 0 12px" } },
					h("span", { style: { display: "inline-flex", color: TOKENS.muted } }, ICON_UPLOAD),
					h("div", { style: { fontSize: "12.5px", color: TOKENS.secondary } }, "还没有任何账号"),
					h("div", { style: HINT }, "用上面的「授权登录」或「导入 JSON」添加 —— 网关对 auths/ 每 5 秒轮询，加完自动生效，不用重启。"))
				: h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, accounts.map(accountCard));

			// ---- 模型目录 ----
			const modelBody = models === null
				? h("div", { style: HINT }, gateway.running ? "模型目录读取失败（网关刚起来时可能还没就绪，刷新一下）。" : "网关未运行，读不到模型目录。")
				: models.length === 0
					? h("div", { style: HINT }, "网关没返回任何模型 —— 通常意味着还没有可用账号。")
					: h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "7px" } },
						models.map((model) => h("div", {
							key: model.id,
							className: "wb2ui-model",
							style: { border: "1px solid " + TOKENS.border, borderRadius: "9px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "3px" },
						},
							// 网关的模型 id 带区域前缀（`cn:auto` / `global:gpt-5`）。区域信息在
							// 网关配置里已经定了，账号卡上也标了，这里再重复一遍只会把真正
							// 要看的模型名挤窄。完整 id 留在 title 里，悬停能看到、也能抄。
							h("span", { style: { fontSize: "12px", fontWeight: 600, wordBreak: "break-all", fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace" }, title: model.id }, shortModelId(model.id)),
							h("span", { style: HINT },
								compact(model.contextLength) + " 上下文"
								+ (model.maxOutputTokens ? " · 输出 " + compact(model.maxOutputTokens) : "")
								+ (model.supportsImages ? " · 支持图片" : ""),
							),
						)),
					);

			return h("div", { style: WRAP },
				h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
					h("div", { style: CARD }, statusRow, headerNote, configWarn, binaryWarn, gatewayWarn),
					notice.kind !== "idle"
						? h("div", {
							// 横幅化：左侧 3px 强调边 + 同色淡底，成功/失败一眼分清，不再是一行裸文字。
							style: {
								fontSize: "12.5px", color: noticeColor, lineHeight: 1.6,
								padding: "9px 12px", borderRadius: "10px",
								borderLeft: "3px solid " + noticeColor,
								background: "color-mix(in srgb, " + noticeColor + " 9%, transparent)",
							},
						}, notice.text)
						: null,
					// 任务轮次状态：待办确认 / 执行进度 / 领奖汇总 / 日志尾巴。
					// 只在有内容时出现 —— 平时它不该占版面。
					(taskRun.running || taskRun.summary || taskRun.error || taskRun.pending || taskRun.missing)
						? h("div", {
							style: {
								border: "1px solid " + TOKENS.border, borderRadius: "10px", padding: "10px 12px",
								display: "flex", flexDirection: "column", gap: "6px", background: TOKENS.panel2,
							},
						},
							h("div", { style: { fontSize: "12.5px", fontWeight: 600, color: TOKENS.ink } },
								taskRun.running
									? "任务执行中…（确认待办 → 执行动作 → 自动领奖）"
									: (taskRun.summary
										? "任务执行完成：领奖 " + taskRun.summary.totals.claimItems + " 项，+" + taskRun.summary.totals.credit + " 分 +"
											+ taskRun.summary.totals.energy + " 能"
											+ (taskRun.summary.totals.errors > 0 ? "，" + taskRun.summary.totals.errors + " 项出错" : "")
										: (taskRun.error ? "任务执行失败" : "任务状态"))),
							taskRun.pending
								? h("div", { style: HINT },
									"确认待办：" + taskRun.pending.total + " 项"
									+ (taskRun.pending.accounts || [])
										.filter((a) => (a.pending || []).length > 0)
										.map((a) => " · " + (a.nickname || String(a.uid).slice(0, 8)) + " " + a.pending.length + " 项")
										.join(""))
								: null,
							taskRun.error
								? h("div", { style: Object.assign({}, HINT, { color: TOKENS.danger }) }, taskRun.error)
								: null,
							taskRun.summary
								? h("div", { style: HINT },
									taskRun.summary.accounts
										.filter((a) => a.credit > 0 || a.errors.length > 0)
										.map((a) => (a.nickname || String(a.uid).slice(0, 8)) + " +" + a.credit + "分"
											+ (a.errors.length > 0 ? "（" + a.errors.length + " 错）" : ""))
										.join(" · ") || "没有新增奖励（待办都已完成或未达标）")
								: null,
							(taskRun.logs && taskRun.logs.length > 0)
								? h("div", {
									style: {
										maxHeight: "132px", overflowY: "auto", fontFamily: "ui-monospace, Consolas, monospace",
										fontSize: "11px", lineHeight: 1.5, color: TOKENS.caption, whiteSpace: "pre-wrap",
									},
								}, taskRun.logs.slice(-8).join("\n"))
								: null,
						)
						: null,
					Section({ title: "添加账号", children: addAccountBody }),
					Section({
						title: "账号（" + accounts.length + "）",
						extra: h("div", { style: Object.assign({}, ROW, { marginLeft: "auto" }) },
							h("span", {
								// 「积分更新于 N 秒前」宽度随时间变，会把右边三个按钮推来推去
								// —— 占住固定宽度，按钮就不再左右横跳。
								style: Object.assign({}, HINT, credits.missing ? { color: TOKENS.warn } : null, {
									display: "inline-block", minWidth: "9.5em", fontVariantNumeric: "tabular-nums",
								}),
							},
								credits.phase === "error"
									? (credits.missing
										? "面板后端未加载：插件 host 半侧只在 dsh 启动时加载，改动后需重启 dsh 生效"
										: "积分读取失败：" + credits.error)
									: (creditsData && creditsData.oldestFetch ? "积分更新于 " + timeAgo(creditsData.oldestFetch) : ""),
							),
							// 「一键做任务」放最前：它是这一区唯一「帮我把便宜占回来」的动作，
							// 另三个是查看/收尾类。主按钮色只给它一个，避免一排放三个蓝底。
							h("button", {
								type: "button",
								style: Object.assign({}, SMALL, {
									background: TOKENS.fill, color: TOKENS.onFill,
									borderColor: "transparent", fontWeight: 600,
								}),
								disabled: busy === "tasks" || taskRun.running || accounts.length === 0,
								onClick: runTasks,
								title: "先确认每个账号有无待办任务，再逐个执行（对话 / 桌面事件链 / 专家链），达标自动领奖。一轮可能几分钟。",
							}, taskRun.running ? "任务执行中…" : "一键做任务"),
							h("button", {
								type: "button", className: "wb2ui-ghost", style: SMALL,
								disabled: credits.phase === "loading",
								onClick: () => loadCredits(true),
							}, credits.phase === "loading" ? "读取中…" : "刷新积分"),
							// 签到**不放手动的** —— 每天首次打开面板自动跑，够用了。
							// 留个按钮只会让人以为必须点它一下。
							// 下面的「领取任务积分」要留：任务完成是随机发生的，
							// 没有固定时机可挂。
							h("button", {
								type: "button", className: "wb2ui-ghost", style: SMALL,
								disabled: busy === "growth" || accounts.length === 0,
								onClick: () => runActivity("growth"),
								// 只领「已完成但还没领」的 —— 没做完的任务发过去会被上游拒。
								title: "领取已完成的成长任务奖励。可领数量见各账号卡上的紫色徽章。",
							}, busy === "growth" ? "领取中…" : "领取任务积分"),
							h("button", {
								type: "button", className: "wb2ui-ghost", style: SMALL,
								disabled: busy === "keepalive" || accounts.length === 0,
								onClick: () => runActivity("keepalive"),
								title: "用每个账号发起一次云端会话，保持账号活跃度。",
							}, busy === "keepalive" ? "保活中…" : "保持活跃"),
						),
						children: accountRows,
					}),
					Section({ title: "可用模型" + (models ? "（" + models.length + "）" : ""), children: modelBody }),
				),
			);
		}

		/** 客户端入口：往设置里加一个独立分区。 */
		function apply(ctx) {
			injectStyles();
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-plugin-wb2api-ui",
				order: 43,
				label: () => "WorkBuddy 反代",
			}, () => h(Panel, null)));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
