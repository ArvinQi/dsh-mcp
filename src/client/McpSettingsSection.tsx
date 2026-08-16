import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  McpManagerFailure, McpServerId, McpServerView,
  McpToolInjectionMode, McpToolsState, McpToolView,
} from './types.ts'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { McpServerForm, type McpServerFormRemote } from './ServerForm.tsx'
import type { McpToolControlRemote } from './ToolControlSection.tsx'
import type { McpSettingsLocaleKey } from './locales.ts'
import { createMcpManagerStore, type McpDraft, type McpTestOutcome } from './mcp-store.ts'
import css from './McpSettingsSection.module.css'

/** Registration-side Remote face used by the section. */
export interface McpManagerInjected extends McpServerFormRemote, McpToolControlRemote {
  /** Read the current server list. */
  list: () => Promise<readonly McpServerView[]>
  /** Persist one draft; null means success, a failure is otherwise returned. */
  save: (draft: McpDraft) => Promise<McpManagerFailure | null>
  /** Delete one server; null means success, a failure is otherwise returned. */
  remove: (id: McpServerId) => Promise<McpManagerFailure | null>
  /** Probe one draft; `draft.id` lets stored secret values resolve. */
  test: (draft: McpDraft) => Promise<McpTestOutcome>
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

/** Raw `mcp__<server>__<tool>` tail, for the tool list. */
function rawOf(name: string): string {
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  return i < 0 ? rest : rest.slice(i + 2)
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
    env: server.env.map((entry, index) => ({
      key: `view-${index}`,
      name: entry.name,
      secret: entry.secret,
      value: '',
      configured: entry.configured,
    })),
    toolCallTimeoutMs: String(server.toolCallTimeoutMs),
    failOnStartupError: server.failOnStartupError,
  }
}

/**
 * Render the MCP management page: the injection-mode selector (default
 * on-demand search), the server list with per-server refresh and an expandable
 * per-server tool-binding list, or the editor when a draft is open.
 */
export function McpSettingsSection(props: McpSettingsSectionProps): ReactNode {
  const { list, save, remove, test } = props
  const state = props.useStore(snapshot => snapshot)
  const { setLoadState, setServers, beginCreate, beginEdit, cancelEdit, updateDraft, setBusy, setTestRunning, setTest } = props.actions
  const t = props.t

  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null)
  const [tools, setTools] = useState<McpToolsState | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set())
  const timersRef = useRef<number[]>([])

  useEffect(() => () => {
    for (const id of timersRef.current) window.clearTimeout(id)
  }, [])

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
    setLoadErrorDetail(String((error instanceof Error ? error.message : error) ?? error))
    setLoadState('error')
  }

  const load = (): void => {
    void list().then(
      (servers) => {
        setServers(servers)
        setLoadState('ready')
        setLoadErrorDetail(null)
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

  const toggleTool = (tool: McpToolView): void => {
    const next = !tool.enabled
    // Optimistic local toggle; the Host is the source of truth.
    setTools(prev => prev === null
      ? prev
      : { ...prev, tools: prev.tools.map(item => item.name === tool.name ? { ...item, enabled: next } : item) })
    void props.toolsSet({ name: tool.name, enabled: next }).catch((error) => {
      console.error('[dsh-mcp] toolsSet failed:', error)
      refreshTools()
    })
  }

  const refreshServer = (serverName: string): void => {
    setRefreshing(prev => new Set(prev).add(serverName))
    void Promise.all([
      list().then(
        (servers) => { setServers(servers); setLoadState('ready') },
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

  const toggleExpand = (serverName: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(serverName)) next.delete(serverName)
      else next.add(serverName)
      return next
    })
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

  const serverTools = (serverName: string): McpToolView[] =>
    (tools?.tools ?? []).filter(tool => tool.server === serverName)

  const mode = tools?.mode ?? 'search'

  if (state.loadState === 'loading') {
    return <p className={css.status} aria-busy="true">{t('loading')}</p>
  }
  if (state.loadState === 'error') {
    return (
      <div className={css.failure}>
        <p role="alert">{t('loadError')}</p>
        {loadErrorDetail !== null ? <pre className={css.muted}>{loadErrorDetail}</pre> : null}
        <button type="button" onClick={() => { setLoadState('loading'); load() }}>{t('retry')}</button>
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
    return (
      <McpServerForm
        draft={state.draft}
        busy={state.busy}
        testRunning={state.testRunning}
        test={state.test}
        t={t}
        actions={actions}
        injected={{ save, remove, test, list }}
        onSaved={() => {
          // Mounting is asynchronous: refresh again after the connection
          // settles so the badge and tool count reflect the live state without
          // a manual refresh (mirrors the enable-toggle path).
          const serverName = state.draft.serverName
          timersRef.current.push(window.setTimeout(() => refreshServer(serverName), 2000))
          timersRef.current.push(window.setTimeout(() => refreshServer(serverName), 6000))
        }}
      />
    )
  }

  return (
    <div className={css.section}>
      <div className={css.header}>
        <button type="button" className={css.primary} onClick={beginCreate}>{t('addServer')}</button>
      </div>

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

      {state.servers.length === 0 ? (
        <p className={css.status}>{t('empty')}</p>
      ) : (
        <ul className={css.list}>
          {state.servers.map(server => {
            const isExpanded = expanded.has(server.serverName)
            const isRefreshing = refreshing.has(server.serverName)
            const serverToolList = serverTools(server.serverName)
            return (
              <li key={server.id} className={css.card}>
                <div className={css.row}>
                  <div className={css.rowMain}>
                    <div className={css.rowTitle}>
                      <span className={css.serverName}>{server.serverName}</span>
                      <span className={`${css.badge} ${css[server.status.phase]}`}>{t(phaseKey(server.status.phase))}</span>
                      {!server.enabled && server.status.phase !== 'stopped' ? <span className={css.muted}>{t('statusStopped')}</span> : null}
                    </div>
                    <div className={css.rowMeta}>
                      <span>{server.transport}</span>
                      <span>{t('toolCount')}: {server.status.tools.length}</span>
                      <span>{t('envVars')}: {server.env.length}</span>
                    </div>
                  </div>
                  <div className={css.rowActions}>
                    <button type="button" disabled={isRefreshing} onClick={() => void toggleEnabled(server)}>
                      {server.enabled ? t('disable') : t('enabled')}
                    </button>
                    <button type="button" disabled={isRefreshing} onClick={() => refreshServer(server.serverName)}>
                      {isRefreshing ? t('refreshing') : t('refresh')}
                    </button>
                    <button type="button" onClick={() => toggleExpand(server.serverName)}>
                      {isExpanded ? t('toolsCollapse') : t('toolsExpand')}
                    </button>
                    <button type="button" onClick={() => beginEdit(server)}>{t('edit')}</button>
                  </div>
                </div>
                {isExpanded ? (
                  <div className={css.toolPanel}>
                    {tools === null ? (
                      <p className={css.muted}>{toolsError ?? t('toolsLoading')}</p>
                    ) : serverToolList.length === 0 ? (
                      <p className={css.muted}>{t('toolsEmpty')}</p>
                    ) : (
                      <div className={css.toolGrid}>
                        {serverToolList.map(tool => (
                          <label key={tool.name} className={css.toolRow} title={tool.name}>
                            <input
                              type="checkbox"
                              checked={tool.enabled}
                              onChange={() => toggleTool(tool)}
                            />
                            <span className={css.toolName}>{rawOf(tool.name)}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
