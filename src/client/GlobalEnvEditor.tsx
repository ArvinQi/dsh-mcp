/**
 * Process-level environment-variable editor: registers the variable names the
 * plugin may substitute into server headers. Values are never stored — they
 * are read from the process environment (process.env) by the same name at
 * connect time, so the editor is a name registry plus a live status check.
 * @module dsh-mcp/client/GlobalEnvEditor
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { McpEnvVarView } from './types.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './GlobalEnvEditor.module.css'

/** One editable row in the editor. */
interface EnvRowDraft {
  readonly key: string
  name: string
  configured: boolean
}

/** Host Remote face required by the editor. */
export interface GlobalEnvRemote {
  /** Read the registered variable names. */
  envList: () => Promise<{ vars: readonly McpEnvVarView[] }>
  /** Replace the whole registration (names only; values come from process.env). */
  envSet: (vars: readonly { name: string }[]) => Promise<{ vars: readonly McpEnvVarView[] }>
}

/** Props for the process env editor panel. */
export interface GlobalEnvEditorProps {
  readonly injected: GlobalEnvRemote
  readonly t: (key: McpSettingsLocaleKey) => string
  /** Called after a successful save; the parent refreshes the page. */
  readonly onApplied: () => void
}

let rowSeq = 0
function nextKey(): string {
  rowSeq += 1
  return `genv-${rowSeq}`
}

function emptyRow(): EnvRowDraft {
  return { key: nextKey(), name: '', configured: false }
}

/** Render the process-level environment-variable editor panel. */
export function GlobalEnvEditor({ injected, t, onApplied }: GlobalEnvEditorProps): ReactNode {
  const [rows, setRows] = useState<EnvRowDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const seqRef = useRef(0)

  const reload = (): void => {
    const seq = ++seqRef.current
    setLoadFailed(false)
    void injected.envList().then(
      (state) => {
        if (seq !== seqRef.current) return
        setRows(state.vars.map(row => ({
          key: nextKey(),
          name: row.name,
          configured: row.configured,
        })))
        setLoaded(true)
        setError(null)
      },
      (error: unknown) => {
        if (seq !== seqRef.current) return
        setLoadFailed(true)
        setError(error instanceof Error ? error.message : String(error))
      },
    )
  }

  useEffect(() => {
    if (loaded) return
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected, loaded])

  const update = (key: string, patch: Partial<EnvRowDraft>): void => {
    setRows(prev => prev.map(row => row.key === key ? { ...row, ...patch } : row))
  }
  const remove = (key: string): void => {
    setRows(prev => prev.filter(row => row.key !== key))
  }
  const add = (): void => {
    setRows(prev => [...prev, emptyRow()])
  }

  /** Parse lines (one per line) into variable-name rows. */
  const applyBulk = (): void => {
    const parsed = bulkText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
    if (parsed.length === 0) {
      setBulkOpen(false)
      return
    }
    const next: EnvRowDraft[] = []
    for (const line of parsed) {
      const eq = line.indexOf('=')
      const name = (eq > 0 ? line.slice(0, eq) : line).trim()
      if (name.length === 0) continue
      next.push({ key: nextKey(), name, configured: false })
    }
    if (next.length > 0) setRows(prev => [...prev, ...next])
    setBulkOpen(false)
    setBulkText('')
  }

  const save = (): void => {
    const vars: Array<{ name: string }> = []
    const seen = new Set<string>()
    for (const row of rows) {
      const name = row.name.trim()
      if (name.length === 0) continue // 空行跳过
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        setError(`变量名 "${name}" 必须是字母/数字/下划线，且以字母或下划线开头`)
        return
      }
      if (seen.has(name)) {
        setError(`变量名 "${name}" 重复`)
        return
      }
      seen.add(name)
      vars.push({ name })
    }
    const seq = ++seqRef.current
    setBusy(true)
    setError(null)
    setNotice(null)
    void injected.envSet(vars).then(
      (state) => {
        if (seq !== seqRef.current) return
        setRows(state.vars.map(row => ({
          key: nextKey(),
          name: row.name,
          configured: row.configured,
        })))
        setNotice(t('globalEnvDone'))
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
      <p className={css.hint}>{t('globalEnvHint')}</p>
      {rows.length === 0 && !loadFailed ? <p className={css.muted}>{t('globalEnvEmpty')}</p> : null}
      {rows.map(row => (
        <div key={row.key} className={css.row}>
          <input
            type="text"
            className={css.name}
            value={row.name}
            placeholder={t('globalEnvName')}
            aria-label={t('globalEnvName')}
            onChange={(event) => update(row.key, { name: event.currentTarget.value })}
          />
          <span className={`${css.statusBadge} ${row.configured ? css.statusOn : ''}`}>
            {row.configured ? t('globalEnvSet') : t('globalEnvUnset')}
          </span>
          <button type="button" className={css.danger} aria-label={t('globalEnvRemove')} onClick={() => remove(row.key)}>
            ✕
          </button>
        </div>
      ))}
      {loadFailed ? (
        <div className={css.retryRow}>
          <p className={css.error} role="alert">{t('globalEnvLoadFailed')}</p>
          <button type="button" onClick={reload}>{t('globalEnvRetry')}</button>
        </div>
      ) : null}
      {error !== null && !loadFailed ? <p className={css.error} role="alert">{error}</p> : null}
      {notice !== null ? <p className={css.notice} role="status">{notice}</p> : null}
      <div className={css.actions}>
        <button type="button" disabled={busy} onClick={add}>{t('globalEnvAdd')}</button>
        <button type="button" disabled={busy} onClick={() => setBulkOpen(true)}>{t('globalEnvBulk')}</button>
        <button type="button" className={css.primary} disabled={busy} onClick={save}>
          {busy ? t('globalEnvSaving') : t('globalEnvSave')}
        </button>
      </div>

      {bulkOpen ? (
        <div className={css.overlay} onClick={() => setBulkOpen(false)}>
          <div className={css.dialog} role="dialog" aria-label={t('globalEnvBulk')} onClick={(event) => event.stopPropagation()}>
            <p className={css.dialogTitle}>{t('globalEnvBulk')}</p>
            <p className={css.hint}>{t('globalEnvBulkPrompt')}</p>
            <textarea
              className={css.bulkText}
              rows={8}
              autoFocus
              spellCheck={false}
              value={bulkText}
              onChange={(event) => setBulkText(event.currentTarget.value)}
            />
            <div className={css.actions}>
              <button type="button" onClick={() => setBulkOpen(false)}>{t('cancel')}</button>
              <button type="button" className={css.primary} onClick={applyBulk}>{t('globalEnvBulkOk')}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
