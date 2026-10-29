package agent

import (
	"encoding/json"
	"testing"
)

// 孤儿 tool_result（id 未在前文出现、前条也无 tool_calls）→ 转 user 文本。
// 语义对照 anthropic_bridge.ant_to_oai 的同名词分支。
func TestAntToChatOrphanToolResult(t *testing.T) {
	req := `{
		"model": "cn:auto",
		"max_tokens": 100,
		"messages": [
			{"role": "user", "content": [
				{"type": "tool_result", "tool_use_id": "toolu_orphan", "content": "hello result"}
			]}
		]
	}`
	body, err := AntToChat([]byte(req))
	if err != nil {
		t.Fatal(err)
	}
	msgs := body["messages"].([]map[string]any)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d", len(msgs))
	}
	content, _ := msgs[0]["content"].(string)
	if content[:17] != "[tool result for " {
		t.Fatalf("orphan tool_result not converted to text: %q", content)
	}
}

// 正常配对：assistant tool_use → user tool_result 紧跟。
func TestAntToChatPairedToolResult(t *testing.T) {
	req := `{
		"model": "cn:auto",
		"max_tokens": 100,
		"messages": [
			{"role": "assistant", "content": [
				{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
			]},
			{"role": "user", "content": [
				{"type": "tool_result", "tool_use_id": "toolu_1", "content": "file.txt"}
			]}
		]
	}`
	body, err := AntToChat([]byte(req))
	if err != nil {
		t.Fatal(err)
	}
	msgs := body["messages"].([]map[string]any)
	// 期望：assistant(tool_calls) + tool 结果
	if len(msgs) != 2 {
		b, _ := json.Marshal(msgs)
		t.Fatalf("want 2 messages, got %d: %s", len(msgs), b)
	}
	if msgs[0]["tool_calls"] == nil {
		t.Fatal("first message should carry tool_calls")
	}
	if msgs[1]["role"] != "tool" {
		t.Fatalf("second message should be tool result, got %v", msgs[1]["role"])
	}
}

// system 字符串 → system 消息；reasoning_effort 默认 low。
func TestAntToChatSystemAndEffort(t *testing.T) {
	req := `{"model":"claude-x","system":"be nice","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}`
	body, err := AntToChat([]byte(req))
	if err != nil {
		t.Fatal(err)
	}
	msgs := body["messages"].([]map[string]any)
	if msgs[0]["role"] != "system" || msgs[0]["content"] != "be nice" {
		t.Fatalf("system message wrong: %v", msgs[0])
	}
	if body["reasoning_effort"] != "low" {
		t.Fatalf("reasoning_effort should default low, got %v", body["reasoning_effort"])
	}
}

// Responses：字符串 input + custom 工具折成 function。
func TestRespToChatStringInputCustomTool(t *testing.T) {
	req := `{
		"model": "cn:test",
		"instructions": "be brief",
		"input": "hello",
		"tools": [{"type": "custom", "name": "notes"}],
		"reasoning": {"effort": "high"}
	}`
	body, custom, err := RespToChat([]byte(req))
	if err != nil {
		t.Fatal(err)
	}
	if !custom["notes"] {
		t.Fatal("custom tool name not collected")
	}
	msgs := body["messages"].([]map[string]any)
	if msgs[0]["role"] != "system" || msgs[0]["content"] != "be brief" {
		t.Fatalf("instructions not mapped to system: %v", msgs[0])
	}
	if msgs[1]["role"] != "user" || msgs[1]["content"] != "hello" {
		t.Fatalf("string input not mapped to user: %v", msgs[1])
	}
	if body["reasoning_effort"] != "high" {
		t.Fatalf("effort not propagated: %v", body["reasoning_effort"])
	}
}

// function_call / function_call_output 往返 → assistant(tool_calls) + tool。
func TestRespToChatToolRoundtrip(t *testing.T) {
	req := `{
		"model": "cn:test",
		"input": [
			{"type": "function_call", "name": "shell", "arguments": "{\"command\":[\"ls\"]}", "call_id": "c1"},
			{"type": "function_call_output", "call_id": "c1", "output": "out.txt"}
		]
	}`
	body, _, err := RespToChat([]byte(req))
	if err != nil {
		t.Fatal(err)
	}
	msgs := body["messages"].([]map[string]any)
	if len(msgs) != 2 {
		b, _ := json.Marshal(msgs)
		t.Fatalf("want 2 messages, got %d: %s", len(msgs), b)
	}
	if msgs[0]["tool_calls"] == nil || msgs[1]["role"] != "tool" {
		b, _ := json.Marshal(msgs)
		t.Fatalf("roundtrip shape wrong: %s", b)
	}
}

// ChatToAnt 非流式翻译：thinking + content + tool_calls 的块序。
func TestChatToAntBlocks(t *testing.T) {
	resp := map[string]any{
		"id": "chatcmpl-1",
		"choices": []any{map[string]any{
			"finish_reason": "tool_calls",
			"message": map[string]any{
				"reasoning_content": "thinking hard",
				"content":           "let me run",
				"tool_calls": []any{map[string]any{
					"id": "call_1", "type": "function",
					"function": map[string]any{"name": "Bash", "arguments": "{\"command\":\"ls\"}"},
				}},
			},
		}},
		"usage": map[string]any{"prompt_tokens": 11.0, "completion_tokens": 7.0},
	}
	ant := ChatToAnt(resp, "cn:test")
	b, _ := json.Marshal(ant)
	var out struct {
		Content []struct {
			Type    string          `json:"type"`
			Text    string          `json:"text,omitempty"`
			ID      string          `json:"id,omitempty"`
			Name    string          `json:"name,omitempty"`
			Input   json.RawMessage `json:"input,omitempty"`
			Thinking string         `json:"thinking,omitempty"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Content) != 3 ||
		out.Content[0].Type != "thinking" ||
		out.Content[1].Type != "text" ||
		out.Content[2].Type != "tool_use" ||
		out.Content[2].Name != "Bash" {
		t.Fatalf("block sequence wrong: %s", b)
	}
	if out.StopReason != "tool_use" {
		t.Fatalf("stop_reason should be tool_use, got %s", out.StopReason)
	}
	if out.Usage.Input != 11 || out.Usage.Output != 7 {
		t.Fatalf("usage wrong: %+v", out.Usage)
	}
}

// 流式 Anthropic：text 增量 → 单一 text 块的 start/delta/stop + message 收尾。
func TestAntStreamTextOnly(t *testing.T) {
	var events []string
	sw := NewAntStreamWriter("cn:test", func(event string, data any) error {
		events = append(events, event)
		return nil
	})
	if err := sw.Start(); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"choices":[{"delta":{"role":"assistant","content":"he"}}]}`,
		`{"choices":[{"delta":{"content":"llo"}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
	} {
		var ev map[string]any
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			t.Fatal(err)
		}
		if err := sw.FeedChunk(ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := sw.Finish(); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"message_start",
		"content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
		"message_delta", "message_stop",
	}
	if len(events) != len(want) {
		t.Fatalf("event sequence wrong: %v", events)
	}
	for i := range want {
		if events[i] != want[i] {
			t.Fatalf("event[%d] = %s, want %s", i, events[i], want[i])
		}
	}
}
