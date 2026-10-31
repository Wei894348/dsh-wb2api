# backend/ · 网关二进制

本目录放插件的后端服务：一个把 CodeBuddy / WorkBuddy 账号变成 OpenAI 兼容 API 的网关
可执行文件，以及从源码重建它的脚本。

```
backend/
├── bin/wb2a-server.exe      随包发布的可执行文件（Windows amd64）
├── build-gateway.ps1        从 Go 源码重建（需要 go ≥ 1.22）
└── README.md                本文件
```

插件怎么用它：

- `lib/gw/proc.js` 负责它的生命周期（拉起 / 探活 / 崩溃重启 / 随 dsh 退出回收）；
- `lib/gw/chat.js` + `lib/gw/catalog.js` 把它的模型目录注册成 dsh 的 LLM provider。

## 当前这份二进制

| 项 | 值 |
|---|---|
| 文件名 | `bin/wb2a-server.exe` |
| 大小 | 10,135,040 字节（9.7 MiB） |
| SHA256 | `99A30AB58C0E66D91DC1E5BF9A0DBC4ED1DBE195DB37FCE0DA243518C5CEDEE7` |
| 目标平台 | windows / amd64 |
| 入口 | Go 侧 `cmd/server` |

> 本次重建（2026-10-31）：出站请求头对齐官方原生客户端（chat 去掉 `Origin`/`Referer`/
> `Accept-Language`/派生设备头与 `X-No-*` 否定族，补齐归属族 / `acp-connection-id` /
> trace 三方言，`X-Product` 归位 `SaaS`，refresh 渠道标识改 `workbuddy`）。源码在
> `gateway-src/`，构建命令见下。

## 重建

```powershell
pwsh -File backend/build-gateway.ps1 -SourceRepo <源码仓库地址或本地路径>
pwsh -File backend/build-gateway.ps1 -SourceRepo <...> -OutDir .\dist    # 换个输出目录
pwsh -File backend/build-gateway.ps1 -SourceRepo <...> -KeepSource       # 保留源码目录
```

脚本做的事：`git clone --depth 1`（或复用 `.build/upstream`）→ 读 `go.mod` 确认是那份源码
→ `go build` 出 `wb2a-server[.exe]` → 复制进 `backend/bin/` → 打印 SHA256，并与包内那份比对。

## 运行前提

网关缺 `config.json` 会直接退出；首次使用跑一次插件命令 `/wb2api-setup`，或在运行目录
（默认 `~/.dsh/wb2api/`）里放一份：

```json
{ "listen": "127.0.0.1:7863", "api_key": "<随机串>", "auth_dir": "./auths", "state_file": "./data/state.json" }
```

## 使用须知

- 只在本机驱动使用者**自己**的账号，遵守 CodeBuddy / WorkBuddy 的服务条款。
- 网关只监听回环地址；`api_key` 由本机生成，不要外传。
