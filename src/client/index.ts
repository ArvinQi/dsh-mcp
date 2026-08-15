/**
 * MCP server management settings page, browser half: one `settings.section`
 * entry named `mcp` over the `mcpManager` Remote namespace.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Local wire vocabulary (vendored from the original mcp-manager types).
import type { McpManagerFailure, McpServerId, McpServerView } from './types.ts'
import remoteContribution from './remote-contribution.js'
import { McpSettingsSection, type McpManagerInjected } from './McpSettingsSection.tsx'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'
import { createMcpManagerStore, draftToSubmission } from './mcp-store.ts'

/** One Remote carrier result: success carries the decoded value, failure a code. */
type McpRemoteResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Wire face of the self-mounted `mcpManager` Remote namespace. */
interface McpManagerRemote {
  list(): Promise<McpRemoteResult<{ readonly servers: readonly McpServerView[] }>>
  upsert(request: {
    readonly id?: McpServerId
    readonly server: unknown
    readonly env: readonly unknown[]
  }): Promise<McpRemoteResult<{ readonly server: McpServerView }>>
  delete(request: { readonly id: McpServerId }): Promise<McpRemoteResult<unknown>>
  test(request: {
    readonly id?: McpServerId
    readonly server: unknown
    readonly env: readonly unknown[]
  }): Promise<McpRemoteResult<{ readonly probe: unknown; readonly elapsedMs: number }>>
  toolsList(): Promise<McpRemoteResult<{ readonly tools: readonly unknown[]; readonly mode: unknown; readonly hotSize: number }>>
  toolsSet(request: { readonly name: string; readonly enabled: boolean }): Promise<McpRemoteResult<{ readonly ok: boolean }>>
  toolsMode(request: { readonly mode: unknown }): Promise<McpRemoteResult<{ readonly ok: boolean }>>
}

export type { McpSettingsSectionProps, McpManagerInjected } from './McpSettingsSection.tsx'
export type { McpServerFormProps } from './ServerForm.tsx'
export type { McpDraft, McpEnvRowDraft, McpTestOutcome } from './mcp-store.ts'
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

/**
 * Contribute the MCP management page to the Settings section. Unlike the
 * original assembly (where the api-remotes facade mounted every Remote
 * namespace), this standalone plugin mounts the `mcpManager` contribution
 * itself so it needs no modification to any in-box package.
 * @param ctx - Client Cordis root.
 */
export async function apply(ctx: ClientContext): Promise<void> {
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

  const injected = (): McpManagerInjected => ({
    list: async () => {
      const result = await unwrap(() => manager.list())
      return result.servers
    },
    save: async (draft) => {
      const submission = draftToSubmission(draft)
      const result = await manager.upsert({
        ...draft.id === null ? {} : { id: draft.id },
        server: submission.server,
        env: submission.env,
      })
      if (result.ok) return null
      return failureOf(result.error)
    },
    remove: async (id) => {
      const result = await manager.delete({ id })
      if (result.ok) return null
      return failureOf(result.error)
    },
    test: async (draft) => {
      const submission = draftToSubmission(draft)
      const result = await unwrap(() => manager.test({
        ...draft.id === null ? {} : { id: draft.id },
        server: submission.server,
        env: submission.env,
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
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    store: createMcpManagerStore,
    inject: injected,
  }, McpSettingsSection))
}
