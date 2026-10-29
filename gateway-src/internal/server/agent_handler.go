package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/linguo2625469/workbuddy2api-panel/internal/agent"
)

// chatViaAgent：agent 协议（Anthropic/Responses）→ Chat 主链路 → 响应翻译。
//
// 实现采用「响应拦截」：把 ResponseWriter 包一层翻译 shim，请求体替换为翻译后
// 的 Chat body，然后原样调用 chatCompletions。账号池轮转、粘性会话、错误分类、
// 提示词改写、用量统计全部继承；翻译层只在写出侧挂钩：
//   - 流式：chatCompletions → upstream.StreamHint 逐帧 write "data: {...}\n\n"，
//     shim 逐帧解析后交给对应协议的 StreamWriter 重写为该协议的事件流；
//   - 非流式：chatCompletions → writeJSON(map)，shim 截住整个 JSON 体翻译后写出。

// agentResponseWriter 拦截写出内容并按协议翻译。
type agentResponseWriter struct {
	http.ResponseWriter
	kind      agentKind
	model     string
	translate func(frame []byte) bool // 流式：每帧回调；返回 false 终止
	doneFn    func()                  // 流式：chatCompletions 返回后收尾（Finish 事件）
	done      bool                    // 非流式：已翻译写出
	hijacked  bool
}

func (a *agentResponseWriter) WriteHeader(code int) {
	if a.done || !a.isSSE() {
		// 非流式或错误路径：头直接透传（错误 JSON 由 Write 拦截翻译）
		a.ResponseWriter.WriteHeader(code)
	}
	// 流式成功路径：StreamHint 会设 SSE 头，形状两边一致，透传即可。
}

func (a *agentResponseWriter) isSSE() bool {
	return a.Header().Get("Content-Type") == "text/event-stream"
}

// Write 拦截两类写出：
//  1. 非流式 JSON（writeJSON）：整段截住，翻译后写出；
//  2. 流式 SSE 帧（"data: {...}\n\n"）：逐帧翻译重写。
func (a *agentResponseWriter) Write(p []byte) (int, error) {
	if a.done {
		return len(p), nil
	}
	if a.isSSE() {
		// SSE 帧。只翻译 data: 帧；空帧/注释原样。
		trimmed := bytes.TrimSpace(p)
		if !bytes.HasPrefix(trimmed, []byte("data:")) {
			// 帧间空行等：Anthropic 流不需要（事件自带\n\n），跳过写。
			// Responses 流同样由 emit 自带分隔。
			return len(p), nil
		}
		payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
		if bytes.Equal(payload, []byte("[DONE]")) {
			// Chat 的 [DONE] 由对应协议收尾事件替代（message_stop / response.completed）。
			return len(p), nil
		}
		if a.translate != nil {
			a.translate(payload)
		}
		return len(p), nil
	}
	// 非流式：整段 JSON。可能含错误（writeJSON 的 map）或成功响应。
	a.done = true
	a.translateJSON(p)
	return len(p), nil
}

// translateJSON 非流式翻译出口。
func (a *agentResponseWriter) translateJSON(p []byte) {
	var obj map[string]any
	if json.Unmarshal(p, &obj) != nil {
		a.ResponseWriter.Write(p)
		return
	}
	// 错误帧（OpenAI error 对象）按协议错误形状透出。
	if _, hasErr := obj["error"]; hasErr {
		switch a.kind {
		case agentKindAnthropic:
			msg := ""
			if e, ok := obj["error"].(map[string]any); ok {
				msg, _ = e["message"].(string)
			}
			out, _ := json.Marshal(map[string]any{
				"type": "error",
				"error": map[string]any{
					"type": "api_error", "message": msg,
				},
			})
			a.ResponseWriter.Write(out)
			return
		default:
			a.ResponseWriter.Write(p)
			return
		}
	}
	switch a.kind {
	case agentKindAnthropic:
		out, _ := json.Marshal(agent.ChatToAnt(obj, a.model))
		a.ResponseWriter.Write(out)
	case agentKindResponses:
		out, _ := json.Marshal(agent.ChatToResp(obj, a.model, map[string]bool{}))
		a.ResponseWriter.Write(out)
	}
}

// chatViaAgent 入口（agent_routes.go 的 proxyChat 落点）。
func (h *Handler) chatViaAgent(w http.ResponseWriter, r *http.Request, chatBody []byte, stream bool, modelIn string, kind agentKind) {
	// 替换请求体与必要的头，交给 chatCompletions 主链路。
	newReq := r.Clone(r.Context())
	newReq.Body = io.NopCloser(bytes.NewReader(chatBody))
	newReq.ContentLength = int64(len(chatBody))
	newReq.Header.Set("Content-Type", "application/json")

	aw := &agentResponseWriter{ResponseWriter: w, kind: kind, model: modelIn}
	if stream {
		switch kind {
		case agentKindAnthropic:
			sw := agent.NewAntStreamWriter(modelIn, func(event string, data any) error {
				b, _ := json.Marshal(data)
				_, err := w.Write([]byte("event: " + event + "\ndata: " + string(b) + "\n\n"))
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				return err
			})
			started := false
			aw.translate = func(frame []byte) bool {
				var ev map[string]any
				if json.Unmarshal(frame, &ev) != nil {
					return true
				}
				if !started {
					started = true
					// 首帧前先发 message_start（SSE 头此时已由 StreamHint 设好）。
					if err := sw.Start(); err != nil {
						return false
					}
				}
				_ = sw.FeedChunk(ev)
				return true
			}
			aw.doneFn = func() { _ = sw.Finish() }
		case agentKindResponses:
			sw := agent.NewRespStreamWriter(modelIn, func(event string, data map[string]any) error {
				b, _ := json.Marshal(data)
				_, err := w.Write([]byte("event: " + event + "\ndata: " + string(b) + "\n\n"))
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				return err
			})
			started := false
			aw.translate = func(frame []byte) bool {
				var ev map[string]any
				if json.Unmarshal(frame, &ev) != nil {
					return true
				}
				if !started {
					started = true
					if err := sw.Start(); err != nil {
						return false
					}
				}
				_ = sw.FeedChunk(ev)
				return true
			}
			aw.doneFn = func() { _ = sw.Finish() }
		}
	} else {
		aw.translate = nil
	}
	h.chatCompletions(aw, newReq)
	if stream && aw.doneFn != nil {
		aw.doneFn()
	}
}
