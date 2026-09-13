/**
 * Wire vocabulary of the mcp-manager domain, vendored into the standalone
 * plugin so the browser half names the Remote payloads without depending on
 * the original @deepseek-ai/dsh-mcp-manager package. Pure types — no runtime
 * code. `McpServerId` is branded structurally (dsh-brand style) so no extra
 * package is needed.
 * @module dsh-mcp/client/types
 */

/** Stable identity of one managed MCP server definition. */
export type McpServerId = string & { readonly __brand: 'McpServerId' }

/** Supported MCP transports. */
export type McpTransportKind = 'stdio' | 'streamable-http'

/** One HTTP header of a streamable-http server definition. */
export interface McpHeaderEntry {
  readonly name: string
  readonly value: string
}

/** One environment variable of a stdio server definition. */
export interface McpEnvVarEntry {
  readonly name: string
  readonly secret: boolean
  readonly value?: string
}

/** Env-var row the client submits; a secret entry's value is write-only. */
export interface McpEnvVarInput {
  readonly name: string
  readonly secret: boolean
  readonly value?: string
}

/** Definition the client submits; ids are minted by the manager. */
export interface McpServerInput {
  readonly serverName: string
  readonly transport: McpTransportKind
  readonly enabled: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly url: string
  readonly headers: readonly McpHeaderEntry[]
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
}

/** One env var as the client renders it. */
export interface McpEnvVarView {
  readonly name: string
  readonly secret: boolean
  readonly configured: boolean
  /** Plain-text value of a non-secret env var (secret values never leave the Host). */
  readonly value?: string
}

/** Lifecycle phase of one managed server's live mount. */
export type McpMountPhase = 'mounting' | 'live' | 'failed' | 'stopped'

/** Live status of one managed server. */
export interface McpServerStatus {
  readonly phase: McpMountPhase
  readonly tools: readonly string[]
  readonly error?: string
}

/** Where one server definition came from. */
export type McpServerSource = 'plugin' | 'cordis'

/** Which Cordis patch layer declared one server. */
export type McpPatchLayerKind = 'profile' | 'home'

/** Full client-facing projection of one managed server. */
export interface McpServerView {
  readonly id: McpServerId
  readonly serverName: string
  readonly transport: McpTransportKind
  readonly enabled: boolean
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly url: string
  readonly headers: readonly McpHeaderEntry[]
  readonly env: readonly McpEnvVarView[]
  readonly toolCallTimeoutMs: number
  readonly failOnStartupError: boolean
  readonly status: McpServerStatus
  /** `plugin` = stored and mounted here; `cordis` = declared in a patch layer. */
  readonly source?: McpServerSource
  /** True for a patch-layer declaration: the page views it, it does not own it. */
  readonly readOnly?: boolean
  /** True when a patch-layer declaration owns this stored row's serverName. */
  readonly conflict?: boolean
  /** Absolute patch file the declaration was read from. */
  readonly declaredIn?: string
  /** Patch layer that carried the declaration. */
  readonly layer?: McpPatchLayerKind
  /** Streamable-http declaration with no static Authorization header. */
  readonly oauthHint?: boolean
  /** True for a mirror whose declaration disappeared from the patch layers. */
  readonly stale?: boolean
  /** False when the entry is shown straight from the patch file (not imported). */
  readonly imported?: boolean
  /** Why the entry has no importable mirror. */
  readonly skipReason?: 'js-expression'
  /** True when the declaration can be taken over by the plugin. */
  readonly adoptable?: boolean
  /** True when this managed row is a declaration the plugin took over. */
  readonly adopted?: boolean
  /** Registered takeover whose disable block is not applied yet (needs a restart). */
  readonly pendingTakeover?: boolean
  /** The declaration can only authenticate while the plugin owns the mount. */
  readonly needsPlugin?: boolean
}

/** One MCP tool summary in a probe report. */
export interface McpProbeToolView {
  readonly name: string
  readonly description?: string
}

/** Probe outcome: successful tool listing or a readable failure. */
export type McpProbeView =
  | { readonly ok: true; readonly tools: readonly McpProbeToolView[] }
  | { readonly ok: false; readonly message: string }

/** Stable failure codes for rejected management operations. */
export type McpManagerFailureCode =
  | 'MCP_SERVER_NOT_FOUND'
  | 'MCP_SERVER_NAME_CONFLICT'
  | 'MCP_INVALID_SPEC'
  | 'MCP_MOUNT_FAILED'
  | 'MCP_ADOPT_NOT_DECLARED'
  | 'MCP_ADOPT_NO_ID'
  | 'MCP_ADOPT_JS_EXPR'
  | 'MCP_ADOPT_FAILED'
  | 'MCP_ADOPT_RELOAD_PENDING'
  | 'MCP_RELEASE_FAILED'

/** Explicit business failure of one management operation. */
export interface McpManagerFailure {
  readonly code: McpManagerFailureCode
  readonly message: string
}

/** One MCP tool row in the tool-control section. */
export interface McpToolView {
  readonly name: string
  readonly server: string
  readonly description: string
  readonly enabled: boolean
}

/** Injection mode of the tool-control layer. */
export type McpToolInjectionMode = 'full' | 'search'

/** Full tool-control state read from the Host. */
export interface McpToolsState {
  readonly tools: readonly McpToolView[]
  readonly mode: McpToolInjectionMode
  readonly hotSize: number
}
