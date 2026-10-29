package upstream

import "strings"

// internalModelAliases 上游桌面端 / 路由层的「内部别名」模型。
//
// 它们不是可对话模型，只是客户端内部档位名（路由档、画布、任务代理用）：
// 上游企业端点家族（/v2、/console）与 IDE UA 的 /v3/config 会把这些别名一起下发，
// 一旦被当成真模型透进 /v1/models，用户下拉里就会出现
// "enhance-1.0 / seedance-2.5 / fast-model / primary-model / auto-chat / o4-mini /
// default-model" 这种一看就不对的名字（2026-10-29 实测复现）。
// 客户端选到它们只会在 chat 通道上吃 11102 / 400。
//
// 这里做**最后一道闸**：无论上游哪个端点、哪个 realm 下发，出口一律剔除。
// 与 global_models.go 里 probeGlobalModels 的 per-endpoint 过滤互为兜底
// （那边是「别混进目录」，这里是「混进来了也不许出去」）。
var internalModelAliases = map[string]bool{
	"default-model":  true,
	"fast-model":     true,
	"balanced-model": true,
	"primary-model":  true,
	"deep-model":     true,
	"auto-chat":      true,
	"auto-model":     true,
	"enhance":        true,
	"enhance-1.0":    true,
	"seedance":       true,
	"seedance-2.5":   true,
	"o4-mini":        true,
	"canvas":         true,
	"canvas-model":   true,
}

// nonChatArtifacts 真正的「非对话产物」：客户端内部功能入口，不是模型。
//
// 与上面那组档位别名的区别很关键（2026-10-29 现场核对）：
//   - global 域里 default-model / fast-model / balanced-model / primary-model /
//     deep-model 是**客户端菜单本身**的档位项，上游给的名字是 Auto / Fast /
//     Balanced / Primary / Deep —— 它们在 international 客户端里可选、也可用，
//     剔除等于砍功能；
//   - 但 enhance / seedance / auto-chat / o4-mini / canvas 这类是画布、图片生成、
//     任务代理的内部入口，任何时候都不是可对话模型。
//
// 所以：CN 域按 internalModelAliases 全剔（CN 菜单里出现档位别名 = 2026-10-29 那种
// 「国际菜单被冠上 cn: 前缀」的串域事故）；global 域只剔本表。
var nonChatArtifacts = map[string]bool{
	"auto-chat":    true,
	"auto-model":   true,
	"enhance":      true,
	"enhance-1.0":  true,
	"seedance":     true,
	"seedance-2.5": true,
	"o4-mini":      true,
	"canvas":       true,
	"canvas-model": true,
}

// bareModelID 去 realm 前缀、转小写、去空白。
func bareModelID(id string) string {
	s := strings.ToLower(strings.TrimSpace(id))
	if i := strings.IndexByte(s, ':'); i >= 0 {
		s = s[i+1:]
	}
	return s
}

// IsInternalModelAlias 判断模型 id 是否为内部别名（CN 域口径：档位别名 + 非对话产物）。
// 大小写不敏感，忽略 realm 前缀（"cn:fast-model" → "fast-model"）。
func IsInternalModelAlias(id string) bool {
	return internalModelAliases[bareModelID(id)]
}

// IsNonChatArtifact 判断模型 id 是否为非对话产物（global 域口径，比别名窄）。
func IsNonChatArtifact(id string) bool {
	return nonChatArtifacts[bareModelID(id)]
}
