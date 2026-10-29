package agent

import (
	"encoding/json"
	"fmt"
	"time"
)

// ---------- OpenAI Chat (aggregate) -> Anthropic Messages ----------

// ChatToAnt 非流式：把网关聚合出的 Chat 响应翻译成 Anthropic Messages 响应。
// resp 是 upstream.Aggregate 产出的 map（choices[0].message 等）。
func ChatToAnt(resp map[string]any, modelIn string) map[string]any {
	choices, _ := resp["choices"].([]any)
	var msg map[string]any
	if len(choices) > 0 {
		msg, _ = choices[0].(map[string]any)["message"].(map[string]any)
	}
	if msg == nil {
		msg = map[string]any{}
	}

	blocks := []map[string]any{}
	if rc := strOr(msg["reasoning_content"]); rc != "" {
		blocks = append(blocks, map[string]any{
			"type": "thinking", "thinking": rc, "signature": "",
		})
	}
	if txt := strOr(msg["content"]); txt != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": txt})
	}
	for _, tcall := range anySlice(msg["tool_calls"]) {
		tc, _ := tcall.(map[string]any)
		if tc == nil {
			continue
		}
		fn, _ := tc["function"].(map[string]any)
		if fn == nil {
			fn = map[string]any{}
		}
		args := strOr(fn["arguments"])
		var input any
		if json.Unmarshal([]byte(orEmpty(args)), &input) != nil || args == "" {
			input = map[string]any{"_raw": args}
		}
		id := strOr(tc["id"])
		if id == "" {
			id = "toolu_" + randHex(16)
		}
		blocks = append(blocks, map[string]any{
			"type": "tool_use", "id": id,
			"name": strOr(fn["name"]), "input": input,
		})
	}

	// finish_reason → stop_reason
	ch := map[string]any{}
	if len(choices) > 0 {
		if c, ok := choices[0].(map[string]any); ok {
			ch = c
		}
	}
	stop := "end_turn"
	switch strOr(ch["finish_reason"]) {
	case "tool_calls":
		stop = "tool_use"
	case "length":
		stop = "max_tokens"
	}

	u, _ := resp["usage"].(map[string]any)
	if u == nil {
		u = map[string]any{}
	}
	id := strOr(resp["id"])
	if id == "" {
		id = "msg_" + randHex(24)
	}
	return map[string]any{
		"id":            id,
		"type":          "message",
		"role":          "assistant",
		"model":         modelIn,
		"content":       blocks,
		"stop_reason":   stop,
		"stop_sequence": nil,
		"usage": map[string]any{
			"input_tokens":  numOr(u["prompt_tokens"], 0),
			"output_tokens": numOr(u["completion_tokens"], 0),
		},
	}
}

// ---------- OpenAI Chat SSE -> Anthropic SSE ----------

// AntStreamWriter 把网关透传的 Chat SSE 流实时翻译成 Anthropic 事件流。
// 逐帧读入（上游 StreamHint 同款分行逻辑），delta 三类（reasoning_content /
// content / tool_calls）分别驱动 thinking/text/tool_use 块的开合与增量。
type AntStreamWriter struct {
	antMsgID string
	model    string
	seq      struct {
		nextIdx  int
		open     int // 当前打开的块 index，-1 = 无
		openKind string
	}
	usageOut int
	finish   string
	toolIdx  map[int]int // chat tool_calls index → anthropic block index
	nextIdx  int
	open     int    // 当前打开的块 index，-1 = 无
	openKind string // thinking | text | tool | ""
	emitter  func(event string, data any) error
}

// NewAntStreamWriter 构造；emitter 收到每个 Anthropic 事件并负责写出+flush。
func NewAntStreamWriter(model string, emitter func(event string, data any) error) *AntStreamWriter {
	return &AntStreamWriter{
		antMsgID: "msg_" + randHex(24),
		model:    model,
		open:     -1,
		toolIdx:  map[int]int{},
		emitter:  emitter,
	}
}

// Emit 写出一个事件。
func (w *AntStreamWriter) Emit(event string, data any) error {
	return w.emitter(event, data)
}

// Start 发出 message_start。
func (w *AntStreamWriter) Start() error {
	return w.Emit("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": w.antMsgID, "type": "message", "role": "assistant",
			"model": w.model, "content": []any{}, "stop_reason": nil,
			"stop_sequence": nil,
			"usage":         map[string]any{"input_tokens": 0, "output_tokens": 0},
		},
	})
}

// closeOpen 关闭当前打开的块。
func (w *AntStreamWriter) closeOpen() error {
	if w.open < 0 {
		return nil
	}
	if err := w.Emit("content_block_stop", map[string]any{
		"type": "content_block_stop", "index": w.open,
	}); err != nil {
		return err
	}
	w.open = -1
	w.openKind = ""
	return nil
}

// openBlock 打开新块。
func (w *AntStreamWriter) openBlock(btype string, extra map[string]any) (int, error) {
	idx := w.nextIdx
	w.nextIdx++
	block := map[string]any{"type": btype}
	for k, v := range extra {
		block[k] = v
	}
	if err := w.Emit("content_block_start", map[string]any{
		"type": "content_block_start", "index": idx, "content_block": block,
	}); err != nil {
		return 0, err
	}
	w.open = idx
	return idx, nil
}

// FeedChunk 处理一帧 Chat SSE delta（ev 为解析后的 chat.completion.chunk）。
// 返回写流过程中的错误。
func (w *AntStreamWriter) FeedChunk(ev map[string]any) error {
	if u, ok := ev["usage"].(map[string]any); ok && u != nil {
		if v, ok := u["completion_tokens"].(float64); ok {
			w.usageOut = int(v)
		}
	}
	choices := anySlice(ev["choices"])
	var ch map[string]any
	if len(choices) > 0 {
		ch, _ = choices[0].(map[string]any)
	}
	if ch == nil {
		return nil
	}
	if fr := strOr(ch["finish_reason"]); fr != "" {
		w.finish = fr
	}
	d, _ := ch["delta"].(map[string]any)
	if d == nil {
		return nil
	}

	// reasoning_content → thinking 块
	if rc := strOr(d["reasoning_content"]); rc != "" {
		if w.openKind != "thinking" {
			if err := w.closeOpen(); err != nil {
				return err
			}
			if _, err := w.openBlock("thinking", nil); err != nil {
				return err
			}
			w.openKind = "thinking"
		}
		if err := w.Emit("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": w.open,
			"delta": map[string]any{"type": "thinking_delta", "thinking": rc},
		}); err != nil {
			return err
		}
	}

	// content → text 块
	if txt := strOr(d["content"]); txt != "" {
		if w.openKind != "text" {
			if err := w.closeOpen(); err != nil {
				return err
			}
			if _, err := w.openBlock("text", map[string]any{"text": ""}); err != nil {
				return err
			}
			w.openKind = "text"
		}
		if err := w.Emit("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": w.open,
			"delta": map[string]any{"type": "text_delta", "text": txt},
		}); err != nil {
			return err
		}
	}

	// tool_calls → tool_use 块（按 chat index 归位）
	for _, t := range anySlice(d["tool_calls"]) {
		tc, _ := t.(map[string]any)
		if tc == nil {
			continue
		}
		ci := int(numOr(tc["index"], 0))
		fn, _ := tc["function"].(map[string]any)
		if fn == nil {
			fn = map[string]any{}
		}
		idx, known := w.toolIdx[ci]
		if !known {
			if err := w.closeOpen(); err != nil {
				return err
			}
			w.openKind = "tool"
			id := strOr(tc["id"])
			if id == "" {
				id = "toolu_" + randHex(16)
			}
			var err error
			idx, err = w.openBlock("tool_use", map[string]any{
				"id": id, "name": strOr(fn["name"]), "input": map[string]any{},
			})
			if err != nil {
				return err
			}
			w.toolIdx[ci] = idx
		}
		if frag := strOr(fn["arguments"]); frag != "" {
			if err := w.Emit("content_block_delta", map[string]any{
				"type": "content_block_delta", "index": idx,
				"delta": map[string]any{"type": "input_json_delta", "partial_json": frag},
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

// Finish 收尾：关块 + message_delta + message_stop。返回 stop_reason。
func (w *AntStreamWriter) Finish() error {
	if err := w.closeOpen(); err != nil {
		return err
	}
	stop := "end_turn"
	switch w.finish {
	case "tool_calls":
		stop = "tool_use"
	case "length":
		stop = "max_tokens"
	}
	if err := w.Emit("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": stop, "stop_sequence": nil},
		"usage": map[string]any{"output_tokens": w.usageOut},
	}); err != nil {
		return err
	}
	return w.Emit("message_stop", map[string]any{"type": "message_stop"})
}

// anySlice any → []any（nil 安全）。
func anySlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// numOr any 数值 → int（nil 安全）。
func numOr(v any, d int) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return d
}

func orEmpty(s string) string { return s }

// nowUnix 当前秒级时间戳（Responses 侧用，放这避免循环依赖）。
func nowUnix() int64 { return time.Now().Unix() }

var _ = fmt.Sprintf // 保持 fmt 引用（翻译过程中的错误包装用途）
