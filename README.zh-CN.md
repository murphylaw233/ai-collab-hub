> [English](README.md) | **简体中文**

# AI Collab Hub

本地 AI 协作桥接器，将 **Antigravity**（桌面端与 Remote Control PWA）以及 **Gemini App**（网页端与手机端 Custom Connected Apps）接入本机的 **OpenAI Codex**（`codex app-server`），提供共享 SQLite 任务与审计存储、受控项目文件沙箱、实时监视台与仅限本地人工确认的 L2 安全审批。

> **平台说明（Windows 优先）：** 核心 Node.js 24+ 服务端基本跨平台，但内置的开机自启/启停脚本（`scripts/*.ps1`）、PowerShell UTF-8 环境默认配置以及进程树清理（`taskkill.exe`）针对 **Windows** 构建。macOS 与 Linux 用户可通过 `npm start` / `npm run start:dist` 手动运行核心服务。

## 核心特性

- **双端口安全隔离（`127.0.0.1:3789` vs `127.0.0.1:3790`）**
  - **本地控制面（`3789`）**：监视与 L2 人工审批台（`/ui`）、本地 REST API（`/api/*`）、OAuth 紧急吊销接口（`POST /api/oauth/revoke-all`）与本地 MCP 端点（`/mcp/local`）。严禁暴露到公网。
  - **远程网关（`3790`）**：设计运行于 **Tailscale Funnel**（`https://<node>.<tailnet>.ts.net`）之后，提供 OAuth 2.1 + PKCE `S256` 端点（`/.well-known/*`、`/oauth/*`、RFC 7591 动态客户端注册）以及受认证的 Streamable HTTP MCP 端点（`/mcp/remote`）。
- **原生适配 Gemini App Connected Apps**
  - 支持 Gemini 多域名 DCR 回调批次（`oauth-redirect`、`oauth-redirect-sandbox`、`oauth-redirect-test`）、超长 `state` 参数、兼容 Chrome 多跳回调的 Consent CSP、Gemini 兼容的 32 位整数字段 Schema、`<15s` `codex_wait` 上限与 `afterSeq` 增量游标、合并流式事件摘要与多轮追问隔离。
- **Antigravity 插件与零 Token SSE 等待**
  - 内置 `plugin/ai-collab-hub/`（`AGENTS.md`、`collab-orchestrator`、`codex-collab`）与 `scripts/hub-wait-done.mjs`（零外部依赖的 SSE 等待脚本，支持单任务及多任务 `--mode=all|any`），让 Antigravity 提交任务后挂起等待，彻底避免轮询循环消耗上下文额度。
  - 支持仅限本地的动态项目注册与移除（`project_register` / `project_remove`，原子持久化至 `config/hub.json` 并热加载生效，无需重启 Hub；已从 `/mcp/remote` 隔离排除）。
- **仅限本地的 L2 人工审批与软超时保护**
  - 敏感命令/文件操作审批会暂停在 `WAITING_APPROVAL`，只能由用户在本地 Web 控制台（`http://127.0.0.1:3789/ui`）人工决定。
  - 状态中暴露 `contextUsage.pressure`，在接近硬超时（默认耗时 82%）时通过 `turn/steer` 发送收尾提醒，并在硬超时中断时保留已缓冲的中间诊断输出。

## 前置条件

- **Node.js 24+**（依赖内置 `node:sqlite`）与 **Git**
- **OpenAI Codex CLI** 已完成登录（`codex login status`）
- *（可选，仅接入 Gemini App 远程控制时需要）* 已启用 MagicDNS、HTTPS Certificates 与 Funnel 的 **Tailscale**，以及支持 **Connected Apps → Add a custom app** 的个人 Google 账号（需年满 18 岁且开启 **Keep Activity**；注意：目前 Gemini Task 模式下需在提示词中 `@你的自定义应用名`）。

## 快速开始

1. **安装依赖**
   ```powershell
   npm install
   ```

2. **初始化本地配置与 Antigravity 插件**
   ```powershell
   npm run setup:local
   ```
   该脚本会生成包含随机 `localToken` 的 `config/hub.json`（若已存在则保留原配置），并将 `plugin/ai-collab-hub/` 与 `scripts/hub-wait-done.mjs` 安装到 `~/.gemini/config/plugins/ai-collab-hub/`。

   你也可以手动将 `config/projects.example.json` 复制为 `config/hub.json`，设置强 `localToken`（或环境变量 `$env:HUB_LOCAL_TOKEN`），并按项目配置 `permissionMode`：
   - `read_only`：允许 `precheck`、`readonly_research` 以及只读 `fs_*` 工具
   - `docs_write`：`read_only` 加上仅限 `docsSubdir` 目录下的文档写入（`fs_write_doc`）
   - `codex_work`：允许 Codex 在 `execute` 模式下修改代码与运行测试

3. **构建并启动 Hub**
   ```powershell
   npm run build
   npm start
   ```
   - **监视与 L2 人工审批台**：`http://127.0.0.1:3789/ui`
   - **本地 Streamable HTTP MCP**：`http://127.0.0.1:3789/mcp/local`

## 接入任意 MCP 客户端（`/mcp/local`）

Antigravity 用户运行 `npm run setup:local` 即可完成自动配置。其他支持带 Bearer 请求头的 Streamable HTTP MCP 客户端（如 Claude Desktop、Cursor 等）可直接配置连接到 `/mcp/local`：

```json
{
  "mcpServers": {
    "ai-collab-hub": {
      "url": "http://127.0.0.1:3789/mcp/local",
      "headers": {
        "Authorization": "Bearer YOUR_HUB_LOCAL_TOKEN"
      }
    }
  }
}
```

## 接入 Gemini App（远程 MCP + OAuth 2.1）

请参考以下中文指南与设计文档（其中架构与契约文档目前为英文）：
- [docs/zh-CN/gemini-app-setup.md](docs/zh-CN/gemini-app-setup.md) — Tailscale Funnel（仅暴露 `3790`）、`config/hub.json` `"remote"` 配置、OAuth 2.1 授权与 `/api/oauth/revoke-all` 紧急吊销。
- [docs/zh-CN/gemini-gem-prompt.md](docs/zh-CN/gemini-gem-prompt.md) — 推荐的 Gemini 专用 Gem 指令模板（严谨派单与研究/执行分工）。
- [DESIGN.md](DESIGN.md) — 技术架构与设计说明（英文）。

## 在 Codex TUI 中接管任意会话

每个任务都会记录持久化的 `threadId`。在监视台或 MCP 返回中复制 `resumeCommand` 即可在终端接管：
```powershell
codex resume <threadId>
```

## Windows 开机自启（任务计划程序）

无需保持 IDE 或终端窗口开启，直接在 Windows 登录时后台拉起 `ai-collab-hub`：
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts/hub-ctl.ps1 -Action start
```
其他控制命令：`stop`、`restart`、`status`、`logs`。如需卸载计划任务，运行 `scripts/uninstall-autostart.ps1`。

## 开发与验证

```powershell
npm run typecheck
npm run build
npm test
npm run probe:codex:ws
```

如需在本地重新生成 Codex app-server 协议 TypeScript 类型参考（位于 `.gitignore` 忽略目录 `docs/codex-protocol/` 下）：
```powershell
npx codex app-server generate-ts --out docs/codex-protocol/ts
```

## 开源协议

[MIT](LICENSE)
