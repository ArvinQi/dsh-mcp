/**
 * MCP settings page store: the server list projection, the editing draft, and
 * the transient probe outcome. All Remote traffic happens in the apply-world
 * inject callbacks; the store only mirrors their results so components stay
 * pure presentational.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type {
  McpProbeView, McpServerId, McpServerInput, McpServerView, McpTransportKind,
} from './types.ts'

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
    toolCallTimeoutMs: String(server.toolCallTimeoutMs),
    failOnStartupError: server.failOnStartupError,
  }
}

/** Parse newline-separated lines into trimmed non-empty arguments. */
function parseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * Shell-style argument parsing: split on whitespace (spaces, tabs, newlines)
 * while honoring single quotes, double quotes (with `\"` and `\\` escapes),
 * and backslash escapes outside quotes. Unclosed quotes are tolerated: the
 * remaining input becomes one argument. An explicitly empty quoted argument
 * (`""` or `''`) is preserved.
 */
export function parseArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        i += 1
        continue
      }
      if (ch === '\\' && quote === '"' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1]
        i += 2
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1]
      hasToken = true
      i += 2
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken || current.length > 0) {
        args.push(current)
        current = ''
        hasToken = false
      }
      i += 1
      continue
    }
    current += ch
    hasToken = true
    i += 1
  }
  if (quote !== null || hasToken || current.length > 0) {
    args.push(current)
  }
  return args
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
}

/**
 * Convert the editing draft into the Remote upsert/test payload. The form no
 * longer edits env rows (process-level env vars are managed separately), so
 * no env is submitted and the host keeps the stored env untouched.
 */
export function draftToSubmission(draft: McpDraft): McpSubmission {
  return {
    server: {
      serverName: draft.serverName.trim(),
      transport: draft.transport,
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: parseArgs(draft.argsText),
      cwd: draft.cwd.trim(),
      url: draft.url.trim(),
      headers: parseHeaders(draft.headersText),
      toolCallTimeoutMs: parseTimeout(draft.toolCallTimeoutMs),
      failOnStartupError: draft.failOnStartupError,
    },
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
