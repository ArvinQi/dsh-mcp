# Changelog

**[简体中文](CHANGELOG.md) | English**

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Compatibility

- **Supported DSH version**: **dsh `0.2.0-rc.2`** — the latest release is developed and verified on `0.2.0-rc.2` (declared in `package.json` → `dsh.supported`); older entries state the version verified at their time. When the DSH and plugin versions do not match, the Settings page reports a diagnosis (check whether the bundle is selected → restart `dsh web` → hard-refresh → upgrade both sides).
- **Release convention**: every version entry states `- **Supported DSH version**: dsh <version>`, mirrored in the GitHub Release notes. The release body is written in **Chinese** (matching [CHANGELOG.md](CHANGELOG.md)), with heading levels mirroring the entry.

## [Unreleased]

- **Supported DSH version**: **dsh `0.2.0-rc.2`**

### Fixed

- **Authorization fails after the browser already reports success when the authorization server advertises RFC 9207 `iss` support but never sends `iss` ([#18](https://github.com/ArvinQi/dsh-mcp/issues/18))**: Notion's authorization-server metadata (`https://mcp.notion.com/.well-known/oauth-authorization-server`) says `authorization_response_iss_parameter_supported: true`, yet its real callback URL carries **no** `iss` parameter. MCP SDK 2.0.0's `validateAuthorizationResponseIssuer()` reads "advertised + absent" as an authorization-server mix-up attack and throws `IssuerMismatchError`, so the browser shows a successful authorization while the plugin reports `Issuer mismatch in authorization response (RFC 9207): expected "https://mcp.notion.com", received undefined` — with no way around it until the server fixes its metadata. Two changes in `lib/oauth.js`: (1) the `iss` from the callback URL is now handed to `exchangeAuthorization()` as-is — it used to be **dropped**, so the SDK only ever saw `undefined` and that was wrong in both directions: a server that advertises support *and* sends the correct `iss` was also rejected, while a **mix-up response carrying a wrong `iss` from a non-advertising server was silently accepted**; (2) only when the callback really carries no `iss` and the metadata claims support is that one claim removed (from a copy, so registration/authorization-URL construction see the original) before the token exchange, with one warning logged — RFC 9207 makes `iss` OPTIONAL, so an absent value is not by itself an attack signal, the advertisement is simply inaccurate for this response. A callback that does carry `iss` still goes through the SDK's strict string comparison and still throws on a mismatch. Both the settings-page / tool-auth callback listener and the legacy no-`serverUrl` fallback listener are fixed

### Notes

- Three regression cases added to `test/oauth-flow.test.mjs` (that file needs the DSH module closure, so it runs only where a DSH installation is present): (1) advertises support but sends no `iss` → authorizes (the #18 reproduction, which failed before the fix); (2) callback with the correct `iss` → authorizes (also failed before the fix: with the parameter dropped, validation saw `undefined`); (3) callback with a wrong `iss` → still rejected with `Issuer mismatch` and no tokens stored
- Host-side `lib/oauth.js` only: the client bundle `lib/client.js` and every Remote interface are untouched, so no rebuild is needed after upgrading

## [1.14.2] - 2026-10-29

- **Supported DSH version**: **dsh `0.2.0-rc.2`**

### Fixed

- **Windows OAuth authorization page never opens ([#16](https://github.com/ArvinQi/dsh-mcp/issues/16))**: `openBrowser` used to run `spawn("start", [url])` on Windows, but `start` is a `cmd.exe` builtin rather than an executable, so spawning it without a shell only ever produced `ENOENT` — and `child.on("error", () => {})` swallowed that error. The result was that on Windows the authorization page never opened and nothing was reported (both call sites in `lib/oauth.js`, `oauthStart` and `allowBrowserOnMount`, were affected). It now uses `rundll32.exe url.dll,FileProtocolHandler`, passing the authorization URL as **one untouched argument** with no shell involved, so `&` in the query string cannot split the command — which also avoids the command-injection surface of handing the URL back to a shell via `cmd /c start "" <url>`. The macOS (`open`) / Linux (`xdg-open`) openers and the best-effort semantics (error callback, `detached`, `unref`) are unchanged (PR [#17](https://github.com/ArvinQi/dsh-mcp/pull/17), thanks [@Nyarlathoteppppp](https://github.com/Nyarlathoteppppp))

### Notes

- New zero-dependency module `lib/browser-command.js`: `browserCommand(url, platform)` returns the "command + argument array" per platform, lifting "which program opens the URL" out of `openBrowser` so it can be asserted
- New `test/oauth-browser.test.mjs`: asserts that on win32 an authorization URL containing `&` is handed to `rundll32.exe url.dll,FileProtocolHandler` as a single argument, and that the darwin / linux commands are unchanged; the test does not need the DSH module closure, so it also runs in CI's `npm test` (unlike `oauth-flow.test.mjs`, which is skipped there)
- Only the host-side way of opening the browser changed: the client bundle `lib/client.js` and every Remote interface are untouched, so no rebuild is needed after upgrading

## [1.14.1] - 2026-10-20

- **Supported DSH version**: **dsh `0.2.0-rc.2`**

### Fixed

- **Plugin styles no longer leak into the host UI, and controls are styled by class only ([#14](https://github.com/ArvinQi/dsh-mcp/issues/14))**: `ServerForm.module.css` and `McpSettingsSection.module.css` each carried an unqualified `button { … }` rule, and several selectors ended in an element (`.field input`, `.row input`, `.actions button`, `.retryRow button`). The client stylesheets are injected into the host's `<head>` verbatim — the build's CSS Modules are an identity class map, not a scoping boundary — so those rules matched **every** matching element in the host page. The DSH composer's attach button (28×28, bottom-left) and send button (34×34, bottom-right) center their SVG with `display: grid; place-items: center` and declare no `padding` of their own; the leaked `padding: 5px 12px` shrank their content box from 16px / 22px to 4px / 10px, the 14px / 16px icon overflowed horizontally and was aligned to the start edge, so the icon drifted right inside the circle (measured +5.0 px and +3.0 px). **No style targets an element any more** (`button` / `input` / `select` / `textarea` / `label` / `p` are all gone): the base control styles now live in the new `src/client/controls.module.css` as classes — `.button` (with `:hover` / `:focus-visible` / `:disabled`), `.buttonSmall`, `.primary`, `.control` (shared by `<input>` / `<select>` / `<textarea>`), `.controlMono` and `.checkbox`. Components import that module for the class **names** only; their own sheets keep layout plus the `.active` / `.danger` / `.dangerButton` / `.moduleTitle` modifiers, all matched by class. Because an identity class map makes class names global, the shared classes are defined exactly once, in `controls.module.css`; specificity no longer needs tricks (the previous `:where()` wrappers are gone) — within that one sheet `.primary` follows `.button`, and the component sheets are injected after it

### Notes

- `test/client-style-scope.test.mjs` was rewritten: (1) every selector of `src/client/*.module.css` must be a pure class chain (an element selector, `*` or `:root` fails); (2) the bundle is loaded through the shell's loader wire format and the stylesheets it actually injects are checked the same way; (3) the shared classes must be defined once, `controls.module.css` must be injected first, and the `.primary` / `.buttonSmall` / `.controlMono` rules must follow their base classes; (4) every `<button>` in the `.tsx` sources must carry `controls.button` so a missed class cannot silently render an unstyled control. It fails against the pre-fix build
- `scripts/build.mjs` strips CSS comments before computing the identity class map, so class names mentioned only in a comment no longer become dead keys; the build header now states that injected styles are global, that every rule must be a pure class selector, and that shared control classes live in `controls.module.css`
- Only the client half changed (the host `lib/index.js` and all Remote interfaces are untouched), so upgrading the plugin and hard-refreshing the DSH page is enough to see the centered icons

## [1.14.0] - 2026-10-13

- **Supported DSH version**: **dsh `0.2.0-rc.2`**

### Changed

- **HTTPS servers are verified against the system trust store by default**: the host's `streamable-http` connections and its OAuth metadata discovery / dynamic registration / token exchange all went through Node's bundled root store, so intranet hosts (Ctrip Root CA, Zscaler/Sangfor proxy roots — CAs that only live in the OS keychain) failed with `fetch failed` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` unless `dsh web` was started with `NODE_OPTIONS=--use-system-ca` or `NODE_EXTRA_CA_CERTS`. The new `lib/system-ca.js` merges the operating system's roots into Node's default store at plugin start (`tls.getCACertificates('system')`, keeping every bundled root, idempotent), so HTTPS requests verify exactly what the OS trusts; on older hosts (Node < 24.9, no such API) it falls back to a scoped fetch bound to an undici Agent carrying the system roots. Neither path touches `http` servers or sites that were already trusted. Measured on the user's machine: 135 system roots are merged; and the DSH desktop runtime drops `NODE_OPTIONS` outright (`Node.js environment variables are disabled…`), so intranet HTTPS works exactly because of this merge — a server whose certificate is issued by `Ctrip Root Certificate Authority` connects without the variable
- **OAuth authorization is now a button plus 5s polling, and the Host opens the browser**: the server card shows an "Authorize" button when authorization is missing (new `oauthStart` / `oauthStatus` Remotes). Clicking it makes the **Host** open the authorization page in the system browser — a client-side `window.open` is denied inside the DSH shell and only flashes a blank tab, which was the "nothing happens" root cause. The row then shows "authorizing…" and polls the status every 5 seconds; once tokens land the existing `credentials/reference-updated` path remounts the server, the button disappears and the tools appear. Mounts and "Test connection" share one loopback flow (`createToolAuthorizationUrl` now dedupes concurrent requests per server)
- **The editor no longer carries its own authorization button**: the "open authorization page" button and link paragraph are gone (they cannot open in the shell and only added noise); the editor keeps the OAuth switch, a one-line hint and an "authorizing… / authorization complete" status, and "Test connection" remains its probe
- **The authorization outcome is visible**: the Host records the last flow's result per server, `oauthStatus` returns `pending` and `error` (the authorization server's `access_denied`, or a token-exchange failure), and the row renders "authorizing… / authorization failed: reason / authorization did not complete (retry)". The server view gained `oauthAuthorized` (list/upsert/adopt results) as the basis for the button and badge

### Fixed

- **No more "authorization failed" before the user authorized**: an OAuth server used to render a red "mount failed" with the raw error as soon as it needed authorization, and Test connection popped the browser and could block for up to 5 minutes. `test` no longer opens a browser or blocks for an OAuth server — it returns an `oauthRequired` marker immediately; the mount records `status.oauthRequired` from a provider callback before the error is thrown (the `mcp-client` wrapper replaces the error, so the flag must be set early); the page renders that as an "awaiting authorization" badge and a one-line hint
- **The loopback callback port no longer leaks, and a retry is no longer shadowed by a stale connection**: the callback answered with keep-alive, so `server.close()` waited for the connection to end and the next authorization on the same stable port could have its callback delivered to the previous (closed) listener — the new one never fired and the page polled forever. Callbacks now answer with `Connection: close` and are force-closed via `closeAllConnections()`; the regression test proves a deny-then-retry succeeds without leaving a listening port behind
- **A working OAuth server is no longer flagged as unauthorized**: a server that is `live` and serving tools (its static headers are enough) keeps its normal status badge and a plain "Authorize" button; the red "not authorized" badge/button and the hint are reserved for servers the missing authorization actually blocks
- **No more raw authorization-link text when authorization is missing**: the several-hundred-character authorization URL embedded in the mount error (it contains `response_type=code`) is recognized and reduced to a one-line "click Authorize to finish"; real failures still show their diagnostic text

### Notes

- Added `test/oauth-flow.test.mjs`: a built-in fake OAuth server (RFC 9728 resource metadata + RFC 8414 authorization-server metadata + registration/token endpoints, with `/mcp` always answering a 401 challenge) drives the real SDK flow, covering `oauthStart` payload validation and "the Host opens the browser", the `pending → authorized` poll, Test connection reporting `oauthRequired` instead of a failure, the mount's `status.oauthRequired`, and a deny (`access_denied`) followed by a successful retry that leaves no listening port behind
- Added `test/system-ca.test.mjs`: it mints a 127.0.0.1 self-signed certificate with openssl, serves HTTPS, and asserts that `fetch` fails before the merge and succeeds after while every bundled root survives (skipped without openssl or on Node < 24.9)
- Added `test/client-bundle.test.mjs`: it loads the built artifact through the shell's `__ModuleLoader__` wire format and asserts the exports plus the new copy/Remotes, so a stale `lib/client.js` fails the suite
- Verified live against a `dsh web` host (`web` profile): `mcpManager/oauthStart` and `oauthStatus` answer (`octop-memory-oauth: authorized:false`, `bigdata-adhoc-mcp-oauth: authorized:true`), `list` returns `oauthAuthorized`, and the served client bundle rev matches the repository build

## [1.13.0] - 2026-10-08

- **Supported DSH version**: **dsh `0.1.6-alpha.2`**

### Changed

- **The package declares `dsh.bundle`, so it now installs and enables as a bundle**: it declared none before, and the DSH Web plugin manager refused the install at the `not-a-bundle` branch of `plugin-manager.inspect()` — `dsh-mcp declares no dsh.bundle` (both registry and local-path sources are refused), while `dsh plugin add` merely installed the package as a plain profile dependency that still needed a hand-written `- insert: [{ id: dsh-mcp, name: dsh-mcp }]` row to take effect. `package.json` now declares `dsh.bundle.patch` → the package-root `cordis.patch.yml`: installing writes `dsh-mcp` into `dsh.profile.bundles` and that patch inserts the plugin row. `cordis.patch.yml` was added to `files` so it ships in the tarball
- **The registration row moved into the package; the user patch layers only override config**: `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (profile layer) and `$DSH_HOME/cordis.patch.yml` (machine layer) no longer insert the same id — they use an id-targeted entry to override `config` (`probeTimeoutMs` / `allowBrowserOnMount`), because one row id declared by two layers makes the loader fail to compose. Both READMEs' install, registration and troubleshooting sections were rewritten accordingly, and now state that the in-package bundle patch and the profile patch used for declared servers are two different files

### Notes

- Added `test/bundle-manifest.test.mjs`: it asserts the manifest declares `dsh.bundle.patch`, that the referenced patch exists and is listed in `files`, and that the patch parses to exactly one inserted row `{ id: dsh-mcp, name: dsh-mcp }` (`js-yaml` parses it; environments without the DSH module closure skip only that subtest)

## [1.12.1] - 2026-10-07

- **Supported DSH version**: **dsh `0.1.6-alpha.2`**

### Fixed

- **stdio servers now actually receive the process-level environment variables ([#11](https://github.com/ArvinQi/dsh-mcp/issues/11))**: `global_env` was only used for `streamable-http` header substitution — the stdio branch dropped it entirely — and the parent process environment is no substitute, because `dsh-mcp-client` strips `KEY`/`TOKEN`/`SECRET`/`PASSWORD`-shaped names out of the inherited env before merging the server's own. So a stdio server that only reads its key from the environment (such as `tavily`, `npx -y tavily-mcp`) and whose per-server env the form no longer edits could only start keyless (it surfaced as `tavily_research` reporting "requires an API key" while keyless `tavily_search`/`tavily_extract` worked). `toClientConfig()`'s stdio branch now merges `global_env` with the server's own env into the child process, with the **per-server entry winning** on a collision; the settings hint, both READMEs and this document now state the real scope (injected into stdio children *and* available to HTTP header substitution)
- **Automatic remount after a credential update works again ([#12](https://github.com/ArvinQi/dsh-mcp/issues/12))**: `managedServerId()` recovered the server id from `DSH_MCP_<serverId>_<name>` with `lastIndexOf("_")`, but both the id (`mcp_<12 hex>`) and the variable name may contain `_`: as soon as the name had an underscore (`TAVILY_API_KEY`, `MY_VAR`) it split in the wrong place and produced an id that is not in the table, so the `credentials/reference-updated` handler silently skipped the remount — **rotating a key through the credentials UI or another plugin left the server on its old value until a manual refresh**. It now matches the id's fixed shape (`mcp_[0-9a-f]{12}`) exactly, and keeps `DSH_MCP_ENV_*` (process-level) and `DSH_MCP_OAUTH_*` refs unresolved

### Notes

- Each fix ships with a regression test: `test/stdio-env.test.mjs` spawns a real child through a real mount and reads the environment it received back (it fails against the old implementation), and `test/managed-server-id.test.mjs` runs a ref-resolution matrix against the shipped `lib/index.js` function

## [1.12.0] - 2026-09-18

- **Supported DSH version**: **dsh `0.1.6-alpha.2`**

### Changed

- **Migrated to the official split MCP SDK 2.0 packages**: since DSH `0.1.6-alpha.1`, the in-box `dsh-mcp-client` derives from `@modelcontextprotocol/{client,server,node}@2.0.0` instead of the monolithic `@modelcontextprotocol/sdk@1.x`, and the old package is no longer a DSH dependency. This plugin migrates with it (`lib/transport.js`, `lib/probe.js`, `lib/mcp-client.js`, `lib/oauth.js`) and declares `@modelcontextprotocol/client@2.0.0` and `zod@^4.2.0` explicitly in `package.json` instead of relying on the host profile's dependency hoisting — without this, DSH `0.1.6-alpha.1` fails the plugin load with `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk'`, taking the Settings page and tool search down with it
- **Adapted to two breaking changes in SDK 2.0**: `Client` options no longer accept `authProvider` (the OAuth provider now travels on the **transport**; this plugin's `createTransport` already reads `config.authProvider` and passes it to the transport, so the OAuth flow is unchanged), and `setNotificationHandler`'s first argument is now a **method name** rather than a schema, so the tool-list-changed notification registers as `notifications/tools/list_changed`
- **Result schemas now come from the new package's `specTypeSchemas`**: `ListToolsResultSchema` → `specTypeSchemas.ListToolsResult`; `ToolListChangedNotificationSchema` is no longer needed since notifications register by method name
- **Regenerated the client half for the Typert `create()` contract**: the `@deepseek-ai/dsh-typert-generator` output in `src/client/remote-contribution.js` carried only `schema: TypertSchema`, but since DSH `0.1.6-alpha.1` that field is `create: () => TypertSchema` and the registry calls it unconditionally (`record.value ??= record.create()`) — so the Settings page's Remote descriptors threw `create is not a function` on mount and the whole MCP settings page failed. Regenerated with the current generator (all 21 strict descriptors now carry `create`) and rebuilt `lib/client.js` to match. This stayed hidden because the long-running host had been on `0.1.5-rc.1` since Sep 14, whose contract was still `schema`

### Fixed

- **The "do not open a browser from a tool call" OAuth guard works again**: `startConnection`'s `opts` never carried `url` or `authProvider`, so the branch that should return an authorization link when a stored token is missing or expired never ran — the SDK opened a browser mid-tool-call instead (a single session could open several tabs). `opts` now carries both fields, restoring the documented behavior

## [1.11.1] - 2026-09-13

### Fixed

- **OAuth is now an explicit switch instead of a header guess (no more repeated browser authorizations)**: the previous rule was "streamable-http without an `Authorization` header gets an OAuth provider", so servers that authenticate with static tokens or custom headers (`x-bbzai-mcp-token`, `X-Mcp-Token`, `Private-Token`) were treated as OAuth servers. When such a server answered 401 (a stale token, a gateway challenge), the SDK asked for authorization, the plugin opened the browser and started its loopback callback (`127.0.0.1:<port>/callback`) — a flow that could never satisfy those servers, so every reconnect or remount opened the browser again. A stored server now has an **`oauth: true`** switch (the form's "Use OAuth authorization" checkbox, off by default; taking over a declaration without an `Authorization` header ticks it, and it stays editable)
- **Upgrade migration**: servers that already hold OAuth credentials (a token or a client registration) keep `oauth: true`, everything else is turned off — so servers that genuinely need OAuth keep working while the misdetected ones stop opening the browser
- **Automatic-authorization circuit breaker**: the plugin opens the browser **at most once per server per process**; later automatic attempts return the authorization-link error instead (the 1.8.0 behaviour), and "Test connection" can still start an authorization on demand

## [1.11.0] - 2026-09-13

### Added

- **Declared MCP servers from `cordis.patch.yml` are read and shown**: the Settings page now also lists the `@deepseek-ai/dsh-mcp-client` rows the composition mounts natively — the profile layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`) and the machine-wide layer (`$DSH_HOME/cordis.patch.yml`, which outranks the profile layer) — badged as a "cordis declaration" with the file it came from, read-only. Parsing reuses the composition's own YAML dialect (`!!js` scalars render as their source text); a missing file is not an error and a malformed one degrades to a page diagnostic instead of breaking the manager
- **Declarations win, so no duplicate mount**: when a `serverName` is already declared by a patch layer, the manager no longer mounts the same-named stored row (two mounts under one name collide in the tool registry and roll back that server's whole generation); the page explains the conflict, and mount ownership follows live patch reloads (`web`/`desktop` reload live)
- **OAuth boundary hint**: a declaration cannot carry an OAuth provider (the native client takes static config only). For a streamable-http declaration with no static `Authorization` header the page explains that browser authorization requires adding the server in the plugin and disabling the declared row
- **Take over / give back (declarations gain OAuth)**: the Settings page offers "Take over" on a declared server — the plugin writes an id-targeted `disabled: true` into its own **managed block** in `cordis.patch.yml` (a `.dsh-mcp.bak` backup is taken before the first write; atomic, idempotent, reversible, and confined to that block), so the declaration releases the `serverName` and the plugin mounts a managed row instead — which enables **OAuth authorization, managed credentials, `${VAR}` header substitution and connection tests**. A hard mount failure (e.g. `failOnStartupError: true` with a failing connection) rolls back automatically: the managed block is removed, the row returns to mirror state, and the failure is reported; "Give back" removes the block, hands the mount back to the declaration and deletes the managed row. A declaration without an explicit `id`, or one containing a `!!js` expression, cannot be taken over (`MCP_ADOPT_NO_ID` / `MCP_ADOPT_JS_EXPR`)
- **Safe degradation when the hot reload does not commit (`pendingTakeover`)**: if the native tools have not unregistered within 5 seconds of writing the disable block (that profile's patch hot reload did not commit — a sibling entry failing its re-apply rolls the whole generation back), the plugin **registers the takeover but does not mount**: the managed row is stored and marked `pendingTakeover`, and the next dsh start mounts it; "Give back" likewise reports that a restart is needed when the reload does not commit. Independently, a mount is always skipped when same-named `mcp__<server>__` tools already exist without a local mount — the plugin never fights a still-mounted declaration for one name (that collides in the registry and rolls one side back)
- **Declaration reads now report the EFFECTIVE state**: layers are replayed through `applyEntryPatches`, so the disable block this plugin writes and any cross-layer (profile → machine-wide) id override are reflected; a taken-over declaration reads as disabled while attribution stays with the layer that declared it

### Notes

- **Declarations are imported into storages as mirror rows**: at startup (and on every list refresh) each declaration is imported into the storage domain with id `cordis:<rowId>` plus provenance (`origin: cordis`, `declaredIn`, `declaredRowId`). Rules: **import only** — a row this manager created (`origin: plugin`) is never overwritten; a live mirror is refreshed from the patch layer; a mirror whose declaration disappeared is **removed automatically** (a mirror is only a copy of a declaration, so an ownerless one must not pile up in the list; rows an earlier build marked `stale` are cleaned up too); a declaration containing a `!!js` expression is **skipped** (its value cannot be resolved outside the Loader) and shown from the file with the reason. Mirrors are **never mounted** (the composition owns the mount), so they cannot fight the native row for the same tools
- **Tool search already covers declared servers, with no change needed**: the injection layer handles the whole tool set by `mcp__` prefix, so declared tools join search/hot injection and per-tool switches, and appear in the `mcp-tool-control` server list

### Changed

- **`allowBrowserOnMount` now defaults to `true`**: mounting an OAuth server that needs authorization opens the browser to complete it (previously `false`, which made such mounts fail silently and register no tools); set it to `false` under the dsh-mcp entry to keep mounts browser-free

### Fixed

- **A save dropped the declaration provenance**: `upsert`/`upsertJson` rebuilt the row without `declaredIn`/`declaredRowId`, so an adopted server lost its "came from a declaration" marker after one disable/enable or edit — the "Give back" button disappeared and give-back failed with "no declaration source". Saves now keep the provenance, and startup **repairs** a lost source from the ids in this manager's own managed block (only ids this plugin disabled)
- **Disable → enable could no longer remount (stuck showing disabled)**: the "same-named tools already exist, skip mounting" guard mistook tools lingering from this manager's OWN previous mount for a foreign owner. The manager now remembers the ids it has mounted and waits for its own tools to unregister before mounting again; composition-owned declarations are still skipped
- **Declared-server rows overflowed**: the source file path now takes its own wrapping line and the badge/action areas wrap, so narrow widths no longer push the card apart
- **The JSON editor materialized declarations into managed rows**: its document was seeded from the WHOLE list (including `source: cordis`), so saving wrote a declaration back as an ordinary server — producing a "managed row + declaration with the same name" conflict (shown as disabled, with a toggle that did nothing). The editor now serializes **only plugin-owned rows**, and the host adds a backstop: a JSON document never rewrites a declaration mirror (`origin: cordis`) and never deletes a mirror or a taken-over row (`declaredIn`); skipped entries are reported as "skipped declared N" in the editor notice
- **A declaration-served row no longer reads as "disabled"**: the composition currently serves its tools, yet the page showed the mount phase (`stopped` → "Disabled") with an enable/disable button that could not take effect. It now shows a "Served by declaration" / "Takeover pending restart" badge and hides the toggle
- **Giving a declaration back left it "connecting" with no tools (`needsPlugin`)**: declaration mounts run on the composition's native client, which has **no OAuth** (authorization-code + PKCE and token storage are plugin features) and **no `${VAR}` / bare-name placeholder substitution** (also a plugin feature), so a declaration that needs plugin authentication can never connect once released. The plugin now detects them — streamable-http without an `Authorization` header (an OAuth candidate), or a header value that matches a `global_env` placeholder — reports them as **failed with the reason** instead of forever-connecting, renders `status.error` on the page, uses a stronger confirmation for "Give back", and returns an explanatory warning. Taking the server over again restores its tools
- **The release pipeline was blocked by a test import error**: this package has zero runtime dependencies and resolves `@deepseek-ai/*` and `js-yaml` from the DSH installation, which public CI does not have — the three test files added in 1.11.0 import them at load time, so `npm test` failed and the publish job was skipped. `npm test` now adapts to the environment (`scripts/test.mjs`): with no DSH module closure it skips those files and says so, while a local checkout runs them all

## [1.10.0] - 2026-09-02

### Added

- **Actionable diagnosis when the host half is missing**: when the server-list load fails because of an HTTP 404 on `/api/mcpManager/*` (plugin host half not registered, or client/host version mismatch), the page now shows a troubleshooting hint next to the raw error (verify the `cordis.patch.yml` row → restart `dsh web` → hard-refresh → upgrade both sides); the README troubleshooting section is updated as well

### Fixed

- **Host-side copy internationalization**: the settings UI was fully bilingual but the host half (`lib/index.js`/`lib/oauth.js`/`lib/mcp-client.js`) kept model-visible copy and OAuth errors hardcoded in Chinese. The `mcp_tool_search` description/parameter docs, search-result text, the injected `mcp-tool-control` system prompt, and the OAuth authorization/callback page copy now follow the DSH `locale.preference` from the settings document (new `lib/host-locales.js` table; falls back to Chinese — the previous behavior — when the preference cannot be read)
- **OAuth decisions no longer key on message text**: the tool-call OAuth preflight used `error.message.includes("授权")` to decide whether to re-throw the link-carrying error — translating the message would silently break OAuth error propagation. It now keys on a stable error code `MCP_OAUTH_REQUIRED` (`error.code`), decoupling control flow from display text
- **Static-credential servers are no longer mistaken for OAuth**: only streamable-http servers configured for authorization-code + PKCE and WITHOUT a static `Authorization` request header get an OAuth provider; a static-token server facing a 401 now reports the authentication failure instead of starting a browser authorization flow

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
