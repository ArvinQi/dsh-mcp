import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type {
  McpManagerFailure, McpPlacement, McpPrefs, McpPrefsWrite, McpServerId, McpServerView, McpSurface,
  McpToolInjectionMode, McpToolsState, McpToolView,
} from './types.ts'
import { MCP_PLACEMENTS } from './types.ts'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { McpServerForm, OAUTH_POLL_MS, type McpServerFormRemote } from './ServerForm.tsx'
import { ServersJsonEditor, type ServersJsonEntry } from './ServersJsonEditor.tsx'
import { GlobalEnvEditor, type GlobalEnvRemote } from './GlobalEnvEditor.tsx'
import type { McpToolControlRemote } from './ToolControlSection.tsx'
import type { McpSettingsLocaleKey } from './locales.ts'
import { createMcpManagerStore, type McpDraft, type McpTestOutcome } from './mcp-store.ts'
import controls from './controls.module.css'
import css from './McpSettingsSection.module.css'

/** One adopt/release attempt: a business failure, or an advisory note. */
export interface McpTakeoverOutcome {
  readonly failure: McpManagerFailure | null
  readonly warning?: string
}

/** Registration-side Remote face used by the section. */
export interface McpManagerInjected extends McpServerFormRemote, McpToolControlRemote, GlobalEnvRemote {
  /** Read the current server list. */
  list: () => Promise<readonly McpServerView[]>
  /** Persist one draft; null means success, a failure is otherwise returned. */
  save: (draft: McpDraft) => Promise<McpManagerFailure | null>
  /** Delete one server; null means success, a failure is otherwise returned. */
  remove: (id: McpServerId) => Promise<McpManagerFailure | null>
  /** Probe one draft; `draft.id` lets stored secret values resolve. */
  test: (draft: McpDraft) => Promise<McpTestOutcome>
  /** Replace the whole server list (JSON editor path). */
  upsertJson: (servers: readonly ServersJsonEntry[]) => Promise<{ added: number; updated: number; removed: number; skipped?: number }>
  /** Take a declared server over so the plugin owns the mount (enables OAuth). */
  adopt: (serverName: string) => Promise<McpTakeoverOutcome>
  /** Give an adopted server back to its declaration. */
  release: (serverName: string) => Promise<McpTakeoverOutcome>
  /** Durable prefs snapshot: placement, pins, per-server search aliases. */
  prefs: McpPrefs
  /** Persist and apply a new display location; null means success. */
  setPlacement: (next: McpPlacement) => Promise<McpManagerFailure | null>
  /** Replace the pinned-tool set. */
  setPinned: (pins: readonly string[]) => Promise<McpPrefsWrite>
  /** Replace the whole alias record. */
  setAliases: (aliases: Readonly<Record<string, readonly string[]>>) => Promise<McpPrefsWrite>
  /** Re-read the durable prefs (used on mount, so a remount never shows a stale snapshot). */
  prefsRead: () => Promise<McpPrefs>
  /** Which surface rendered this page. */
  surface: McpSurface
  /** Settings shell affordance: close the modal (settings surface only). */
  close?: () => void
}

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcp'>
  & PropsStore<ReturnType<typeof createMcpManagerStore>>
  & InjectFace<McpManagerInjected>

/** Phase label key for a status badge. */
function phaseKey(phase: McpServerView['status']['phase']): McpSettingsLocaleKey {
  switch (phase) {
    case 'mounting': return 'statusMounting'
    case 'live': return 'statusLive'
    case 'failed': return 'statusFailed'
    case 'stopped': return 'statusStopped'
  }
}

/** Fill `{name}` placeholders; the locale service hands back raw templates. */
function fillTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    vars[name] === undefined ? match : String(vars[name])
  ))
}

/** `mcp__<server>__<tool>` → the tool tail shown to a person. */
function tailOf(name: string): string {
  const rest = name.slice(5)
  const index = rest.indexOf('__')
  return index < 0 ? rest : rest.slice(index + 2)
}

/** `mcp__<server>__<tool>` → the server namespace. */
function serverOfName(name: string): string {
  const rest = name.slice(5)
  const index = rest.indexOf('__')
  return index < 0 ? rest : rest.slice(0, index)
}

/**
 * Servers whose tool sets substantially overlap (same-family variants such as
 * `x`, `x-prod`, `x-oauth`). Shown on the later card so an operator can see
 * which one is redundant instead of comparing tool names by eye.
 * @param tools - every tool row.
 * @returns later server → the earlier server it duplicates, with the shared count.
 */
function findDuplicates(tools: readonly McpToolView[]): Map<string, { server: string; count: number }> {
  const byServer = new Map<string, Set<string>>()
  for (const tool of tools) {
    const set = byServer.get(tool.server) ?? new Set<string>()
    set.add(tailOf(tool.name))
    byServer.set(tool.server, set)
  }
  const servers = [...byServer.keys()].sort()
  const duplicates = new Map<string, { server: string; count: number }>()
  for (let right = 0; right < servers.length; right += 1) {
    const rightSet = byServer.get(servers[right]) ?? new Set<string>()
    for (let left = 0; left < right; left += 1) {
      const leftSet = byServer.get(servers[left]) ?? new Set<string>()
      let shared = 0
      for (const name of rightSet) if (leftSet.has(name)) shared += 1
      const smaller = Math.min(rightSet.size, leftSet.size)
      if (shared >= 3 && shared >= smaller * 0.7) {
        duplicates.set(servers[right], { server: servers[left], count: shared })
        break
      }
    }
  }
  return duplicates
}

/** Group pinned tool names by server, keeping the pin order inside a server. */
function groupPins(pins: readonly string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>()
  for (const name of pins) {
    const server = serverOfName(name)
    const bucket = groups.get(server) ?? []
    bucket.push(name)
    groups.set(server, bucket)
  }
  return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))
}

/** Locale key of each display-location option. */
const PLACEMENT_LABEL_KEY: Record<McpPlacement, McpSettingsLocaleKey> = {
  sidebar: 'placementSidebar',
  settings: 'placementSettings',
  both: 'placementBoth',
}

/** Rebuild an editable draft from a stored server view (quick toggle path). */
function viewToDraft(server: McpServerView): McpDraft {
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
    oauth: server.oauth === true,
    failOnStartupError: server.failOnStartupError,
  }
}

/**
 * Render the MCP management page: the injection-mode selector (default
 * on-demand search), the server list with per-server refresh and an expandable
 * per-server tool-binding list, or the editor when a draft is open.
 */
export function McpSettingsSection(props: McpSettingsSectionProps): ReactNode {
  const { list, save, remove, test, adopt, release, oauthStart, oauthStatus } = props
  const state = props.useStore(snapshot => snapshot)
  const { setLoadState, setServers, beginCreate, beginEdit, cancelEdit, updateDraft, setBusy, setTestRunning, setTest } = props.actions
  const t = props.t

  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null)
  const [hostMissing, setHostMissing] = useState(false)
  const [tools, setTools] = useState<McpToolsState | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  /** Tool filter applied inside every server card (and across the list). */
  const [toolQuery, setToolQuery] = useState('')
  /** Show only pinned tools / servers that hold one. */
  const [onlyPinned, setOnlyPinned] = useState(false)
  /** Servers whose tool panel is open. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** Unsaved alias text per server. */
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({})
  const [aliasBusy, setAliasBusy] = useState<ReadonlySet<string>>(new Set())
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set())
  const [jsonOpen, setJsonOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(true)
  const [adopting, setAdopting] = useState<ReadonlySet<string>>(new Set())
  const [oauthWaiting, setOauthWaiting] = useState<ReadonlySet<string>>(new Set())
  const [oauthStarting, setOauthStarting] = useState<ReadonlySet<string>>(new Set())
  const [oauthLinks, setOauthLinks] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [oauthErrors, setOauthErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [oauthIncomplete, setOauthIncomplete] = useState<ReadonlySet<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<McpPrefs>(props.prefs)

  const [placementSaving, setPlacementSaving] = useState(false)
  const [placementError, setPlacementError] = useState<string | null>(null)
  const timersRef = useRef<number[]>([])
  /** Servers whose flow died (no listener, no tokens): stop polling them. */
  const oauthStoppedRef = useRef<Set<string>>(new Set())
  // The injected face is re-created on every render; the poller reads it
  // through a ref so its interval is not restarted by unrelated renders.
  const oauthStatusRef = useRef(oauthStatus)
  oauthStatusRef.current = oauthStatus
  const tRef = useRef(t)
  tRef.current = t
  let inlineForm: ReactNode | null = null

  useEffect(() => () => {
    for (const id of timersRef.current) window.clearTimeout(id)
  }, [])

  // The page is re-registered after a successful switch, which remounts it with
  // the new placement; keep the radios in step if the Host value changes
  // without a remount.
  useEffect(() => {
    setPrefs(props.prefs)
  }, [props.prefs])

  // The inject face is a snapshot; after a remount (switching panels) it can be
  // stale, which made the pinned list look like it had been lost. Re-read the
  // durable prefs whenever the page mounts.
  useEffect(() => {
    let live = true
    void props.prefsRead().then(
      (next) => { if (live) setPrefs(next) },
      () => {},
    )
    return () => { live = false }
  }, [])

  /**
   * Persist a new display location and apply it. The Host owns the stored
   * value: a rejected write reverts the radios instead of pretending the page
   * moved. Leaving Settings while this section is displayed closes the modal,
   * otherwise it would sit on a page that no longer exists.
   */
  const pickPlacement = (next: McpPlacement): void => {
    if (next === prefs.placement || placementSaving) return
    const previous = prefs.placement
    setPrefs(current => ({ ...current, placement: next }))
    setPlacementError(null)
    setPlacementSaving(true)
    void props.setPlacement(next).then(
      (failure) => {
        setPlacementSaving(false)
        if (failure === null) {
          if (next === 'sidebar' && props.surface === 'settings') props.close?.()
          return
        }
        setPrefs(current => ({ ...current, placement: previous }))
        setPlacementError(`${failure.code}: ${failure.message}`)
      },
      (error) => {
        setPlacementSaving(false)
        setPrefs(current => ({ ...current, placement: previous }))
        setPlacementError(String((error instanceof Error ? error.message : error) ?? error))
      },
    )
  }

  /** Pin or unpin a set of tools; the Host returns the accepted snapshot. */
  const applyPins = (names: readonly string[], pinned: boolean): void => {
    const next = new Set(prefs.pins)
    for (const name of names) {
      if (pinned) next.add(name)
      else next.delete(name)
    }
    void props.setPinned([...next]).then(
      (result) => {
        if (result.ok) setPrefs(result.prefs)
        else setActionError(`${result.failure.code}: ${result.failure.message}`)
      },
      (error) => setActionError(String((error instanceof Error ? error.message : error) ?? error)),
    )
  }

  /** Save the alias input of one server (comma or whitespace separated). */
  const saveAliasInput = (server: string): void => {
    const words = (aliasDraft[server] ?? '')
      .split(/[,，\s]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 0)
    setAliasBusy((prev) => new Set(prev).add(server))
    void saveAliases(server, words).then(
      (ok) => {
        setAliasBusy((prev) => {
          const next = new Set(prev)
          next.delete(server)
          return next
        })
        if (ok) {
          setAliasDraft((prev) => {
            const next = { ...prev }
            delete next[server]
            return next
          })
        }
      },
      () => setAliasBusy((prev) => {
        const next = new Set(prev)
        next.delete(server)
        return next
      }),
    )
  }

  /** Persist one server's search aliases; an empty list removes the entry. */
  const saveAliases = async (server: string, keywords: readonly string[]): Promise<boolean> => {
    const next: Record<string, readonly string[]> = { ...prefs.aliases }
    if (keywords.length === 0) delete next[server]
    else next[server] = [...keywords]
    const result = await props.setAliases(next)
    if (result.ok) {
      setPrefs(result.prefs)
      return true
    }
    setActionError(`${result.failure.code}: ${result.failure.message}`)
    return false
  }

  const refreshTools = (): void => {
    void props.toolsList().then(
      (next) => { setTools(next); setToolsError(null) },
      (error) => {
        console.error('[dsh-mcp] toolsList failed:', error)
        setToolsError(String((error instanceof Error ? error.message : error) ?? error))
        setTools(null)
      },
    )
  }

  const fail = (error: unknown): void => {
    // The settings shell hides Remote failures behind a generic copy; surface
    // the real message here so a broken list() is diagnosable from the page.
    console.error('[dsh-mcp] list failed:', error)
    const message = String((error instanceof Error ? error.message : error) ?? error)
    setLoadErrorDetail(message)
    // HTTP 404 on /api/mcpManager/* means the host did not register the
    // mcpManager Typert service (host half missing or client/host version
    // mismatch). Surface that distinctively instead of a bare transport error.
    setHostMissing(/HTTP 404|transport failure/.test(message))
    setLoadState('error')
  }

  const load = (): void => {
    void list().then(
      (servers) => {
        setServers(servers)
        setLoadState('ready')
        setLoadErrorDetail(null)
        setHostMissing(false)
      },
      (error) => fail(error),
    )
    refreshTools()
  }

  useEffect(() => {
    let current = true
    void list().then(
      (servers) => {
        if (!current) return
        setServers(servers)
        setLoadState('ready')
        setLoadErrorDetail(null)
        setHostMissing(false)
      },
      (error) => { if (current) fail(error) },
    )
    void props.toolsList().then(
      (next) => { if (current) { setTools(next); setToolsError(null) } },
      (error) => {
        if (!current) return
        console.error('[dsh-mcp] toolsList failed:', error)
        setToolsError(String((error instanceof Error ? error.message : error) ?? error))
        setTools(null)
      },
    )
    return () => { current = false }
  }, [list, setLoadState, setServers])

  const setMode = (mode: McpToolInjectionMode): void => {
    void props.toolsMode({ mode }).then(refreshTools, (error) => {
      console.error('[dsh-mcp] toolsMode failed:', error)
      refreshTools()
    })
  }

  /** Flip a set of tools locally without persisting yet (drag painting). */
  const optimisticEnabled = (names: ReadonlySet<string>, enabled: boolean): void => {
    setTools(prev => prev === null
      ? prev
      : { ...prev, tools: prev.tools.map(item => names.has(item.name) ? { ...item, enabled } : item) })
  }

  /** Persist one state for several tools in a single batch. */
  const persistEnabled = (names: readonly string[], enabled: boolean): void => {
    if (names.length === 0) return
    void Promise.all(names.map((name) => props.toolsSet({ name, enabled }))).catch((error) => {
      console.error('[dsh-mcp] toolsSet failed:', error)
      refreshTools()
    })
  }

  const toggleTool = (tool: McpToolView): void => {
    const next = !tool.enabled
    // Optimistic local toggle; the Host is the source of truth.
    optimisticEnabled(new Set([tool.name]), next)
    persistEnabled([tool.name], next)
  }

  /**
   * Pressing on a tool row and dragging across others flips every crossed row to
   * the state of the first one. The move is batched into one toolsSet call per
   * tool on release, not one per pointer move.
   */
  const paintRef = useRef<{ target: boolean; names: Set<string> } | null>(null)

  useEffect(() => {
    const stop = (): void => {
      const paint = paintRef.current
      paintRef.current = null
      if (paint !== null) persistEnabled([...paint.names], paint.target)
    }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  })

  const paintStart = (tool: McpToolView, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    // The checkbox, the "?" and the pin keep their own click behaviour.
    if ((event.target as HTMLElement).closest('button, input')) return
    const target = !tool.enabled
    paintRef.current = { target, names: new Set([tool.name]) }
    optimisticEnabled(new Set([tool.name]), target)
  }

  const paintOver = (tool: McpToolView): void => {
    const paint = paintRef.current
    if (paint === null || paint.names.has(tool.name)) return
    paint.names.add(tool.name)
    optimisticEnabled(new Set([tool.name]), paint.target)
  }

  const refreshServer = (serverName: string): void => {
    setRefreshing(prev => new Set(prev).add(serverName))
    void Promise.all([
      list().then(
        (servers) => { setServers(servers); setLoadState('ready'); setHostMissing(false) },
        () => {},
      ),
      props.toolsList().then(setTools, () => {}),
    ]).finally(() => {
      setRefreshing(prev => {
        const next = new Set(prev)
        next.delete(serverName)
        return next
      })
    })
  }

  /**
   * Servers the Host itself reports as awaiting authorization: a mount that
   * only failed because the user still has to authorize, or an interactive
   * flow the mount opened (`allowBrowserOnMount`). They are polled too, so a
   * browser authorization completed while the page sat open is noticed within
   * one poll interval instead of needing a manual refresh. A server whose flow
   * already died (no listener, no tokens) stops being polled until the user
   * clicks its button again.
   */
  const hostPendingOAuth = state.servers
    .filter(server => server.oauth === true
      && server.status.oauthRequired === true
      && server.oauthAuthorized !== true
      && !oauthStoppedRef.current.has(server.serverName))
    .map(server => server.serverName)
  const pollKey = [...new Set([...oauthWaiting, ...hostPendingOAuth])].sort().join(',')

  /**
   * Poll the authorization state of every pending flow every 5s. Nothing
   * renders as failed before the host reports tokens; a completed
   * authorization refreshes the list (the host remounts the server when the
   * credentials update lands), and a flow that is gone stops being polled.
   */
  useEffect(() => {
    if (pollKey.length === 0) return
    const names = pollKey.split(',')
    let cancelled = false
    const tick = async (): Promise<void> => {
      const results = await Promise.all(names.map(async (name) => {
        try {
          return { name, status: await oauthStatusRef.current(name) }
        } catch (error) {
          console.error('[dsh-mcp] oauthStatus failed:', error)
          return { name, status: null }
        }
      }))
      if (cancelled) return
      const authorized = results
        .filter(entry => entry.status?.authorized === true)
        .map(entry => entry.name)
      // A flow that reported a failure (`access_denied`, token exchange, ...)
      // or that lost its listener is not going to complete on its own: stop
      // polling it, remember the outcome, and let the user retry.
      const failed = results
        .filter(entry => entry.status !== null && !entry.status.authorized && entry.status.error !== undefined)
        .map(entry => ({ name: entry.name, error: entry.status?.error ?? '' }))
      const gone = results
        .filter(entry => entry.status !== null && !entry.status.authorized && entry.status.error === undefined && !entry.status.pending)
        .map(entry => entry.name)
      for (const entry of failed) {
        oauthStoppedRef.current.add(entry.name)
        setOauthErrors(prev => new Map(prev).set(entry.name, entry.error))
      }
      for (const name of gone) {
        oauthStoppedRef.current.add(name)
        setOauthIncomplete(prev => new Set(prev).add(name))
      }
      const finished = new Set([
        ...authorized,
        ...failed.map(entry => entry.name),
        ...gone,
      ])
      if (finished.size === 0) return
      setOauthWaiting((prev) => {
        const next = new Set(prev)
        for (const name of finished) next.delete(name)
        return next
      })
      if (authorized.length === 0) return
      setOauthErrors((prev) => {
        const next = new Map(prev)
        for (const name of authorized) next.delete(name)
        return next
      })
      setOauthIncomplete((prev) => {
        const next = new Set(prev)
        for (const name of authorized) next.delete(name)
        return next
      })
      setActionError(null)
      setActionNotice(tRef.current('oauthAuthorized'))
      refreshServer('')
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, OAUTH_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pollKey])

  const runAdopt = async (server: McpServerView): Promise<void> => {
    const giveBack = server.adopted === true
    // Giving a declaration back to a composition that cannot authenticate it
    // drops every tool it serves, so that variant states the consequence.
    const confirmKey = giveBack
      ? server.needsPlugin === true ? 'releaseConfirmNeedsPlugin' : 'releaseConfirm'
      : 'adoptConfirm'
    if (!window.confirm(t(confirmKey))) return
    setActionError(null)
    setActionNotice(null)
    setAdopting(prev => new Set(prev).add(server.serverName))
    try {
      const outcome = await (giveBack ? release(server.serverName) : adopt(server.serverName))
      if (outcome.failure !== null) setActionError(`${outcome.failure.code}: ${outcome.failure.message}`)
      else if (outcome.warning !== undefined) setActionNotice(outcome.warning)
    } catch (error) {
      setActionError(String((error instanceof Error ? error.message : error) ?? error))
    } finally {
      setAdopting(prev => {
        const next = new Set(prev)
        next.delete(server.serverName)
        return next
      })
      load()
    }
  }

  /**
   * Row-level authorization: ask the Host to start (or reuse) the server's
   * flow. The Host opens the system browser itself — a client-side
   * `window.open` is denied inside the DSH shell and only flashes a blank tab
   * — and the row keeps the URL as a manual fallback link. The 5s poller above
   * then reports "authorizing…", the failure reason, or success.
   */
  const runOAuth = async (server: McpServerView): Promise<void> => {
    setActionError(null)
    setActionNotice(null)
    oauthStoppedRef.current.delete(server.serverName)
    setOauthErrors(prev => {
      const next = new Map(prev)
      next.delete(server.serverName)
      return next
    })
    setOauthIncomplete(prev => {
      const next = new Set(prev)
      next.delete(server.serverName)
      return next
    })
    setOauthStarting(prev => new Set(prev).add(server.serverName))
    try {
      const url = await oauthStart({ id: server.id, serverName: server.serverName })
      setOauthLinks(prev => new Map(prev).set(server.serverName, url))
      setOauthWaiting(prev => new Set(prev).add(server.serverName))
    } catch (error) {
      // A missing Host method (a client/host version mismatch before the next
      // restart) is the one failure this path can hit; say what to do.
      setActionError(`${tRef.current('oauthStartFailed')}: ${String((error instanceof Error ? error.message : error) ?? error)}`)
    } finally {
      setOauthStarting(prev => {
        const next = new Set(prev)
        next.delete(server.serverName)
        return next
      })
    }
  }

  const toggleEnabled = async (server: McpServerView): Promise<void> => {
    const target = !server.enabled
    const draft = viewToDraft(server)
    draft.enabled = target
    try {
      const failure = await save(draft)
      if (failure !== null) {
        console.error('[dsh-mcp] setEnabled failed:', failure.message)
        return
      }
      await refreshServer(server.serverName)
      if (target) {
        // Mounting is asynchronous: refresh again after the connection settles
        // so the badge and tool count reflect the live state without a manual
        // refresh.
        timersRef.current.push(window.setTimeout(() => refreshServer(server.serverName), 2000))
      }
    } catch (error) {
      console.error('[dsh-mcp] setEnabled failed:', error)
    }
  }

  const mode = tools?.mode ?? 'search'

  /** Tools of one server, narrowed by the list's filter controls. */
  const serverTools = (serverName: string): McpToolView[] => {
    const needle = toolQuery.trim().toLowerCase()
    return (tools?.tools ?? []).filter((tool) => {
      if (tool.server !== serverName) return false
      if (onlyPinned && !pinnedSet.has(tool.name)) return false
      if (needle.length === 0) return true
      const aliases = (prefs.aliases[serverName] ?? []).join(' ').toLowerCase()
      return `${tool.name} ${tool.description} ${aliases}`.toLowerCase().includes(needle)
    })
  }

  /** Every tool of one server, ignoring the list filters (whole-server pinning). */
  const allToolsOf = (serverName: string): string[] =>
    (tools?.tools ?? []).filter((tool) => tool.server === serverName).map((tool) => tool.name)

  /** Whether this server already has all of its tools pinned. */
  const allPinned = (serverName: string): boolean => {
    const names = allToolsOf(serverName)
    return names.length > 0 && names.every((name) => pinnedSet.has(name))
  }

  /** Whether the list is in a filtered mode (auto-expands matching cards). */
  const filtering = toolQuery.trim().length > 0 || onlyPinned

  /** Same-family servers, computed once per render (18 servers ≈ trivial). */
  const duplicates = findDuplicates(tools?.tools ?? [])
  /** Pinned tool names as a Set: the card rows ask per tool. */
  const pinnedSet = new Set(prefs.pins)

  const toggleExpand = (serverName: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(serverName)) next.delete(serverName)
      else next.add(serverName)
      return next
    })
  }

  if (state.loadState === 'loading') {
    return <p className={css.status} aria-busy="true">{t('loading')}</p>
  }
  if (state.loadState === 'error') {
    return (
      <div className={css.failure}>
        <p className={css.failureText} role="alert">{t('loadError')}</p>
        {hostMissing ? <p className={`${css.muted} ${css.failureText}`}>{t('loadErrorHostMissing')}</p> : null}
        {loadErrorDetail !== null ? <pre className={css.muted}>{loadErrorDetail}</pre> : null}
        <button type="button" className={controls.button} onClick={() => { setLoadState('loading'); load() }}>{t('retry')}</button>
      </div>
    )
  }
  if (state.draft !== null) {
    const actions = {
      updateDraft,
      cancelEdit,
      setBusy,
      setTestRunning,
      setTest,
      setServers,
    }
    const form = (
      <McpServerForm
        draft={state.draft}
        busy={state.busy}
        testRunning={state.testRunning}
        test={state.test}
        t={t}
        actions={actions}
        injected={{ save, remove, test, list, oauthStart, oauthStatus }}
        onSaved={(serverName, warning) => {
          // Mounting is asynchronous: refresh again after the connection
          // settles so the badge and tool count reflect the live state without
          // a manual refresh (mirrors the enable-toggle path). The name is
          // carried out of the form because `cancelEdit` nulls the draft
          // before this callback runs.
          if (warning !== undefined) setActionNotice(warning)
          if (serverName.length === 0) return
          timersRef.current.push(window.setTimeout(() => refreshServer(serverName), 2000))
          timersRef.current.push(window.setTimeout(() => refreshServer(serverName), 6000))
        }}
      />
    )
    inlineForm = form
  }

  return (
    <div className={css.section}>
      <div className={css.placementRow}>
        <span className={css.placementLabel}>{t('placementLabel')}</span>
        {MCP_PLACEMENTS.map(option => (
          <label key={option} className={css.modeOption}>
            <input
              type="radio"
              name="mcp-placement"
              checked={prefs.placement === option}
              disabled={placementSaving}
              onChange={() => pickPlacement(option)}
            />
            {t(PLACEMENT_LABEL_KEY[option])}
          </label>
        ))}
      </div>
      <p className={css.modeHint}>{placementSaving ? t('placementSaving') : t('placementHint')}</p>
      {placementError !== null
        ? <p className={css.failure}>{t('placementFailed')}{placementError}</p>
        : null}
      <div className={css.modeRow}>
        <span className={css.modeLabel}>{t('toolsModeLabel')}</span>
        <label className={css.modeOption}>
          <input
            type="radio"
            name="mcp-tool-mode"
            checked={mode === 'search'}
            onChange={() => setMode('search')}
          />
          {t('toolsModeSearch')}
        </label>
        <label className={css.modeOption}>
          <input
            type="radio"
            name="mcp-tool-mode"
            checked={mode === 'full'}
            onChange={() => setMode('full')}
          />
          {t('toolsModeFull')}
        </label>
      </div>
      <p className={css.modeHint}>
        {toolsError !== null ? toolsError : tools === null ? t('toolsLoading') : mode === 'search' ? t('toolsHintSearch') : t('toolsHintFull')}
      </p>

      <div className={css.module}>
        <button
          type="button"
          className={`${controls.button} ${css.moduleTitle}`}
          aria-expanded={envOpen}
          onClick={() => setEnvOpen(open => !open)}
        >
          <span className={css.caret}>{envOpen ? '▾' : '▸'}</span>
          {t('globalEnv')}
        </button>
        {envOpen ? (
          <GlobalEnvEditor
            injected={{ envList: props.envList, envSet: props.envSet }}
            t={t}
            onApplied={() => {
              // New process env may feed stdio children and header
              // substitution: refresh server rows (connection attempts
              // re-resolve env) but keep the tool list.
              refreshServer('')
            }}
          />
        ) : null}
      </div>

      <div className={css.module}>
        <div className={css.configHeader}>
          <span className={css.moduleTitle}>{t('configTitle')}</span>
          <div className={css.configActions}>
            <button
              type="button"
              className={jsonOpen ? `${controls.button} ${css.active}` : controls.button}
              aria-expanded={jsonOpen}
              onClick={() => setJsonOpen(open => !open)}
            >
              {jsonOpen ? t('serversJsonBack') : t('serversJson')}
            </button>
            <button
              type="button"
              className={`${controls.button} ${controls.primary}`}
              onClick={() => {
                // The JSON panel replaces the list; starting a new server while
                // it is open would stack the form above the editor for nothing.
                setJsonOpen(false)
                beginCreate()
              }}
            >
              {t('addServer')}
            </button>
          </div>
        </div>
        {actionError !== null ? (
          <p className={css.warn} role="alert">{t('actionFailed')}: {actionError}</p>
        ) : null}
        {actionNotice !== null ? (
          <p className={css.note} role="status">{t('actionNotice')}: {actionNotice}</p>
        ) : null}
        {jsonOpen ? (
          <ServersJsonEditor
            injected={{ list: props.list, upsertJson: props.upsertJson }}
            t={t}
            onApplied={() => {
              // The whole list changed on the Host: refresh the server rows and
              // the tool list, then close the JSON panel to show the UI list.
              refreshServer('')
              refreshTools()
              setJsonOpen(false)
              // Mounting is asynchronous: refresh again after the connection
              // settles so badges/tool counts reflect the live state.
              timersRef.current.push(window.setTimeout(() => refreshServer(''), 2000))
              timersRef.current.push(window.setTimeout(() => refreshServer(''), 6000))
            }}
          />
        ) : null}

        {state.draft !== null && state.draft.id === null ? (
          <div className={css.inlineForm}>{inlineForm}</div>
        ) : null}

        {jsonOpen ? null : state.servers.length === 0 ? (
          <p className={css.status}>{t('empty')}</p>
        ) : (
        <>
        <div className={css.listControls}>
          <input
            className={css.toolSearch}
            type="search"
            value={toolQuery}
            placeholder={t('listSearch')}
            onChange={(event) => setToolQuery(event.target.value)}
          />
          <label className={css.pinToggle}>
            <input
              type="checkbox"
              checked={onlyPinned}
              onChange={(event) => setOnlyPinned(event.target.checked)}
            />
            {t('onlyPinned')} {prefs.pins.length > 0 ? `(${prefs.pins.length})` : ''}
          </label>
        </div>
        <p className={css.modeHint}>{t('pinExplainer')}</p>
        {prefs.pins.length > 0 ? (
          <div className={css.pinnedBlock}>
            <div className={css.pinnedHeader}>
              <span className={css.pinnedTitle}>{fillTemplate(t('pinnedTitle'), { count: prefs.pins.length })}</span>
              <button
                type="button"
                className={controls.button}
                onClick={() => applyPins(prefs.pins, false)}
              >
                {t('pinnedClearAll')}
              </button>
            </div>
            <div className={css.pinnedGroups}>
              {groupPins(prefs.pins).map(([server, names]) => (
                <div key={server} className={css.pinnedGroup}>
                  <span className={css.pinnedServer}>{server}</span>
                  <span className={css.pinnedChips}>
                    {names.map((name) => (
                      <span key={name} className={css.pinnedChip}>
                        {tailOf(name)}
                        <button
                          type="button"
                          className={`${controls.button} ${css.pinnedRemove}`}
                          title={t('pinTooltipUnpin')}
                          aria-label={t('pinTooltipUnpin')}
                          onClick={() => applyPins([name], false)}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    className={`${controls.button} ${css.pinnedGroupClear}`}
                    title={t('pinnedGroupClearHint')}
                    onClick={() => applyPins(names, false)}
                  >
                    {t('pinnedGroupClear')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <ul className={css.list}>
          {state.servers.flatMap(server => {
            const isRefreshing = refreshing.has(server.serverName)
            const serverToolList = serverTools(server.serverName)
            // A filter narrows the whole list: hide servers with no match and
            // open the ones that do, so a search never hides its own result.
            if (filtering && serverToolList.length === 0) return []
            const isExpanded = expanded.has(server.serverName) || filtering
            const duplicate = duplicates.get(server.serverName)
            // Declared servers are mounted by the composition, so this page
            // only views them: no enable/disable, no refresh, no editor.
            const declared = server.source === 'cordis'
            // OAuth state of a managed row: unauthorized rows carry the red
            // button (and never the raw authorization-link error), a pending
            // flow reads as "awaiting authorization", and once tokens are
            // stored the button disappears.
            const oauthManaged = !declared && server.oauth === true
            const oauthAuthorized = server.oauthAuthorized === true
            const oauthNeedsAuth = oauthManaged && !oauthAuthorized
            // A server that is live and serving tools does not need the red
            // "not authorized" alarm even without OAuth tokens (its static
            // headers may be enough): keep a plain button, drop the alarm.
            const oauthUsable = server.status.phase === 'live' && server.status.tools.length > 0
            const oauthBlocks = oauthNeedsAuth && !oauthUsable
            const oauthPending = oauthNeedsAuth && server.status.oauthRequired === true
            const oauthInFlight = oauthNeedsAuth
              && (oauthStarting.has(server.serverName) || oauthWaiting.has(server.serverName))
            // The mount's "authorization required" error embeds the link (and
            // only that error does); it is recognized across host versions so
            // the row shows the button hint instead of the raw link text.
            const oauthLinkError = oauthNeedsAuth
              && typeof server.status.error === 'string'
              && server.status.error.includes('response_type=code')
            /** Manual fallback for the authorization page (the Host opens the browser itself). */
            const oauthLink = oauthLinks.get(server.serverName)
            const oauthError = oauthErrors.get(server.serverName)
            const oauthIncompleteHere = oauthIncomplete.has(server.serverName)
            const card = (
              <li key={server.id} className={css.card}>
                <div className={css.row}>
                  <div className={css.rowMain}>
                    <div className={css.rowTitle}>
                      <span className={css.serverName}>{server.serverName}</span>
                      {declared ? <span className={`${css.badge} ${css.cordis}`}>{t('sourceCordis')}</span> : null}
                      {/* A name the composition currently serves is declared, not
                          disabled: showing the mount phase as "未启用" would be wrong
                          and the enable/disable button cannot take effect. */}
                      {server.pendingTakeover ? (
                        <span className={`${css.badge} ${css.cordis}`}>{t('pendingBadge')}</span>
                      ) : server.conflict ? (
                        <span className={`${css.badge} ${css.cordis}`}>{t('conflictBadge')}</span>
                      ) : oauthPending ? (
                        /* A flow is waiting for the user: the pending state,
                           never a pre-authorization failure. */
                        <span className={`${css.badge} ${css.oauth}`}>{t('oauthBadgeWaiting')}</span>
                      ) : oauthBlocks ? (
                        <span className={`${css.badge} ${css.oauthMiss}`}>{t('oauthBadgeUnauthorized')}</span>
                      ) : (
                        <span className={`${css.badge} ${css[server.status.phase]}`}>{t(phaseKey(server.status.phase))}</span>
                      )}
                      {!server.enabled && server.status.phase !== 'stopped' ? <span className={css.muted}>{t('statusStopped')}</span> : null}
                    </div>
                    <div className={css.rowMeta}>
                      <span>{server.transport}</span>
                      <span>{t('toolCount')}: {server.status.tools.length}</span>
                      <span>{t('envVars')}: {server.env.length}</span>
                      {duplicate === undefined ? null : (
                        <span className={css.duplicateHint}>
                          {fillTemplate(t('duplicateBadge'), { server: duplicate.server, count: duplicate.count })}
                        </span>
                      )}
                    </div>
                    {server.declaredIn ? (
                      <p className={css.path} title={server.declaredIn}>{t('declaredIn')}: {server.declaredIn}</p>
                    ) : null}
                    {server.conflict ? <p className={css.warn}>{t('conflictDeclared')}</p> : null}
                    {server.needsPlugin ? <p className={css.warn}>{t('needsPluginHint')}</p> : null}
                    {/* The authorization outcome, always visible: authorizing
                        (with a manual link), the failure reason reported by the
                        authorization server, "did not complete", or the short
                        "click the button" hint. Only non-authorization failures
                        keep the raw mount error. */}
                    {oauthInFlight || (oauthPending && oauthLink !== undefined) ? (
                      <p className={css.note}>
                        {t('oauthInProgress')}
                        {oauthLink !== undefined ? (
                          <>
                            {' · '}
                            <a href={oauthLink} target="_blank" rel="noreferrer">{t('oauthOpenManual')}</a>
                          </>
                        ) : null}
                      </p>
                    ) : oauthError !== undefined ? (
                      <p className={css.warn}>{t('oauthFailed')}: {oauthError}</p>
                    ) : oauthIncompleteHere ? (
                      <p className={css.note}>{t('oauthNotCompleted')}</p>
                    ) : oauthPending || oauthBlocks ? (
                      <p className={css.note}>{t('oauthRequiredHint')}</p>
                    ) : oauthLinkError && !oauthUsable ? (
                      <p className={css.note}>{t('oauthRequiredHint')}</p>
                    ) : server.status.error ? <p className={css.warn}>{server.status.error}</p> : null}
                    {declared ? <p className={css.note}>{t('readOnlyHint')}</p> : null}
                    {server.stale ? <p className={css.note}>{t('staleMirror')}</p> : null}
                    {server.skipReason === 'js-expression' ? <p className={css.warn}>{t('skipJsExpr')}</p> : null}
                    {server.pendingTakeover ? <p className={css.note}>{t('pendingTakeover')}</p> : null}
                    {declared && server.oauthHint ? <p className={css.warn}>{t('oauthHint')}</p> : null}
                  </div>
                  <div className={css.rowActions}>
                    {declared || server.conflict || server.pendingTakeover ? null : (
                      <button
                        type="button"
                        // Stopping a running server is destructive-ish: it drops its
                        // tools from the model, so it carries the error color.
                        className={server.enabled ? `${controls.button} ${css.dangerButton}` : controls.button}
                        disabled={isRefreshing}
                        onClick={() => void toggleEnabled(server)}
                      >
                        {server.enabled ? t('disable') : t('enabled')}
                      </button>
                    )}
                    {/* Unauthorized OAuth servers keep the button; it is red
                        only when the missing authorization actually blocks the
                        server (not live with tools). It reads "authorizing…"
                        from the click on and the 5s poll hides it once tokens
                        land. */}
                    {oauthNeedsAuth && !server.conflict && !server.pendingTakeover ? (
                      <button
                        type="button"
                        className={oauthBlocks ? `${controls.button} ${css.dangerButton}` : controls.button}
                        onClick={() => void runOAuth(server)}
                      >
                        {oauthInFlight ? t('oauthInProgress') : t('oauthAuthorize')}
                      </button>
                    ) : null}
                    {declared ? null : (
                      <button type="button" className={controls.button} disabled={isRefreshing} onClick={() => refreshServer(server.serverName)}>
                        {isRefreshing ? t('refreshing') : t('refresh')}
                      </button>
                    )}
                    {declared && server.adoptable ? (
                      <button type="button" className={controls.button} disabled={adopting.has(server.serverName)} onClick={() => void runAdopt(server)}>
                        {adopting.has(server.serverName) ? t('adopting') : t('adopt')}
                      </button>
                    ) : null}
                    {server.adopted ? (
                      <button type="button" className={controls.button} disabled={adopting.has(server.serverName)} onClick={() => void runAdopt(server)}>
                        {adopting.has(server.serverName) ? t('releasing') : t('release')}
                      </button>
                    ) : null}
                    {filtering ? null : (
                      <button type="button" className={controls.button} onClick={() => toggleExpand(server.serverName)}>
                        {isExpanded ? t('toolsCollapse') : t('toolsExpand')}
                      </button>
                    )}
                    {declared ? null : <button type="button" className={controls.button} onClick={() => beginEdit(server)}>{t('edit')}</button>}
                  </div>
                </div>
                {isExpanded ? (
                  <div className={css.toolPanel}>
                    <div className={css.aliasRow}>
                      <span className={css.aliasLabel}>{t('aliasLabel')}</span>
                      <input
                        className={css.aliasInput}
                        value={aliasDraft[server.serverName] ?? (prefs.aliases[server.serverName] ?? []).join(',')}
                        placeholder={t('aliasPlaceholder')}
                        title={t('aliasHint')}
                        onChange={(event) => setAliasDraft((prev) => ({ ...prev, [server.serverName]: event.target.value }))}
                        onBlur={() => {
                          // Auto-save: a lone 保存 button here read as "save what?",
                          // and the field is the only thing in this row that edits.
                          if (aliasDraft[server.serverName] !== undefined) saveAliasInput(server.serverName)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveAliasInput(server.serverName)
                        }}
                      />
                      {aliasBusy.has(server.serverName)
                        ? <span className={css.aliasStatus}>{t('aliasSaving')}</span>
                        : null}
                      <button
                        type="button"
                        className={`${controls.button} ${css.pinAll}`}
                        onClick={() => applyPins(allToolsOf(server.serverName), !allPinned(server.serverName))}
                        title={t('pinAllHint')}
                      >
                        {allPinned(server.serverName)
                          ? t('pinAllOff')
                          : fillTemplate(t('pinAllOn'), { count: allToolsOf(server.serverName).length })}
                      </button>
                    </div>
                    {tools === null ? (
                      <p className={css.muted}>{toolsError ?? t('toolsLoading')}</p>
                    ) : serverToolList.length === 0 ? (
                      <p className={css.muted}>{filtering ? t('toolsEmptyFiltered') : t('toolsEmpty')}</p>
                    ) : (
                      <ul className={css.toolList}>
                        {serverToolList.map(tool => {
                          const isPinned = pinnedSet.has(tool.name)
                          return (
                            <li
                              key={tool.name}
                              className={tool.enabled ? css.toolRow : `${css.toolRow} ${css.toolRowOff}`}
                              onPointerDown={(event) => paintStart(tool, event)}
                              onPointerEnter={() => paintOver(tool)}
                            >
                              <input
                                type="checkbox"
                                checked={tool.enabled}
                                title={t('toolEnableHint')}
                                aria-label={`${tool.name} ${t('toolEnableHint')}`}
                                onChange={() => toggleTool(tool)}
                              />
                              <span className={css.toolName} title={tool.name}>{tailOf(tool.name)}</span>
                              <span className={css.helpWrap}>
                                <button
                                  type="button"
                                  className={`${controls.button} ${css.helpButton}`}
                                  aria-label={t('descHelp')}
                                >
                                  ?
                                </button>
                                <span className={css.helpTip} role="tooltip">{tool.description}</span>
                              </span>
                              <button
                                type="button"
                                className={isPinned ? `${controls.button} ${css.pinOn}` : `${controls.button} ${css.pinOff}`}
                                aria-pressed={isPinned}
                                onClick={() => applyPins([tool.name], !isPinned)}
                              >
                                {isPinned ? t('pinActionOn') : t('pinActionOff')}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            )
            // Editing this server: the form REPLACES the row, in the same slot.
            // Rendering both left the old card (with its 禁用/刷新/编辑 buttons)
            // stacked above the editor, which read as two different servers.
            if (state.draft !== null && state.draft.id === server.id) {
              return [<li key={`${server.id}-form`} className={css.inlineFormItem}>{inlineForm}</li>]
            }
            return [card]
          })}
        </ul>
        </>
      )}
      </div>
    </div>
  )
}
