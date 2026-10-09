/**
 * The built browser half must stay loadable in the DSH web shell.
 *
 * `lib/client.js` is an esbuild bundle in the shell's exact wire format: a CJS
 * factory handed to `window.__ModuleLoader__.load({ id, factory })`, with the
 * platform modules resolved through the injected `require` and everything else
 * inlined. This test loads that bundle with the platform modules stubbed, so a
 * broken build (wrong banner/id, a new platform import, a factory that throws
 * on evaluation) fails here instead of blanking the Settings page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(ROOT, "lib/client.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Platform modules the shell injects; every other import must be inlined. */
const PLATFORM = {
	react: {
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial }),
		createElement: () => null,
		Fragment: Symbol("Fragment"),
	},
	"react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: Symbol("Fragment") },
	"react-dom": {},
	"react-dom/client": {},
	"@deepseek-ai/cordis": {},
	"@deepseek-ai/dsh-client-store": { defineStore: (spec) => ({ spec }) },
	"@deepseek-ai/dsh-client-ui-slots": {},
	"@deepseek-ai/dsh-client-ui-primitives": {},
};

/** Evaluate the bundle and return what its factory exports. */
function loadBundle() {
	const loaded = [];
	const context = vm.createContext({
		window: {
			__ModuleLoader__: {
				load: (entry) => { loaded.push(entry); },
			},
		},
		console,
	});
	vm.runInContext(source, context, { filename: "lib/client.js" });
	assert.equal(loaded.length, 1, "the bundle registers exactly one loader entry");
	const [entry] = loaded;
	assert.equal(entry.id, manifest.name, "the loader id is the package name (it must match the patch row)");
	assert.equal(typeof entry.factory, "function");
	return {
		entry,
		exports: entry.factory((id) => {
			assert.ok(id in PLATFORM, `unexpected platform import ${id}: it would not resolve in the shell`);
			return PLATFORM[id];
		}),
	};
}

test("the built bundle loads through the module loader and exports the plugin", () => {
	const { exports: exported } = loadBundle();
	assert.equal(exported.NS, "settings.mcp");
	assert.equal(typeof exported.apply, "function");
	assert.ok(Array.isArray(exported.inject));
});

test("the built bundle carries the OAuth button, its 5s polling, and the new remotes", () => {
	// Non-ASCII copy is emitted as \uXXXX escapes by the bundler, so match the
	// ASCII markers and the escape of "未授权" (the unauthorized badge).
	for (const marker of [
		"\\u672A\\u6388\\u6743",
		"Not authorized",
		"Authorizing",
		"oauthBadgeUnauthorized",
		"dangerButton",
		"oauthStart",
		"oauthStatus",
		"oauthRequired",
		"oauthAuthorized",
	]) {
		assert.ok(source.includes(marker), `lib/client.js must carry "${marker}" — rebuild it (npm run build)`);
	}
	// esbuild folds the 5000ms interval constant into its numeric form.
	assert.ok(/5e3|5000/.test(source), "the authorization poll interval is inlined");
});
