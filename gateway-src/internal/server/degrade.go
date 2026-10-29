package server

import (
	"os"
	"strconv"
	"sync"
	"time"
)

// degradeGate 降级状态机：passthrough 模式下请求被上游内容策略拦截时，
// 切换到 Degraded 中性提示词。
//
// 定位：误报处理（与 internal/upstream/sanitize.go 同哲学）——内容拦截多为
// system 来源的指纹误报，换最小中性提示词即可绕开；不是对抗框架。
//
// 历史教训（2026-10-29）：初版让降级持续到"次日 00:00 CST"、且是进程级的。
// 结果是任何一次上游误杀都会让当天之后所有请求的 system 被整条替换成
// Degraded —— 用户侧表现为"人设/提示词注入突然全失效，第二天自己好了"，
// 且完全看不出是网关干的。现在改为：
//   - 窗口短（默认 10 分钟，WB2A_DEGRADE_WINDOW 可调），过期自动恢复；
//   - 且只对"本次撞墙后的一次重试"生效（见 handler.go 的 degradedApplied），
//     窗口内后续请求仍先按客户端原文出站，撞墙了再降级那一条；
//   - WB2A_DEGRADE_DISABLE=1 可整体关掉降级（只保留错误透传）。
//
// 状态机：进程内存、重启清零。
type degradeGate struct {
	mu      sync.Mutex
	until   time.Time
	probeAt time.Time // 下次允许原文探针出站的时间（降级期内限频）
}

// degradeWindow 降级窗口时长。
//
// 默认 10 分钟：足够覆盖一次上游指纹规则的瞬时抖动，又不会让一次误杀把
// 半天的人设吃掉。WB2A_DEGRADE_WINDOW 接受 Go duration 语法（如 "30s"、"2h"）；
// 非法值或 <=0 一律回落默认。
func degradeWindow() time.Duration {
	const def = 10 * time.Minute
	if v := os.Getenv("WB2A_DEGRADE_WINDOW"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

// degradeDisabled 是否整体关闭降级（WB2A_DEGRADE_DISABLE=1/true）。
// 关闭后撞墙不再有中性提示词抢救，错误原文直接回客户端——排查期的正确形态。
func degradeDisabled() bool {
	v := os.Getenv("WB2A_DEGRADE_DISABLE")
	if v == "" {
		return false
	}
	b, err := strconv.ParseBool(v)
	return err == nil && b
}

// Active 当前是否处于降级期（now < until）。
func (g *degradeGate) Active() bool {
	if degradeDisabled() {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return time.Now().Before(g.until)
}

// Trigger 触发降级，持续 degradeWindow()。
// 已在降级期内则不续期（保持最早触发点的过期语义，避免连续撞墙把窗口无限拉长）。
func (g *degradeGate) Trigger() {
	if degradeDisabled() {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !time.Now().Before(g.until) {
		g.until = time.Now().Add(degradeWindow())
	}
}

// probeInterval 降级期内的"原文探针"间隔。
//
// 为什么需要探针：降级期若一律改发 Degraded，就无法察觉上游其实已经恢复到
// 能放行客户端原文了——人设会白白损失整个窗口。每隔 probeInterval 放一条
// 原文请求出站：通过则立即清空降级（persona 当场回来），仍被拦则代价只有
// 一次 400，不放大请求量。WB2A_DEGRADE_PROBE 可调（0 = 关闭探针）。
func probeInterval() time.Duration {
	const def = 30 * time.Second
	if v := os.Getenv("WB2A_DEGRADE_PROBE"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= 0 {
			return d
		}
	}
	return def
}

// AllowProbe 降级期内是否放这一条请求用客户端原文出站（限频）。
func (g *degradeGate) AllowProbe() bool {
	iv := probeInterval()
	if iv == 0 {
		return false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !time.Now().Before(g.until) {
		return false
	}
	if time.Now().Before(g.probeAt) {
		return false
	}
	g.probeAt = time.Now().Add(iv)
	return true
}

// Clear 立刻结束降级（探针发现原文已能通过时调用）。
func (g *degradeGate) Clear() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.until = time.Time{}
	g.probeAt = time.Time{}
}

// Until 返回当前降级截止时间（供 /status 与日志；未降级为零值）。
func (g *degradeGate) Until() time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.until
}
