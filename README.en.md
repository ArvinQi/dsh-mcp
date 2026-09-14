# dsh-mcp — MCP management UI + tool search: stable tool list, cache hits, no context bloat

[![dshfind](https://dshfind.com/api/badge/ArvinQi/dsh-mcp?lang=en)](https://dshfind.com/en/plugins/ArvinQi/dsh-mcp?ref=badge)

![Settings preview](static/snapshot.en.webp)

## Why dsh-mcp?

**Problems it solves:**

- **Full tool injection burns tokens**: with multiple MCP servers, the tool count can reach hundreds, and injecting all of them every request is expensive. The `search` mode lets the model hot-inject only the tools it needs via `mcp_tool_search`, saving tokens at scale.
- **Re-syncs churn the tool list and break caches**: `tools/list_changed` notifications dispose and re-register same-named tools, jittering the system-prompt tool list and constantly invalidating the prompt cache. Tool-list stabilization keeps unchanged tools registered, maximizing cache hits.
- **No visual management entry**: server config, enable/disable, and tool toggles used to require editing files by hand. Settings → MCP brings everything into one UI.

**Highlights:**

- **Visual management**: server list / create / edit / delete / test connection / enable-disable / refresh, all in the UI
- **Process-level environment variables**: a global key-value list (expanded by default, batch-add supported); header values can reference a variable by bare name or `${NAME}` and are substituted at connect time (e.g. `Authorization: Bearer ${TOKEN}`)
- **Whole-list JSON config**: the "JSON config editor" panel views/edits every server as one JSON array; applying saves immediately (create/update/delete)
- **Fine-grained tool control**: expand each server to see its tools, all checked by default; uncheck to load only what you need
- **Image result passthrough**: images returned by MCP tools (screenshots/charts) are projected through the attachment service into model image context, with strict preflight and bounded fallbacks (PR #4)
- **Two injection modes**: `search` (on-demand, token-saving) and `full` (inject everything)
- **Zero npm dependencies**: plugs into DeepSeek Harness internals, install and go
- **OAuth authentication**: for `streamable-http` servers using MCP OAuth (authorization-code + PKCE), the browser opens automatically for authorization on connect; tokens and OAuth client info are persisted and refreshed automatically by the SDK (auto-renewed while active within 24h), with automatic re-authorization after expiry
- **Three install paths**: npm / GitHub git source / local link; bilingual UI and docs

Migrated and merged from uncommitted MCP work in the `deepseek-harness` repository:

| Original package | Migrated to |
|---|---|
| `packages/mcp/mcp-manager` (host registry) | `lib/index.js` (host half) |
| `packages/client/ui-settings-mcp` (settings UI) | `src/client/*` → `lib/client.js` (browser half) |
| `packages/bundle/web-mcp` (bundle assembly) | single row registered via `cordis.patch.yml` |
| `packages/mcp/mcp-client/src/probe.ts` + `transport.ts` | `lib/probe.js` + `lib/transport.js` (vendored; no in-box changes) |

## Features

- **Managed MCP server registry** (host): persistent definitions (storage-domain `mcp_servers`), per-server
  `@deepseek-ai/dsh-mcp-client` mounts, environment variable injection (plain values in the definition, secrets via credentials),
  connection probe (`test`).
- **Web settings page** (client): Settings → MCP — list / edit / delete / test servers.
- **Server-level enable/disable**: disabling a server unmounts it and unregisters its tools immediately.
- **Per-server refresh** button: re-pulls server status and tool list.
- **Tool control**:
  - Injection mode: `search` (on-demand, default — the model hot-injects tools via `mcp_tool_search`) and `full` (inject every enabled tool each request).
  - Expandable per-server tool list, all checked by default; unchecking a tool keeps it out of injection. Changes take effect immediately.
- **OAuth authentication** (host, `lib/oauth.js`): on a 401 + OAuth challenge from a `streamable-http`
  server, runs the authorization-code + PKCE flow automatically — opens the browser, receives the
  callback on a loopback server, persists tokens, and refreshes them on demand; test connection and
  mounts share the same token.
- **Remote self-mount**: the client half mounts the `mcpManager` Remote namespace itself via `ctx.remote.$mount()` in `apply()`,
  so no in-box package modification is required.
- **Declared servers are read too** (host, `lib/cordis-servers.js`): `@deepseek-ai/dsh-mcp-client` rows
  declared in the patch layers are listed read-only on the Settings page (see below).
- Zero npm runtime dependencies (`@deepseek-ai/*` resolve from the DSH profiles module fallback).

### Declared servers (`cordis.patch.yml`) and precedence

DSH can declare MCP servers directly in the composition: **one row per server**, `name: '@deepseek-ai/dsh-mcp-client'`,
in the profile layer `$DSH_HOME/profiles/<profile>/cordis.patch.yml` or the machine-wide layer
`$DSH_HOME/cordis.patch.yml` (machine-wide applies to every profile and overrides the profile layer per row id).

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio          # or streamable-http
        serverName: github
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
```

Since 1.11.0 those declarations appear in Settings → MCP, badged "cordis declaration", read-only, with the file they came from:

- **Declarations win**: when a `serverName` is already declared (and not `disabled`), the manager does not mount the same-named stored row — two mounts under one name collide in the tool registry and roll back that server's whole generation; the page explains the conflict.
- **Read-only**: declared servers cannot be enabled/disabled or edited here; edit `cordis.patch.yml` instead (`web`/`desktop` reload live; `headless`/`sdk` apply it on the next start).
- **Imported into storages as mirrors**: at startup and on every refresh the declarations are imported into the storage domain (id `cordis:<rowId>`, with `origin/declaredIn/declaredRowId`), **import only** — a row created in the plugin is never overwritten; a mirror whose declaration disappeared is **removed automatically** (a mirror is only a copy of a declaration, so an ownerless one must not pile up); a declaration containing a `!!js` expression is skipped and flagged with the reason (its value only resolves inside the Loader). Mirrors are never mounted — the composition owns the mount.
- **Take over / give back**: clicking "Take over" makes the plugin write an id-targeted `disabled: true` into its own **managed block** in `cordis.patch.yml` (a `.dsh-mcp.bak` backup is taken before the first write; atomic, idempotent, reversible, confined to that block). The declaration releases the `serverName` and the plugin mounts its own row instead — enabling **OAuth authorization, managed credentials, `${VAR}` header substitution and connection tests**. A hard mount failure rolls back automatically (the block is removed and the row returns to mirror state) and reports why; "Give back" hands the mount back to the declaration and deletes the managed row. A declaration without an explicit `id`, or one containing a `!!js` expression, cannot be taken over.
- **OAuth / placeholder limit (`needsPlugin`)**: a declaration can carry neither an OAuth provider nor `${VAR}` / bare-name placeholder substitution — only the plugin does those. Such a declaration can therefore only work while the plugin owns the mount: the page reports it as **failed with the reason** (not "connecting"), "Give back" makes its tools disappear (the confirmation and the result warning both say so), and taking it over again restores them.
- **OAuth is an explicit switch (since 1.11.1)**: an OAuth provider is attached only when the server sets `oauth: true` (the form's "Use OAuth authorization" checkbox, off by default). **Do not tick it for servers that authenticate with static tokens or custom headers** — otherwise a 401 is treated as an OAuth challenge and the plugin keeps opening the browser (with its `127.0.0.1:<port>/callback` loopback listener). The plugin also opens the browser **at most once per server per process**; later automatic attempts return the authorization-link error, and "Test connection" can still start one on demand. Upgrading migrates automatically from existing OAuth credentials, so servers that genuinely need OAuth are unaffected.
- **Safe degradation when the hot reload does not commit**: if the native tools have not unregistered within 5 seconds of writing the disable block (that profile's patch hot reload did not commit — a sibling entry failing its re-apply rolls the whole generation back), the plugin **registers the takeover without mounting** (the managed row is marked `pendingTakeover`); the next dsh start mounts it, and "Give back" reports the same need for a restart. A mount is also always skipped when same-named `mcp__<server>__` tools already exist without a local mount, so the plugin never fights a still-mounted declaration for one name.
- **Tool search covers them**: search/hot injection and per-tool switches work by `mcp__` prefix across the whole tool set, so declared tools need no extra configuration.

## Structure

```
dsh-mcp/
├── package.json          name=dsh-mcp; dsh.client declaration; zero npm dependencies
├── lib/
│   ├── index.js          host half (McpManagerService, built from mcp-manager)
│   ├── cordis-servers.js reads natively declared MCP servers from the patch layers (1.11.0)
│   ├── patch-writer.js   managed-block writer: disables a declaration on takeover (backup/atomic/idempotent)
│   ├── mcp-client.js     vendored MCP client (from @deepseek-ai/dsh-mcp-client, with tool-list stability extension)
│   ├── oauth.js          MCP OAuth client provider (authorization-code + PKCE, loopback callback, token persistence)
│   ├── probe.js          vendored connection probe (from mcp-client/src/probe.ts)
│   ├── transport.js      vendored transport factory (from mcp-client/src/transport.ts)
│   └── client.js         browser half (esbuild bundle, ModuleLoader wire format)
├── src/client/           browser half source (TSX + CSS Modules + local types + remote-contribution)
└── scripts/build.mjs     build script (esbuild resolved from a DSH checkout, see below)
```

## Build

```sh
node scripts/build.mjs
```

- esbuild is resolved from a DSH source checkout: `$DSH_SOURCE`, or `~/.dsh/source/current` when unset.
- Runtime dependencies (`@deepseek-ai/*`, `zod`, `@modelcontextprotocol/sdk`) are not installed as npm packages;
  they resolve from `$DSH_HOME/profiles/node_modules` (DSH profiles module fallback, `$DSH_HOME` defaults to `~/.dsh`);
  the build points `nodePaths` at the same directory.
- CSS Modules are handled by an esbuild onLoad plugin: styles are injected into a
  `<style data-plugin="dsh-mcp" data-file="…">` tag, and the module default-exports an identity class-name map.

## Test

```sh
npm test
```

- `npm test` adapts to the environment: the files that import the DSH module closure
  (`@deepseek-ai/*`, `js-yaml`) — `cordis-servers`, `patch-writer`, `takeover` — are **skipped when
  no local DSH installation resolves** (as in public CI), while a local checkout with the profile's
  `node_modules` in reach runs the whole suite; the run says which files it skipped.
- When you add a test file that needs the DSH closure, add it to `NEEDS_DSH_CLOSURE` in
  `scripts/test.mjs`.

## Install & Usage

### 1. Install

**Option 1: npm (after publishing)**

```sh
dsh plugin --profile web add dsh-mcp
```

**Option 2: GitHub git source**

```sh
dsh plugin --profile web add github:ArvinQi/dsh-mcp
# or
dsh plugin --profile web add git+https://github.com/ArvinQi/dsh-mcp.git
```

**Option 3: local development (link)**

```sh
dsh plugin --profile web add link:<absolute path to this repo>
```

> Note: with a local `link:` install, the plugin directory needs a `node_modules -> $DSH_HOME/profiles/node_modules`
> symlink (development-only, not committed); otherwise the linked symlink is realpath-resolved and `@deepseek-ai/*`
> cannot be resolved.

### 2. Registration (all install options)

Append to `$DSH_HOME/profiles/web/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`):

```yaml
- insert:
    - id: dsh-mcp
      name: dsh-mcp
```

> ⚠️ **This step is mandatory**: dsh-mcp does not declare `dsh.bundle`, so `dsh plugin add` only
> installs the package into the profile — **it does not activate the plugin**. Without the
> registration row the plugin never mounts.

Then **restart `dsh web`** and **hard-refresh the browser** (`Cmd/Ctrl + Shift + R`):

> ⚠️ **Both the restart and the hard refresh are required**:
> - The settings page (client half) needs the **client roster**, and roster changes only take
>   effect after **restarting `dsh web`** (refreshing the browser alone is not enough);
> - After the restart you must **hard-refresh** (`Cmd/Ctrl + Shift + R`) — a normal reload may
>   keep serving the cached old page.

### 3. Usage

**Open the management page**: after restart, open DSH Web → **Settings → MCP**.

### 4. Troubleshooting

**Q1: No "MCP" entry in Settings after installing?**

Check in order:

1. **Is the plugin registered?** Confirm `$DSH_HOME/profiles/web/cordis.patch.yml` has the
   `- insert: [{ id: dsh-mcp, name: dsh-mcp }]` row (`id`/`name` must exactly match the package
   name `dsh-mcp`). `dsh plugin add` does not equal activation — **without the registration row
   the plugin never mounts**.
2. **Did you restart `dsh web`?** Refreshing the browser is not enough — the settings entry comes
   from the client roster, and roster changes require **restarting the process**.
3. **Did you hard-refresh the browser?** After the restart use `Cmd/Ctrl + Shift + R`
   (Windows/Linux: `Ctrl + Shift + R`); a plain `F5` may load a cached old page.
4. **Is it installed in the right profile?** Make sure both the install and the registration use
   the `web` profile (`dsh plugin --profile web add dsh-mcp` +
   `$DSH_HOME/profiles/web/cordis.patch.yml`); other profiles have their own settings pages.
5. **Is it the latest version?** npm metadata caching can pin an old version; force the version
   with `dsh plugin --profile web add dsh-mcp@latest` (or `@1.8.0`).

**Q2: "MCP" is visible but the server list is empty or errors?**

- Check the `dsh web` process log for `mcp-manager` initialization errors;
- After upgrading the plugin, restart and **hard-refresh** so the old client bundle does not
  mix with the new host (typical symptom: `client api: ... 404` or `env is not iterable` — both
  come from mixing versions);
- An error shaped like `transport failure for /api/mcpManager/list: HTTP 404` means the host did
  not register the `mcpManager` service: usually the plugin host half is not active (missing
  cordis.patch.yml row / wrong profile) or the client and host versions disagree. Verify the
  registration row per Q1, confirm the install targets the `web` profile, restart, and
  hard-refresh; if it persists, upgrade both `dsh web` and the plugin to the latest versions.

**Q3: MCP tools do not show up in an agent session?**

- Make sure the server status is "Connected" and its tools are checked (all checked by default);
- In "On-demand search" mode the model discovers tools via `mcp_tool_search` and hot-injects them,
  so tools not searched are absent from the system prompt by design; switch to "Full injection"
  to verify.

**Q4: A server with an `Authorization` header still asks for OAuth / fails to mount?**

- When an `Authorization` (static bearer/token) header is configured, dsh-mcp does NOT treat the
  server as OAuth: the authorization-code + PKCE flow is enabled only for servers WITHOUT a static
  `Authorization` header, so a 401 is never mistaken for an OAuth challenge that opens the browser.
  For a static-token server, make sure the request headers are correct;
- If an HTTPS intranet host reports `fetch failed` / `unable to verify the first certificate`, the
  host Node does not trust the internal CA: start `dsh web` with `NODE_OPTIONS=--use-system-ca`
  (or add the root cert to `NODE_EXTRA_CA_CERTS`), then restart the host and hard-refresh.

**Add a server**:

1. Click **Add server** (the form expands inline above the list).
2. Fill in: server name (`serverName`, determines the tool prefix `mcp__<serverName>__`), transport
   (`streamable-http` → URL / `stdio` → command), headers, tool-call timeout, etc.
3. Click **Test connection** to verify connectivity and the tool list, then **Save**.

**Process env vars** (below the injection mode, expanded by default):

- Configure global key-value pairs referenced by every server's header substitution;
  secret values are stored in the credentials document, a blank value keeps the stored one
- **process.env wins**: if a variable already exists in the process environment (`process.env`)
  under the same name, that value is used verbatim (name unchanged) at connect/display time and
  stored values only act as fallback — export it in your startup script first
  (e.g. `export ADA_TOKEN=...`) then restart `dsh web`
- Batch-add (paste one `NAME=value` per line) or add rows one by one
- A header value can reference a variable by **bare name** or **`${NAME}`** (e.g. `Authorization: Bearer ${GITLAB_TOKEN}`),
  substituted at connect time (priority: server env > process-level env > system environment)

**JSON config editor** (top-right of the MCP config module):

- View/edit every server definition as one JSON array; applying replaces the whole list
  (create/update/delete) and refreshes the list and tool list automatically;
  the UI list is hidden while the JSON panel is open and restored after applying
- Server-level env (secret flags and stdio child injection) is still maintained through the JSON editor

**OAuth servers** (`streamable-http` using MCP OAuth, e.g. OAuth-protected gateway services):

- Just fill in the URL and test the connection; when the server responds with a 401 + OAuth challenge,
  the plugin **opens the browser automatically** for authorization.
- Log in / approve in the browser and return to DSH; the test result refreshes automatically
  ("connection succeeded + tool count").
- Tokens and the registered OAuth client are persisted in the credentials document (scoped by `serverName`)
  and refreshed automatically by the MCP SDK (auto-renewed while active within 24h); after authorizing once,
  mounts and later test connections reuse the same token, and an expired token triggers a fresh
  browser authorization automatically.
- The first authorization needs browser interaction, so the test/connect wait budget is relaxed to
  5 minutes; non-OAuth servers are unaffected and fail fast.

**Day-to-day management**:

- **Enable / disable**: row button; disabling a server unregisters all of its tools immediately.
- **Refresh**: re-pulls server status and the tool list (syncs new tools after a server restart).
- **Test connection**: available in the edit form at any time.

**Tool control (the key to saving tokens)**:

- **Injection mode**: switch at the top of the page between `search` (on-demand, default) and `full` (inject everything).
  - In `search` mode, the model calls `mcp_tool_search` to discover and hot-inject the MCP tools it needs.
- **Tool toggles**: click **Expand tools** to see all tools of that server (all checked by default);
  unchecking a tool keeps it out of injection, applied immediately without saving.

**Verifying the effect**:

- In any agent session, available tools include `mcp__<serverName>__<tool>`.
- In `search` mode, tools not retrieved stay out of the system prompt, saving tokens and improving
  prompt-cache hit rate.
- When tool content is unchanged, `list_changed` notifications no longer dispose and re-register
  same-named tools, keeping the tool list stable.

## Versioning notes

- The host half `lib/index.js` is a **build artifact** of mcp-manager (spec/types inlined); edit the lib files
  directly, or rebuild from TypeScript with the repository toolchain.
- After changing `src/client/*`, re-run `node scripts/build.mjs`; host-half changes take effect without
  reinstalling (link install).
- Configuration changes (bundle additions/removals, new plugin rows) require restarting `dsh web` to enter
  the client roster.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Released under the [MIT License](LICENSE).

[![dshfind](https://dshfind.com/api/card/ArvinQi/dsh-mcp?lang=en)](https://dshfind.com/en/plugins/ArvinQi/dsh-mcp?ref=badge)
