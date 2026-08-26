import { useState, type ReactNode } from 'react'
import type { McpManagerFailure, McpServerId, McpServerView } from './types.ts'
import type {
  McpDraft, McpTestOutcome,
} from './mcp-store.ts'
import { parseArgs } from './mcp-store.ts'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './ServerForm.module.css'

/** The Remote verbs the editor needs; structurally the section's inject face. */
export interface McpServerFormRemote {
  save: (draft: McpDraft) => Promise<McpManagerFailure | null>
  remove: (id: McpServerId) => Promise<McpManagerFailure | null>
  test: (draft: McpDraft) => Promise<McpTestOutcome>
  list: () => Promise<readonly McpServerView[]>
}

/** Store actions the editor drives. */
export interface McpServerFormActions {
  updateDraft: (patch: Partial<McpDraft>) => void
  cancelEdit: () => void
  setBusy: (busy: 'save' | 'remove' | null) => void
  setTestRunning: (running: boolean) => void
  setTest: (test: McpTestOutcome | null) => void
  setServers: (servers: readonly McpServerView[]) => void
}

/** Full editor props assembled by the section. */
export interface McpServerFormProps {
  draft: McpDraft
  busy: 'save' | 'remove' | null
  testRunning: boolean
  test: McpTestOutcome | null
  t: (key: McpSettingsLocaleKey) => string
  actions: McpServerFormActions
  injected: McpServerFormRemote
  /** Called after a successful save, before the editor closes. */
  onSaved?: () => void
}

/** Render the editor for one server draft. */
export function McpServerForm(props: McpServerFormProps): ReactNode {
  const { draft, busy, testRunning, test, t, actions, injected, onSaved } = props
  const [saveError, setSaveError] = useState<string | null>(null)

  const update = (patch: Partial<McpDraft>): void => {
    setSaveError(null)
    actions.updateDraft(patch)
  }

  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  const runTest = async (): Promise<void> => {
    setSaveError(null)
    actions.setTestRunning(true)
    try {
      actions.setTest(await injected.test(draft))
    } catch (error) {
      console.error('[dsh-mcp] test failed:', error)
      actions.setTest(null)
      setSaveError(errorText(error))
    } finally {
      actions.setTestRunning(false)
    }
  }

  const submit = async (): Promise<void> => {
    setSaveError(null)
    actions.setBusy('save')
    try {
      const failure = await injected.save(draft)
      if (failure !== null) {
        setSaveError(`${failure.code}: ${failure.message}`)
        return
      }
      if (!await refresh()) return
      actions.cancelEdit()
      onSaved?.()
    } catch (error) {
      console.error('[dsh-mcp] save failed:', error)
      setSaveError(errorText(error))
    } finally {
      actions.setBusy(null)
    }
  }

  const removeServer = async (): Promise<void> => {
    if (draft.id === null || !window.confirm(t('removeConfirm'))) return
    setSaveError(null)
    actions.setBusy('remove')
    try {
      const failure = await injected.remove(draft.id)
      if (failure !== null) {
        setSaveError(`${failure.code}: ${failure.message}`)
        return
      }
      if (!await refresh()) return
      actions.cancelEdit()
    } catch (error) {
      console.error('[dsh-mcp] remove failed:', error)
      setSaveError(errorText(error))
    } finally {
      actions.setBusy(null)
    }
  }

  const refresh = async (): Promise<boolean> => {
    try {
      actions.setServers(await injected.list())
      return true
    } catch (error) {
      console.error('[dsh-mcp] refresh failed:', error)
      setSaveError(errorText(error))
      return false
    }
  }

  const stdio = draft.transport === 'stdio'
  const probe = test?.probe
  return (
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <div className={css.titleRow}>
        <h3 className={css.title}>{draft.id === null ? t('newTitle') : t('editTitle')}</h3>
        <div className={css.titleActions}>
          <button type="button" onClick={() => actions.cancelEdit()}>{t('backToList')}</button>
          {draft.id !== null ? (
            <button type="button" className={css.danger} disabled={busy !== null} onClick={() => void removeServer()}>
              {busy === 'remove' ? t('removing') : t('remove')}
            </button>
          ) : null}
        </div>
      </div>

      {saveError !== null ? <p className={css.error} role="alert">{saveError}</p> : null}

      <label className={css.field}>
        <span>{t('serverName')}</span>
        <input
          type="text"
          value={draft.serverName}
          placeholder={t('serverNameHint')}
          onChange={(event) => update({ serverName: event.currentTarget.value })}
        />
      </label>

      <label className={css.field}>
        <span>{t('transport')}</span>
        <select
          value={draft.transport}
          onChange={(event) => update({ transport: event.currentTarget.value as McpDraft['transport'] })}
        >
          <option value="stdio">{t('transportStdio')}</option>
          <option value="streamable-http">{t('transportHttp')}</option>
        </select>
      </label>

      {stdio ? (
        <>
          <label className={css.field}>
            <span>{t('command')}</span>
            <input
              type="text"
              value={draft.command}
              placeholder={t('commandPlaceholder')}
              onChange={(event) => update({ command: event.currentTarget.value })}
            />
          </label>
          <label className={css.field}>
            <span>{t('args')}</span>
            <textarea
              rows={3}
              value={draft.argsText}
              placeholder={t('argsPlaceholder')}
              onChange={(event) => update({ argsText: event.currentTarget.value })}
            />
            {(() => {
              const parsed = parseArgs(draft.argsText)
              if (parsed.length === 0) return <span className={css.muted}>{t('argsPreviewEmpty')}</span>
              const shown = parsed.map(arg => arg.length > 48 ? `${arg.slice(0, 45)}…` : arg).join(' | ')
              return <span className={css.muted}>{t('argsPreview')}: {parsed.length} · {shown}</span>
            })()}
          </label>
          <label className={css.field}>
            <span>{t('cwd')}</span>
            <input
              type="text"
              value={draft.cwd}
              placeholder={t('cwdPlaceholder')}
              onChange={(event) => update({ cwd: event.currentTarget.value })}
            />
            <span className={css.muted}>{t('cwdHint')}</span>
          </label>
        </>
      ) : (
        <>
          <label className={css.field}>
            <span>{t('url')}</span>
            <input
              type="url"
              value={draft.url}
              placeholder={t('urlPlaceholder')}
              onChange={(event) => update({ url: event.currentTarget.value })}
            />
          </label>
          <label className={css.field}>
            <span>{t('headers')}</span>
            <textarea
              rows={2}
              value={draft.headersText}
              placeholder={t('headersPlaceholder')}
              onChange={(event) => update({ headersText: event.currentTarget.value })}
            />
          </label>
        </>
      )}

      <label className={css.field}>
        <span>{t('toolCallTimeoutMs')}</span>
        <input
          type="number"
          min={1}
          value={draft.toolCallTimeoutMs}
          onChange={(event) => update({ toolCallTimeoutMs: event.currentTarget.value })}
        />
      </label>

      <label className={css.checkRow}>
        <input
          type="checkbox"
          checked={draft.failOnStartupError}
          onChange={(event) => update({ failOnStartupError: event.currentTarget.checked })}
        />
        {t('failOnStartupError')}
      </label>

      <label className={css.checkRow}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.currentTarget.checked })}
        />
        {t('enabled')}
      </label>

      {test !== null ? (
        <p className={`${css.testResult} ${probe !== undefined && probe.ok ? css.testOk : css.testFail}`} role="status">
          {probe !== undefined && probe.ok
            ? `${t('testOk')} (${probe.tools.length} ${t('toolCount')}, ${test.elapsedMs}ms)`
            : probe !== undefined && !probe.ok
              ? `${t('testFail')}: ${probe.message}`
              : t('testUnknown')}
        </p>
      ) : null}

      {testRunning && draft.transport === 'streamable-http' ? (
        <p className={css.muted} role="status">{t('testBrowserHint')}</p>
      ) : null}

      <div className={css.actions}>
        <button type="button" disabled={testRunning || busy !== null} onClick={() => void runTest()}>
          {testRunning ? t('testRunning') : t('test')}
        </button>
        <button type="submit" className={css.primary} disabled={busy !== null || testRunning}>
          {busy === 'save' ? t('saving') : t('save')}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => actions.cancelEdit()}>{t('cancel')}</button>
      </div>
    </form>
  )
}
