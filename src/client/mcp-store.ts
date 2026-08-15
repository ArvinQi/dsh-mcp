/**
 * MCP settings page store: the server list projection, the editing draft, and
 * the transient probe outcome. All Remote traffic happens in the apply-world
 * inject callbacks; the store only mirrors their results so components stay
 * pure presentational.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  McpEnvVarInput, McpProbeView, McpServerId, McpServerInput, McpServerView, McpTransportKind,
} from './types.ts'

/** One env row in the editor. */
export interface McpEnvRowDraft {
  /** Stable row key for React lists. */
  readonly key: string
  readonly name: string
  readonly secret: boolean
  /** Editor text; a blank secret value keeps the stored one on save. */
  readonly value: string
  /** Whether a stored value exists (secret rows render write-only). */
  readonly configured: boolean
}

/** One server being edited. */
export interface McpDraft {
  /** Existing server id; null creates a new server. */
  readonly id: McpServerId | null
  readonly serverName: string
  readonly transport: McpTransportKind
  readonly enabled: boolean
  readonly command: string
  /** Arguments as newline-separated editor text. */
  readonly argsText: string
  readonly cwd: string
  readonly url: string
  /** Headers as "Name: value" lines. */
  readonly headersText: string
  readonly env: readonly McpEnvRowDraft[]
  /** Timeout as editor text; blank falls back to the default. */
  readonly toolCallTimeoutMs: string
  readonly failOnStartupError: boolean
}

/** The transient probe outcome of the current draft. */
export interface McpTestOutcome {
  readonly probe: McpProbeView
  readonly elapsedMs: number
}

/** Page-level state mirroring Remote results and the current editing session. */
export interface McpManagerUiState {
  loadState: 'loading' | 'ready' | 'error'
  servers: readonly McpServerView[]
  /** Draft being edited; null renders the server list. */
  draft: McpDraft | null
  /** Verb of the current in-flight Remote operation. */
  busy: 'save' | 'remove' | null
  testRunning: boolean
  test: McpTestOutcome | null
}

/** Declared mutation surface for the page. */
type McpManagerActions = {
  setLoadState: (draft: McpManagerUiState, state: McpManagerUiState['loadState']) => void
  setServers: (draft: McpManagerUiState, servers: readonly McpServerView[]) => void
  beginCreate: (draft: McpManagerUiState) => void
  beginEdit: (draft: McpManagerUiState, server: McpServerView) => void
  cancelEdit: (draft: McpManagerUiState) => void
  updateDraft: (draft: McpManagerUiState, patch: Partial<McpDraft>) => void
  setBusy: (draft: McpManagerUiState, busy: 'save' | 'remove' | null) => void
  setTestRunning: (draft: McpManagerUiState, running: boolean) => void
  setTest: (draft: McpManagerUiState, test: McpTestOutcome | null) => void
}

/** Default tool-call timeout when the editor leaves it blank (ms). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

let envRowSeq = 0

/** A fresh env row key for React identity. */
function nextEnvRowKey(): string {
  envRowSeq += 1
  return `env-${envRowSeq}`
}

/** A fresh empty env row for the editor. */
export function createEnvRowDraft(): McpEnvRowDraft {
  return { key: nextEnvRowKey(), name: '', secret: false, value: '', configured: false }
}

/** Build an empty create draft. */
export function emptyDraft(): McpDraft {
  return {
    id: null,
    serverName: '',
    transport: 'stdio',
    enabled: true,
    command: '',
    argsText: '',
    cwd: '',
    url: '',
    headersText: '',
    env: [],
    toolCallTimeoutMs: String(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    // Reject the mount by default when the startup connection fails, so a
    // broken server never registers stale tools.
    failOnStartupError: true,
  }
}

/** Build an edit draft from a stored server view. */
export function draftFromServer(server: McpServerView): McpDraft {
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command,
    argsText: server.args.join('\n'),
    cwd: server.cwd,
    url: server.url,
    headersText: server.headers.map(header => `${header.name}: ${header.value}`).join('\n'),
    env: server.env.map(entry => ({
      key: nextEnvRowKey(),
      name: entry.name,
      secret: entry.secret,
      value: '',
      configured: entry.configured,
    })),
    toolCallTimeoutMs: String(server.toolCallTimeoutMs),
    failOnStartupError: server.failOnStartupError,
  }
}

/** Parse newline-separated lines into trimmed non-empty arguments. */
function parseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** Parse "Name: value" header lines; malformed lines are dropped. */
function parseHeaders(text: string): Array<{ name: string; value: string }> {
  const headers: Array<{ name: string; value: string }> = []
  for (const line of parseLines(text)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (name.length > 0) headers.push({ name, value })
  }
  return headers
}

/** Parse the timeout text; blank or invalid falls back to the default. */
function parseTimeout(text: string): number {
  const value = Number(text)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TOOL_CALL_TIMEOUT_MS
}

/** The Remote submission derived from the current draft. */
export interface McpSubmission {
  readonly server: McpServerInput
  readonly env: readonly McpEnvVarInput[]
}

/**
 * Convert the editing draft into the Remote upsert/test payload. A blank
 * secret value submits no value, which keeps the stored secret on upsert.
 */
export function draftToSubmission(draft: McpDraft): McpSubmission {
  return {
    server: {
      serverName: draft.serverName.trim(),
      transport: draft.transport,
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: parseLines(draft.argsText),
      cwd: draft.cwd.trim(),
      url: draft.url.trim(),
      headers: parseHeaders(draft.headersText),
      toolCallTimeoutMs: parseTimeout(draft.toolCallTimeoutMs),
      failOnStartupError: draft.failOnStartupError,
    },
    env: draft.env.map(row => ({
      name: row.name.trim(),
      secret: row.secret,
      ...row.secret && row.value.trim().length === 0 ? {} : { value: row.value },
    })),
  }
}

/** Map a Remote failure code to a locale key for user-facing copy. */
export function failureLocaleKey(code: string): string {
  switch (code) {
    case 'MCP_SERVER_NAME_CONFLICT': return 'serverNameConflict'
    case 'MCP_SERVER_NOT_FOUND': return 'notFound'
    case 'MCP_INVALID_SPEC': return 'invalidSpec'
    case 'MCP_MOUNT_FAILED': return 'mountFailed'
    default: return 'failureTitle'
  }
}

/**
 * Declares the MCP management page state and write surface.
 * @returns the store handle.
 */
export function createMcpManagerStore(): EngineStoreHandle<McpManagerUiState, McpManagerActions> {
  return defineStore({
    init: (): McpManagerUiState => ({
      loadState: 'loading',
      servers: [],
      draft: null,
      busy: null,
      testRunning: false,
      test: null,
    }),
    actions: {
      setLoadState: (d, state) => {
        d.loadState = state
      },
      setServers: (d, servers) => {
        d.servers = servers
      },
      beginCreate: (d) => {
        d.draft = emptyDraft()
        d.test = null
      },
      beginEdit: (d, server) => {
        d.draft = draftFromServer(server)
        d.test = null
      },
      cancelEdit: (d) => {
        d.draft = null
        d.test = null
        d.busy = null
      },
      updateDraft: (d, patch) => {
        if (d.draft === null) return
        d.draft = { ...d.draft, ...patch }
      },
      setBusy: (d, busy) => {
        d.busy = busy
      },
      setTestRunning: (d, running) => {
        d.testRunning = running
      },
      setTest: (d, test) => {
        d.test = test
      },
    },
  })
}
