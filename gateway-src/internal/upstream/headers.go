// Package headers 构造三类上游请求头（common / chat / billing / refresh）。
// 规则来自 docs/api-reference.md §0/§4/§6。
package upstream

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
	"github.com/linguo2625469/workbuddy2api-panel/internal/session"
)

const (
	// defaultClientVersion 出站 WorkBuddy 客户端版本段（UA 的 `WorkBuddy/<ver>` 与
	// 白名单头组的 X-IDE-Version）。对齐官方 WorkBuddy Desktop 分发包版本（5.5.6，
	// 与 engine/wb_up 的 DESKTOP_UA、成长任务路径同一真机版本——三条出站路径共用
	// 一个版本号，避免同账号在不同端点自报两个客户端）。
	// config upstream.client_version 可覆盖（空 = 内置默认）。
	defaultClientVersion = "5.5.6"
	// defaultCliVersion 出站 UA 中 `CLI/<ver>` 段版本。对齐官方内置 CLI（2.137.1）。
	// config upstream.cli_version 可覆盖（空 = 内置默认）。
	defaultCliVersion = "2.137.1"

	originRefererCN     = "https://www.codebuddy.cn"
	originRefererGlobal = "https://www.workbuddy.ai"

	// acceptConsole 控制台类端点（refresh / catalog / v3 config）的 Accept：
	// 官方 commonHeaders 原样值（宽松集合）。
	acceptConsole = "application/json, text/plain, */*"
	// acceptChat 原生客户端 chat 端点的 Accept：**单值** application/json
	// （实读 WorkBuddy.app 的 chatHeaders；SSE 由 body 的 stream:true 决定，
	// 不靠 Accept 协商——带 text/event-stream 是浏览器 EventSource 的形状）。
	acceptChat = "application/json"
	// acceptJSON 只认 JSON 的端点（billing / checkin）。
	acceptJSON = "application/json"
)

// originRefererFor 按账号 realm 返回 Origin/Referer 基础域：
// global → https://www.workbuddy.ai；cn（含全局开关未开）→ https://www.codebuddy.cn。
func originRefererFor(a *auth.Auth) string {
	if a != nil && a.IsGlobal() {
		return originRefererGlobal
	}
	return originRefererCN
}

// clientVersion 生效的 WorkBuddy 客户端版本：Client.ClientVersion 非空则取之，
// 否则内置默认 defaultClientVersion。
func (c *Client) clientVersion() string {
	if c != nil && c.ClientVersion != "" {
		return c.ClientVersion
	}
	return defaultClientVersion
}

// cliVersion 生效的 CLI 版本：Client.CliVersion 非空则取之，否则内置默认 defaultCliVersion。
func (c *Client) cliVersion() string {
	if c != nil && c.CliVersion != "" {
		return c.CliVersion
	}
	return defaultCliVersion
}

// defaultWorkBuddyUAFor 组装默认客户端出站 UA（官方桌面端网关代理形态，两服同形）：
// `WorkBuddy/<clientVersion> WorkBuddy/<clientVersion> CLI/<cliVersion>`。
//
// 产品段两服都写 `WorkBuddy`，**不写 `WorkBuddy AI`**：两个官方包的网关代理
// （`WorkBuddy.app` 的 `main/daemon-bootstrap.js` 与 `WorkBuddy AI.app` 的同名函数）
// 都硬编码 `[WorkBuddy/<v>, WorkBuddy/<v>, CLI/…]`；`WorkBuddy AI` 只出现在
// `product.json`、窗口标题、以及目录请求的 `WorkBuddyAI/<v>` 里，从不出现在 chat 的 UA。
// 2026-10-20 实测两写法接受率无可测差异（6/10 vs 7/10，拒绝全是 429/14003），
// 故回到官方真实形态。官方无任何 UA 随机化，默认确定性。
func (c *Client) defaultWorkBuddyUAFor(a *auth.Auth) string {
	return "WorkBuddy/" + c.clientVersion() + " WorkBuddy/" + c.clientVersion() + " CLI/" + c.cliVersion()
}

// defaultWorkBuddyUA 返回 CN 形态的默认 UA（默认账号形态即 CN，零回归兼容既有调用/测试）。
func (c *Client) defaultWorkBuddyUA() string {
	return c.defaultWorkBuddyUAFor(nil)
}

// userAgent 返回当前出站 UA（客户端出站路径：chat/refresh/FetchModels）。
// 优先级：Client.UserAgent（config user_agent）显式覆盖 > 按账号 realm 的默认 WorkBuddy 三段式。
// 显式覆盖兼容既有覆盖逻辑：用户配了即以用户值为准（自定义品牌/版本），
// 未配则走官方桌面端默认形态（两服同一形态，产品段恒 `WorkBuddy`）。
func (c *Client) userAgent(a *auth.Auth) string {
	if c != nil && c.UserAgent != "" {
		return c.UserAgent
	}
	return c.defaultWorkBuddyUAFor(a)
}

// billingUA 白名单类（billing/checkin/banner）出站 UA：单段 `WorkBuddy/<clientVersion>`
// （官方 banner 显式覆写形态，不带 CLI 段）。默认生效（伪造官方桌面端指纹）；
// 显式 client_name="SaaS" 才不设 UA（还原旧行为，Go 默认 UA）。
func (c *Client) billingUA() string {
	if c == nil || c.attributionClientName() == "SaaS" {
		return ""
	}
	return "WorkBuddy/" + c.clientVersion()
}

// resolveDeviceToken 解析本次请求的 X-Device-Token 取值。
// 优先级：auth.Auth.DeviceToken（每号）> Client.DeviceToken（config 全局）> 文件兜底。
// 三者皆空/读失败则返回空串（调用方不注入该头，优雅降级）。
func (c *Client) resolveDeviceToken(a *auth.Auth) string {
	if a != nil && a.DeviceToken != "" {
		return a.DeviceToken
	}
	if c != nil && c.DeviceToken != "" {
		return c.DeviceToken
	}
	if c != nil && c.DeviceTokenFile != "" {
		return readDeviceTokenFile(c.DeviceTokenFile)
	}
	return ""
}

// injectDeviceToken 在 req 注入 X-Device-Token 头（仅当取到非空 token）。
func (c *Client) injectDeviceToken(req *http.Request, a *auth.Auth) {
	if tok := c.resolveDeviceToken(a); tok != "" {
		req.Header.Set("X-Device-Token", tok)
	}
}

// deriveAccountStableID 按 uid + 用途盐稳定派生 36 hex 设备/会话标识。
// 跨重启稳定（固定盐 "wb2a:"，不随进程换——这是与 session 包派生盐的本质差异：
// 那是会话键维度的进程级随机盐，重启换新；本函数是账号维度，必须跨重启恒定）、
// 账号间互异（uid 不同则不同）、同 uid 同用途恒同值（幂等）。用 sha256 与项目
// 既有派生（session/ids.go、cache_key.go）保持一致；截 36 hex 提供更长熵。
//
// 两个用途：
//   - purpose="machine" → X-Machine-ID（设备级，跨会话稳定）
//   - purpose="session" → X-Session-ID（账号固定会话，跨重启稳定）
//
// 与 injectDeviceToken 的 X-Device-Token 并存不冲突：那是登录时上游签发的
// 真实设备令牌（有则发，权威）；本对头是「每账号一台固定虚拟设备」的稳定指纹，
// 防多号被上游按设备指纹缺失/漂移关联风控。两者是不同头族，官方桌面端都发。
func deriveAccountStableID(uid, purpose string) string {
	sum := sha256.Sum256([]byte("wb2a:" + purpose + ":" + uid))
	return hex.EncodeToString(sum[:18]) // 36 hex chars
}

// injectAccountStableHeaders 在 req 注入 X-Machine-ID / X-Session-ID：按 uid 稳定
// 派生，跨重启固定、账号间互异。uid 为空时不注入（匿名请求无设备标识，上游不要求）。
func (c *Client) injectAccountStableHeaders(req *http.Request, a *auth.Auth) {
	if a == nil || a.UID == "" {
		return
	}
	req.Header.Set("X-Machine-ID", deriveAccountStableID(a.UID, "machine"))
	req.Header.Set("X-Session-ID", deriveAccountStableID(a.UID, "session"))
}

// CommonHeaders 设置所有 API 共享的请求头。
func (c *Client) CommonHeaders(req *http.Request, a *auth.Auth) {
	req.Header.Set("Content-Type", "application/json")
	// Accept：控制台类端点（refresh / catalog / v3 config）用官方 commonHeaders
	// 原样宽松集合；原生客户端 chat 的单值形态在 ChatHeaders 覆盖为 acceptChat。
	req.Header.Set("Accept", acceptConsole)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	origin := originRefererFor(a)
	req.Header.Set("Origin", origin)
	req.Header.Set("Referer", origin+"/")
	req.Header.Set("User-Agent", c.userAgent(a))
	// X-CodeBuddy-Request: 1（官方客户端风控闸门头，所有 API 请求必带，D1）。
	req.Header.Set("X-CodeBuddy-Request", "1")
	// Accept-Language 按 realm 切（D5）：CN zh-CN，global en-US。官方客户端按账号域
	// 发对应语言标识，对齐避免上游风控按语言缺失误判。
	req.Header.Set("Accept-Language", acceptLanguageFor(a))
	// X-Machine-ID / X-Session-ID：按 uid 稳定派生的账号级设备头（见
	// injectAccountStableHeaders）。注入在 CommonHeaders——chat 经 ChatHeaders
	// 叠加 CommonHeaders 天然继承；billing 域另行注入，全出站覆盖。
	c.injectAccountStableHeaders(req, a)
}

// acceptLanguageFor 按账号 realm 返回 Accept-Language：global → en-US，cn → zh-CN。
func acceptLanguageFor(a *auth.Auth) string {
	if a != nil && a.IsGlobal() {
		return "en-US"
	}
	return "zh-CN"
}

// injectCodeBuddyRequest 在 req 注入 X-CodeBuddy-Request: 1。
// billing 域未走 CommonHeaders，单独注入保证全出站覆盖（D1）。
func (c *Client) injectCodeBuddyRequest(req *http.Request) {
	req.Header.Set("X-CodeBuddy-Request", "1")
}

// ChatMeta 一次 chat 出站的会话头族元数据（issue #35：后台按 X-Conversation-Request-ID
// 聚合请求，官方客户端一次 user send 内所有 tool call/重试/换号复用同一个 ID）。
// handler 在轮转循环外生成 conversationID / conversationRequestID，循环内每次出站
// 复用同值；TraceID 透传入站值（空 = 回落 conversationRequestID）。
// RootRequestID 透传入站 X-Root-Request-ID：官方**只在**会话有根请求（fork /
// subagent）时才发这条，顶层会话一律不带，故零值 = 不发。
// messageID（消息级，每条独立）由 ChatHeaders 内部生成，无需外部可见。
type ChatMeta struct {
	ConversationID        string // X-Conversation-ID：body 提取的入站值，空则不发（透传优先，不伪造）
	ConversationRequestID string // X-Conversation-Request-ID：对话轮级聚合主键，必发
	RootRequestID         string // X-Root-Request-ID：入站透传，空则不发（官方顶层会话不带）
	TraceID               string // X-Trace-ID：入站透传值，非法则回落 conversationRequestID
}

// ChatHeaders 在 common 之上加 chat 专属的账号头，形态逐项对齐官方原生客户端
// （实读 WorkBuddy.app 的 applyGatewayHeaders / buildConversationHeaders）。
//
// 与「控制台端点」（refresh / catalog / billing）的差别是刻意的，也是官方本来的
// 差别：chat 由原生客户端发出，不发 Origin/Referer，不用 X-No-* 否定族，
// 也不带 Accept-Language / X-Machine-ID / X-Session-ID。
//
// clientIP 为本次请求的客户端 IP（按参数传递，不读共享字段——避免并发串扰）；
// PassthroughIP=false 或 clientIP 为空时不注入 IP 头。
func (c *Client) ChatHeaders(req *http.Request, a *auth.Auth, clientIP string, meta ChatMeta) {
	c.CommonHeaders(req, a)
	// ── 官方 chat 头形态：删掉控制台专属的三类「浏览器/网关」声明 ──
	// 1) Origin/Referer：原生客户端不跨域。一条 POST 到 copilot.tencent.com 却
	//    声称来源是 codebuddy.cn 的网页，是最硬的「非客户端」特征（网关按 origin
	//    会把请求归到网页会话桶，而不是桌面端）。
	req.Header.Del("Origin")
	req.Header.Del("Referer")
	// 2) Accept-Language：官方 chat 头族没有这条。
	req.Header.Del("Accept-Language")
	// 3) X-Machine-ID / X-Session-ID：官方 chat 不自报派生设备指纹；带着等于多
	//    一条官方从不做的断言。设备侧只保留登录时上游真实签发的 X-Device-Token。
	req.Header.Del("X-Machine-ID")
	req.Header.Del("X-Session-ID")
	// 4) Accept：官方 chat 单值 application/json（SSE 由 body 的 stream:true 决定）。
	req.Header.Set("Accept", acceptChat)
	// AccessToken 加锁快照：keepalive 定时刷新会在 a.mu 内改写它，锁外直读构成数据竞争
	// （见 auth.AccessTokenValue 注释）。
	if at := a.AccessTokenValue(); at != "" {
		req.Header.Set("Authorization", "Bearer "+at)
	}
	// 身份头：官方「有值才发」，chat 上绝不用 X-No-* 否定族（那族只属于
	// /v2/auth/state 的匿名态）。企业与租户 id 成对出现，与官方 chatHeaders 一致。
	if a.UID != "" {
		req.Header.Set("X-User-Id", a.UID)
	}
	if a.EnterpriseID != "" {
		req.Header.Set("X-Enterprise-Id", a.EnterpriseID)
		req.Header.Set("X-Tenant-Id", a.EnterpriseID)
	}
	// 域头：global 固定声明国际版域（官方原生客户端同款）；CN 透传登录会话原值，
	// 空则不发（不伪造、也不用 X-No-Department-Info 否定）。
	if a.IsGlobal() {
		req.Header.Set("X-Domain", "www.workbuddy.ai")
	} else if d := a.DomainValue(); d != "" {
		req.Header.Set("X-Domain", d)
	}
	// 安全红线：绝不在 chat 请求里携带 X-Refresh-Token。
	//
	// 归属族（X-Agent-* / X-IDE-* / X-Product / X-Private-Data）在下面注入——
	// 官方每一次模型调用都带，缺一项就不再像那个客户端。
	c.injectAttribution(req)
	// 客户端 IP 透传（仅 PassthroughIP=true 且本次请求带 IP）。
	c.injectClientIP(req, clientIP)
	// 设备风控头：上游登录时真实签发的设备令牌（auth 每号 > config 全局 > 文件兜底）。
	c.injectDeviceToken(req, a)
	// 会话头族（对话/请求/消息/acp 连接/trace 三方言），见 injectConversationHeaders。
	c.injectConversationHeaders(req, meta)
}

// injectConversationHeaders 注入官方客户端会话头族（issue #35 后台聚合）。
// 头族分层，各司其职（生命周期抄自官方会话账本）：
//   - X-Conversation-ID：会话级，多轮稳定（body 的 conversationId，36 字符带横线 UUID）。
//     空则不发——透传客户端原值优先，客户端没给就不伪造。
//   - X-Conversation-Request-ID：**对话轮级聚合主键**，必发。一次 user send 内的
//     所有 tool call/重试/换号/降级复用同一个 → 后台按它聚合成一条（不再碎片化）。
//   - X-Conversation-Message-ID = X-Request-ID：消息级，每条独立（32 位 hex）。
//   - acp-connection-id：官方网关代理 `applyGatewayHeaders` 在**每个** chat 上都从
//     会话账本取这条（36 字符带横线 UUID）。我们没走 `/connect` 握手，按会话稳定
//     派生一个——缺一条必带头是明确可辨的"非客户端"，同形的稳定值则与握过手的
//     客户端一致。
//   - X-Root-Request-ID：官方只在会话有 rootRequestId（fork / subagent）时才发，
//     顶层会话一律不带；故只在入站透传了该头时才发。
//   - trace 三方言（traceparent / b3 / X-B3-* / X-Trace-ID）：**共享同一个 trace id**。
//     官方代理自带注释即规格：三个 id 各自随机 = 三个视图无法交叉关联 = 等于没发。
func (c *Client) injectConversationHeaders(req *http.Request, meta ChatMeta) {
	convReqID := meta.ConversationRequestID
	if convReqID == "" {
		// 零值 meta（直接调 ChatHeaders 的调用方/测试）也要保证聚合主键必发：
		// 本级补一个 32 hex，调用方（handler）已生成稳定的不走到这里。
		convReqID = session.NewMessageID()
	}
	messageID := session.NewMessageID()
	if meta.ConversationID != "" {
		req.Header.Set("X-Conversation-ID", meta.ConversationID)
	}
	req.Header.Set("X-Conversation-Request-ID", convReqID)
	req.Header.Set("X-Conversation-Message-ID", messageID)
	req.Header.Set("X-Request-ID", messageID)
	if meta.RootRequestID != "" {
		req.Header.Set("X-Root-Request-ID", meta.RootRequestID)
	}
	if acp := acpConnectionID(meta.ConversationID, convReqID); acp != "" {
		req.Header.Set("acp-connection-id", acp)
	}
	// trace id：入站值只在 32 hex（W3C traceparent 的 trace-id 宽度）时采用，
	// 否则回落 conversationRequestID，再不行用 messageID（恒 32 hex）。
	traceID := meta.TraceID
	if !validTraceID32(traceID) {
		traceID = convReqID
	}
	if !validTraceID32(traceID) {
		traceID = messageID
	}
	// span 每请求新（B3 规范 16 hex）；parent span 独立取值，官方同样不沿用上一跳。
	injectTraceHeaders(req, traceID, messageID[:16], deriveHex("wb2a:parent:"+convReqID, 8))
}

// injectTraceHeaders 注入三种 trace 方言，全部共享同一个 traceID。
// 官方网关的注释就是规格：三个 id 各自随机 = 三个视图无法交叉关联 = 等于没发。
func injectTraceHeaders(req *http.Request, traceID, spanID, parentSpanID string) {
	req.Header.Set("traceparent", "00-"+traceID+"-"+spanID+"-01")
	req.Header.Set("b3", traceID+"-"+spanID+"-1-"+parentSpanID)
	req.Header.Set("X-B3-TraceId", traceID)
	req.Header.Set("X-B3-ParentSpanId", parentSpanID)
	req.Header.Set("X-B3-SpanId", spanID)
	req.Header.Set("X-B3-Sampled", "1")
	req.Header.Set("X-Trace-ID", traceID)
}

// deriveHex 按种子稳定派生 n 字节 hex（用于 acp 连接 id / parent span 这类
// "同一会话内必须一致、但无需真随机"的标识）。
func deriveHex(seed string, n int) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:n])
}

// acpConnectionID 派生会话级 ACP 连接 id：36 字符带横线 UUID 形态（官方取
// crypto.randomUUID()）。会话内恒定、会话间互异——与"握过手的客户端"同形。
func acpConnectionID(conversationID, convReqID string) string {
	seed := conversationID
	if seed == "" {
		seed = convReqID
	}
	if seed == "" {
		return ""
	}
	return dashedUUID("wb2a:acp:" + seed)
}

// dashedUUID 按种子派生 8-4-4-4-12 带横线 UUID（v4 版本位 / RFC 4122 变体位）。
func dashedUUID(seed string) string {
	b := []byte(deriveHex(seed, 16)) // 32 hex chars
	b[12] = '4'                      // version 4（第 3 组首字符 = 第 7 字节高 4 位）
	switch b[16] {                   // variant（第 4 组首字符 = 第 9 字节高 4 位）
	case '8', '9', 'a', 'b', 'c', 'd', 'e', 'f':
		b[16] = '9'
	default:
		b[16] = '8'
	}
	s := string(b)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

// validTraceID32 判断是否 32 位 hex（W3C traceparent 的 trace-id 宽度）。
func validTraceID32(s string) bool {
	return len(s) == 32 && validTraceID(s)
}

// validTraceID 判断 B3 TraceId 是否合法：16 或 32 位 hex（大小写均可）。
// 官方客户端生成的 conversationRequestId 是 32 位 hex（UUID 去横线），入站透传值
// 可能是任意形状（含横线/超长/非 hex），直接塞进 B3 头会破坏链路关联（issue #35）。
func validTraceID(s string) bool {
	if len(s) != 16 && len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) {
			return false
		}
	}
	return true
}

// attributionClientName 生效的用量归属名：ClientName 非空取之；
// 空默认 "WorkBuddy"（伪造官方桌面端指纹；显式配 "SaaS" 可还原旧行为）。
func (c *Client) attributionClientName() string {
	if c != nil && c.ClientName != "" {
		return c.ClientName
	}
	return "WorkBuddy"
}

// injectAttribution 注入官方模型调用必带的归属族，仅在 chat/completions 路径生效。
//
// 实读 WorkBuddy.app：CLI 的 buildConversationHeaders 与桌面网关代理的
// applyGatewayHeaders 都发这一族——X-Agent-Intent=craft / X-Agent-Purpose=conversation /
// X-Agent-Type=main / X-Private-Data=true / x-codebuddy-request=1 / X-IDE-*，
// 而 X-Product **恒为 SaaS**（产品身份由 X-IDE-* 声明，不由 X-Product 声明）。
//
// 这些是"客户端对本次请求的声明"：缺一项就不只是不够礼貌，而是可辨认为非该客户端
// （上游把 subagent 计入不同桶，故 X-Agent-Type 必须是 main）。
// 显式 client_name="SaaS" 只声明产品面，不声明 X-IDE-*（旧行为）。
func (c *Client) injectAttribution(req *http.Request) {
	req.Header.Set("X-Agent-Intent", "craft")
	req.Header.Set("X-Agent-Purpose", "conversation")
	req.Header.Set("X-Agent-Type", "main")
	req.Header.Set("X-Private-Data", "true")
	req.Header.Set("X-CodeBuddy-Request", "1")
	req.Header.Set("X-Product", "SaaS")
	if c != nil && c.ClientName == "SaaS" {
		return
	}
	name := c.attributionClientName()
	req.Header.Set("X-IDE-Name", name)
	req.Header.Set("X-IDE-Type", name)
	req.Header.Set("X-IDE-Version", c.clientVersion())
}

// injectClientIP 在 PassthroughIP 开启时把 clientIP 参数透传给上游（三等价头）。
func (c *Client) injectClientIP(req *http.Request, clientIP string) {
	if c == nil || !c.PassthroughIP || clientIP == "" {
		return
	}
	req.Header.Set("X-Forwarded-For", clientIP)
	req.Header.Set("X-Real-IP", clientIP)
	req.Header.Set("X-Client-IP", clientIP)
}

// ExtractClientIP 从入站请求提取客户端 IP 首段（X-Forwarded-For 首段，回落 X-Real-IP）。
func ExtractClientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for i := 0; i < len(xff); i++ {
			if xff[i] == ',' {
				return strings.TrimSpace(xff[:i])
			}
		}
		return strings.TrimSpace(xff)
	}
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}
	return ""
}

// BillingHeaders billing 接口请求头。
// UA 语义：默认**不设置**（保持现状，Go 客户端自带默认 UA）；仅当显式配置
// c.UserAgent 非空才覆盖——避免默认路径给 billing 引入新的 UA 指纹。
func (c *Client) BillingHeaders(req *http.Request, a *auth.Auth) {
	// AccessToken 加锁快照（同 ChatHeaders：keepalive 可在 a.mu 内改写）。
	req.Header.Set("Authorization", "Bearer "+a.AccessTokenValue())
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	c.injectCodeBuddyRequest(req)
	// Accept-Language 按 realm 切（D5，billing 域未走 CommonHeaders，单独注入）。
	req.Header.Set("Accept-Language", acceptLanguageFor(a))
	if c != nil && c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	} else if ua := c.billingUA(); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	if a.UID != "" {
		req.Header.Set("X-User-Id", a.UID)
	}
	if a.EnterpriseID != "" {
		req.Header.Set("X-Enterprise-Id", a.EnterpriseID)
		req.Header.Set("X-Tenant-Id", a.EnterpriseID)
	}
	if d := a.DomainValue(); d != "" {
		req.Header.Set("X-Domain", d)
	}
	// 设备风控头：billing 域（report/travel/balance/checkin）同样注入。
	c.injectDeviceToken(req, a)
}

// RefreshHeaders refresh 端点专属头（X-Refresh-Token 只允许出现在这里）。
func (c *Client) RefreshHeaders(req *http.Request, a *auth.Auth) {
	c.CommonHeaders(req, a)
	req.Header.Set("X-Refresh-Token", a.RefreshToken)
	if a.EnterpriseID != "" {
		req.Header.Set("X-Enterprise-Id", a.EnterpriseID)
	}
	// X-Auth-Refresh-Source：官方客户端的渠道标识是 "workbuddy"（refresh 端点专用头）。
	// 此前发 "plugin" 等于在 refresh 请求里自报"插件"，与 chat 侧伪装成桌面端自相矛盾。
	req.Header.Set("X-Auth-Refresh-Source", "workbuddy")
}
