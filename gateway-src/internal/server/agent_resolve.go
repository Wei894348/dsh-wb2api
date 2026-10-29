package server

import (
	"strings"
)

// resolveAnthropicModel Anthropic 请求的模型名落点。
// 语义对照 anthropic_bridge.map_model：带 cn:/hf:/global: 前缀的名字原样保留
// （网关 resolveModel 认前缀），其余（claude-* 等裸名）落默认模型——原桥用
// WB2A_DEFAULT_MODEL 环境变量，这里用网关配置的 prompt 侧默认（裸名交给
// chatCompletions 的 resolveModel 也会落到 cn 裸名查询，11102 兜底），为对齐
// 原桥行为，裸名统一换成 "cn:auto"（与原桥默认值一致）。
func resolveAnthropicModel(reqModel string, translated any) string {
	_ = translated
	if strings.HasPrefix(reqModel, "cn:") ||
		strings.HasPrefix(reqModel, "hf:") ||
		strings.HasPrefix(reqModel, "global:") {
		return reqModel
	}
	return "cn:auto"
}

// resolveResponsesModel Responses 请求的模型名落点。
// 语义对照 codex_bridge.resolve_model：优先精确名；前缀兜底；大小写不敏感的
// 全等/后缀匹配；子串匹配；最终落 "cn:auto"。网关 modelList 的 id 形如
// "cn:xxx"（modelList 里 "cn:"+mi.ID），在这里用 status 级信息做近似匹配，
// 不额外拉目录（目录拉取有 1h 缓存，代价高）——简化为：带前缀原样透传，
// 裸名尝试加 "cn:" 前缀（网关模型目录的 CN 形态），匹配失败由上游 11102
// 错误自然暴露。原桥的目录级模糊匹配依赖 /v1/models 往返，这里省略该往返，
// 直连场景下 Codex 桌面端配置的模型名应写网关 /v1/models 列出的全名。
func (h *Handler) resolveResponsesModel(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "cn:auto"
	}
	if strings.Contains(name, ":") {
		return name // cn:/global:/hf: 前缀，原样
	}
	return "cn:" + name
}
