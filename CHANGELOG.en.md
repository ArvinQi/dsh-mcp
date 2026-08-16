# Changelog

**[简体中文](CHANGELOG.zh.md) | English**

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **JSON editor for the whole tool list**: a new "JSON tool editor" panel on Settings → MCP views and edits every MCP tool's enable switch as one JSON document grouped by server (`{ "server": { "tool": true/false } }`); Apply submits the whole switch set in a single call (new host `toolsSetJson` batch method) and refreshes the tool list automatically — no more per-tool clicking

## [1.3.0] - 2026-08-16

### Added

- **Windows working-directory support**: stdio servers now accept drive-letter absolute paths for `cwd` (e.g. `C:\Users\...`, `C:/...`), consistent with POSIX `/` and UNC `\\` paths (PR #2, thanks @coding-chong)

### Fixed

- Form operations now surface the real error: save / delete / test-connection failures show `code: message` (e.g. `MCP_SERVER_NAME_CONFLICT: serverName "x" is already used...`) instead of a generic message, making failures diagnosable
- Refresh is decoupled from save/delete: a `refresh()` failure no longer misreports the save/delete outcome — the editor stays open and shows the refresh failure reason (`refresh()` keeps its try/catch and returns a result)
- Removed the now-unused `failureLocaleKey` dead code (error display shows `code: message` directly)

## [1.2.0] - 2026-08-16

### Added

- **OAuth authentication**: `streamable-http` servers using MCP OAuth (authorization-code + PKCE) trigger browser authorization on connect; tokens are persisted (credentials document) and refreshed automatically by the SDK (auto-renewed while active within 24h) (`lib/oauth.js`)

### Fixed

- OAuth token credential-ref names collided with hyphens in server ids and failed credential validation (ref names only allow `[A-Za-z_][A-Za-z0-9_]*`): refs now use a sanitized server id plus a stable short hash, avoiding illegal characters and naming collisions
- The interactive OAuth probe budget was raised from 90 seconds to 5 minutes: the first authorization requires browser login/approval, and slower-than-90s flows caused the probe to time out and report a false failure (the authorization had actually succeeded and tokens were saved); now the test result appears automatically once authorization completes
- Disabled servers no longer render two "Disabled" badges (the phase badge plus a redundant caption)
- The settings page primary buttons (Add/Save) and the "Connecting" badge used theme tokens that do not exist in the web shell, breaking their text color: switched to the shell's real theme tokens (`--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-foreground` / `--dsw-alias-brand-primary`)

### Improved

- While testing a streamable-http server, a hint explains that a browser authorization page may open and the result refreshes automatically after it is completed
- After saving a server, the list refreshes itself on a delay so "Connecting" settles to "Connected" once the mount is live

## [1.1.0] - 2026-08-15

### Added

- **Tool-list stabilization**: during a same-connection re-sync (e.g. a `tools/list_changed` notification), unchanged MCP tools keep their existing registration instead of being disposed and re-registered, keeping the system-prompt tool list stable to preserve prompt-cache hits (vendored `lib/mcp-client.js` extension)

## [1.0.0] - 2026-08-15

First stable release.

### Added

- **Managed MCP server registry** (host half, `lib/index.js`):
  - Persistent server definitions (storage-domain `mcp_servers`)
  - Per-server `@deepseek-ai/dsh-mcp-client` mounts; tools registered as `mcp__<serverName>__<tool>`
  - Environment variable injection (plain values in the definition, secrets via the credentials document)
  - Connection probe (`test`)
- **Web settings page** (client half, `src/client/*`):
  - Settings → MCP: server list / create / edit / delete / test connection
  - Server-level enable/disable (tools unregister immediately when disabled)
  - Per-server refresh button (re-pulls server status and tool list)
- **Tool control**:
  - Injection modes: `search` (on-demand, default — the model hot-injects tools via `mcp_tool_search`) and `full` (inject every enabled tool each request)
  - Expandable per-server tool list, all checked by default; unchecking a tool keeps it out of injection, applied immediately
- **Remote self-mount**: the client half mounts the `mcpManager` Remote namespace itself via `ctx.remote.$mount()` in `apply()`, so no in-box package modification is required
- Zero npm runtime dependencies (`@deepseek-ai/*` resolve from the DSH profiles module fallback)
