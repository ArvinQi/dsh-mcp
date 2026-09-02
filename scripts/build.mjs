/**
 * Build the dsh-mcp client bundle.
 *
 * Produces lib/client.js in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }), with
 * platform modules resolved through the injected require (the loader module
 * table) and everything else inlined.
 *
 * CSS Modules are handled by an esbuild onLoad plugin: each `.module.css` is
 * rewritten to a JS module that (1) injects the stylesheet text into a
 * <style data-plugin="dsh-mcp"> tag and (2) default-exports an identity class
 * map (class name -> class name; the standalone plugin does not need hashed
 * names because its UI is scoped to the settings section it owns).
 *
 * esbuild is resolved from the DSH source checkout (the only place it is
 * installed); the plugin package itself has zero runtime dependencies.
 * Set DSH_SOURCE to the DSH checkout root when it is not one of the known
 * defaults below.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** DSH source checkout root; override with $DSH_SOURCE when not a default. */
function resolveCheckout() {
  if (process.env.DSH_SOURCE && existsSync(process.env.DSH_SOURCE)) return process.env.DSH_SOURCE
  const defaults = [
    join(homedir(), '.dsh/source/current'),
  ]
  for (const candidate of defaults) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('esbuild not found: set DSH_SOURCE to the DSH checkout root')
}

const CHECKOUT = resolveCheckout()

/** Loader entry name — must equal the patch row `name` EXACTLY. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = MANIFEST.name

/** Platform module table (must stay aligned with packages/client/web/src/platform.ts + the runtime exemption). */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Locate the esbuild package inside a pnpm checkout (store or hoisted). */
function resolveEsbuild(checkout) {
  const store = join(checkout, 'node_modules/.pnpm')
  if (existsSync(store)) {
    const entries = readdirSync(store).filter((name) => name.startsWith('esbuild@')).sort()
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const candidate = join(store, entries[i], 'node_modules/esbuild/package.json')
      if (existsSync(candidate)) return candidate
    }
  }
  const hoisted = join(checkout, 'node_modules/esbuild/package.json')
  if (existsSync(hoisted)) return hoisted
  throw new Error(`esbuild not found under ${checkout} (set DSH_SOURCE to the DSH checkout root)`)
}

const require = createRequire(resolveEsbuild(CHECKOUT))
const esbuild = require('esbuild')

/** Identity class map for one CSS module + the stylesheet text, as a JS module. */
function cssModuleLoader() {
  return {
    name: 'dsh-mcp-css-modules',
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, (args) => {
        const css = readFileSync(args.path, 'utf8')
        const classes = [...new Set(
          [...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]),
        )]
        const map = Object.fromEntries(classes.map((name) => [name, name]))
        const file = args.path.split('/').pop()
        const contents = [
          `(function () {`,
          `  if (typeof document !== 'undefined') {`,
          `    const existing = document.querySelector('style[data-plugin="${PLUGIN_ID}"][data-file="${file}"]');`,
          `    if (!existing) {`,
          `      const style = document.createElement('style');`,
          `      style.setAttribute('data-plugin', '${PLUGIN_ID}');`,
          `      style.setAttribute('data-file', '${file}');`,
          `      style.textContent = ${JSON.stringify(css)};`,
          `      document.head.appendChild(style);`,
          `    }`,
          `  }`,
          `})();`,
          `export default ${JSON.stringify(map)};`,
        ].join('\n')
        return { contents, loader: 'js' }
      })
    },
  }
}

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = 'return module.exports; } });'

await esbuild.build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Components import only named react hooks (React 17+ style); the classic
  // 'transform' mode emits bare `React.createElement` with no React binding in
  // scope, which crashed the settings section with "React is not defined".
  // 'automatic' emits jsx-runtime calls (`react/jsx-runtime` is already an
  // external platform module), so no default React import is required.
  jsx: 'automatic',
  external: EXTERNALS,
  // The plugin lives outside any node_modules tree of its own; the DSH
  // profiles fallback directory is where zod (inlined into the bundle) and the
  // external @deepseek-ai/* platform modules resolve from at build time.
  nodePaths: [join(homedir(), '.dsh/profiles/node_modules')],
  plugins: [cssModuleLoader()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: { js: banner },
  footer: { js: footer },
})

console.log('lib/client.js built')
