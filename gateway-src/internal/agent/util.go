package agent

import (
	"crypto/rand"
	"encoding/hex"
)

// randomHex 生成 n 位随机 hex 字符串（补齐缺失的 tool_call id / block id 用）。
func randomHex(n int) string {
	b := make([]byte, (n+1)/2)
	_, _ = rand.Read(b)
	s := hex.EncodeToString(b)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

// strOr any → string（nil 安全）。
func strOr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// nilIfEmpty 空串转 nil（assistant content 为空时保持 null 而非 ""）。
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// orDefault 零值兜底。
func orDefault(v, d int) int {
	if v > 0 {
		return v
	}
	return d
}
