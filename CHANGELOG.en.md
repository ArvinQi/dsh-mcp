# Changelog

**[简体中文](CHANGELOG.zh.md) | English**

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.0] - 2026-08-28

### Added

- **Tool-list stability (better prompt-cache hits)**: tool schemas are canonicalized (recursive key sorting) before registration, so servers reordering schema keys no longer triggers dispose/re-register churn; MCP tools in the system prompt are rendered in stable name order, so the same tool set renders byte-identically no matter the hot-set or `tools/list` order

## [1.8.0] - 2026-08-27

### Added

- **OAuth authorization UX**: mounts no longer open the browser (they fail with guidance when authorization is needed; only Test connection auto-opens the browser); tool calls with a missing/expired token return a **clickable authorization link** (a background callback listener on the stable port completes the flow; concurrent calls reuse the same pending flow); a global authorization queue keeps at most one flow active at a time
- **Mount failure now carries an authorization link**: when a mount needs OAuth authorization, the failure message includes a **clickable authorization link**; once the user opens it, the tokens are stored automatically — no manual trip to the settings page
- **New `allowBrowserOnMount` config**: `false` by default (mounts never pop the browser); set it to `true` to restore the legacy behavior (mounts open the browser for authorization). Configure it under the dsh-mcp entry in the profile's `cordis.patch.yml`
- **stdio form argument input**: arguments now parse shell-style (space/newline separated, with quote, escape, and explicit empty-argument support) so a command line pastes directly; the args box shows a live parsed-argument preview so split mistakes surface before saving

### Fixed

- **OAuth authorization link was dropped from the mount failure message**: the underlying connect error (including the authorization link) used to be folded into `cause`, while the mount failure view only showed the message; the detail is now folded into the message
- **Tools did not register automatically after OAuth authorization**: saving tokens now remounts every enabled server of that name by serverName, so tools appear without a manual refresh or restart (the listener previously subscribed to a credential event name the service never dispatches, so the remount never ran; fixed)
- **Callback-port conflict crashed the Host**: all authorization flows now share one deduplicated per-server loopback listener and every listen has an error handler — an `EADDRINUSE` can no longer crash the DSH process
- **Wrong `resource` parameter in the authorization link**: the link used to serialize `resource=undefined`, which the authorization server rejects; it now passes a URL object (preferring the protected-resource metadata's resource)
- **stdio working-directory pitfall**: the form now explains that an empty cwd inherits the Host working directory and that a pnpm workspace there can make npx and similar commands resolve the wrong local package; the hint carries no concrete path, leaving the value to the user

## [1.7.0] - 2026-08-21

### Added

- **JSON config editor switched to key-value format**: server configs are shown/edited as a JSON object keyed by server name (`{ "server": { "type": "streamable_http", "url": ..., "headers": {...}, "disabled": false } }`) instead of the previous array; `type` is `streamable_http` or `stdio`, `disabled: true` disables the server

### Fixed

- **MCP image admission diagnostics no longer misreport failures**: distinguish image count, batch/per-image byte, MIME, Base64, raster format, decoded-pixel, and maximum-dimension limits; unknown admission errors use a fixed diagnostic so valid-but-oversized images are not reported as invalid image data and attachment storage internals are not leaked (PR #5, thanks @coding-chong)
- The publish workflow now runs `npm test` (image-projection regression) before syntax checks and publishing

## [1.6.0] - 2026-08-17

### Added

- **MCP tool image results**: image content blocks returned by MCP tools are projected through the attachment service into model image context, with strict type/size/count preflight and degraded text fallbacks; non-image content (audio/resource etc.) gets bounded text fallbacks (PR #4, thanks @coding-chong)

## [1.5.0] - 2026-08-17

### Added

- **Process env vars now prefer process.env by name**: when a variable exists in process.env its value is used verbatim (name unchanged) and stored values act as fallback; the UI is unchanged (value input and secret retained), and non-secret variables display the process.env value

### Fixed

- **OAuth authorization page rejected with `redirect_uri_mismatch`**: the loopback port used to be random per process while the persisted OAuth client's `redirect_uris` are fixed at registration — after a restart the new callback address no longer matched, so the CAS server refused authorization. Fixed by deriving a stable port from the server name and validating in `clientInformation()` that the persisted client's `redirect_uris` cover the current callback, dropping it (and re-registering) otherwise
- **OAuth silently failed to connect with an expired token** (no browser authorization): when the access token expired and the refresh token was also dead, the SDK threw `InvalidTokenError` without retrying, so the connection just failed. The provider's `tokens()` now reads the JWT `exp` claim and clears expired credentials, letting the SDK fall through to a fresh browser authorization flow
- **OAuth token exchange failed with `code, code_verifier, client_id, redirect_uri are required`**: when the client was loaded from persistence the in-memory closure was null, so the token request lacked `client_id`. The exchange now reads client info and code verifier through the provider accessors (memory first, persistence fallback)
- **OAuth concurrent authorization port collision**: with a stable callback port, a mount and a test connection authorizing at the same time collided on the port (EADDRINUSE). Authorization flows are now serialized per server
- **Env-variable secret values were not persisted**: the editor dropped the value for secret rows. Filled values are now submitted (secret values go to the credentials document); a blank value keeps the stored one

## [1.4.0] - 2026-08-16

### Added

- **Process-level environment variables**: a new "Process env vars" section on Settings → MCP holds a global key-value list shared by every server (expanded by default, with batch-add and a load-failure retry); secret values are stored in the credentials document, a blank value keeps the stored one
- **Header env substitution**: `streamable-http` header values support `${ENV}` placeholders and bare variable names, resolved at connect time from the server's configured env (including secrets from the credentials document), the process-level env table, or the process environment (e.g. `Authorization: Bearer ${TOKEN}`); unmatched placeholders stay literal so a missing variable never silently empties a header
- **JSON editor for the whole MCP server list**: a new "JSON config editor" panel on Settings → MCP views and edits every server definition as one JSON array (serverName / transport / enabled / url / command / args / cwd / headers / timeout / failOnStartupError / env); applying replaces the whole list — listed servers are created or updated, existing servers absent from the document are removed (new host `upsertJson` batch method; Apply saves directly), and the server list and tool list refresh automatically afterwards
- **Page layout**: injection mode on top → env-vars module (expanded by default) → MCP config module; the add/edit server form renders inline above the list or below the edited row (the list stays visible); opening the JSON config panel hides the UI list and applying it restores the list
- **The server form no longer edits env vars** (managed by the process-level module): saving submits no env and leaves existing server env untouched (the JSON config editor can still replace env wholesale, including stdio child injection)
- The server list (`list`) now returns non-secret env values with each server so they round-trip through the JSON editor; secret values still live only in the credentials document (exported as a `configured` flag; a blank value keeps the stored one)

### Fixed

- **OAuth no longer re-authorizes after a token refresh fails** (after a JSON save / restart, OAuth servers failed to connect without opening the browser): the OAuth client (client_id) was never persisted — every process re-registered a fresh client, so token refresh was rejected by the server with `client_id mismatch`, and the SDK-required `invalidateCredentials` was missing so the stale token could not be cleared and the retry kept failing. Fixed by persisting the client info alongside the tokens (credentials document) and implementing `invalidateCredentials`, so an unrecoverable failure now starts a fresh browser authorization flow
- **Form save/test failed with "env is not iterable" when no env was submitted**: the host now guards every `request.env` iteration with `?? []` (omitted env keeps the stored one)
- **List state did not refresh after applying JSON**: mounting is asynchronous, so the apply now refreshes immediately and again at 2s/6s, settling "Connecting" into "Connected"

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
