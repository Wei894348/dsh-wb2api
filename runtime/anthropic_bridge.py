#!/usr/bin/env python3
"""Anthropic Messages API <-> wb2a(OpenAI 兼容) 桥。

Claude Code -> http://127.0.0.1:7864/v1/messages  ->  wb2a /v1/chat/completions
仅用标准库。环境变量：
  WB2A_UPSTREAM      上游地址，默认 http://127.0.0.1:7863
  WB2A_API_KEY       上游 api_key（Claude 未带 Authorization 时兜底）
  WB2A_DEFAULT_MODEL claude-* 模型名映射目标，默认 cn:auto
  WB2A_BRIDGE_LISTEN 监听地址，默认 127.0.0.1:7864
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("WB2A_UPSTREAM", "http://127.0.0.1:7863").rstrip("/")
API_KEY = os.environ.get("WB2A_API_KEY", "")
DEFAULT_MODEL = os.environ.get("WB2A_DEFAULT_MODEL", "cn:auto")
LISTEN = os.environ.get("WB2A_BRIDGE_LISTEN", "127.0.0.1:7864")
HOST, PORT = LISTEN.rsplit(":", 1)


def map_model(m):
    m = m or ""
    if m.startswith("cn:") or m.startswith("hf:"):
        return m
    return DEFAULT_MODEL


def _blocks_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for b in content:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text", ""))
    return "\n".join(parts)


def ant_to_oai(req):
    msgs = []
    sysv = req.get("system")
    texts = []
    if isinstance(sysv, str) and sysv:
        texts = [sysv]
    elif isinstance(sysv, list):
        texts = [b.get("text", "") for b in sysv
                 if isinstance(b, dict) and b.get("type") == "text"]
    if texts:
        msgs.append({"role": "system", "content": "\n\n".join(texts)})

    for m in req.get("messages", []):
        role = m.get("role")
        c = m.get("content")
        if isinstance(c, str):
            msgs.append({"role": role, "content": c})
            continue
        # 第一遍：收集该消息里的 tool_use id，作为配对依据
        use_ids = set()
        for b in c or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                use_ids.add(b.get("id") or "")
        # 前一条是否是带 tool_calls 的 assistant（决定 user 文本能否安全插入）
        prev_has_tc = msgs and msgs[-1].get("tool_calls")

        texts = []
        tool_calls = []
        pending_results = []
        for b in c or []:
            t = b.get("type") if isinstance(b, dict) else None
            if t == "text":
                texts.append(b.get("text", ""))
            elif t == "tool_use":
                tool_calls.append({
                    "id": b.get("id") or ("call_" + uuid.uuid4().hex[:16]),
                    "type": "function",
                    "function": {
                        "name": b.get("name", ""),
                        "arguments": json.dumps(b.get("input", {}), ensure_ascii=False),
                    },
                })
            elif t == "tool_result":
                cc = b.get("content")
                if isinstance(cc, list):
                    cc = "\n".join(x.get("text", "") for x in cc
                                   if isinstance(x, dict) and x.get("type") == "text")
                elif not isinstance(cc, str):
                    cc = json.dumps(cc, ensure_ascii=False) if cc is not None else ""
                # 孤儿结果（id 没在前面出现过）→ 转成 user 文本，避免上游校验炸
                if b.get("tool_use_id") not in use_ids and not prev_has_tc:
                    texts.append("[tool result for %s]\n%s" % (b.get("tool_use_id", "?"), cc))
                else:
                    pending_results.append({
                        "role": "tool",
                        "tool_call_id": b.get("tool_use_id", ""),
                        "content": cc,
                    })
            elif t == "image":
                src = b.get("source", {})
                texts.append("[image: %s]" % src.get("media_type", "unknown"))

        if pending_results:
            # tool 结果必须紧跟 tool_calls：先补齐缺失的配对（发空结果占位），
            # 再放本条的结果，最后才轮到 user 文本
            emitted = set()
            for pr in pending_results:
                emitted.add(pr["tool_call_id"])
            for tc in tool_calls:
                if tc["id"] not in emitted:
                    pending_results.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": "(no result)",
                    })
            if msgs and msgs[-1].get("tool_calls"):
                # 前一条 assistant 带 tool_calls → 结果直接续在它后面，合法
                msgs.extend(pending_results)
            else:
                # tool_calls 和结果在同一条 Anthropic 消息里（罕见）→
                # 先发 assistant(tool_calls)，紧跟结果
                if tool_calls:
                    msgs.append({"role": "assistant", "content": None,
                                 "tool_calls": tool_calls})
                    tool_calls = []
                msgs.extend(pending_results)

        if tool_calls:
            msgs.append({"role": "assistant", "content": "\n".join(texts) or None,
                         "tool_calls": tool_calls})
            tool_calls = []
        elif texts:
            msgs.append({"role": role, "content": "\n".join(texts)})

    body = {
        "model": map_model(req.get("model", "")),
        "messages": msgs,
        "max_tokens": req.get("max_tokens") or 8192,
        "stream": bool(req.get("stream")),
    }
    if req.get("stream"):
        body["stream_options"] = {"include_usage": True}
    if req.get("temperature") is not None:
        body["temperature"] = req["temperature"]
    if req.get("top_p") is not None:
        body["top_p"] = req["top_p"]
    if req.get("stop_sequences"):
        body["stop"] = req["stop_sequences"]
    tools = req.get("tools")
    if tools:
        body["tools"] = [{
            "type": "function",
            "function": {
                "name": t.get("name", ""),
                "description": t.get("description", ""),
                "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
            },
        } for t in tools]
    tc = req.get("tool_choice")
    if tc:
        tt = tc.get("type")
        if tt == "auto":
            body["tool_choice"] = "auto"
        elif tt == "any":
            body["tool_choice"] = "required"
        elif tt == "none":
            body["tool_choice"] = "none"
        elif tt == "tool":
            body["tool_choice"] = {"type": "function",
                                   "function": {"name": tc.get("name", "")}}
    return body


def oai_to_ant(resp, model_in):
    ch = (resp.get("choices") or [{}])[0]
    msg = ch.get("message", {})
    blocks = []
    rc = msg.get("reasoning_content")
    if rc:
        blocks.append({"type": "thinking", "thinking": rc, "signature": ""})
    if msg.get("content"):
        blocks.append({"type": "text", "text": msg["content"]})
    for tcall in msg.get("tool_calls") or []:
        fn = tcall.get("function", {})
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {"_raw": fn.get("arguments", "")}
        blocks.append({
            "type": "tool_use",
            "id": tcall.get("id") or ("toolu_" + uuid.uuid4().hex[:16]),
            "name": fn.get("name", ""),
            "input": args,
        })
    stop = {"tool_calls": "tool_use", "length": "max_tokens"}.get(
        ch.get("finish_reason"), "end_turn")
    u = resp.get("usage", {}) or {}
    return {
        "id": resp.get("id") or ("msg_" + uuid.uuid4().hex[:24]),
        "type": "message",
        "role": "assistant",
        "model": model_in,
        "content": blocks,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {
            "input_tokens": u.get("prompt_tokens", 0),
            "output_tokens": u.get("completion_tokens", 0),
        },
    }


def upstream_post(path, payload, auth):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if auth:
        headers["Authorization"] = auth
    elif API_KEY:
        headers["Authorization"] = "Bearer " + API_KEY
    req = urllib.request.Request(UPSTREAM + path, data=data, headers=headers,
                                 method="POST")
    return urllib.request.urlopen(req, timeout=90)


def estimate_tokens(req):
    n = 0
    s = req.get("system")
    if isinstance(s, str):
        n += len(s)
    elif isinstance(s, list):
        n += sum(len(b.get("text", "")) for b in s if isinstance(b, dict))
    for m in req.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):
            n += len(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    n += len(str(b.get("text", "")) or str(b.get("input", ""))
                             or b.get("content", "") or "")
    if req.get("tools"):
        n += sum(len(json.dumps(t)) for t in req["tools"])
    return max(1, n // 4)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_header(self):
        a = self.headers.get("Authorization")
        if a:
            return a
        k = self.headers.get("x-api-key")
        if k:
            return "Bearer " + k
        return None

    def do_GET(self):
        if self.path in ("/", "/health"):
            self._send_json(200, {"ok": True, "upstream": UPSTREAM})
            return
        # 其余 GET 透传（如 /v1/models）
        try:
            headers = {}
            a = self._auth_header()
            if a:
                headers["Authorization"] = a
            r = urllib.request.urlopen(urllib.request.Request(
                UPSTREAM + self.path, headers=headers), timeout=60)
            self._send_json(r.status, json.loads(r.read().decode("utf-8")))
        except urllib.error.HTTPError as e:
            self._send_json(e.code, {"error": {"message": str(e)}})
        except Exception as e:
            self._send_json(502, {"error": {"message": str(e)}})

    def do_POST(self):
        # 去掉查询串：Claude Code 会请求 /v1/messages?beta=true
        path = self.path.split("?", 1)[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send_json(400, {"error": {"message": "bad request: %s" % e}})
            return

        if path.endswith("/count_tokens"):
            self._send_json(200, {"input_tokens": estimate_tokens(req)})
            return
        if not path.endswith("/messages"):
            self._send_json(404, {"error": {"message": "unknown path " + self.path}})
            return

        model_in = req.get("model", "")
        body = ant_to_oai(req)
        auth = self._auth_header()
        try:
            resp = upstream_post("/v1/chat/completions", body, auth)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:2000]
            self._send_json(e.code, {"type": "error", "error": {
                "type": "api_error", "message": detail}})
            return
        except Exception as e:
            self._send_json(502, {"type": "error", "error": {
                "type": "api_error", "message": str(e)}})
            return

        if body.get("stream"):
            self._stream(resp, model_in)
        else:
            try:
                data = json.loads(resp.read().decode("utf-8"))
            except Exception as e:
                self._send_json(502, {"type": "error", "error": {
                    "type": "api_error", "message": "bad upstream: %s" % e}})
                return
            self._send_json(200, oai_to_ant(data, model_in))

    # ---- 流式：OpenAI chunk SSE -> Anthropic 事件流 ----
    def _stream(self, resp, model_in):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(event, data):
            chunk = ("event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False)))
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()

        msg_id = "msg_" + uuid.uuid4().hex[:24]
        emit("message_start", {
            "type": "message_start",
            "message": {
                "id": msg_id, "type": "message", "role": "assistant",
                "model": model_in, "content": [], "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        })
        state = {"next_idx": 0, "blocks": {}, "open": None, "usage_out": 0, "finish": None}

        def close_open():
            if state["open"] is not None:
                emit("content_block_stop", {"type": "content_block_stop",
                                            "index": state["open"]})
                state["open"] = None

        def open_block(btype, extra=None):
            idx = state["next_idx"]
            state["next_idx"] += 1
            start = {"type": "content_block_start", "index": idx,
                     "content_block": {"type": btype}}
            if extra:
                start["content_block"].update(extra)
            emit("content_block_start", start)
            state["open"] = idx
            return idx

        buf = b""
        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        continue
                    try:
                        ev = json.loads(payload)
                    except Exception:
                        continue
                    if ev.get("usage"):
                        state["usage_out"] = ev["usage"].get("completion_tokens",
                                                             state["usage_out"])
                    ch = (ev.get("choices") or [{}])[0]
                    if ch.get("finish_reason"):
                        state["finish"] = ch["finish_reason"]
                    delta = ch.get("delta") or {}
                    rc = delta.get("reasoning_content")
                    if rc:
                        cur = state.get("cur_kind")
                        if cur != "thinking":
                            close_open()
                            open_block("thinking")
                            state["cur_kind"] = "thinking"
                        emit("content_block_delta", {
                            "type": "content_block_delta",
                            "index": state["open"],
                            "delta": {"type": "thinking_delta", "thinking": rc},
                        })
                    txt = delta.get("content")
                    if txt:
                        cur = state.get("cur_kind")
                        if cur != "text":
                            close_open()
                            open_block("text", {"text": ""})
                            state["cur_kind"] = "text"
                        emit("content_block_delta", {
                            "type": "content_block_delta",
                            "index": state["open"],
                            "delta": {"type": "text_delta", "text": txt},
                        })
                    for tcall in delta.get("tool_calls") or []:
                        oi = tcall.get("index", 0)
                        ent = state["blocks"].get(oi)
                        if ent is None:
                            close_open()
                            state["cur_kind"] = None
                            fn = tcall.get("function", {})
                            idx = open_block("tool_use", {
                                "id": tcall.get("id") or ("toolu_" + uuid.uuid4().hex[:16]),
                                "name": fn.get("name", ""),
                                "input": {},
                            })
                            ent = {"idx": idx, "json": ""}
                            state["blocks"][oi] = ent
                            state["cur_kind"] = "tool"
                        frag = (tcall.get("function") or {}).get("arguments")
                        if frag:
                            ent["json"] += frag
                            emit("content_block_delta", {
                                "type": "content_block_delta",
                                "index": ent["idx"],
                                "delta": {"type": "input_json_delta",
                                          "partial_json": frag},
                            })
        finally:
            close_open()
            stop = {"tool_calls": "tool_use", "length": "max_tokens"}.get(
                state["finish"], "end_turn")
            emit("message_delta", {
                "type": "message_delta",
                "delta": {"stop_reason": stop, "stop_sequence": None},
                "usage": {"output_tokens": state["usage_out"]},
            })
            emit("message_stop", {"type": "message_stop"})


def main():
    srv = ThreadingHTTPServer((HOST, int(PORT)), Handler)
    sys.stderr.write("anthropic-bridge %s -> %s (default model %s)\n"
                     % (LISTEN, UPSTREAM, DEFAULT_MODEL))
    sys.stderr.flush()
    srv.serve_forever()


if __name__ == "__main__":
    main()