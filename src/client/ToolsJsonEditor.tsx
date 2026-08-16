/**
 * JSON tool-list editor: view and edit every MCP tool's enable switch as a
 * single JSON document, grouped by server:
 *
 *   {
 *     "feishu-mcp": { "create-doc": true, "search-user": false },
 *     "gitlab-mcp": { "get-user": true }
 *   }
 *
 * Applying the document submits the whole switch set to the Host in one
 * Remote call (toolsSetJson); the parent then refreshes the tool list.
 * @module dsh-mcp/client/ToolsJsonEditor
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { McpToolView } from './types.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './ToolsJsonEditor.module.css'

/** Host Remote face required by the JSON editor. */
export interface ToolsJsonRemote {
  /** Read the tool-control state (tools, mode). */
  toolsList: () => Promise<{ tools: readonly McpToolView[] }>
  /** Apply a batch of tool enable switches in one call. */
  toolsSetJson: (switches: Readonly<Record<string, boolean>>) => Promise<{ ok: boolean; count: number }>
}

/** Props for the JSON editor panel. */
export interface ToolsJsonEditorProps {
  readonly injected: ToolsJsonRemote
  readonly t: (key: McpSettingsLocaleKey) => string
  /** Called after a successful apply; the parent refreshes the tool list. */
  readonly onApplied: () => void
}

/** Display name of one tool: the raw `mcp__<server>__<tool>` tail. */
function rawOf(name: string): string {
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  return i < 0 ? rest : rest.slice(i + 2)
}

/**
 * Serialize the current tools into the nested JSON document text.
 * @param tools - Current tool rows from the Host.
 * @returns pretty-printed JSON text.
 */
export function toolsToJsonText(tools: readonly McpToolView[]): string {
  const byServer = new Map<string, Map<string, boolean>>()
  for (const tool of tools) {
    const bucket = byServer.get(tool.server) ?? new Map<string, boolean>()
    bucket.set(rawOf(tool.name), tool.enabled)
    byServer.set(tool.server, bucket)
  }
  const document: Record<string, Record<string, boolean>> = {}
  for (const server of [...byServer.keys()].sort()) {
    const bucket = byServer.get(server)!
    document[server] = Object.fromEntries([...bucket.entries()].sort())
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Parse and validate the JSON document text.
 * @param text - The editor content.
 * @returns the flat {fullName: boolean} switch set, or an error message.
 */
export function parseToolsJson(text: string): { ok: true; switches: Record<string, boolean> } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'JSON 顶层必须是对象：{ "服务器名": { "工具名": true/false } }' }
  }
  const switches: Record<string, boolean> = {}
  for (const [server, bucket] of Object.entries(value as Record<string, unknown>)) {
    if (server.trim().length === 0) return { ok: false, error: '服务器名不能为空' }
    if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) {
      return { ok: false, error: `服务器 "${server}" 的值必须是对象：{ "工具名": true/false }` }
    }
    for (const [tool, enabled] of Object.entries(bucket as Record<string, unknown>)) {
      if (tool.trim().length === 0) return { ok: false, error: `服务器 "${server}" 下存在空工具名` }
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: `工具 "${server} / ${tool}" 的值必须是 true 或 false` }
      }
      switches[`mcp__${server}__${tool}`] = enabled
    }
  }
  return { ok: true, switches }
}

/** Render the JSON tool-list editor panel. */
export function ToolsJsonEditor({ injected, t, onApplied }: ToolsJsonEditorProps): ReactNode {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const seqRef = useRef(0)

  // Seed the document once with the current switch state.
  useEffect(() => {
    if (loaded) return
    let current = true
    void injected.toolsList().then(
      (state) => {
        if (!current) return
        setText(toolsToJsonText(state.tools))
        setLoaded(true)
        setError(null)
      },
      () => { if (current) setError('无法读取工具列表') },
    )
    return () => { current = false }
  }, [injected, loaded])

  const reseed = (): void => {
    const seq = ++seqRef.current
    setBusy(true)
    void injected.toolsList().then(
      (state) => {
        if (seq !== seqRef.current) return
        setText(toolsToJsonText(state.tools))
        setError(null)
      },
      () => { if (seq === seqRef.current) setError('无法读取工具列表') },
    ).finally(() => {
      if (seq === seqRef.current) setBusy(false)
    })
  }

  const apply = (): void => {
    const parsed = parseToolsJson(text)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const seq = ++seqRef.current
    setBusy(true)
    setError(null)
    void injected.toolsSetJson(parsed.switches).then(
      () => { if (seq === seqRef.current) onApplied() },
      (error: unknown) => {
        if (seq !== seqRef.current) return
        setError(error instanceof Error ? error.message : String(error))
      },
    ).finally(() => {
      if (seq === seqRef.current) setBusy(false)
    })
  }

  return (
    <div className={css.panel}>
      <textarea
        className={css.editor}
        rows={14}
        spellCheck={false}
        aria-label={t('toolsJsonLabel')}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <p className={css.hint}>{t('toolsJsonHint')}</p>
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      <div className={css.actions}>
        <button type="button" disabled={busy} onClick={reseed}>{t('toolsJsonReseed')}</button>
        <button type="button" className={css.primary} disabled={busy} onClick={apply}>
          {busy ? t('toolsJsonSaving') : t('toolsJsonApply')}
        </button>
      </div>
    </div>
  )
}
