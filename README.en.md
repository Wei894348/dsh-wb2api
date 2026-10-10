<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-plugin-wb2api-ui logo">
</p>

# dsh-plugin-wb2api-ui

English | [中文](README.md)

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

Bring a local WorkBuddy / CodeBuddy account pool into DeepSeek Harness — one package does three things:
**runs the gateway process and registers the model provider**, ships a **Web settings panel**, and runs a
**growth-task automation engine**.

Install one plugin → you get model service, a settings panel, and one-click task runs.
The gateway binary ships inside the package, so it works wherever it is installed.

![Settings panel](assets/demo.svg)

## What you get

- **Model service** — the plugin supervises the `wb2a-server` gateway itself (spawn / probe / restart on crash / reclaim when dsh exits) and registers its model catalog as a dsh LLM provider; pick a model in dsh and it just works
- **Gateway in the package** — `backend/bin/wb2a-server.exe` (Windows amd64) travels with the package and wins the lookup order, so `dsh plugin add` finds it in any profile
- **Settings panel** — a "WorkBuddy 反代" section in dsh settings: gateway status, per-account credits, OAuth login, credential import, account toggles — all on one screen
- **One-click tasks** — confirm pending → two execution passes → auto-claim rewards, with live progress in the panel
- **Zero third-party deps** — gateway supervision, ZIP extraction, and the task engine are pure Node; no dependency tree, no build chain
- **Credentials stay local** — the pool is read from the local runtime directory; `accessToken` / `refreshToken` and the gateway `api_key` never enter the repo

## Install

Four ways — pick one. **Restart dsh afterwards**; the host half only reads `bundles` at startup.

### 1. Plugin marketplace

Search `wb2api` in dsh's plugin marketplace and hit install:

- **DSH Plugin Hub** (`dsh-plugin`) — Settings → Plugin Marketplace, feeds from [dsh-plugin.org](https://dsh-plugin.org)
- **dshmarket** — Settings → Plugins, feeds from [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

### 2. CLI: straight from GitHub

```powershell
dsh plugin --profile web add github:Wei894348/dsh-wb2api
```

### 3. CLI: from a tarball

```powershell
# pack at the repo root
npm pack                                              # → dsh-plugin-wb2api-ui-<version>.tgz

# install into a profile (create it first if needed:
#   dsh --profile <name> --from-default-profile web --dump-config)
dsh plugin --profile web add file:<this repo>\dsh-plugin-wb2api-ui-1.5.0.tgz
```

### 4. Local development (link)

```powershell
# link the repo into the live plugin dir; the profile then holds
# "dsh-plugin-wb2api-ui": "link:<path>"
dsh plugin --profile web add link:<path to this repo>
```

`dsh plugin add` does two things: it installs the package into `~/.dsh/profiles/<profile>/node_modules/`
and writes the package name into that profile's `dsh.profile.bundles`. **A running dsh does not re-read
that list — restart dsh after installing** (the host half loads only at startup).

> **The Electron `desktop` profile is the exception**: it is owned by the desktop app, so
> `dsh plugin --profile desktop …` is refused outright
> (`profile "desktop" is managed exclusively by the Electron application`). Install there through the
> desktop plugin marketplace UI instead.

### Verify the install

```powershell
dsh plugin --profile web list                                  # is the dependency there
dsh --profile web --dump-config | Select-String wb2api-ui      # the composed tree should contain: - id: wb2api-ui
```

## Uninstall

```powershell
dsh plugin --profile web remove dsh-plugin-wb2api-ui
```

Restart dsh afterwards. The runtime directory `%USERPROFILE%\.dsh\wb2api\` (account pool and
`config.json`) is **not touched by `remove`** — it is a data directory independent of the plugin;
delete that layer by hand if you want it gone.

## Quick start

```powershell
# 1. install (above) → 2. restart dsh → 3. first-time setup
#    a) recommended: run /wb2api-setup in a session — it prepares the runtime dir,
#       fetches the binary, walks OAuth login, and starts the gateway
#    b) or by hand: runtime/config.example.json → %USERPROFILE%\.dsh\wb2api\config.json,
#       replace api_key with your own
#       credentials: node tools/wb_import.mjs --write (import from the desktop client)
#                    or use the panel's "add account" OAuth flow

# 4. Settings → WorkBuddy 反代: check account count / credits, click "一键做任务" once
```

Command-line equivalents:

```powershell
node engine/wb_tasks.mjs list                 # task list
node engine/wb_tasks.mjs auto all --passes 2  # execute + auto-claim
node engine/wb_tasks.mjs credits              # per-account credits
```

## Topology

```
                     ┌──────────────────── dsh process (host half, loaded once at startup) ──────────┐
    browser GUI  ────►  dsh-plugin-wb2api-ui  ──►  /dsh-wb2api/* routes  ──┐                           │
   (settings.section)   client/client.js (hot swap 500ms)  lib/index.js    │                           │
                     └────────────────────────────────────────────────────┼───────────────────────────┘
                                                                          │
        ┌─────────────────────────────────────────────────────────────────┴──────────────────────┐
        │  this plugin (repo root = npm package dsh-plugin-wb2api-ui)                             │
        │  ① sub-plugin wb2api-gateway (lib/gw/): supervises the wb2a-server child process        │
        │     and registers the LLM provider `workbuddy2api`; commands /wb2api-setup · -status ·  │
        │     -start · -restart · -login · -account                                               │
        │  ② task automation engine (engine/, pure Node, no third-party deps)                     │
        │     scanPendingTasks → runAutomation (two passes) → auto-claim                          │
        │  ③ settings panel (client/client.js): gateway status / credits / OAuth / import / accounts │
        └───────┬───────────────────────────────────┬──────────────────────────────┬─────────────┘
                │ spawn / GET /healthz              │                              │
    ┌───────────▼────────────────────┐   ┌──────────▼────────────────────┐   ┌─────▼──────────────────┐
    │ wb2a-server gateway (in-package)│   │ credential pool auths/         │   │ upstream (CodeBuddy)   │
    │ backend/bin/wb2a-server.exe    │   │ ~/.dsh/wb2api/auths/*.json    │   │ copilot.tencent.com    │
    │ default 127.0.0.1:7863         │   └───────────────────────────────┘   │ www.codebuddy.cn       │
    │ /v1/chat/completions           │                                       │ www.workbuddy.cn / .ai │
    │ /v1/models · /status · /healthz│                                       └────────────────────────┘
    └────────────────────────────────┘
```

The gateway and the task engine share **one credential pool** at `~/.dsh/wb2api/auths/`: the gateway serves
models from it, the engine runs tasks with it. Change that directory and both sides follow.

## Layout

```
dsh-wb2api/                       ← repo root = npm package root (package.json lives here)
├── package.json                  manifest: main / exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml              bundle patch (one insert row)
├── lib/                          host half (node side)
│   ├── index.js                  15 /dsh-wb2api/* routes + direct upstream calls + engine bridge
│   │                             (imports the sub-plugin at the top, mounts it via ctx.plugin at mountGateway)
│   └── gw/                       gateway supervision + provider registration (13 .js files)
│       ├── index.js              sub-plugin entry: /wb2api-* commands, auto-start, status reporting
│       ├── settings.js           config normalization + defaults, provider settings namespace
│       ├── runtime.js            path policy: runtime dir / cwd / credential dir / gateway config generation
│       ├── proc.js               child process: locate binary → /healthz probe → spawn → restart on crash → dispose
│       ├── chat.js               LlmAdapter: request assembly + SSE → StreamChunk
│       ├── stream.js             SSE frame parsing with dual timeouts (first frame / inter-frame)
│       ├── catalog.js            /v1/models → dsh model catalog mapping (TTL cache + de-dup)
│       ├── binary.js             binary download + SHA256 verification + atomic write
│       ├── archive.js            built-in ZIP extraction (no third-party deps)
│       ├── credentials.js        account toggles (rename the suffix under auths/)
│       ├── authorize.js          Node OAuth login + credential write
│       ├── bootstrap.js          /wb2api-setup orchestration
│       └── render.js             status/report text rendering (pure functions)
├── client/                       browser half (web side)
│   └── client.js                 settings section card (hand-written __ModuleLoader__ factory, no build step)
├── backend/                      the gateway binary (shipped, included in `files`)
│   ├── bin/wb2a-server.exe       Windows amd64 executable (SHA256 in backend/README.md)
│   ├── build-gateway.ps1         rebuild from Go source: clone + go build
│   └── README.md                 checksums and rebuild instructions
├── engine/                       task automation engine (ships with the package)
│   ├── wb_tasks.mjs              CLI: list / scan / auto / credits
│   └── wb_up/
│       ├── core.mjs              upstream access core: three client fingerprints, endpoint table, envelope parsing, retries
│       ├── events.mjs            event construction + desktop/web/billing reporting + real chat (SSE)
│       ├── tasks.mjs             task list / accept / claim (mini-program variant, night-owl, streak)
│       ├── growth.mjs            growth domain (buddy adoption, agreement, streak)
│       ├── billing.mjs           credit package queries
│       ├── actions.mjs           task action table (criteria, cost, throttling)
│       ├── backend.mjs           api facade used by the action layer
│       ├── store.mjs             credential read/write (~/.dsh/wb2api/auths)
│       └── run.mjs               orchestration: scan → two passes → auto-claim + single-flight lock
├── locale/                       panel strings and metadata (zh / en)
│   ├── zh.json
│   └── en.json
├── assets/                       images used by the READMEs
│   ├── logo.svg
│   └── demo.svg
├── tools/                        ops scripts (run manually, not through the plugin)
│   ├── wb_import.mjs             import the desktop client's current login (%wbEncrypted envelope)
│   ├── wb_daily.mjs              check-in / claim finished tasks (--tasks to run the engine; off by default)
│   ├── wb_checkin.mjs            single-account check-in + token verification
│   ├── wb_pooltest.mjs           fire a few requests to see which account is working
│   └── wb_client_smoke.mjs       offline render smoke test for client/client.js (minimal React stand-in + dummy DOM)
├── runtime/
│   ├── config.example.json       gateway config template (api_key is a placeholder)
│   └── anthropic_bridge.py       optional bridge exposing the gateway as Anthropic /v1/messages
├── docs/
│   ├── ARCHITECTURE.md           upstream channels, task actions, scoring/claim semantics, credential decryption, supervision, troubleshooting
│   └── PANEL.md                  panel features and installation notes
├── sync.ps1                      live ↔ archive sync (pulls from live by default)
├── CHANGELOG.md
├── LICENSE
└── .gitignore
```

## Slash commands

| Command | What it does |
|---|---|
| `/wb2api-setup` | One-shot: prepare the runtime dir + fetch the binary + OAuth login + start the gateway |
| `/wb2api-status` | Gateway status and account availability report |
| `/wb2api-start` / `/wb2api-restart` | Start / restart the supervised gateway process |
| `/wb2api-login` | Node OAuth login (`cn` / `global`) |
| `/wb2api-account` | Account toggles (`auto` / index / uid prefix) |

## Host routes (`/dsh-wb2api/*`, served on dsh's own port, default 3080)

| Method | Path | What it does |
|---|---|---|
| GET | `/state` | First-screen status: gateway health, credential pool, model catalog, today's check-in/keepalive results (first open each day also tops up check-in + claims) |
| GET | `/models` | Refresh the model catalog |
| POST | `/checkin` | Manual check-in (pass `uid` in the body to run one account) |
| POST | `/keepalive` | Keep-alive: create one cloud session per account |
| GET | `/growth` | Growth-center task list + consecutive login days (`?force=1` bypasses the cache) |
| POST | `/growth/claim` | Claim rewards for **completed** growth tasks |
| GET | `/credits` | Per-account remaining credits (package breakdown; `?force=1` bypasses the 60s cache) |
| POST | `/tasks/run` | "One-click tasks": confirm pending → execute → auto-claim (runs in the background, returns immediately) |
| GET | `/tasks/status` | Progress / log tail / summary of that run |
| POST | `/login/begin` | Request an OAuth authorization link (`realm: cn\|global`) |
| POST | `/login/poll` | Poll the authorization result (202 + pending while upstream has not acknowledged) |
| POST | `/import` | Upload / paste credential JSON (single object or array) |
| POST | `/account/toggle` | Enable / disable one account (renames the `.disabled` suffix) |
| POST | `/account/only` | Enable exactly one account (renames and disables the rest) |
| POST | `/account/delete` | Delete a credential file |

`tasks/run` body (all optional): `{ uid?: "<prefix>", only?: ["<task_code>"], passes?: 1-4 }`.

## Where the gateway binary comes from

`resolveBinary()` in `lib/gw/proc.js` tries these in order and uses the first hit:

| # | Location | Notes |
|---|---|---|
| 1 | config `binaryPath` | Explicit; **if the file does not exist it fails immediately** instead of falling through |
| 2 | config `repoPath`, its root and its `bin/` | For when you keep gateway sources or your own build |
| 3 | **in-package `backend/bin/`** | The binary that ships with this package (resolved via `new URL('../../backend/bin', import.meta.url)`), priority above any downloaded copy — so `dsh plugin add` finds it wherever it installs |
| 4 | `~/.dsh/wb2api/bin/` | Runtime cache |
| 5 | `PATH` | Handed to `ctx.subprocess.resolveExecutable()`; may already be installed globally |

It only throws when every candidate misses, and the error lists every path it tried. Auto-download is off by
default (`autoDownloadBinary: false`); when enabled, the release repository points at this repository
(`DEFAULT_RELEASE_REPO` in `lib/gw/binary.js`, `binaryReleaseRepo` in `lib/gw/settings.js`).

## Runtime directory and data

The gateway's `config.json` / `auth_dir` / `state_file` are **relative to cwd**; point cwd wrong and it reads a
missing config (it exits right after startup). Working-directory order (`resolveWorkingDir()`): config
`workingDir` → config `repoPath` → **`~/.dsh/wb2api/`** (when `config.json` exists) → the executable's directory.

| Path | What it is |
|---|---|
| `~/.dsh/wb2api/config.json` | Gateway config: `listen` / `api_key` / `auth_dir` / `state_file` (missing → the gateway exits) |
| `~/.dsh/wb2api/auths/` | Credential pool, one `workbuddy-<uid>.json` per account (**must exist before the gateway starts**, otherwise it skips hot loading and never retries) |
| `~/.dsh/wb2api/data/` | Gateway state and plugin artifacts: `state.json`, the engine's single-flight lock `wb-tasks.lock` |
| `~/.dsh/wb2api/bin/` | Cache for downloaded/built binaries (the in-package `backend/bin/` wins over it) |

Gateway routes: `/v1/chat/completions`, `/v1/models`, `/status`, `/healthz` (`/healthz` needs no auth and
listens on loopback only).

### Why the provider id is `workbuddy2api`

The sub-plugin's identity name is `wb2api-gateway` (`export const name` in `lib/gw/index.js`), but the LLM
provider id stays `PROVIDER = 'workbuddy2api'` (`lib/gw/settings.js`) **on purpose**: dsh settings such as
`agent-default-model.provider` reference that id, and renaming it would break existing model configurations.

> Do **not** mount two plugins that register the same provider id in one profile — they collide with
> `DUPLICATE_ADAPTER` and the host will not start.

## Security

- **Credentials never leave the machine**: the pool lives in `~/.dsh/wb2api/auths/`, the gateway listens on loopback only (`127.0.0.1:7863`), and `/healthz` is unauthenticated but exposes no account data
- **No secrets in the repo**: `accessToken` / `refreshToken` under `auths/` and the `api_key` in `config.json` are blocked by `.gitignore`; `runtime/config.example.json` carries a masked placeholder
- **Verified binary**: `lib/gw/binary.js` checks SHA256 after download before writing atomically; the shipped copy's digest is recorded in `backend/README.md`
- **Readable patch**: `cordis.patch.yml` is a single `insert` row naming the plugin id and package — no hidden injection
- **Single-flight lock on the engine**: real-credit actions (expert chains) never run concurrently (`~/.dsh/wb2api/data/wb-tasks.lock`, expires after 20 minutes)

## Automation switches (current state)

| Entry point | State | Notes |
|---|---|---|
| Panel "一键做任务" button | **on** (the only automation entry) | Manual click, auto-claims when done |
| Auto check-in when the panel opens | on (once a day) | `WB2API_NO_AUTO_ACTIVITY=1` disables it |
| Windows scheduled tasks | **all removed** | `wb2api-tasks-night` / `-dawn` / `dsh-wb2api-daily` are gone |
| Your own check-in schedule (e.g. 08:30 hitting `/checkin`) | kept | Check-in + claim finished tasks only, **never touches the engine** |

## Development: live copy vs this repo

| | Path | Notes |
|---|---|---|
| Live (what dsh actually loads) | `~/.dsh/plugins/dsh-plugin-wb2api-ui/` | Mounted through the profile's `link:` dependency; **only changes here affect a running dsh** (the host half still needs a restart) |
| Live (gateway runtime) | `~/.dsh/wb2api/` | `config.json` / `auths/` / `data/` |
| This repo | `<wherever you cloned it>` | The publishable copy (engine, docs, packaging included) |

Engine lookup order (`resolveTasksEngine()` in `lib/index.js`): `WB_TASKS_ENGINE` env var → **in-package
`engine/wb_up/run.mjs`**. The in-package copy ships with the plugin, so it works wherever it lands; set
`WB_TASKS_ENGINE` to use a different engine.

Sync:

```powershell
pwsh -File sync.ps1                  # default: live → archive (run this after editing live)
pwsh -File sync.ps1 -Direction push  # archive → live (restart dsh for the host half)
pwsh -File sync.ps1 -WhatIfOnly      # show what would move
```

> `accessToken` / `refreshToken` in `auths/` and the gateway `config.json` `api_key` **never enter the repo**
> (`.gitignore` blocks them).

The browser half `client/client.js` is hot-swapped every 500ms — refresh the page. The host half `lib/index.js`
**requires a dsh restart**.

## Known pitfalls (all measured)

1. **No hot reload for the host half**: editing `lib/index.js` requires a dsh restart; until then new routes
   are 404 (GET) / 405 (POST).
2. **Upstream scoring is asynchronous**: after the behavior chain is reported, progress takes seconds to
   minutes to land → tasks must run **two passes**, and the second one is the claiming pass.
3. **Read-back budget**: pass criteria use a bounded poll of 4 × 3s; anything outside the window or under
   target is left to the next pass.
4. **Night-owl only scores between 23:00 and 08:00**: outside that window the button reports "not in window",
   which is not a failure.
5. **Expert chains cost real credits**: `expert_5` / `Expert_team_use_3` / `Expert_lighthouse` / `skill_1`
   each contain a real conversation; re-running burns quota — hence the single-flight lock
   (`~/.dsh/wb2api/data/wb-tasks.lock`, expires after 20 minutes).
6. **`auths/` must exist before the gateway starts**, otherwise it skips hot loading and never retries
   (restart the gateway after adding an account).
7. **Enabling/disabling an account means renaming the file suffix** (`workbuddy-<uid>.json.disabled`); the
   gateway globs `workbuddy*.json`. Stop the gateway first, or it will atomically write the credentials back
   to the old path and undo your rename.
8. **`$wbEncrypted` envelope**: desktop 5.6.0+ stores tokens as AES-256-GCM field envelopes.
   `tools/wb_import.mjs` asks the desktop executable for the key (`loggerGet()`) before decrypting; a
   signature mismatch means a keyId mismatch and it errors out rather than returning garbage.
9. **dsh version compatibility**: `dsh.client.inject` in `package.json` depends on dsh's client plugin
   contract (`dsh-client-connection / runtime / ui-settings / ui-slots / locale`) — re-check after a major
   upgrade.
10. **Provider id is unique**: two plugins registering the same provider id in one profile trigger
    `DUPLICATE_ADAPTER` and the host will not start.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| A button says the host half has not mounted the route | The host half loads only at dsh startup: restart dsh |
| "A task run is already in progress" | Single-flight lock: `~/.dsh/wb2api/data/wb-tasks.lock` (expires after 20 minutes; delete it once you confirm no process is running) |
| Pending confirmation works but "0 executed" | Normal: actions already done, or `black_cat` is outside 23:00–08:00 |
| A task's `progress_after` stays `not_accepted` | Asynchronous scoring has not landed: run one more pass (the second pass skips claimed tasks and tops up the rest) |
| 401 / "login expired" | That account's accessToken is dead: log in again in the desktop client and re-run `node tools/wb_import.mjs --write` |
| No model responses | Check `healthy` on `/healthz`: `healthy = 0` means no usable account (`/wb2api-login` to add one, or `/wb2api-account auto`) |
| Status says the gateway is running but no models | The probe only proves the port is open; `healthy` is what means an account is usable |
| dsh fails to start with `DUPLICATE_ADAPTER` | Two plugins in that profile register the same provider id; remove one and restart |

## Packaging and release

```powershell
npm pack                              # produce the tarball
git remote add origin https://github.com/Wei894348/dsh-wb2api.git
git branch -M main
git push -u origin main
```

Before uploading, check `git status`: it must **not** contain `auths/`, `config.json`, `*.log`, `*.tgz`, or
`node_modules/`.

## License

MIT — see [LICENSE](LICENSE).
