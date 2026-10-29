# wb2api 网关补丁独立验证报告

- 验证者：gateway-verifier（独立验证，不复用打补丁者的结论）
- 时间：2026-10-29 18:35–18:5x（Asia/Shanghai）
- 环境：Windows 11 + PowerShell 7（无 bash 语法）
- 被测二进制：`C:\Users\86157\.dsh\wb2api\bin\wb2a-server.exe`（9,970,176 B，SHA256 `0DFA7E08…6A9E53`，与插件副本同 sha）
- 在线网关：PID 25544 / 127.0.0.1:7863，**全程未重启、未杀**
- 源码：`F:\tmp\wb2a-src`（**只读，未改任何文件**；`git status` 仅显示既有 M/?? 改动）
- 隔离实例：端口 7970–7985，config/auths/state 全部在 `F:\project\dsh_chajian\.tmp\verify\` 下，用完逐个按 PID+端口确认真死亡
- 文中 `@` 表示 ASCII `@`（U+0040），用来规避本会话文本层对 `@` 的改写

## 结论汇总

| # | 验证项 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | 关脱敏后发原指纹句 → content_blocked + 降级重试 | **通过** | 上游 400 `{"code":11-128,…}` + 日志 `content-blocked … -> degraded prompt retry`，同请求 200（inst_b / inst_d / inst_c3） |
| 2a | 默认窗口约 10 分钟（不是次日 00:00） | **通过** | 源码 `10*time.Minute` + 8/8 单测 PASS + 行为：触发后 +223s 仍降级（pt=72），30s 实例 +43s 已自愈，C3 复核到点自愈（见 §2.4） |
| 2b | `WB2A_DEGRADE_WINDOW=30s` 快速自愈 | **通过** | 触发 18:36:54；+3s 降级（pt=72、canary 不回显）；+43s 恢复（pt=78、回显 K7QZ） |
| 2c | `WB2A_DEGRADE_DISABLE=1` 不降级 | **部分通过** | 无粘滞窗口 ✓（后一条 clean 请求 pt=78 回显 K7QZ）；但**同请求内仍换 Degraded 重试并返回 200**，与「只保留错误透传」的注释不符（见 §2.5 缺陷②） |
| 3 | 降级期内按 `WB2A_DEGRADE_PROBE` 放行原文探针 | **通过（有缺陷①）** | 探针原文确实出站（降级期内被再次 400）；clean 探针成功 → 日志 `degrade probe succeeded … passthrough system restored` + 立即回显 canary；但存在「Degraded 重试成功被误判为探针成功」的假清理（见 §3.3） |
| 4 | 在线 7863 未降级、system 被尊重 | **通过** | pt 随 system 单调增长 78 → 753 → 1863；canary 回显 `K7QZ`；`gw-debug.log` 今日 content_blocked/11-128 命中 0 |
| 5 | 宿主仍发出带 `@` 的原句，脱敏层确有必要 | **通过** | `dsh-file-reference/lib/index.js:54` 的 `FILE_REFERENCE_PROMPT` 字面含 U+0040（机器校验 charcode=64）；A/B：关脱敏→400、开脱敏→一次通过（pt=101，回显 K7QZ） |

另有 3 项行为/可观测性问题（§6），不阻塞主线结论，但建议修。

---

## 1. 指纹拦截 → 降级重试（验证项 1）

隔离实例 `inst_b_ttl30`（7971，`WB2A_SANITIZE_FINGERPRINTS=0`，仅保留健康号 5d4c7de1，`WB2A_DEGRADE_WINDOW=30s`，`WB2A_DEGRADE_PROBE=0`），system 为宿主原句：

```text
Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root;
```

命令（`lib.ps1` 内 `Send-Chat`，pwsh7）：

```powershell
. 'F:\project\dsh_chajian\.tmp\verify\lib.ps1'
$i = New-GwInstance -Name 'inst_b_ttl30' -Port 7971 -KeepAuth @('5d4c7de1') -EnvMap @{
  WB2A_SANITIZE_FINGERPRINTS='0'; WB2A_DEGRADE_WINDOW='30s'; WB2A_DEGRADE_PROBE='0' }
Send-Chat -Port 7971 -System (New-System -Kind fp)
```

上游原文与网关日志（`inst_b_ttl30\stderr.log`）：

```text
2026/10/29 18:36:54 WARN: [upstream] chat_stream acct=快乐不打烊(5d4c7de1): upstream 400 content_blocked
body={"code":11-128,"msg":"Illegal API invocation from an unapproved channel","requestId":"5ab0ef5e06927d7fc899f419de8b20c3",…}
2026/10/29 18:36:54 content-blocked (likely fingerprint false positive) -> degraded prompt retry
```

客户端侧（同一次请求）：`status=200, pt=72, content=''` —— 首撞 400 后网关自动换 Degraded 中性提示词重试并成功，客户端无感。

补充：`inst_a_disable`（7970，全 6 号）那次因为 5/6 个号 token 已被上游 401（openresty `401 Authorization Required`），3 次轮转名额被 401 吃掉，客户端最终拿到 503 `no_healthy_account`；但同一日志里仍可见 400→降级的完整链路（18:36:11，`requestId=b7f387c9…`）。账号 401 是环境现状（只有 5d4c7de1 健康），与补丁无关。

## 2. 降级窗口语义（验证项 2）

### 2.1 源码与单测

`internal/server/degrade.go`：`degradeWindow()` 默认 `10*time.Minute`，`WB2A_DEGRADE_WINDOW`（Go duration，非法/≤0 回落 10m）；`degradeDisabled()` 读 `WB2A_DEGRADE_DISABLE`；`Trigger()` 不续期；`probeInterval()` 默认 30s，`0` 关闭；`AllowProbe()` 限频。

```powershell
cd F:\tmp\wb2a-src; go test ./internal/server -run TestDegrade -v
# TestDegradeWindowDefault / WindowEnv / GateActiveTriggered / TriggerNoRenewal /
# DisabledKillSwitch / ProbeRateLimited / ProbeDisabled / Clear —— 8/8 PASS，ok 4.251s
```

### 2.2 默认窗口 = 10 分钟量级，不是「次日 00:00」

`inst_c_default_window`（7972，脱敏关、探针关=0，默认窗口）：

- 18:38:45 触发（400 11-128 + 降级重试日志），首个请求 200 / pt=72。
- **+223s**（18:42:28/18:42:30）两条 clean 请求（canary 98 字、canary_long 3138 字）全部 `pt=72, content=''` —— 3138 字 system 仍是 72 pt，说明 system 仍被替换成 Degraded，窗口未过期。
  若窗口是旧行为（到次日 00:00），此刻降级必然仍在；而新行为 +223s 仍在、+30s 实例早已恢复，已排除「窗口=0」与「窗口≤223s」。
- 复核（`inst_c3_default_window`，7977，同参数）：18:43:37 触发；+5s `pt=72, content=''`；到点复核结果见 §2.4。

### 2.3 `WB2A_DEGRADE_WINDOW=30s` 快速自愈

`inst_b_ttl30`（7971，探针 0）时间线：

| 时刻 | 请求 | 结果 | 解读 |
|---|---|---|---|
| 18:36:54 | fp system | 400→降级重试→200，pt=72 | 触发+同请求抢救 |
| 18:37:01 (+3s) | clean canary | 200，pt=72，content='' | 仍在降级期（system 被换） |
| 18:37:37 (+43s) | clean canary | 200，**pt=78，content='K7QZ'** | 30s 窗口已过，原文 system 恢复 |

pt 差 72 vs 78、canary 有无回显，是「system 是否被换」最直观的判据。

### 2.4 默认窗口到点自愈（C3 复核）

见本报告末尾「§8 C3 复核」一节的实测记录（触发 18:43:37，窗口应在 18:53:37 到期）。

### 2.5 `WB2A_DEGRADE_DISABLE=1`

`inst_a_disable`（7970）与 `inst_f_disable`（7979，仅 5d4c7de1）：

- 触发请求：`content-blocked … -> degraded prompt retry` 日志照打，客户端拿到 **200 / pt=72 / content=''**（f_disable F1）——即**同请求内仍被换成 Degraded 重试成功**。
- 紧接着的 clean canary：200 / pt=78 / `K7QZ` —— **没有粘滞降级**，kill switch 在「窗口」维度生效。

结论：`WB2A_DEGRADE_DISABLE` 实际语义 = 「不建立降级窗口」，而非注释里写的「整体关掉降级，只保留错误透传」。见 §6 缺陷②。

## 3. 降级期原文探针（验证项 3）

### 3.1 探针确实放行原文出站（`inst_d_probe`，7973，窗口 180s，探针 60s）

```text
18:38:48 400 content_blocked   requestId=a81d79ef…   ← 触发请求（原文）
18:38:48 content-blocked … -> degraded prompt retry
18:38:52 400 content_blocked   requestId=aeeef2c6…   ← 降级期内第二次 fp 请求，被判为探针 → 原文出站，再次被拦
```

即降级期内存在「按间隔把客户端原文送出」的通道，且拦截一次只付一次 400，不放大请求量。

### 3.2 clean 探针成功 → 清降级（`inst_d2_probe_ok`，7974，窗口 180s，探针 30s）

| 时刻 | 请求 | 结果 |
|---|---|---|
| 18:40:39 | fp system | 400→降级重试→200，pt=72 |
| 18:40:45 (+6s) | clean canary | 200，**pt=78，content='K7QZ'**（原文出站成功） |
| 18:40:45 | 日志 | `[server] degrade probe succeeded (acct=快乐不打烊(5d4c7de1) model=deepseek-v4.1-flash): passthrough system restored` |
| 18:40:49 (+10s) | clean canary | 200，pt=78，content='K7QZ'（已退出降级） |

限频证据：`go test -run TestDegradeProbeRateLimited` PASS；行为上 `inst_d_probe` 60s 间隔内只出现了一次原文探针。

### 3.3 缺陷①：Degraded 重试成功被误判为「探针成功」

同一 `inst_d_probe` 时间线暴露了假清理：

```text
18:38:52 探针原文被 400 content_blocked（探针失败）
18:38:54 [server] degrade probe succeeded … passthrough system restored   ← 实际是它随后的 Degraded 重试成功触发的
18:39:04 (+17s) clean canary → pt=78, content='K7QZ'  ← 180s 窗口内就已恢复原文，说明降级被提前 Clear
```

代码定位（`internal/server/handler.go`）：`degradeProbe` 在请求进入时（第 599–601 行）置真且**不会在撞墙改写后复位**；第 745–752 行撞墙分支把 body 换成 `prompt.Degraded` 后重试，成功后第 803–808 行看到 `degradeProbe==true` 就 `Clear()` 并打「probe succeeded」。于是「探针被拦 + 降级重试成功」被记账成「探针成功」。

影响：窗口语义被削弱（探针一旦失败就把状态清掉），后续每条请求都先原文撞一次 400 再降级重试（每条多一次上游 400）；日志也会误导排障。修复建议见 §6。

## 4. 在线网关 7863 现状（验证项 4）

在线 PID 25544 未重启，只发读请求（`verifykey` 换真 key，模型 `deepseek-v4.1-flash`，`stream=false`）：

| 请求 | system 长度 | pt | content |
|---|---|---|---|
| canary（max_tokens=256） | 98 | **78** | `K7QZ` |
| canary + 3000 字 filler | 3138 | **753** | `K7QZ` |
| canary + 8000 字 filler | 8133 | **1863** | `''`（该次输出被长度截断） |
| `cn:deepseek-v4.1-flash` + 3000 字 | 3138 | **753** | `K7QZ` |

- pt 随 system 单调增长（78→753→1863），canary 被回显 ⇒ system 被上游真实看到，**未处于降级**（降级时 pt 恒 ≈72 且 canary 丢失）。
- 短 canary 用 `max_tokens=64` 时会因 reasoning 先吃掉配额导致 content 为空，属输出截断，非降级（放宽到 256 即回显）。
- `C:\Users\86157\.dsh\wb2api\data\gw-debug.log`：今日 814 行，`content_blocked|11-128` 命中 **0**（该文件是宿主侧 `[chat] resolveModel/resolveImages` 调试流；网关自身 stdout/stderr 由宿主管道接管，不落盘，故「在线是否降级」以行为证据为准，见上表）。
- `sidecar-debug.log` 中 `content_blocked` 命中 0。

## 5. 宿主原句与脱敏层必要性（验证项 5）

### 5.1 宿主仍然发出带 `@` 的原句

`F:\Softstore\deepseek harness\resources\app\dsh\node_modules\@deepseek-ai\dsh-file-reference\lib\index.js`（`app.dshpurge-next` 下同一份副本）：

```js
// 第 54 行
const FILE_REFERENCE_PROMPT = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. …";
```

机器校验（排除显示层改写）：

```powershell
$t = Get-Content -Raw '…\dsh-file-reference\lib\index.js'
$i = $t.IndexOf('Tokens prefixed with')
[int][char]$t[$i + 20]   # → 64，即 U+0040
```

运行期旁证：本次会话系统提示里同一句呈「Tokens prefixed with the at-sign are …」——因为本会话出站经 7863、脱敏开启，`sanitize.go` 的改写对**在途请求**生效了；宿主模板本身仍是 `@` 形态。

### 5.2 A/B：脱敏层确有必要

| 实例 | 脱敏 | 出站 system | 结果 |
|---|---|---|---|
| `inst_b_ttl30` / `inst_d` / `inst_c3`（7971/7973/7977） | `WB2A_SANITIZE_FINGERPRINTS=0` | 原句（含 `@`） | 上游 **400 `{"code":11-128,…}`**，必须靠降级抢救 |
| `inst_e2_sanitize_on`（7978） | 默认（开） | canary + 原句（合计 211 字） | 一次通过：**pt=101、content='K7QZ'**，stderr 无 400，只有一行 chat 记录（无重试） |

即：不脱敏 → 每条请求先撞一次 11-128 并吃掉降级窗口；脱敏 → 改写一处（`@` → `the at-sign`）语义不变、上游放行。

> 注：`inst_e_sanitize_on`（第一版）因同一 pwsh 会话里残留了上一条实例的 `WB2A_SANITIZE_FINGERPRINTS=0`，得到“脱敏无效”的假阴性；改在独立调用中显式设 `=1` 重跑（E2）才是有效证据。这本身是可复现的环境陷阱，报告以 E2 为准。

---

## 6. 未通过项 / 缺陷与修复建议

**缺陷①（中）探针假成功 → 提前 Clear**
- 位置：`internal/server/handler.go` 撞墙分支（`body = prompt.Rewrite(body, prompt.Degraded)` 前后）与成功分支的 `if degradeProbe { … Clear() }`。
- 现象：见 §3.3。
- 修复：撞墙进入「换 Degraded 重试」时把探针标记复位，例如在 `degradedApplied = true` 同一处加 `degradeProbe = false`；或把成功分支改为 `if degradeProbe && !degradedApplied`。补一个单测：「探针被 400 → 降级重试成功 → 仍 Active()」。

**缺陷②（中）`WB2A_DEGRADE_DISABLE=1` 与文档不符**
- 现象：kill switch 只阻止建立窗口，同请求内仍会用 Degraded 重试并回 200；客户端看不到 400 原文（F1）。
- 修复二选一：(a) 语义保持「整体关闭」，在撞墙分支的条件里加 `&& !degradeDisabled()`；(b) 保持现行为，把 `degrade.go`/README 注释改成「仅关闭降级窗口与探针，保留单次请求内抢救」。

**缺陷③（低）探针失败不可观测、降级状态无机器可读出口**
- `AllowProbe` 放行的原文探针被拦时没有任何专门日志（只能凭「降级期内又多一条 400」推断）；建议加 `log.Printf("degrade probe blocked: still degraded")`。
- `degradeGate.Until()` 已实现但未接到 `GET /status`；建议输出 `degrade_until`（RFC3339，未降级为空），宿主/面板可直接判断，不必靠 pt 推理。

**优化建议（低）** 触发降级时把 `probeAt` 置为 `now+probeInterval`，避免降级刚建立就被用户下一条消息消耗掉探针（当前 `AllowProbe` 在 `probeAt` 为零值时立刻放行）。

---

## 7. 证据文件与清理

- 报告：`F:\project\dsh_chajian\.tmp\verify\report.md`
- 复用脚本：`lib.ps1`（`New-GwInstance` / `Stop-GwInstance` / `New-System` / `Send-Chat`）、`runC.ps1`、`runD.ps1`
- 实例日志：`inst_*\stderr.log`（网关 `log.Printf`）、`inst_*\stdout.log`（请求流水行）
- 结果汇总：`logs\runC.txt`、`logs\runD.txt`、`logs\runD2.txt`、`logs\runE2.txt`、`logs\runF.txt`
- 实例目录清单：`inst_a_disable`(7970) `inst_b_ttl30`(7971) `inst_c_default_window`(7972) `inst_c2_default10m`(7975) `inst_c3_default_window`(7977) `inst_d_probe`(7973) `inst_d2_probe_ok`(7974) `inst_e_sanitize_on`/`inst_e2_sanitize_on`(7976/7978) `inst_f_disable`(7979)
- 清理核对：除 C3 外全部 `ProcessAlive=False / PortStillListening=False`；C3 在 §8 复核后停止。在线 7863（PID 25544）自始至终未被触碰。
- 未改动：`F:\tmp\wb2a-src` 任何文件、`C:\Users\86157\.dsh` 下任何在用文件（隔离实例使用 auth 文件的**副本**，避免 refresh 回写原目录）。

## 8. C3 复核（默认 10m 窗口到点自愈）


- 实例 `inst_c3_default_window`（7977，脱敏关、`WB2A_DEGRADE_PROBE=0`、不设 `WB2A_DEGRADE_WINDOW`=默认窗口），单号 5d4c7de1。
- 18:43:37 触发：上游 400 `11-128`（`requestId=edac8862d20c1f849a3bf89216998fcf`）+ 日志 `content-blocked … -> degraded prompt retry`，同请求 200 / pt=72。
- +5s（18:43:42）clean canary：200，pt=72，content=''（空）→ 仍在降级。
- **18:53:57（+620s，窗口 600s 于 18:53:37 到期）** 两条 clean 请求：
  - canary（98 字）：200，**pt=78**，content='K'（输出被截断，非降级）
  - canary_long（3138 字）：200，**pt=753**，content='K7QZ' → 原文 system 已恢复，降级自愈
- 与 §2.2 的「+223s 仍降级（pt=72，3138 字 system 也压成 72）」合并：默认窗口落在 (223s, 620s] 区间，与 600s=10m 完全吻合；旧行为「到次日 00:00」（>5h）被排除。
- 清理：C3 于复核后停止，`ProcessAlive=False / PortStillListening=False`。

补记（证据卫生）：`inst_c_default_window`(7972) 的脚本被重复执行过，日志后半段 `t=+304s / t=+626s status=-1` 是实例已被前一执行停止后的连接失败，**不作为证据**；该实例有效数据只有 18:38:45 触发与 +224s 仍降级两条。`inst_e_sanitize_on` 的第一版同样因同会话残留 env 作废，以 E2 为准。
