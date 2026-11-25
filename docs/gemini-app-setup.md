> **English** | [简体中文](zh-CN/gemini-app-setup.md)

# Gemini App (Web & Mobile) Remote Setup Guide

This guide explains how to expose `ai-collab-hub`'s remote MCP gateway (`/mcp/remote`) on Windows using **Tailscale Funnel (zero-server public HTTPS)** and built-in **OAuth 2.1**, and connect it to a personal Google account in **Gemini App** (once configured on Web, it syncs automatically to the iOS / Android Gemini apps).

---

## 1. Dual-Port Security Isolation

`ai-collab-hub` strictly separates the local control plane from the public remote gateway across two ports:

| Port | Bind Address | Exposure Scope | Purpose |
| :--- | :--- | :--- | :--- |
| **`3789`** | `127.0.0.1:3789` | **Localhost only (NEVER expose publicly)** | `/ui` Monitor & L2 human approval console, `/api/*` (including `/api/oauth/revoke-all` kill-switch), `/mcp/local` |
| **`3790`** | `127.0.0.1:3790` | **Exposed via Tailscale Funnel** | `/.well-known/*`, `/oauth/*`, `/mcp/remote` (Codex orchestration + guarded File Sandbox; `/ui` and `/api/*` always return `404`) |

> [!CAUTION]
> Only attach port **`3790`** to Tailscale Funnel. **Never** expose port `3789` to the public internet.

---

## 2. Prerequisites

1. Open `gemini.google.com` → **Settings → Connected Apps** and confirm **Add a custom app** is available on your personal Google account (requires an `18+` personal account with **Keep Activity** enabled).
2. Install and sign in to **Tailscale** on Windows:
   - Official download: <https://tailscale.com/download/windows>
   - In the [Tailscale Admin Console](https://login.tailscale.com/admin/):
     1. Enable **MagicDNS** and **HTTPS Certificates** under **DNS**.
     2. Ensure your device node has `funnel` permission in **Access Controls (ACL)**.
3. Check your machine's `*.ts.net` public hostname:
   ```powershell
   tailscale status
   ```

---

## 3. Configure `config/hub.json` and Start the Hub

Edit `config/hub.json` and add the `"remote"` section (replace the hostname and passphrase with your real values; **`ownerPassphrase` should be a strong passphrase of at least 12 characters**):

```json
{
  "host": "127.0.0.1",
  "port": 3789,
  "localToken": "keep-your-existing-localToken",
  "remote": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3790,
    "publicBaseUrl": "https://your-machine.your-tailnet.ts.net",
    "ownerPassphrase": "replace-with-a-strong-passphrase-12-plus-chars",
    "allowRemoteDocsWrite": false,
    "maxStateLength": 16384
  }
}
```

- By default, `allowRemoteDocsWrite` is `false`, restricting the remote MCP client to read-only file sandbox inspection (`fs_list_dir`, `fs_read_lines`, `fs_search`, `fs_git_diff`) and Codex orchestration. Set it to `true` if you want Gemini App to write markdown reports into a project's `docs/` subdirectory via `fs_write_doc`.
- Restart the Hub after saving the config:
  ```powershell
  npm start
  ```

---

## 4. Enable Tailscale Funnel (`3790` Only)

Open PowerShell **as Administrator** and map public HTTPS port `443` to local `127.0.0.1:3790`:

```powershell
tailscale funnel --bg --https=443 3790
tailscale funnel status
```

Verify that the public OAuth metadata endpoint responds:
```powershell
Invoke-RestMethod -Uri "https://your-machine.your-tailnet.ts.net/.well-known/oauth-protected-resource/mcp/remote"
```

To turn off remote exposure later:
```powershell
tailscale funnel --https=443 3790 off
```

---

## 5. Add the Custom MCP App in Gemini

1. Open **[gemini.google.com](https://gemini.google.com)** → **Settings → Connected Apps → Add a custom app**.
2. Enter your remote MCP URL:
   ```text
   https://your-machine.your-tailnet.ts.net/mcp/remote
   ```
3. Keep authentication set to **OAuth** (Dynamic Client Registration via RFC 7591 is built in and supports `state` tokens longer than 2,400 characters).
   - If automatic DCR fails, configure `remote.staticClient` in `config/hub.json` with a static `clientId`, `clientSecret`, and `redirectUris` (for example `["https://oauth-redirect.googleusercontent.com/", "https://vertexaisearch.cloud.google.com/oauth-redirect"]`), then enter the matching `Client ID` and `Client Secret` under Gemini's **Advanced features**.
4. When the browser opens the Hub's OAuth consent screen, enter the `ownerPassphrase` from `config/hub.json` and click **Approve**.
5. Once connected, open the **Gemini App** on Web or mobile (signed into the same Google account) and mention `@YourCustomApp` in your prompt to call `project_list`, `fs_list_dir`, `fs_read_lines`, `codex_submit`, and related tools (note: Gemini Task mode also requires explicitly mentioning `@YourCustomApp` so tools are attached).

---

## 6. Emergency Revocation & Security Notes

- **Revoke all remote OAuth tokens at once**: If you suspect a mobile token leak or want to cut off remote access immediately, run locally on the host:
  ```powershell
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3789/api/oauth/revoke-all" -Headers @{ "X-Requested-With" = "ai-collab-hub-ui" }
  ```
- **L2 human approvals stay desktop-only**: If a remotely submitted `execute` task triggers a sensitive command or file approval, it pauses in `WAITING_APPROVAL`. Open `http://127.0.0.1:3789/ui` on your local machine to approve or decline.
