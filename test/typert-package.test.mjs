import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRIBUTION = readFileSync(join(ROOT, "src/client/remote-contribution.js"), "utf8");
/** The same source with block comments removed: comments may quote the old id. */
const CODE = CONTRIBUTION.replace(/\/\*[\s\S]*?\*\//g, "");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Every `id: '…'` field of the generated Remote descriptors. */
function declaredIds(source) {
	return [...source.matchAll(/^\s+id: '([^']+)',?$/gm)].map((match) => match[1]);
}

test("the Remote package id is ours, not the upstream manager's (issue #24)", () => {
	const declared = CODE.match(/^\s+package: '([^']+)',$/m);
	assert.ok(declared, "the contribution must declare a package id");
	// DSH >= 0.2.2-rc.2 ships an official @deepseek-ai/dsh-mcp-manager client
	// contribution; registering a second owner for that package name throws
	// `typert: Remote package "…" is already registered` and the plugin dies.
	assert.notEqual(declared[1], "@deepseek-ai/dsh-mcp-manager");
	assert.equal(declared[1], MANIFEST.name, "the package id should be this plugin's own package name");
	assert.ok(!/['"]@deepseek-ai\/dsh-mcp-manager/.test(CODE), "no descriptor field may claim the upstream package id");
});

test("every descriptor id is namespaced under the declared package", () => {
	const pkg = CODE.match(/^\s+package: '([^']+)',$/m)[1];
	const ids = declaredIds(CODE);
	assert.ok(ids.length > 0, "the generated contribution must carry descriptors");
	for (const id of ids) {
		assert.ok(id.startsWith(`${pkg}#`), `descriptor id "${id}" must start with "${pkg}#"`);
	}
});

test("routing endpoints stay ours and never overlap the upstream manager's", () => {
	// A Remote invocation routes by `${namespace}/${method}` only, so this is the
	// contract that has to survive a package rename.
	const endpoints = [...CODE.matchAll(/^\s+namespace: '([^']+)',\n\s+method: '([^']+)',/gm)]
		.map((match) => `${match[1]}/${match[2]}`);
	assert.ok(endpoints.length > 0, "descriptors must declare namespace/method pairs");
	assert.equal(new Set(endpoints).size, endpoints.length, "endpoints must be unique");

	// Endpoints of @deepseek-ai/dsh-mcp-manager 0.2.2-rc.3 (probe/restart/watch).
	const upstream = new Set(["mcpManager/probe", "mcpManager/restart", "mcpManager/watch"]);
	const overlapping = endpoints.filter((endpoint) => upstream.has(endpoint));
	assert.deepEqual(overlapping, [], "no endpoint may collide with the built-in MCP manager");
});
