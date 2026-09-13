/**
 * Run the package's tests under whatever module resolution the environment has.
 *
 * The suite has two halves:
 *
 * - dependency-free regression tests (the image projection and the host copy
 *   tables) that run anywhere;
 * - tests of the DSH-integrated modules (`lib/index.js`, `lib/cordis-servers.js`,
 *   `lib/patch-writer.js`), which import `@deepseek-ai/*` and `js-yaml` from the
 *   DSH installation instead of from npm, because this package ships **zero
 *   runtime dependencies** (see README → 构建).
 *
 * CI has no DSH installation, so those files are skipped there rather than
 * breaking the release pipeline; locally — where the profile's `node_modules`
 * is in reach — the whole suite runs. The split is a resolution fact, not a
 * flavour of test, so the list below is maintained by hand: add a file here
 * when it imports a module the package does not declare.
 * @module dsh-mcp/scripts/test
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Test files that require the DSH module closure at import time. */
const NEEDS_DSH_CLOSURE = new Set([
  'cordis-servers.test.mjs',
  'patch-writer.test.mjs',
  'takeover.test.mjs',
])

/** Whether the DSH module closure resolves from this checkout. */
async function closureAvailable() {
  try {
    await import('@deepseek-ai/cordis')
    return true
  } catch {
    return false
  }
}

const available = await closureAvailable()
const files = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.test.mjs')).sort()
const selected = files.filter((name) => available || !NEEDS_DSH_CLOSURE.has(name))
const skipped = files.filter((name) => !selected.includes(name))
if (skipped.length > 0) {
  console.log(`test: no DSH module closure here, skipping ${skipped.join(', ')}`)
}

const result = spawnSync(
  process.execPath,
  ['--test', ...selected.map((name) => join('test', name))],
  { cwd: ROOT, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
