package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/linguo2625469/workbuddy2api-panel/internal/agent"
)

// 注册于 NewHandler：
//   POST /v1/messages  → Anthropic Messages（Claude Code 等）
//   POST /v1/responses → OpenAI Responses（Codex 等）
//   GET  /v1/models    维持 OpenAI 形态（Codex 桥的 catalog 形状由 Responses
//                      客户端自行兼容；如需 catalog 端点后续加 /v1/catalog）。
//
// 两条路由都走同一套翻译：入站协议 → Chat Completions body → 复用
// chatCompletions 的内部链路。为避免重构原函数签名，这里用「自调用」方式：
// 构造一个新的 Chat 请求替换原请求后交给 h.chatCompletions——账号池、粘性、
// 轮转、错误分类、提示词改写全部继承，翻译层只管协议形状。

// anthropicMessages POST /v1/messages。
func (h *Handler) anthropicMessages(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"type": "error", "error": map[string]string{
				"type": "invalid_request_error", "message": "read body: " + err.Error(),
			},
		})
		return
	}
	var peek struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(raw, &peek)

	body, err := agent.AntToChat(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"type": "error", "error": map[string]string{
				"type": "invalid_request_error", "message": err.Error(),
			},
		})
		return
	}
	// Anthropic 请求不带 realm 前缀的模型名走网关默认映射：与原桥
	// WB2A_DEFAULT_MODEL 行为对齐——claude-* / 未知名一律落默认模型。
	body["model"] = resolveAnthropicModel(peek.Model, body["model"])

	out, _ := json.Marshal(body)
	h.proxyChat(w, r, out, peek.Stream, peek.Model, agentKindAnthropic)
}

// openaiResponses POST /v1/responses。
func (h *Handler) openaiResponses(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"message": "read body: " + err.Error(),
				"type": "invalid_request_error", "code": nil},
		})
		return
	}
	var peek struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(raw, &peek)

	body, custom, err := agent.RespToChat(raw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": map[string]any{"message": err.Error(),
				"type": "invalid_request_error", "code": nil},
		})
		return
	}
	// Responses 客户端常给裸名（gpt-5.5 等）：沿用 codex_bridge resolve_model 的
	// 前缀/后缀兜底语义，落不到就保持原名交网关 resolve。
	asked := peek.Model
	if asked == "" {
		asked, _ = body["model"].(string)
	}
	body["model"] = h.resolveResponsesModel(asked)
	agent.SetCustomTools(custom)

	out, _ := json.Marshal(body)
	h.proxyChat(w, r, out, peek.Stream, asked, agentKindResponses)
}

// agentKind 区分翻译出口的响应形态。
type agentKind int

const (
	agentKindAnthropic agentKind = iota
	agentKindResponses
)

// proxyChat 把已翻译的 Chat body 交给 chatCompletions 主链路，并按 kind 改写
// 响应阶段（非流式 JSON / 流式 SSE）的翻译出口。
// 实现方式：把响应改写器挂到 ResponseWriter 上（intercepting writer），
// chatCompletions 内部的 writeJSON / StreamHint 写出的内容先经过翻译层再落地。
func (h *Handler) proxyChat(w http.ResponseWriter, r *http.Request, chatBody []byte, stream bool, modelIn string, kind agentKind) {
	// 流式：翻译必须在 SSE 帧层面进行（不能在字节层面拦截），所以流式路径
	// 不走 intercepting writer——chatCompletions 的流式出口调用 upstream.StreamHint
	// 直接写帧。这里改为：给 chatCompletions 传一个带翻译回调的 request，由
	// chatCompletions 末尾检查（见 handler.go 的 stream kind 分支）。
	//
	// 非流式：chatCompletions 最终 writeJSON(map)——同样需要拦截。为不动
	// chatCompletions 的核心循环，这里复制一条轻量路径：直接调用
	// h.chatViaAgent 完成轮转+翻译（见 handler_agent.go）。
	h.chatViaAgent(w, r, chatBody, stream, modelIn, kind)
}

// sseLineReader 把上游 SSE 流拆成 data: 帧逐条回调（与 Python 桥的
// read(4096)+split 行为一致，bufio 保证半包/粘包安全）。
func sseFrames(r io.Reader, fn func(payload []byte) bool) {
	br := bufio.NewReaderSize(r, 64*1024)
	var buf bytes.Buffer
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			buf.Write(line)
			if bytes.Equal(bytes.TrimSpace(buf.Bytes()), []byte("")) {
				buf.Reset()
				if !fn(nil) {
					return
				}
				continue
			}
			if bytes.HasPrefix(bytes.TrimSpace(buf.Bytes()), []byte("data:")) {
				payload := bytes.TrimSpace(bytes.TrimPrefix(bytes.TrimSpace(buf.Bytes()), []byte("data:")))
				buf.Reset()
				if bytes.Equal(payload, []byte("[DONE]")) {
					continue
				}
				if len(payload) > 0 && !fn(payload) {
					return
				}
				continue
			}
			buf.Reset()
		}
		if err != nil {
			return
		}
	}
}
