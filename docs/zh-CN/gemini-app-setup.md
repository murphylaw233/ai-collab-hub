> [English](../gemini-app-setup.md) | **简体中文**

# Gemini App（网页与手机端）远程接入指南

本指南说明如何在 Windows 上通过 **Tailscale Funnel（零服务器公网 HTTPS）** 与内置 **OAuth 2.1**，将 `ai-collab-hub` 的远程 MCP 网关（`/mcp/remote`）接入个人 Google 账号下的 Gemini App（网页端配置后自动同步到 iOS / Android 手机端）。

---

## 一、双端口安全隔离原则

`ai-collab-hub` 严格将本地控制面与远程网关拆分为两个端口：

| 端口 | 绑定地址 | 暴露范围 | 包含功能 |
| :--- | :--- | :--- | :--- |
| **`3789`** | `127.0.0.1:3789` | **仅限本机（严禁暴露公网）** | `/ui` 监视与 L2 人工审批台、`/api/*`（含 `/api/oauth/revoke-all` 紧急吊销）、`/mcp/local` |
| **`3790`** | `127.0.0.1:3790` | **通过 Tailscale Funnel 暴露** | `/.well-known/*`、`/oauth/*`、`/mcp/remote`（Codex 编排 + 受控 File Sandbox；访问 `/ui` 或 `/api/*` 一律返回 `404`） |

> [!CAUTION]
> 只允许将 **`3790`** 挂到 Tailscale Funnel，**绝对不要**把 `3789` 暴露到公网。

---

## 二、前提条件检查

1. 在 `gemini.google.com` 打开 **Settings → Connected Apps**，确认当前个人 Google 账号能看到 **Add a custom app**（需 18+ 个人账号且开启 **Keep Activity**）。
2. 在 Windows 本机安装并登录 **Tailscale**：
   - 官方下载：<https://tailscale.com/download/windows>
   - 登录 [Tailscale Admin Console](https://login.tailscale.com/admin/)：
     1. 在 **DNS** 页面启用 **MagicDNS** 与 **HTTPS Certificates**。
     2. 在 **Access Controls (ACL)** 中确认当前设备节点拥有 `funnel` 权限。
3. 查看当前节点的 `*.ts.net` 公网域名：
   ```powershell
   tailscale status
   ```

---

## 三、配置 `config/hub.json` 并启动服务

编辑 `config/hub.json`，加入 `"remote"` 配置段（请将域名和口令替换为你的真实值，**`ownerPassphrase` 至少 12 位强口令**）：

```json
{
  "host": "127.0.0.1",
  "port": 3789,
  "localToken": "保留你现有的 localToken",
  "remote": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3790,
    "publicBaseUrl": "https://你的机器名.你的tailnet.ts.net",
    "ownerPassphrase": "请替换为至少12位以上的强授权口令",
    "allowRemoteDocsWrite": false,
    "maxStateLength": 16384
  }
}
```

- 默认 `allowRemoteDocsWrite` 为 `false`，此时远程端仅可读写目录列表/行读取/搜索/Git Diff（以及派发 Codex 任务），不能直接写文档；如需让 Gemini App 往项目 `docs/` 下落盘报告，可改为 `true`。
- 配置保存后重启 Hub：
  ```powershell
  npm start
  ```

---

## 四、开启 Tailscale Funnel（仅暴露 `3790`）

以**管理员权限**打开 PowerShell，将公网 HTTPS `443` 映射到本机 `127.0.0.1:3790`：

```powershell
tailscale funnel --bg --https=443 3790
tailscale funnel status
```

验证公网元数据端点可访问：
```powershell
Invoke-RestMethod -Uri "https://你的机器名.你的tailnet.ts.net/.well-known/oauth-protected-resource/mcp/remote"
```

如需关闭远程入口：
```powershell
tailscale funnel --https=443 3790 off
```

---

## 五、在 Gemini App 中添加自定义 MCP 应用

1. 在电脑浏览器打开 **[gemini.google.com](https://gemini.google.com)** → **Settings → Connected Apps → Add a custom app**。
2. 填入远程 MCP 地址：
   ```text
   https://你的机器名.你的tailnet.ts.net/mcp/remote
   ```
3. 认证方式保持 OAuth（动态客户端注册 DCR 已内置支持，兼容超过 2400 字符的 `state` 参数）。
   - 如果遇到自动 DCR 异常，可在 `config/hub.json` 的 `remote.staticClient` 中预置静态 `clientId`、`clientSecret` 和 `redirectUris`（例如 `["https://oauth-redirect.googleusercontent.com/", "https://vertexaisearch.cloud.google.com/oauth-redirect"]`），然后在 Gemini 的 **Advanced features** 中手动填入同一组 `Client ID` / `Client Secret`。
4. 浏览器弹出授权确认页时，输入你在 `config/hub.json` 设置的 `ownerPassphrase` 并点击 **Approve**。
5. 授权完成后，打开手机端 **Gemini App**（登录同一 Google 账号），在对话中 `@你的自定义应用名` 即可调用 `project_list`、`fs_list_dir`、`fs_read_lines`、`codex_submit` 等工具（注意：在 Gemini Task 模式下也需要在提示词里显式 `@你的自定义应用名` 才能正确挂载工具）。

---

## 六、应急吊销与安全建议

- **一键吊销所有远程 Token**：当怀疑手机端授权泄露或不再需要远程连接时，在本地执行（或于同源调试控制台中发送）：
  ```powershell
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3789/api/oauth/revoke-all" -Headers @{ "X-Requested-With" = "ai-collab-hub-ui" }
  ```
- **L2 人工审批仅限桌面端**：远程发起的 `execute` 任务若触发敏感命令/文件审批，会在 `WAITING_APPROVAL` 暂停，请在电脑打开 `http://127.0.0.1:3789/ui` 人工确认。
