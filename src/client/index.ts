/**
 * MCP server management page, browser half.
 *
 * The page is one component registered on up to two seats:
 *   - `main` (keyed `mcp`) — the left-sidebar panel, whose rail entry lives in
 *     `sidebar.panellist`;
 *   - `settings.section` (id `mcp`) — the classic Settings page.
 *
 * Which seats exist is the user's choice (`placement`), persisted by the Host
 * and switched from the page itself. `main` stays registered even when the rail
 * entry is hidden so a panel selection can never dangle.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the sidebar's SlotMap merge (the 'sidebar.panellist' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the layout owner's SlotMap merge (the 'main' entry, ctx.layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Local wire vocabulary (vendored from the original mcp-manager types).
import type { McpManagerFailure, McpPlacement, McpPrefs, McpPrefsWrite, McpServerId, McpServerView, McpSurface } from './types.ts'
import { isMcpPlacement } from './types.ts'
import remoteContribution from './remote-contribution.js'
import { McpSettingsSection, type McpManagerInjected } from './McpSettingsSection.tsx'
import { McpPage } from './McpPage.tsx'
import { McpIcon } from './McpIcon.tsx'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'
import { createMcpManagerStore, draftToSubmission } from './mcp-store.ts'

/** Identity shared by the rail entry and the main panel it selects. */
export const PANEL_ID = 'mcp'

/** Settings nav position: after Plugins/Agent presets, before the plugin-contributed rows. */
const SETTINGS_ORDER = 25

/** Rail position: after Plugins (0) and Schedules (10), before the Steward panel (60). */
const RAIL_ORDER = 20

/** One Remote carrier result: success carries the decoded value, failure a code. */
type McpRemoteResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * Business outcome the Host returns *inside* a carrier result. `upsert` and
 * `delete` reject invalid specs and conflicts here rather than as a carrier
 * failure, so the caller must inspect `value.ok` — checking the carrier's own
 * `ok` swallows the Host's error and reports a false success.
 */
type McpHostOutcome<Value = unknown> =
  | ({ readonly ok: true } & Value)
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Business outcome of one prefs write (inside the transport carrier). */
type McpPrefsPatchOutcome =
  | ({ readonly ok: true } & McpPrefs)
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Wire face of the self-mounted `mcpManager` Remote namespace. */
interface McpManagerRemote {
  list(): Promise<McpRemoteResult<{ readonly servers: readonly McpServerView[] }>>
  upsert(request: {
    readonly id?: McpServerId
    readonly server: unknown
    /** Omitted or empty keeps the stored env unchanged. */
    readonly env?: readonly unknown[]
  }): Promise<McpRemoteResult<McpHostOutcome<{ readonly server: McpServerView }>>>
  delete(request: { readonly id: McpServerId }): Promise<McpRemoteResult<McpHostOutcome>>
  upsertJson(request: { readonly servers: readonly unknown[] }): Promise<McpRemoteResult<{
    readonly added: number
    readonly updated: number
    readonly removed: number
    readonly skipped?: number
    readonly servers: readonly McpServerView[]
  }>>
  test(request: {
    readonly id?: McpServerId
    readonly server: unknown
    readonly env: readonly unknown[]
  }): Promise<McpRemoteResult<{ readonly probe: unknown; readonly elapsedMs: number }>>
  toolsList(): Promise<McpRemoteResult<{ readonly tools: readonly unknown[]; readonly mode: unknown; readonly hotSize: number }>>
  toolsSet(request: { readonly name: string; readonly enabled: boolean }): Promise<McpRemoteResult<{ readonly ok: boolean }>>
  toolsMode(request: { readonly mode: unknown }): Promise<McpRemoteResult<{ readonly ok: boolean }>>
  envList(): Promise<McpRemoteResult<{ readonly vars: readonly unknown[] }>>
  envSet(request: { readonly vars: readonly unknown[] }): Promise<McpRemoteResult<{ readonly vars: readonly unknown[] }>>
  adopt(request: { readonly serverName: string }): Promise<McpRemoteResult<{
    readonly server: McpServerView
    readonly warning?: string
    readonly pendingRestart?: boolean
  }>>
  release(request: { readonly serverName: string }): Promise<McpRemoteResult<{ readonly warning?: string }>>
  oauthStart(request: {
    readonly id?: McpServerId
    readonly serverName?: string
    readonly url?: string
  }): Promise<McpRemoteResult<{ readonly serverName: string; readonly url: string }>>
  oauthStatus(request: { readonly serverName: string }): Promise<McpRemoteResult<{
    readonly serverName: string
    readonly authorized: boolean
    readonly pending: boolean
    readonly url?: string
    readonly expiresAt?: number
    readonly error?: string
  }>>
  uiPrefs(): Promise<McpRemoteResult<McpPrefs>>
  uiPrefsPatch(request: {
    readonly placement?: McpPlacement
    readonly pins?: readonly string[]
    readonly aliases?: Readonly<Record<string, readonly string[]>>
  }): Promise<McpRemoteResult<McpPrefsPatchOutcome>>
}

export type { McpSettingsSectionProps, McpManagerInjected } from './McpSettingsSection.tsx'
export type { McpServerFormProps } from './ServerForm.tsx'
export type { McpDraft, McpTestOutcome } from './mcp-store.ts'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP server management copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/**
 * Services required by the Settings registration and the Remote mount. The
 * `mcpManager` Remote namespace is NOT injected: this standalone plugin mounts
 * the contribution itself in `apply`, so waiting for `remote.mcpManager` here
 * would deadlock against its own mount.
 */
export const inject = ['slots', 'locale', 'remote']

/**
 * Resolve one Remote call: unwrap the value or throw on a carrier failure.
 * @param run - The typed Remote method invocation.
 * @returns the business value.
 */
async function unwrap<Value>(
  run: () => Promise<{ ok: true; value: Value } | { ok: false; error: { code: string; message: string } }>,
): Promise<Value> {
  const result = await run()
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Map a Remote failure to the manager's business failure vocabulary. */
function failureOf(error: { code: string; message: string }): McpManagerFailure {
  return { code: error.code as McpManagerFailure['code'], message: error.message }
}

/** Reject when `promise` has not settled within `ms`, so startup never hangs on a preference read. */
async function withTimeout<Value>(promise: Promise<Value>, ms: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Contribute the MCP management page to the Settings section. Unlike the
 * original assembly (where the api-remotes facade mounted every Remote
 * namespace), this standalone plugin mounts the `mcpManager` contribution
 * itself so it needs no modification to any in-box package.
 * @param ctx - Client Cordis root.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remoteContribution)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')

  const t = ctx.locale.bind(NS)

  // The mcpManager namespace is self-mounted by $mount above, so injecting
  // `remote.mcpManager` would deadlock this plugin's own activation. Read the
  // provided service through the global service store instead of the ctx
  // property proxy, which would demand an inject declaration.
  const manager = ctx.get('remote.mcpManager') as McpManagerRemote | undefined
  if (manager === undefined) {
    throw new Error('dsh-mcp: remote.mcpManager namespace is not mounted after $mount')
  }

  /**
   * Latest prefs snapshot. The Host owns the durable row; this mirror keeps the
   * seat registrations and the page in step without a re-read per render.
   */
  let prefs: McpPrefs = { placement: 'sidebar', pins: [], aliases: {} }

  /** The layout owner's panel face, when this composition provides it. */
  const layout = (): {
    panelInfo?: { getSnapshot: () => { activePanelId: string | null } }
    selectPanel?: (id: string | null) => void
  } | undefined => ctx.get('layout') as never

  /** The currently selected global panel id, or null for the Conversation. */
  const activeMainPanel = (): string | null => layout()?.panelInfo?.getSnapshot().activePanelId ?? null

  /**
   * Patch the Host's prefs and adopt the accepted snapshot. A placement change
   * also re-seats the page; a failed write leaves every seat where it was.
   * @param patch - Any subset of `{ placement, pins, aliases }`.
   * @returns the accepted snapshot, or the business failure.
   */
  const patchPrefs = async (patch: {
    placement?: McpPlacement
    pins?: readonly string[]
    aliases?: Readonly<Record<string, readonly string[]>>
  }): Promise<McpPrefsWrite> => {
    // Two layers again: the transport carrier (`ok`/`value`) wraps the Host's
    // own outcome. Reading `pins` off the carrier yields `undefined` and the
    // spread throws `outcome.pins is not iterable` — the exact failure this
    // helper must not repeat.
    let outcome: McpPrefsPatchOutcome
    try {
      outcome = await unwrap(() => manager.uiPrefsPatch(patch))
    } catch (error) {
      return {
        ok: false,
        failure: { code: 'MCP_PREFS_UNAVAILABLE', message: String((error instanceof Error ? error.message : error) ?? error) },
      }
    }
    if (!outcome.ok) return { ok: false, failure: failureOf(outcome.error) }
    const next: McpPrefs = {
      placement: isMcpPlacement(outcome.placement) ? outcome.placement : prefs.placement,
      pins: [...(outcome.pins ?? [])],
      aliases: { ...(outcome.aliases ?? {}) },
    }
    const moved = next.placement !== prefs.placement
    prefs = next
    if (moved) sync()
    return { ok: true, prefs }
  }

  /**
   * Persist and apply a new display location.
   * @param next - Requested location.
   * @returns the business failure, or null on success.
   */
  const setPlacement = async (next: McpPlacement): Promise<McpManagerFailure | null> => {
    if (!isMcpPlacement(next)) {
      return { code: 'MCP_INVALID_SPEC', message: `unknown display location '${String(next)}'` }
    }
    const result = await patchPrefs({ placement: next })
    return result.ok ? null : result.failure
  }

  const injected = (surface: McpSurface): McpManagerInjected => ({
    list: async () => {
      const result = await unwrap(() => manager.list())
      return result.servers
    },
    save: async (draft) => {
      const submission = draftToSubmission(draft)
      // Two layers: the carrier (`ok`/`value`) from the Remote transport, then
      // the Host's own outcome inside it. Unwrapping the carrier and reading
      // `value.ok` is what surfaces "invalid spec" / "name conflict" instead of
      // reporting a save that never happened.
      const outcome = await unwrap(() => manager.upsert({
        ...draft.id === null ? {} : { id: draft.id },
        server: submission.server,
      }))
      return outcome.ok ? null : failureOf(outcome.error)
    },
    remove: async (id) => {
      const outcome = await unwrap(() => manager.delete({ id }))
      return outcome.ok ? null : failureOf(outcome.error)
    },
    upsertJson: async (servers) => {
      const result = await unwrap(() => manager.upsertJson({ servers }))
      return {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        ...result.skipped === undefined ? {} : { skipped: result.skipped },
        servers: result.servers,
      }
    },
    test: async (draft) => {
      const submission = draftToSubmission(draft)
      const result = await unwrap(() => manager.test({
        ...draft.id === null ? {} : { id: draft.id },
        server: submission.server,
      }))
      return { probe: result.probe, elapsedMs: result.elapsedMs }
    },
    toolsList: async () => {
      // The contribution declares no parameters for toolsList; pass none.
      const result = await unwrap(() => manager.toolsList())
      return { tools: result.tools, mode: result.mode, hotSize: result.hotSize }
    },
    toolsSet: async (request) => {
      // `request` is the single wire parameter: pass the payload directly.
      const result = await unwrap(() => manager.toolsSet(request))
      return { ok: result.ok }
    },
    toolsMode: async (request) => {
      const result = await unwrap(() => manager.toolsMode({ mode: request.mode }))
      return { ok: result.ok }
    },
    envList: async () => {
      const result = await unwrap(() => manager.envList())
      return { vars: result.vars }
    },
    envSet: async (vars) => {
      const result = await unwrap(() => manager.envSet({ vars }))
      return { vars: result.vars }
    },
    adopt: async (serverName) => {
      const result = await manager.adopt({ serverName })
      if (!result.ok) return { failure: failureOf(result.error) }
      return {
        failure: null,
        ...result.warning === undefined ? {} : { warning: result.warning },
      }
    },
    release: async (serverName) => {
      const result = await manager.release({ serverName })
      if (!result.ok) return { failure: failureOf(result.error) }
      return {
        failure: null,
        ...result.warning === undefined ? {} : { warning: result.warning },
      }
    },
    oauthStart: async (request) => {
      const result = await unwrap(() => manager.oauthStart(request))
      return result.url
    },
    oauthStatus: async (serverName) => {
      const result = await unwrap(() => manager.oauthStatus({ serverName }))
      return {
        authorized: result.authorized,
        pending: result.pending,
        ...result.url === undefined ? {} : { url: result.url },
        ...result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt },
        ...result.error === undefined ? {} : { error: result.error },
      }
    },
    prefs,
    setPlacement,
    setPinned: async (pins) => patchPrefs({ pins }),
    setAliases: async (aliases) => patchPrefs({ aliases }),
    prefsRead: async () => {
      const stored = await withTimeout(unwrap(() => manager.uiPrefs()), 3000)
      prefs = {
        placement: isMcpPlacement(stored.placement) ? stored.placement : prefs.placement,
        pins: [...(stored.pins ?? [])],
        aliases: { ...(stored.aliases ?? {}) },
      }
      return prefs
    },
    surface,
  })

  // `main` is registered unconditionally: the rail entry may come and go, but a
  // selected panel id must always resolve (layout.selectPanel throws for an
  // unregistered key). Only the rail entry and the Settings page are optional.
  const stops: Array<() => void> = []
  const stopMain = ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store: createMcpManagerStore,
    inject: () => injected('panel'),
  }, McpPage))
  stops.push(stopMain)

  let stopSettings: (() => void) | null = null
  let stopSidebar: (() => void) | null = null
  let disposed = false

  /** Move the page between its seats, creating/withdrawing only what changed. */
  const sync = (): void => {
    if (disposed) return
    const wantSettings = prefs.placement !== 'sidebar'
    const wantSidebar = prefs.placement !== 'settings'

    if (wantSettings && stopSettings === null) {
      stopSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mcp',
        order: SETTINGS_ORDER,
        label: () => t('nav'),
        locale: NS,
        store: createMcpManagerStore,
        inject: () => injected('settings'),
      }, McpSettingsSection))
      stops.push(stopSettings)
    } else if (!wantSettings && stopSettings !== null) {
      stopSettings()
      stopSettings = null
    }

    if (wantSidebar && stopSidebar === null) {
      stopSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: RAIL_ORDER,
        label: () => t('panel'),
        locale: NS,
      }, McpIcon))
      stops.push(stopSidebar)
    } else if (!wantSidebar && stopSidebar !== null) {
      stopSidebar()
      stopSidebar = null
      // The panel is still registered, but its rail entry is gone: leaving the
      // user on a page with no way back would be a dead end.
      if (activeMainPanel() === PANEL_ID) layout()?.selectPanel?.(null)
    }
  }

  try {
    const stored = await withTimeout(unwrap(() => manager.uiPrefs()), 3000)
    prefs = {
      placement: isMcpPlacement(stored.placement) ? stored.placement : 'sidebar',
      pins: [...(stored.pins ?? [])],
      aliases: { ...(stored.aliases ?? {}) },
    }
  } catch (error) {
    // A missing/unreachable preference must never cost the user the page: the
    // left rail is the default.
    console.warn('[dsh-mcp] could not read UI prefs; defaulting to the left sidebar:', error)
  }

  sync()

  ctx.effect(() => () => {
    disposed = true
    for (const stop of stops) stop()
    stops.length = 0
    stopSettings = null
    stopSidebar = null
  }, 'ui-settings-mcp: slot registrations')
}
