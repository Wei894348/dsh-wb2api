package agent

import (
	"encoding/json"
	"time"
)

// ---------- OpenAI Chat -> OpenAI Responses（响应与流式） ----------

// respUsage Chat usage → Responses usage 形状。
func respUsage(u map[string]any) map[string]any {
	if u == nil {
		u = map[string]any{}
	}
	ptd, _ := u["prompt_tokens_details"].(map[string]any)
	ctd, _ := u["completion_tokens_details"].(map[string]any)
	cached, reasoning := 0, 0
	if ptd != nil {
		cached = numOr(ptd["cached_tokens"], 0)
	}
	if ctd != nil {
		reasoning = numOr(ctd["reasoning_tokens"], 0)
	}
	return map[string]any{
		"input_tokens":            numOr(u["prompt_tokens"], 0),
		"input_tokens_details":    map[string]any{"cached_tokens": cached},
		"output_tokens":           numOr(u["completion_tokens"], 0),
		"output_tokens_details":   map[string]any{"reasoning_tokens": reasoning},
		"total_tokens":            numOr(u["total_tokens"], 0),
	}
}

// ChatToResp 非流式：Chat 聚合响应 → Responses 对象。
func ChatToResp(resp map[string]any, modelIn string, custom map[string]bool) map[string]any {
	choices := anySlice(resp["choices"])
	var msg map[string]any
	if len(choices) > 0 {
		if c, ok := choices[0].(map[string]any); ok {
			msg, _ = c["message"].(map[string]any)
		}
	}
	if msg == nil {
		msg = map[string]any{}
	}
	out := []map[string]any{}
	if rc := strOr(msg["reasoning_content"]); rc != "" {
		out = append(out, map[string]any{
			"id": "rs_" + randHex(20), "type": "reasoning",
			"summary": []map[string]any{{"type": "summary_text", "text": rc}},
		})
	}
	if txt := strOr(msg["content"]); txt != "" {
		out = append(out, map[string]any{
			"id": "msg_" + randHex(20), "type": "message", "status": "completed",
			"role": "assistant",
			"content": []map[string]any{{
				"type": "output_text", "text": txt, "annotations": []any{},
			}},
		})
	}
	for _, t := range anySlice(msg["tool_calls"]) {
		tc, _ := t.(map[string]any)
		if tc == nil {
			continue
		}
		fn, _ := tc["function"].(map[string]any)
		if fn == nil {
			fn = map[string]any{}
		}
		name := strOr(fn["name"])
		args := strOr(fn["arguments"])
		callID := strOr(tc["id"])
		if callID == "" {
			callID = "call_" + randHex(16)
		}
		if custom[name] {
			raw := args
			var parsed map[string]any
			if json.Unmarshal([]byte(args), &parsed) == nil {
				if in, ok := parsed["input"]; ok {
					if s, ok := in.(string); ok {
						raw = s
					}
				}
			}
			out = append(out, map[string]any{
				"id": "ctc_" + randHex(20), "type": "custom_tool_call",
				"status": "completed", "call_id": callID, "name": name, "input": raw,
			})
		} else {
			out = append(out, map[string]any{
				"id": "fc_" + randHex(20), "type": "function_call",
				"status": "completed", "call_id": callID, "name": name, "arguments": args,
			})
		}
	}
	return map[string]any{
		"id": "resp_" + randHex(24), "object": "response",
		"created_at": nowUnix(), "status": "completed", "model": modelIn,
		"output": out, "parallel_tool_calls": true, "tool_choice": "auto",
		"tools": []any{}, "usage": respUsage(toMap(resp["usage"])),
	}
}

// RespStreamWriter Chat SSE → Responses 事件流实时翻译器。
// 语义对照 codex_bridge.py _stream：output item 的 added/delta/done 全序列。
type RespStreamWriter struct {
	respID    string
	model     string
	seq       int
	out       []map[string]any // 已产出的 output items（最终 response.completed 回带）
	reason    *respReasonState
	text      *respTextState
	tools     map[int]*respToolState
	usage     map[string]any
	finish    string
	createdAt int64
	emitter   func(event string, data map[string]any) error
}

type respReasonState struct {
	item map[string]any
	idx  int
	buf  string
}
type respTextState struct {
	item map[string]any
	idx  int
	buf  string
}
type respToolState struct {
	item   map[string]any
	idx    int
	args   string
	custom bool
	callID string
	name   string
}

// NewRespStreamWriter 构造。
func NewRespStreamWriter(model string, emitter func(event string, data map[string]any) error) *RespStreamWriter {
	return &RespStreamWriter{
		respID:    "resp_" + randHex(24),
		model:     model,
		tools:     map[int]*respToolState{},
		createdAt: time.Now().Unix(),
		emitter:   emitter,
	}
}

func (w *RespStreamWriter) emit(etype string, obj map[string]any) error {
	w.seq++
	obj["type"] = etype
	obj["sequence_number"] = w.seq
	return w.emitter(etype, obj)
}

func (w *RespStreamWriter) base(status string, output any) map[string]any {
	if output == nil {
		output = []any{}
	}
	return map[string]any{
		"id": w.respID, "object": "response", "created_at": w.createdAt,
		"status": status, "model": w.model, "output": output,
		"parallel_tool_calls": true, "tool_choice": "auto", "tools": []any{},
		"usage": nil,
	}
}

// Start 发 response.created + response.in_progress。
func (w *RespStreamWriter) Start() error {
	if err := w.emit("response.created", map[string]any{"response": w.base("in_progress", nil)}); err != nil {
		return err
	}
	return w.emit("response.in_progress", map[string]any{"response": w.base("in_progress", nil)})
}

func (w *RespStreamWriter) openReasoning() (*respReasonState, error) {
	if w.reason != nil {
		return w.reason, nil
	}
	idx := len(w.out)
	item := map[string]any{"id": "rs_" + randHex(20), "type": "reasoning", "summary": []any{}}
	w.out = append(w.out, item)
	w.reason = &respReasonState{item: item, idx: idx}
	if err := w.emit("response.output_item.added", map[string]any{
		"output_index": idx, "item": item,
	}); err != nil {
		return nil, err
	}
	if err := w.emit("response.reasoning_summary_part.added", map[string]any{
		"item_id": item["id"], "output_index": idx, "summary_index": 0,
		"part": map[string]any{"type": "summary_text", "text": ""},
	}); err != nil {
		return nil, err
	}
	return w.reason, nil
}

func (w *RespStreamWriter) openText() (*respTextState, error) {
	if w.text != nil {
		return w.text, nil
	}
	idx := len(w.out)
	item := map[string]any{
		"id": "msg_" + randHex(20), "type": "message", "status": "in_progress",
		"role": "assistant", "content": []any{},
	}
	w.out = append(w.out, item)
	w.text = &respTextState{item: item, idx: idx}
	if err := w.emit("response.output_item.added", map[string]any{
		"output_index": idx, "item": item,
	}); err != nil {
		return nil, err
	}
	if err := w.emit("response.content_part.added", map[string]any{
		"item_id": item["id"], "output_index": idx, "content_index": 0,
		"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
	}); err != nil {
		return nil, err
	}
	return w.text, nil
}

func (w *RespStreamWriter) closeReasoning() error {
	if w.reason == nil {
		return nil
	}
	r := w.reason
	r.item["summary"] = []map[string]any{{"type": "summary_text", "text": r.buf}}
	if err := w.emit("response.reasoning_summary_text.done", map[string]any{
		"item_id": r.item["id"], "output_index": r.idx, "summary_index": 0, "text": r.buf,
	}); err != nil {
		return err
	}
	if err := w.emit("response.reasoning_summary_part.done", map[string]any{
		"item_id": r.item["id"], "output_index": r.idx, "summary_index": 0,
		"part": map[string]any{"type": "summary_text", "text": r.buf},
	}); err != nil {
		return err
	}
	if err := w.emit("response.output_item.done", map[string]any{
		"output_index": r.idx, "item": r.item,
	}); err != nil {
		return err
	}
	w.reason = nil
	return nil
}

func (w *RespStreamWriter) closeText() error {
	if w.text == nil {
		return nil
	}
	t := w.text
	part := map[string]any{"type": "output_text", "text": t.buf, "annotations": []any{}}
	t.item["status"] = "completed"
	t.item["content"] = []map[string]any{part}
	if err := w.emit("response.output_text.done", map[string]any{
		"item_id": t.item["id"], "output_index": t.idx, "content_index": 0, "text": t.buf,
	}); err != nil {
		return err
	}
	if err := w.emit("response.content_part.done", map[string]any{
		"item_id": t.item["id"], "output_index": t.idx, "content_index": 0, "part": part,
	}); err != nil {
		return err
	}
	if err := w.emit("response.output_item.done", map[string]any{
		"output_index": t.idx, "item": t.item,
	}); err != nil {
		return err
	}
	w.text = nil
	return nil
}

func (w *RespStreamWriter) closeTool(ent *respToolState) error {
	ent.item["status"] = "completed"
	if ent.custom {
		raw := ent.args
		var parsed map[string]any
		if json.Unmarshal([]byte(raw), &parsed) == nil {
			if in, ok := parsed["input"]; ok {
				if s, ok := in.(string); ok {
					raw = s
				}
			}
		}
		ent.item["input"] = raw
		if err := w.emit("response.custom_tool_call_input.done", map[string]any{
			"item_id": ent.item["id"], "output_index": ent.idx, "input": raw,
		}); err != nil {
			return err
		}
	} else {
		if ent.args == "" {
			ent.args = "{}"
		}
		ent.item["arguments"] = ent.args
		if err := w.emit("response.function_call_arguments.done", map[string]any{
			"item_id": ent.item["id"], "output_index": ent.idx, "arguments": ent.args,
		}); err != nil {
			return err
		}
	}
	return w.emit("response.output_item.done", map[string]any{
		"output_index": ent.idx, "item": ent.item,
	})
}

// FeedChunk 处理一帧 Chat SSE。
func (w *RespStreamWriter) FeedChunk(ev map[string]any) error {
	if u, ok := ev["usage"].(map[string]any); ok && u != nil {
		w.usage = u
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

	if rc := strOr(d["reasoning_content"]); rc != "" {
		r, err := w.openReasoning()
		if err != nil {
			return err
		}
		r.buf += rc
		if err := w.emit("response.reasoning_summary_text.delta", map[string]any{
			"item_id": r.item["id"], "output_index": r.idx,
			"summary_index": 0, "delta": rc,
		}); err != nil {
			return err
		}
	}

	if txt := strOr(d["content"]); txt != "" {
		if err := w.closeReasoning(); err != nil {
			return err
		}
		t, err := w.openText()
		if err != nil {
			return err
		}
		t.buf += txt
		if err := w.emit("response.output_text.delta", map[string]any{
			"item_id": t.item["id"], "output_index": t.idx, "content_index": 0, "delta": txt,
		}); err != nil {
			return err
		}
	}

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
		ent, ok := w.tools[ci]
		if !ok {
			if err := w.closeReasoning(); err != nil {
				return err
			}
			if err := w.closeText(); err != nil {
				return err
			}
			callID := strOr(tc["id"])
			if callID == "" {
				callID = "call_" + randHex(16)
			}
			name := strOr(fn["name"])
			idx := len(w.out)
			var item map[string]any
			isCustom := customName(w, name)
			if isCustom {
				item = map[string]any{
					"id": "ctc_" + randHex(20), "type": "custom_tool_call",
					"status": "in_progress", "call_id": callID, "name": name, "input": "",
				}
			} else {
				item = map[string]any{
					"id": "fc_" + randHex(20), "type": "function_call",
					"status": "in_progress", "call_id": callID, "name": name, "arguments": "",
				}
			}
			w.out = append(w.out, item)
			ent = &respToolState{item: item, idx: idx, custom: isCustom, callID: callID, name: name}
			w.tools[ci] = ent
			if err := w.emit("response.output_item.added", map[string]any{
				"output_index": ent.idx, "item": ent.item,
			}); err != nil {
				return err
			}
		}
		if id := strOr(tc["id"]); id != "" && ent.callID == "" {
			ent.callID = id
			ent.item["call_id"] = id
		}
		if name := strOr(fn["name"]); name != "" && ent.name == "" {
			ent.name = name
			ent.item["name"] = name
		}
		if frag := strOr(fn["arguments"]); frag != "" {
			ent.args += frag
			if !ent.custom {
				if err := w.emit("response.function_call_arguments.delta", map[string]any{
					"item_id": ent.item["id"], "output_index": ent.idx, "delta": frag,
				}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// customName 判断工具名是否属于 custom 集合（RespToChat 收集的）。
// 流式阶段需要按名字决定 item 形状；翻译器不直接持有 custom 集合，
// 由 handler 侧在构造时注入，这里用包级可注入变量承载（单请求生命周期内读写）。
var customToolNames = map[string]bool{}

func customName(_ *RespStreamWriter, name string) bool { return customToolNames[name] }

// SetCustomTools 注入本请求的 custom 工具名集合（handler 在开流前调用）。
func SetCustomTools(names map[string]bool) { customToolNames = names }

// Finish 收尾：关全部 item + response.completed。
func (w *RespStreamWriter) Finish() error {
	if err := w.closeReasoning(); err != nil {
		return err
	}
	if err := w.closeText(); err != nil {
		return err
	}
	// 按 chat index 序收尾未关的 tool
	for i := 0; i < len(w.tools); i++ {
		if ent, ok := w.tools[i]; ok {
			if err := w.closeTool(ent); err != nil {
				return err
			}
		}
	}
	done := w.base("completed", w.out)
	done["usage"] = respUsage(w.usage)
	return w.emit("response.completed", map[string]any{"response": done})
}

// toMap any → map（nil 安全）。
func toMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}
