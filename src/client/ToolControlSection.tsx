/**
 * Tool-control section merged into the MCP settings page: injection-mode
 * selector (full / on-demand search) plus per-tool enable switches grouped by
 * MCP server. Reads and writes the Host's tool-control Remote methods; all
 * state is process-local on the Host, so the page just reflects it.
 * @module dsh-mcp/client/ToolControlSection
 */

import { useEffect, useState, type ReactNode } from 'react'
import type {
  McpToolInjectionMode, McpToolView, McpToolsState,
} from './types.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './ToolControlSection.module.css'

/** Host Remote face required by this section. */
export interface McpToolControlRemote {
  /** Read the tool-control state. */
  toolsList: () => Promise<McpToolsState>
  /** Set one tool's enable switch. */
  toolsSet: (request: { name: string; enabled: boolean }) => Promise<{ ok: boolean }>
  /** Switch the injection mode. */
  toolsMode: (request: { mode: McpToolInjectionMode }) => Promise<{ ok: boolean }>
}

/** Props: the injected Remote face plus the bound locale `t`. */
export interface ToolControlSectionProps {
  readonly injected: McpToolControlRemote
  readonly t: (key: McpSettingsLocaleKey) => string
}

/** Display name of one tool: the raw `mcp__<server>__<tool>` tail. */
function rawOf(name: string): string {
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  return i < 0 ? rest : rest.slice(i + 2)
}

/** Render the mode selector and grouped per-tool switches. */
export function ToolControlSection({ injected, t }: ToolControlSectionProps): ReactNode {
  const [state, setState] = useState<McpToolsState | null>(null)

  const refresh = (): void => {
    void injected.toolsList().then(setState, () => setState(null))
  }

  useEffect(() => {
    let current = true
    void injected.toolsList().then(
      (next) => { if (current) setState(next) },
      () => { if (current) setState(null) },
    )
    return () => { current = false }
  }, [injected])

  const setMode = (mode: McpToolInjectionMode): void => {
    void injected.toolsMode({ mode }).then(refresh, (error) => {
      console.error('[dsh-mcp] toolsMode failed:', error)
      refresh()
    })
  }
  const toggle = (tool: McpToolView): void => {
    void injected.toolsSet({ name: tool.name, enabled: !tool.enabled }).then(refresh, (error) => {
      console.error('[dsh-mcp] toolsSet failed:', error)
      refresh()
    })
  }

  const groups = new Map<string, McpToolView[]>()
  for (const tool of state?.tools ?? []) {
    const bucket = groups.get(tool.server) ?? []
    bucket.push(tool)
    groups.set(tool.server, bucket)
  }
  const servers = [...groups.keys()].sort()

  const rows: ReactNode[] = []
  for (const server of servers) {
    rows.push(
      <div key={server} className={css.groupTitle}>
        {server}（{groups.get(server)!.length} 个）
      </div>,
    )
    for (const tool of groups.get(server)!) {
      rows.push(
        <label key={tool.name} className={css.row} title={tool.name}>
          <input
            type="checkbox"
            checked={tool.enabled}
            onChange={() => toggle(tool)}
          />
          <span className={css.name}>{rawOf(tool.name)}</span>
          <span className={css.desc}>{tool.description}</span>
        </label>,
      )
    }
  }

  return (
    <section className={css.section}>
      <h3 className={css.title}>{t('toolsTitle')}</h3>
      <div className={css.mode}>
        <span className={css.modeLabel}>{t('toolsModeLabel')}</span>
        <label>
          <input
            type="radio"
            name="mcp-tool-mode"
            checked={state?.mode === 'full'}
            onChange={() => setMode('full')}
          />
          {t('toolsModeFull')}
        </label>
        <label>
          <input
            type="radio"
            name="mcp-tool-mode"
            checked={state?.mode === 'search'}
            onChange={() => setMode('search')}
          />
          {t('toolsModeSearch')}
        </label>
      </div>
      <p className={css.hint}>
        {state === null
          ? t('toolsLoading')
          : state.mode === 'search'
            ? t('toolsHintSearch')
            : t('toolsHintFull')}
      </p>
      {state === null ? null : rows.length === 0 ? (
        <p className={css.hint}>{t('toolsEmpty')}</p>
      ) : (
        <div className={css.list}>{rows}</div>
      )}
    </section>
  )
}
