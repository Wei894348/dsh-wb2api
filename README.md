<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-plugin-wb2api-ui logo">
</p>

# dsh-plugin-wb2api-ui

中文 | [English](README.en.md)

这是一个 DeepSeek Harness（dsh）插件：把本机 WorkBuddy / CodeBuddy 账号池变成一个本地模型网关，并注册为 dsh 的 LLM provider —— 装好后直接在 dsh 里选模型使用，附带一个设置面板管理账号与积分。

## 安装

任选其一。**装完必须重启 dsh**（宿主半侧只在启动时加载插件）。

### 方式一：dshmarket 插件市场（推荐）

打开 dsh 的插件市场（dshmarket），搜索 `wb2api` 或 `wb2api-ui`，找到本插件点 **安装** 即可。

### 方式二：桌面端 UI

桌面端设置 → 插件 → **添加插件**，输入：

```
https://github.com/Wei894348/dsh-wb2api
```

也可以填本地目录绝对路径或 `npm pack` 出来的 `.tgz` 压缩包路径。这是 `desktop` profile 唯一的安装方式（命令行碰不了桌面端）。

### 方式三：命令行

```powershell
dsh plugin --profile web add github:Wei894348/dsh-wb2api
```

## 卸载

- **桌面端**：设置 → 插件 → 找到本插件 → 卸载
- **命令行**：`dsh plugin --profile web remove dsh-plugin-wb2api-ui`

卸完重启 dsh。运行目录 `%USERPROFILE%\.dsh\wb2api\`（账号池与配置）不随卸载删除，要彻底清掉需手动删这一层。

## 许可

MIT，见 [LICENSE](LICENSE)。
