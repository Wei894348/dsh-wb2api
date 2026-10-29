package server

import (
	"testing"
	"time"
)

// TestDegradeWindowDefault 默认窗口为 10 分钟（误杀只损失一小段，不吞掉整天）。
func TestDegradeWindowDefault(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_WINDOW", "")
	if got := degradeWindow(); got != 10*time.Minute {
		t.Fatalf("default window = %v, want 10m", got)
	}
}

// TestDegradeWindowEnv 环境变量覆盖；非法值/非正值回落默认。
func TestDegradeWindowEnv(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_WINDOW", "30s")
	if got := degradeWindow(); got != 30*time.Second {
		t.Fatalf("window = %v, want 30s", got)
	}
	for _, bad := range []string{"abc", "0", "-5m"} {
		t.Setenv("WB2A_DEGRADE_WINDOW", bad)
		if got := degradeWindow(); got != 10*time.Minute {
			t.Fatalf("window(%q) = %v, want default 10m", bad, got)
		}
	}
}

// TestDegradeGateActiveTriggered Active() 在 Trigger 后为 true，窗口过期后为 false。
func TestDegradeGateActiveTriggered(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "")
	t.Setenv("WB2A_DEGRADE_WINDOW", "120ms")
	var g degradeGate
	if g.Active() {
		t.Error("fresh gate should not be active")
	}
	g.Trigger()
	if !g.Active() {
		t.Error("after Trigger should be active")
	}
	time.Sleep(160 * time.Millisecond)
	if g.Active() {
		t.Error("after window expiry should not be active")
	}
}

// TestDegradeGateTriggerNoRenewal 降级期内再次 Trigger 不续期（窗口不被连续撞墙拉长）。
func TestDegradeGateTriggerNoRenewal(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "")
	t.Setenv("WB2A_DEGRADE_WINDOW", "1h")
	var g degradeGate
	g.Trigger()
	first := g.Until()
	if first.IsZero() {
		t.Fatal("Until() should be set after Trigger")
	}
	g.Trigger()
	if second := g.Until(); !first.Equal(second) {
		t.Errorf("Trigger during active should not renew: first=%v second=%v", first, second)
	}
	if d := time.Until(first); d <= 0 || d > time.Hour {
		t.Errorf("Until() = %v (in %v), want within 1h", first, d)
	}
}

// TestDegradeDisabledKillSwitch WB2A_DEGRADE_DISABLE 下 Trigger 不生效、Active 恒 false。
func TestDegradeDisabledKillSwitch(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "1")
	var g degradeGate
	g.Trigger()
	if g.Active() {
		t.Error("kill switch should keep gate inactive")
	}
	if !g.Until().IsZero() {
		t.Error("kill switch should not set until")
	}
}

// TestDegradeProbeRateLimited 探针限频：降级期内第一次放行，间隔内不再放行。
func TestDegradeProbeRateLimited(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "")
	t.Setenv("WB2A_DEGRADE_WINDOW", "1h")
	t.Setenv("WB2A_DEGRADE_PROBE", "1h")
	var g degradeGate
	// 未降级时不放探针。
	if g.AllowProbe() {
		t.Fatal("probe must be denied while not degraded")
	}
	g.Trigger()
	if !g.AllowProbe() {
		t.Fatal("first probe during degrade should be allowed")
	}
	if g.AllowProbe() {
		t.Fatal("second probe within interval must be denied")
	}
}

// TestDegradeProbeDisabled 探针间隔为 0 时彻底关闭探针。
func TestDegradeProbeDisabled(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "")
	t.Setenv("WB2A_DEGRADE_WINDOW", "1h")
	t.Setenv("WB2A_DEGRADE_PROBE", "0")
	var g degradeGate
	g.Trigger()
	if g.AllowProbe() {
		t.Fatal("probe must be off when interval is 0")
	}
}

// TestDegradeClear Clear 后立即不再降级（探针成功收回人设的路径）。
func TestDegradeClear(t *testing.T) {
	t.Setenv("WB2A_DEGRADE_DISABLE", "")
	t.Setenv("WB2A_DEGRADE_WINDOW", "1h")
	var g degradeGate
	g.Trigger()
	if !g.Active() {
		t.Fatal("should be active after Trigger")
	}
	g.Clear()
	if g.Active() {
		t.Fatal("should be inactive after Clear")
	}
	if !g.Until().IsZero() {
		t.Fatal("Until should be zero after Clear")
	}
}
