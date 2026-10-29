package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ---------- OpenAI Responses -> OpenAI Chat ----------
// 语义对照：codex_bridge.py resp_to_chat / oai_to_resp / _stream

// respRequest Responses 请求体（宽松解析，input 是 string | object | 数组）。
type respRequest struct {
	Model             string          `json:"model"`
	Input             json.RawMessage `json:"input,omitempty"`
	Instructions      json.RawMessage `json:"instructions,omitempty"`
	Stream            bool            `json:"stream,omitempty"`
	MaxOutputTokens   int             `json:"max_output_tokens,omitempty"`
	Temperature       *float64        `json:"temperature,omitempty"`
	TopP              *float64        `json:"top_p,omitempty"`
	Tools             []respTool      `json:"tools,omitempty"`
	ToolChoice        json.RawMessage `json:"tool_choice,omitempty"`
	ParallelToolCalls *bool           `json:"parallel_tool_calls,omitempty"`
	Reasoning         struct {
		Effort string `json:"effort,omitempty"`
	} `json:"reasoning,omitempty"`
}

type respTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name,omitempty"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// RespToChat 把 Responses 请求翻译成 Chat Completions 请求体。
// custom 收集 free-text 工具名（custom/local_shell 在 Responses 与 Chat 间的形状转换依赖它）。
func RespToChat(raw []byte) (map[string]any, map[string]bool, error) {
	var req respRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, nil, fmt.Errorf("bad responses request: %w", err)
	}
	custom := map[string]bool{}
	msgs := []map[string]any{}

	// instructions → system 消息（字符串或片段数组）。
	if len(req.Instructions) > 0 {
		if t := joinRespContent(req.Instructions); t != "" {
			msgs = append(msgs, map[string]any{"role": "system", "content": t})
		}
	}

	pending := []map[string]any{}
	flush := func() {
		if len(pending) > 0 {
			msgs = append(msgs, map[string]any{
				"role": "assistant", "content": nil, "tool_calls": pending,
			})
			pending = nil
		}
	}
	addCall := func(name, args, callID string) {
		if callID == "" {
			callID = "call_" + randHex(16)
		}
		if args == "" {
			args = "{}"
		}
		pending = append(pending, map[string]any{
			"id": callID, "type": "function",
			"function": map[string]any{"name": name, "arguments": args},
		})
	}

	// input：字符串 → 单条 user；对象 → 单元素数组；数组 → 逐项。
	var items []json.RawMessage
	var strInput string
	if json.Unmarshal(req.Input, &strInput) == nil && req.Input != nil {
		msgs = append(msgs, map[string]any{"role": "user", "content": strInput})
	} else {
		var one json.RawMessage
		if len(req.Input) > 0 && json.Unmarshal(req.Input, &one) == nil {
			// 判断是对象还是数组
			var arr []json.RawMessage
			if json.Unmarshal(req.Input, &arr) == nil {
				items = arr
			} else {
				items = []json.RawMessage{req.Input}
			}
		}
	}

	for _, it := range items {
		var obj map[string]any
		if json.Unmarshal(it, &obj) != nil || obj == nil {
			continue
		}
		t, _ := obj["type"].(string)
		switch t {
		case "reasoning":
			continue
		case "function_call":
			addCall(strOr(obj["name"]), strOr(obj["arguments"]), strOr(obj["call_id"]))
			continue
		case "custom_tool_call":
			args, _ := json.Marshal(map[string]any{"input": strOr(obj["input"])})
			addCall(strOr(obj["name"]), string(args), strOr(obj["call_id"]))
			continue
		case "local_shell_call":
			action, _ := obj["action"].(map[string]any)
			args, _ := json.Marshal(map[string]any{"command": strOr(action["command"])})
			addCall("shell", string(args), strOr(obj["call_id"]))
			continue
		case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
			flush()
			msgs = append(msgs, map[string]any{
				"role": "tool", "tool_call_id": strOr(obj["call_id"]),
				"content": normRespOutput(obj["output"]),
			})
			continue
		}

		role := strOr(obj["role"])
		if role == "" {
			role = "user"
		}
		if role == "developer" {
			role = "system"
		}
		content := obj["content"]
		if cs, ok := content.(string); ok {
			flush()
			msgs = append(msgs, map[string]any{"role": role, "content": cs})
			continue
		}
		texts := []string{}
		parts := []map[string]any{}
		for _, p := range anySlice(content) {
			pm, _ := p.(map[string]any)
			if pm == nil {
				continue
			}
			pt, _ := pm["type"].(string)
			switch pt {
			case "input_text", "output_text", "text":
				texts = append(texts, strOr(pm["text"]))
			case "refusal":
				texts = append(texts, strOr(pm["refusal"]))
			case "input_image":
				url := strOr(pm["image_url"])
				if url == "" {
					url = strOr(pm["url"])
				}
				if url != "" {
					parts = append(parts, map[string]any{
						"type": "image_url", "image_url": map[string]any{"url": url},
					})
				}
			}
		}
		flush()
		txt := strings.Join(nonEmpty(texts), "\n")
		if len(parts) > 0 {
			arr := []map[string]any{}
			if txt != "" {
				arr = append(arr, map[string]any{"type": "text", "text": txt})
			}
			arr = append(arr, parts...)
			msgs = append(msgs, map[string]any{"role": role, "content": arr})
		} else if txt != "" {
			msgs = append(msgs, map[string]any{"role": role, "content": txt})
		}
	}
	flush()

	body := map[string]any{
		"model":    orStr(req.Model, "cn:auto"),
		"messages": msgs,
		"stream":   req.Stream,
	}
	if req.Stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.MaxOutputTokens > 0 {
		body["max_tokens"] = req.MaxOutputTokens
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		body["top_p"] = *req.TopP
	}
	if tools := respToolsToChat(req.Tools, custom); len(tools) > 0 {
		body["tools"] = tools
		if tc := respToolChoiceToChat(req.ToolChoice); tc != nil {
			body["tool_choice"] = tc
		}
		if req.ParallelToolCalls != nil {
			body["parallel_tool_calls"] = *req.ParallelToolCalls
		}
	}
	if req.Reasoning.Effort != "" && req.Reasoning.Effort != "none" {
		body["reasoning_effort"] = req.Reasoning.Effort
	}
	return body, custom, nil
}

// respToolsToChat Responses tools → Chat tools。custom/local_shell 折成 function 形状。
func respToolsToChat(tools []respTool, custom map[string]bool) []map[string]any {
	out := []map[string]any{}
	for _, t := range tools {
		switch t.Type {
		case "function":
			params := t.Parameters
			if len(params) == 0 {
				params = json.RawMessage(`{"type":"object","properties":{}}`)
			}
			out = append(out, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name": t.Name, "description": t.Description,
					"parameters": json.RawMessage(params),
				},
			})
		case "custom":
			custom[t.Name] = true
			out = append(out, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name": t.Name,
					"description": strings.TrimSpace(t.Description +
						"\n调用时把要发送的原始文本完整放进 input 字段。"),
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"input": map[string]any{"type": "string", "description": "原始文本载荷"},
						},
						"required": []string{"input"},
					},
				},
			})
		case "local_shell":
			custom["shell"] = true
			out = append(out, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        "shell",
					"description": "Run a shell command. 参数 command 为 argv 数组（Windows 下为 PowerShell 命令文本）。",
					"parameters": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"command": map[string]any{
								"oneOf": []map[string]any{
									{"type": "string"},
									{"type": "array", "items": map[string]any{"type": "string"}},
								},
								"description": "要执行的命令",
							},
							"timeout_ms": map[string]any{"type": "number"},
						},
						"required": []string{"command"},
					},
				},
			})
		}
	}
	return out
}

// respToolChoiceToChat tool_choice → Chat 形态。
func respToolChoiceToChat(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		tt, _ := obj["type"].(string)
		switch tt {
		case "function", "custom":
			return map[string]any{
				"type": "function", "function": map[string]any{"name": strOr(obj["name"])},
			}
		case "allowed_tools":
			return "auto"
		}
	}
	return nil
}

// joinRespContent Responses content 片段（string | 数组）拼纯文本。
func joinRespContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []map[string]any
	if json.Unmarshal(raw, &parts) == nil {
		out := []string{}
		for _, p := range parts {
			t, _ := p["type"].(string)
			switch t {
			case "input_text", "output_text", "text", "summary_text":
				out = append(out, strOr(p["text"]))
			case "refusal":
				out = append(out, strOr(p["refusal"]))
			}
		}
		return strings.Join(nonEmpty(out), "\n")
	}
	return ""
}

// normRespOutput function_call_output.output → 纯文本。
func normRespOutput(o any) string {
	switch v := o.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		b, _ := json.Marshal(v)
		if t := joinRespContent(json.RawMessage(b)); t != "" {
			return t
		}
		return string(b)
	case map[string]any:
		if c, ok := v["content"].([]any); ok {
			b, _ := json.Marshal(c)
			if t := joinRespContent(json.RawMessage(b)); t != "" {
				return t
			}
		}
		b, _ := json.Marshal(v)
		return string(b)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// nonEmpty 过滤空串。
func nonEmpty(in []string) []string {
	out := in[:0]
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// orStr 空串兜底。
func orStr(v, d string) string {
	if v != "" {
		return v
	}
	return d
}
