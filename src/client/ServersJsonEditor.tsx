/**
 * JSON server-config editor: view and edit the whole MCP server list as one
 * JSON document. The document is an array of server definitions (the same
 * shape the add/edit form submits); applying it replaces the whole list —
 * listed servers are created or updated, existing servers absent from the
 * document are removed. Secret env values are never exported (a `configured`
 * flag marks them) and a blank secret value keeps the stored one.
 *
 *   [
 *     {
 *       "serverName": "feishu-mcp",
 *       "transport": "streamable-http",
 *       "enabled": true,
 *       "url": "https://.../mcp",
 *       "headers": { "Authorization": "Bearer ..." },
 *       "toolCallTimeoutMs": 60000,
 *       "failOnStartupError": true,
 *       "env": []
 *     }
 *   ]
 * @module dsh-mcp/client/ServersJsonEditor
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { McpServerView } from './types.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './ServersJsonEditor.module.css'

/** One { server, env } entry submitted to the Host's upsertJson. */
export interface ServersJsonEntry {
  readonly server: Record<string, unknown>
  readonly env: readonly unknown[]
}

/** Host Remote face required by the JSON editor. */
export interface ServersJsonRemote {
  /** Read the current server list. */
  list: () => Promise<readonly McpServerView[]>
  /** Replace the whole server list; returns change counts. */
  upsertJson: (servers: readonly ServersJsonEntry[]) => Promise<{ added: number; updated: number; removed: number }>
}

/** Props for the JSON editor panel. */
export interface ServersJsonEditorProps {
  readonly injected: ServersJsonRemote
  readonly t: (key: McpSettingsLocaleKey) => string
  /** Called after a successful apply; the parent refreshes the page. */
  readonly onApplied: () => void
}

/** Serialize the current server list into the JSON document text. */
export function serversToJsonText(servers: readonly McpServerView[]): string {
  const document = servers.map((server) => {
    const entry: Record<string, unknown> = {
      serverName: server.serverName,
      transport: server.transport,
      enabled: server.enabled,
    }
    if (server.transport === 'stdio') {
      entry.command = server.command
      entry.args = [...server.args]
      if (server.cwd.length > 0) entry.cwd = server.cwd
    } else {
      entry.url = server.url
    }
    if (server.headers.length > 0) {
      entry.headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
    }
    entry.toolCallTimeoutMs = server.toolCallTimeoutMs
    entry.failOnStartupError = server.failOnStartupError
    entry.env = server.env.map(row => row.secret
      ? { name: row.name, secret: true, configured: row.configured }
      : { name: row.name, secret: false, ...(row.value !== undefined && row.value.length > 0 ? { value: row.value } : {}) })
    return entry
  })
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Structural validation; deep validation (paths, URLs) happens on the Host. */
export function parseServersJson(text: string): { ok: true; servers: readonly ServersJsonEntry[] } | { ok: false; error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'JSON 顶层必须是服务器配置数组：[ { serverName, transport, ... }, ... ]' }
  }
  if (value.length === 0) {
    return { ok: false, error: '配置列表不能为空' }
  }
  const servers: ServersJsonEntry[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: '每个条目必须是对象：{ serverName, transport, ... }' }
    }
    const server = item as Record<string, unknown>
    const serverName = typeof server.serverName === 'string' ? server.serverName.trim() : ''
    if (serverName.length === 0) return { ok: false, error: 'serverName 不能为空' }
    if (seen.has(serverName)) return { ok: false, error: `serverName "${serverName}" 重复` }
    seen.add(serverName)
    const transport = server.transport
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      return { ok: false, error: `服务器 "${serverName}" 的 transport 必须是 stdio 或 streamable-http` }
    }
    if (transport === 'stdio' && (typeof server.command !== 'string' || server.command.trim().length === 0)) {
      return { ok: false, error: `服务器 "${serverName}"（stdio）缺少 command` }
    }
    if (transport === 'streamable-http' && typeof server.url !== 'string') {
      return { ok: false, error: `服务器 "${serverName}"（streamable-http）缺少 url` }
    }
    if (server.headers !== undefined) {
      const headers = server.headers as unknown
      const okHeaders = (headers !== null && typeof headers === 'object' && !Array.isArray(headers))
        || (Array.isArray(headers) && headers.every(h => h !== null && typeof h === 'object' && typeof (h as { name?: unknown }).name === 'string'))
      if (!okHeaders) return { ok: false, error: `服务器 "${serverName}" 的 headers 必须是 { "名称": "值" } 对象或 { name, value } 数组` }
    }
    const envValue = server.env
    const env: unknown[] = Array.isArray(envValue) ? envValue : []
    for (const row of env) {
      const r = row as Record<string, unknown> | null
      if (r === null || typeof r !== 'object' || typeof r.name !== 'string' || r.name.trim().length === 0) {
        return { ok: false, error: `服务器 "${serverName}" 的 env 条目缺少合法的 name` }
      }
      if (r.secret !== undefined && typeof r.secret !== 'boolean') {
        return { ok: false, error: `服务器 "${serverName}" 的 env 条目 "${r.name}" 的 secret 必须是布尔值` }
      }
      if (r.value !== undefined && typeof r.value !== 'string') {
        return { ok: false, error: `服务器 "${serverName}" 的 env 条目 "${r.name}" 的 value 必须是字符串` }
      }
    }
    servers.push({ server, env })
  }
  return { ok: true, servers }
}

/** Render the JSON server-config editor panel. */
export function ServersJsonEditor({ injected, t, onApplied }: ServersJsonEditorProps): ReactNode {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const seqRef = useRef(0)

  // Seed the document once with the current server list.
  useEffect(() => {
    if (loaded) return
    let current = true
    void injected.list().then(
      (servers) => {
        if (!current) return
        setText(serversToJsonText(servers))
        setLoaded(true)
        setError(null)
      },
      () => { if (current) setError('无法读取服务器列表') },
    )
    return () => { current = false }
  }, [injected, loaded])

  const reseed = (): void => {
    const seq = ++seqRef.current
    setBusy(true)
    setNotice(null)
    void injected.list().then(
      (servers) => {
        if (seq !== seqRef.current) return
        setText(serversToJsonText(servers))
        setError(null)
      },
      () => { if (seq === seqRef.current) setError('无法读取服务器列表') },
    ).finally(() => {
      if (seq === seqRef.current) setBusy(false)
    })
  }

  const apply = (): void => {
    const parsed = parseServersJson(text)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    if (!window.confirm(t('serversJsonConfirm'))) return
    const seq = ++seqRef.current
    setBusy(true)
    setError(null)
    setNotice(null)
    void injected.upsertJson(parsed.servers).then(
      (result) => {
        if (seq !== seqRef.current) return
        setNotice(`${t('serversJsonDone')}: +${result.added} / ~${result.updated} / -${result.removed}`)
        onApplied()
      },
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
        rows={16}
        spellCheck={false}
        aria-label={t('serversJsonLabel')}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <p className={css.hint}>{t('serversJsonHint')}</p>
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      {notice !== null ? <p className={css.notice} role="status">{notice}</p> : null}
      <div className={css.actions}>
        <button type="button" disabled={busy} onClick={reseed}>{t('serversJsonReseed')}</button>
        <button type="button" className={css.primary} disabled={busy} onClick={apply}>
          {busy ? t('serversJsonSaving') : t('serversJsonApply')}
        </button>
      </div>
    </div>
  )
}
