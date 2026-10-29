// Package agent 提供多协议 agent 接入层：
// 把 Anthropic Messages API（/v1/messages）与 OpenAI Responses API
// （/v1/responses）的请求翻译成网关原生的 OpenAI Chat Completions 形态，
// 复用既有的 chatCompletions 出站链路（账号池/粘性/轮转/错误分类全量继承）。
//
// 语义对照源：
//   - Anthropic 侧：~/.dsh/wb2api/anthropic_bridge.py（ant_to_oai / oai_to_ant / _stream）
//   - Responses 侧：~/.dsh/wb2api/codex_bridge.py（resp_to_chat / oai_to_resp / _stream）
//
// 翻译表里的每一条脏细节（孤儿 tool_result 兜底、tool_calls 空结果占位、
// reasoning_effort 压 low 等）都是原桥在真机踩坑换来的，逐条保留。
package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ---------- Anthropic Messages -> OpenAI Chat ----------

// antContentBlock Anthropic 消息 content 块（tagged union，type 区分）。
type antContentBlock struct {
	Type string `json:"type"` // text | tool_use | tool_result | image | thinking

	// text / thinking
	Text     string `json:"text,omitempty"`
	Thinking string `json:"thinking,omitempty"`

	// tool_use
	ID    json.RawMessage `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`

	// tool_result
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`

	// image
	Source json.RawMessage `json:"source,omitempty"`
}

// antMessage Anthropic messages 数组元素。
type antMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"` // string 或 []antContentBlock
}

// antRequest Anthropic Messages 请求体（只取翻译需要的字段，其余丢弃）。
type antRequest struct {
	Model         string          `json:"model"`
	System        json.RawMessage `json:"system,omitempty"` // string 或 block 数组
	Messages      []antMessage    `json:"messages"`
	MaxTokens     int             `json:"max_tokens,omitempty"`
	Stream        bool            `json:"stream,omitempty"`
	Temperature   *float64        `json:"temperature,omitempty"`
	TopP          *float64        `json:"top_p,omitempty"`
	StopSequences []string        `json:"stop_sequences,omitempty"`
	Tools         []antTool       `json:"tools,omitempty"`
	ToolChoice    *antToolChoice  `json:"tool_choice,omitempty"`
}

type antTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema,omitempty"`
}

type antToolChoice struct {
	Type string `json:"type"` // auto | any | none | tool
	Name string `json:"name,omitempty"`
}

// AntToChat 把 Anthropic Messages 请求翻译成 Chat Completions 请求体（map 形态，
// 直接 json.Marshal 后喂 chatCompletions 既有链路）。
func AntToChat(raw []byte) (map[string]any, error) {
	var req antRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("bad anthropic request: %w", err)
	}

	msgs := []map[string]any{}

	// system：字符串或 block 数组，拼成一条 system 消息。
	sysTexts := []string{}
	if len(req.System) > 0 {
		var s string
		if json.Unmarshal(req.System, &s) == nil && s != "" {
			sysTexts = append(sysTexts, s)
		} else {
			var blocks []map[string]any
			if json.Unmarshal(req.System, &blocks) == nil {
				for _, b := range blocks {
					if t, _ := b["type"].(string); t == "text" {
						sysTexts = append(sysTexts, strOr(b["text"]))
					}
				}
			}
		}
	}
	if len(sysTexts) > 0 {
		msgs = append(msgs, map[string]any{"role": "system", "content": strings.Join(sysTexts, "\n\n")})
	}

	for _, m := range req.Messages {
		role := m.Role
		// content 可能是纯字符串。
		var s string
		if json.Unmarshal(m.Content, &s) == nil {
			msgs = append(msgs, map[string]any{"role": role, "content": s})
			continue
		}
		var blocks []antContentBlock
		if err := json.Unmarshal(m.Content, &blocks); err != nil {
			return nil, fmt.Errorf("bad message content: %w", err)
		}

		// 第一遍：收集本条消息里的 tool_use id（配对依据）。
		useIDs := map[string]bool{}
		for _, b := range blocks {
			if b.Type == "tool_use" {
				useIDs[b.BlockID()] = true
			}
		}
		prevHasTC := len(msgs) > 0 && msgs[len(msgs)-1]["tool_calls"] != nil

		texts := []string{}
		toolCalls := []map[string]any{}
		pendingResults := []map[string]any{}
		for _, b := range blocks {
			switch b.Type {
			case "text":
				texts = append(texts, b.Text)
			case "thinking":
				// 思考块不上游（上游自行产出 reasoning_content），丢弃。
			case "tool_use":
				id := b.BlockID()
				if id == "" {
					id = "call_" + randHex(16)
				}
				input := b.Input
				if len(input) == 0 {
					input = json.RawMessage("{}")
				}
				toolCalls = append(toolCalls, map[string]any{
					"id":   id,
					"type": "function",
					"function": map[string]any{
						"name":      b.Name,
						"arguments": string(input),
					},
				})
			case "tool_result":
				cc := toolResultText(b.Content)
				// 孤儿结果（id 没在前面出现过）→ 转 user 文本，避免上游校验炸。
				if !useIDs[b.ToolUseID] && !prevHasTC {
					texts = append(texts, fmt.Sprintf("[tool result for %s]\n%s", b.ToolUseID, cc))
				} else {
					pendingResults = append(pendingResults, map[string]any{
						"role":         "tool",
						"tool_call_id": b.ToolUseID,
						"content":      cc,
					})
				}
			case "image":
				var src struct {
					MediaType string `json:"media_type"`
				}
				_ = json.Unmarshal(b.Source, &src)
				texts = append(texts, "[image: "+src.MediaType+"]")
			}
		}

		if len(pendingResults) > 0 {
			// tool 结果必须紧跟 tool_calls：先补齐缺失的配对（发空结果占位），
			// 再放本条的结果，最后才轮到 user 文本。
			emitted := map[string]bool{}
			for _, pr := range pendingResults {
				emitted[pr["tool_call_id"].(string)] = true
			}
			for _, tc := range toolCalls {
				fn := tc["function"].(map[string]any)
				if !emitted[tc["id"].(string)] {
					pendingResults = append(pendingResults, map[string]any{
						"role":         "tool",
						"tool_call_id": tc["id"],
						"content":      "(no result)",
					})
				}
				_ = fn
			}
			if prevHasTC {
				// 前一条 assistant 带 tool_calls → 结果直接续在它后面，合法。
				msgs = append(msgs, pendingResults...)
			} else if len(toolCalls) > 0 {
				// tool_calls 和结果在同一条 Anthropic 消息里（罕见）→
				// 先发 assistant(tool_calls)，紧跟结果。
				msgs = append(msgs, map[string]any{
					"role":       "assistant",
					"content":    nil,
					"tool_calls": toolCalls,
				})
				toolCalls = nil
				msgs = append(msgs, pendingResults...)
			} else {
				msgs = append(msgs, pendingResults...)
			}
		}

		if len(toolCalls) > 0 {
			content := strings.Join(texts, "\n")
			msgs = append(msgs, map[string]any{
				"role":       "assistant",
				"content":    nilIfEmpty(content),
				"tool_calls": toolCalls,
			})
		} else if len(texts) > 0 {
			msgs = append(msgs, map[string]any{"role": role, "content": strings.Join(texts, "\n")})
		}
	}

	effort := "low"
	if req.ToolChoice != nil && req.ToolChoice.Type == "tool" {
		_ = req.ToolChoice.Name
	}
	body := map[string]any{
		"model":            mapAnthropicModel(req.Model),
		"messages":         msgs,
		"max_tokens":       orDefault(req.MaxTokens, 8192),
		"reasoning_effort": effort,
	}
	if req.Stream {
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		body["top_p"] = *req.TopP
	}
	if len(req.StopSequences) > 0 {
		body["stop"] = req.StopSequences
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			schema := t.InputSchema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			tools = append(tools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        t.Name,
					"description": t.Description,
					"parameters":  json.RawMessage(schema),
				},
			})
		}
		body["tools"] = tools
		if req.ToolChoice != nil {
			switch req.ToolChoice.Type {
			case "auto":
				body["tool_choice"] = "auto"
			case "any":
				body["tool_choice"] = "required"
			case "none":
				body["tool_choice"] = "none"
			case "tool":
				body["tool_choice"] = map[string]any{
					"type":     "function",
					"function": map[string]any{"name": req.ToolChoice.Name},
				}
			}
		}
	}
	return body, nil
}

// BlockID 取 tool_use 的 id（RawMessage 解 string）。
func (b antContentBlock) BlockID() string {
	var s string
	if json.Unmarshal(b.ID, &s) == nil {
		return s
	}
	return ""
}

// toolResultText 把 tool_result.content（string 或块数组）拍平成纯文本。
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []map[string]any
	if json.Unmarshal(raw, &blocks) == nil {
		parts := []string{}
		for _, b := range blocks {
			if t, _ := b["type"].(string); t == "text" {
				parts = append(parts, strOr(b["text"]))
			}
		}
		return strings.Join(parts, "\n")
	}
	return string(raw)
}

// mapAnthropicModel claude-* 模型名映射：不带 realm 前缀的名字交给网关默认映射
// （原桥语义：cn:/hf:/global: 前缀原样透传，其余交给 WB2A_DEFAULT_MODEL）。
// 这里保持请求名原样——网关 chatCompletions 已有 resolveModel 的 realm 解析，
// claude-* 裸名由网关配置的默认模型兜底（与原桥 DEFAULT_MODEL 行为对齐由
// 调用方在 handler 层完成）。
func mapAnthropicModel(m string) string { return m }

// randHex n 位随机 hex（uuid 派生，仅用于补齐缺失 id）。
func randHex(n int) string {
	return randomHex(n)
}
