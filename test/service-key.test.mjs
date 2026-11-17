import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = readFileSync(join(ROOT, "lib/index.js"), "utf8");
const CLIENT = readFileSync(join(ROOT, "src/client/remote-contribution.js"), "utf8");

/** The host's declared `super(ctx, serviceKey, { namespace })`, when explicit. */
function hostBinding() {
	return HOST.match(/super\(ctx, "([^"]+)", \{ namespace: "([^"]+)" \}\)/);
}

/** `service`/`namespace` pairs of the generated client descriptors. */
function clientBindings() {
	return [...CLIENT.matchAll(/^\s+service: '([^']+)',\n\s+namespace: '([^']+)',$/gm)]
		.map((match) => ({ service: match[1], namespace: match[2] }));
}

test("the Cordis service key is ours, not the built-in manager's (issue #25)", () => {
	// DSH >= 0.2.2-rc.3 ships McpServerManager, which registers the `mcpManager`
	// Cordis service key; a second registration throws
	// `service "mcpManager" has been registered at <McpServerManager>`.
	assert.ok(
		!/super\(ctx, "mcpManager"\)/.test(HOST),
		"registering the mcpManager Cordis key collides with the built-in McpServerManager",
	);
	const declared = hostBinding();
	assert.ok(declared, 'the host half must register a private service key with an explicit "mcpManager" wire namespace');
	assert.equal(declared[1], "dshMcpManager");
	assert.equal(declared[2], "mcpManager", "renaming the Cordis service key must not move the wire contract");
});

test("client descriptors dispatch to our service key under the unchanged wire namespace", () => {
	const declared = hostBinding();
	assert.ok(declared, "the host must declare an explicit service key and namespace");
	const [, hostService, hostNamespace] = declared;

	const bindings = clientBindings();
	assert.ok(bindings.length > 0, "the client contribution must declare descriptors");

	// The gateway dispatches by `ctx.get(descriptor.service)` and then validates
	// the binding against `descriptor.namespace`; a mismatch fails every call
	// with `gateway/service-unavailable` / `gateway/method-unavailable`.
	const wrongService = bindings.filter((binding) => binding.service !== hostService);
	const wrongNamespace = bindings.filter((binding) => binding.namespace !== hostNamespace);
	assert.deepEqual(wrongService, [], `every descriptor service must be "${hostService}"`);
	assert.deepEqual(wrongNamespace, [], `every descriptor namespace must be "${hostNamespace}"`);
});
