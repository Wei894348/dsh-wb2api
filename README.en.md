<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-plugin-wb2api-ui logo">
</p>

# dsh-plugin-wb2api-ui

[中文](README.md) | English

A DeepSeek Harness (dsh) plugin that turns your local WorkBuddy / CodeBuddy account pool into a local model gateway and registers it as a dsh LLM provider — pick the models directly inside dsh, with a settings panel for accounts and credits.

## Install

Pick one. **Restart dsh after installing** (the host side only loads plugins at startup).

### Option 1: Desktop UI (recommended)

Desktop app → Settings → Plugins → **Add Plugin**, enter:

```
https://github.com/Wei894348/dsh-wb2api
```

A local directory path or a `.tgz` tarball path (from `npm pack`) also works. This is the only way to install into the `desktop` profile (CLI cannot touch it).

### Option 2: Plugin marketplace

Search `wb2api` in the dsh plugin marketplace and click install.

### Option 3: Command line

```powershell
dsh plugin --profile web add github:Wei894348/dsh-wb2api
```

## Uninstall

- **Desktop**: Settings → Plugins → find this plugin → Uninstall
- **CLI**: `dsh plugin --profile web remove dsh-plugin-wb2api-ui`

Restart dsh afterwards. The runtime directory `%USERPROFILE%\.dsh\wb2api\` (account pool and config) is not removed by uninstall — delete it manually if you want a full cleanup.

## License

MIT, see [LICENSE](LICENSE).
