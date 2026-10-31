// headers_official_test.go 出站头「官方形态」回归闸门。
//
// 基线来源：_ref（dsh-workbuddy-connect）里从 WorkBuddy.app 包内
// `main/daemon-bootstrap.js` 的 applyGatewayHeaders 与 CLI 的
// buildConversationHeaders 逐项抄下来的 chat 头集合。本文件的断言就是那张表：
// 少一条 = missing、多一条官方不发的 = extra、值不同 = mismatch，三类都算红。
//
// 只覆盖「形状」：ID 的实际取值不比对（那是随机的），比的是**在场与取值域**。
package upstream

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/linguo2625469/workbuddy2api-panel/internal/auth"
)

// officialChatHeaderNames 官方原生客户端 chat 请求必带的头（值另断言）。
var officialChatHeaderNames = []string{
	"Accept",
	"Content-Type",
	"User-Agent",
	"X-Requested-With",
	"X-Agent-Intent",
	"X-Agent-Purpose",
	"X-Agent-Type",
	"X-Private-Data",
	"X-CodeBuddy-Request",
	"X-Product",
	"X-IDE-Name",
	"X-IDE-Type",
	"X-IDE-Version",
	"X-Conversation-Request-ID",
	"X-Conversation-Message-ID",
	"X-Request-ID",
	"acp-connection-id",
	"traceparent",
	"b3",
	"X-B3-TraceId",
	"X-B3-ParentSpanId",
	"X-B3-SpanId",
	"X-B3-Sampled",
	"X-Trace-ID",
}

// captureHeaders 起一个 server 端捕获本次出站请求的 header 快照。
func captureHeaders(t *testing.T, apply func(c *Client, req *http.Request)) http.Header {
	t.Helper()
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer srv.Close()
	c := &Client{
		HTTP:          srv.Client(),
		ChatHTTP:      srv.Client(),
		ChatBaseCN:    srv.URL,
		BillingBaseCN: srv.URL,
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v2/chat/completions", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	apply(c, req)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	resp.Body.Close()
	return got
}

// TestChatHeadersMatchOfficialClient chat 头逐项对齐官方原生客户端。
func TestChatHeadersMatchOfficialClient(t *testing.T) {
	h := captureHeaders(t, func(c *Client, req *http.Request) {
		c.ChatHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1"}, "", ChatMeta{ConversationRequestID: "0123456789abcdef0123456789abcdef"})
	})

	// 1) 必带头一个都不能少。
	for _, name := range officialChatHeaderNames {
		if h.Get(name) == "" {
			t.Errorf("missing official header %q", name)
		}
	}

	// 2) 官方 chat **不发**的头，一个都不能多。
	for _, name := range []string{
		"Origin",               // 原生客户端不跨域
		"Referer",              // 同上
		"Accept-Language",      // chat 头族无此条
		"X-Machine-ID",         // 官方不自报派生设备指纹
		"X-Session-ID",         // 同上
		"X-No-Authorization",   // 否定族只属于 /v2/auth/state 匿名态
		"X-No-User-Id",         // 同上
		"X-No-Enterprise-Id",   // 同上
		"X-No-Department-Info", // 同上
	} {
		if v := h.Get(name); v != "" {
			t.Errorf("extra header %q=%q (official chat never sends it)", name, v)
		}
	}

	// 3) 取值域。
	wantValues := map[string]string{
		"Accept":              acceptChat,
		"Content-Type":        "application/json",
		"X-Requested-With":    "XMLHttpRequest",
		"X-Agent-Intent":      "craft",
		"X-Agent-Purpose":     "conversation",
		"X-Agent-Type":        "main",
		"X-Private-Data":      "true",
		"X-CodeBuddy-Request": "1",
		"X-Product":           "SaaS",
		"X-IDE-Name":          "WorkBuddy",
		"X-IDE-Type":          "WorkBuddy",
	}
	for name, want := range wantValues {
		if got := h.Get(name); got != want {
			t.Errorf("%s = %q want %q", name, got, want)
		}
	}
	if ua := h.Get("User-Agent"); !strings.HasPrefix(ua, "WorkBuddy/") || strings.Contains(ua, "WorkBuddy AI") {
		t.Errorf("UA = %q want 官方三段式且产品段为 WorkBuddy（两服同形）", ua)
	}

	// 4) 官方只在 fork/subagent 才发 X-Root-Request-ID：顶层会话（零值 meta）必须不带。
	if v := h.Get("X-Root-Request-ID"); v != "" {
		t.Errorf("X-Root-Request-ID = %q, 顶层会话不该带（官方只在 fork/subagent 发）", v)
	}

	// 5) acp-connection-id 是 36 字符带横线 UUID（官方取 randomUUID）。
	acp := h.Get("acp-connection-id")
	if len(acp) != 36 || strings.Count(acp, "-") != 4 {
		t.Errorf("acp-connection-id = %q want 8-4-4-4-12 带横线 UUID", acp)
	}

	// 6) trace 三方言共享同一个 trace id。
	traceID := h.Get("X-Trace-ID")
	if !validTraceID32(traceID) {
		t.Fatalf("X-Trace-ID = %q want 32 hex", traceID)
	}
	if got := h.Get("X-B3-TraceId"); got != traceID {
		t.Errorf("X-B3-TraceId = %q want %q（三方言必须同 id）", got, traceID)
	}
	if tp := h.Get("traceparent"); !strings.Contains(tp, traceID) {
		t.Errorf("traceparent = %q 应含 trace id %q", tp, traceID)
	}
	if b3 := h.Get("b3"); !strings.HasPrefix(b3, traceID+"-") {
		t.Errorf("b3 = %q 应以 %q 开头", b3, traceID)
	}

	// 7) 消息级 id：X-Conversation-Message-ID == X-Request-ID（官方同值），32 hex。
	msgID := h.Get("X-Conversation-Message-ID")
	if msgID != h.Get("X-Request-ID") {
		t.Errorf("X-Conversation-Message-ID=%q X-Request-ID=%q want 同值", msgID, h.Get("X-Request-ID"))
	}
	if !validTraceID32(msgID) {
		t.Errorf("message id = %q want 32 hex（UUIDv7 去横线形态）", msgID)
	}
}

// TestChatHeadersRootPassedThrough 入站带根请求头时才透传（fork/subagent 语义）。
func TestChatHeadersRootPassedThrough(t *testing.T) {
	h := captureHeaders(t, func(c *Client, req *http.Request) {
		c.ChatHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1"}, "", ChatMeta{
			ConversationRequestID: "0123456789abcdef0123456789abcdef",
			RootRequestID:         "fedcba9876543210fedcba9876543210",
		})
	})
	if got := h.Get("X-Root-Request-ID"); got != "fedcba9876543210fedcba9876543210" {
		t.Errorf("X-Root-Request-ID = %q want 透传值", got)
	}
}

// TestChatHeadersAcpStablePerConversation acp 连接 id 在同一会话内稳定、跨会话互异。
func TestChatHeadersAcpStablePerConversation(t *testing.T) {
	const conv = "11111111-2222-4333-8444-555555555555"
	get := func() string {
		return captureHeaders(t, func(c *Client, req *http.Request) {
			c.ChatHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1"}, "", ChatMeta{ConversationID: conv})
		}).Get("acp-connection-id")
	}
	first, second := get(), get()
	if first != second {
		t.Errorf("acp 应随会话稳定: %q vs %q", first, second)
	}
	other := captureHeaders(t, func(c *Client, req *http.Request) {
		c.ChatHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1"}, "", ChatMeta{ConversationID: "99999999-8888-4777-8666-555555555555"})
	}).Get("acp-connection-id")
	if other == first {
		t.Errorf("不同会话的 acp 不该相同: %q", other)
	}
}

// TestCommonHeadersConsoleShape 控制台端点仍发官方网页形态（Origin/Referer/宽松 Accept）。
func TestCommonHeadersConsoleShape(t *testing.T) {
	h := captureHeaders(t, func(c *Client, req *http.Request) {
		c.CommonHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1"})
	})
	if got := h.Get("Accept"); got != acceptConsole {
		t.Errorf("console Accept = %q want %q", got, acceptConsole)
	}
	if h.Get("Origin") != originRefererCN || h.Get("Referer") != originRefererCN+"/" {
		t.Errorf("console Origin/Referer = %q/%q", h.Get("Origin"), h.Get("Referer"))
	}
}

// TestRefreshHeadersOfficialShape refresh 渠道标识对齐官方 "workbuddy"。
func TestRefreshHeadersOfficialShape(t *testing.T) {
	h := captureHeaders(t, func(c *Client, req *http.Request) {
		c.RefreshHeaders(req, &auth.Auth{AccessToken: "at", UID: "u1", RefreshToken: "rt"})
	})
	if got := h.Get("X-Auth-Refresh-Source"); got != "workbuddy" {
		t.Errorf("X-Auth-Refresh-Source = %q want workbuddy（官方渠道标识）", got)
	}
	if got := h.Get("X-Refresh-Token"); got != "rt" {
		t.Errorf("X-Refresh-Token = %q want rt", got)
	}
}
