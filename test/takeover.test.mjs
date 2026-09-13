/**
 * Takeover lifecycle against a real Cordis context with a stub storage domain.
 *
 * The state these tests pin is the state users hit by hand: a declaration
 * releasing its name, provenance surviving later saves, the pending-restart
 * degradation when the composition keeps serving the name, and the rollback
 * of a hard mount failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { McpManagerService } from "../lib/index.js";
import { managedIds } from "../lib/patch-writer.js";

/** A minimal MCP stdio server: enough for the client to activate and register one tool. */
const FIXTURE_SERVER = `let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    if (message.method === 'initialize') respond(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } })
    else if (message.method === 'tools/list') respond(message.id, { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] })
    else respond(message.id, {})
  }
})
function respond (id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
`;

/** One stdio declaration pointing at the fixture server. */
function declaration(command, serverName = "x", options = {}) {
	return `- insert:
    - id: mcp-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: ${serverName}, command: '${command}', args: ${JSON.stringify(options.args ?? [])}, failOnStartupError: ${options.failOnStartupError === true} }
`;
}

/**
 * Boot the manager over a temporary home with one declaration.
 * @param options.command - stdio command the declaration uses.
 * @param options.args - stdio args the declaration uses.
 * @param options.serverName - the declared server name.
 * @param options.failOnStartupError - whether a failed connect must fail the mount.
 * @param options.externalTools - tool names the fake registry already holds (composition-owned).
 */
async function bootManager(options = {}) {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-takeover-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const patch = join(profileDir, "cordis.patch.yml");
	const serverName = options.serverName ?? "x";
	const original = declaration(options.command, serverName, options);
	writeFileSync(patch, original);
	const records = new Map();
	const registered = [];
	const table = {
		get: (key) => records.get(key),
		entries: () => records.entries(),
		keys: () => records.keys(),
		put: async (key, value) => { records.set(key, value); },
		delete: async (key) => records.delete(key)
	};
	const schemas = () => [
		...(options.externalTools ?? []).map((name) => ({ name })),
		...registered.map((name) => ({ name }))
	];
	const root = new Context();
	root.provide("storageDomain", { open: async () => ({ table: () => table, close: async () => {} }) });
	root.provide("credentials", { describe: async () => ({ configured: false }), resolve: async () => undefined });
	root.provide("tools", {
		register: (definition) => {
			registered.push(definition.name);
			return () => {
				const index = registered.indexOf(definition.name);
				if (index >= 0) registered.splice(index, 1);
			};
		},
		schemas
	});
	root.provide("dshHomePath", () => home);
	root.baseUrl = pathToFileURL(join(profileDir, "cordis.yml")).href;
	await root.plugin(McpManagerService, { probeTimeoutMs: 2e3, allowBrowserOnMount: false });
	const service = root.get("mcpManager");
	await service.list();
	return {
		service,
		records,
		registered,
		patch,
		original,
		profileDir,
		// Dispose the tree (its mounts own child processes) before the temp home
		// goes away, so the test process can exit on its own.
		cleanup: async () => {
			await service.teardownAll();
			await root.fiber.dispose();
			rmSync(home, { recursive: true, force: true });
		}
	};
}

test("adopt takes a declared server over and mounts it under the manager", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "dsh-mcp-fixture-"));
	const fixture = join(fixtureDir, "server.mjs");
	writeFileSync(fixture, FIXTURE_SERVER);
	const context = await bootManager({ command: process.execPath, args: [fixture] });
	try {
		const result = await context.service.adopt({ serverName: "x" });
		assert.equal(result.ok, true, result.ok ? "" : result.error.message);
		assert.equal(context.registered.includes("mcp__x__ping"), true, "the managed mount registers the server's tool");
		const row = context.records.get("cordis:mcp-x");
		assert.equal(row.origin, "plugin");
		assert.equal(row.declaredIn, context.patch);
		assert.deepEqual(managedIds(context.patch), ["mcp-x"]);
	} finally {
		await context.cleanup();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("provenance survives a later save and give-back still works", async () => {
	const fixtureDir = mkdtempSync(join(tmpdir(), "dsh-mcp-fixture-"));
	const fixture = join(fixtureDir, "server.mjs");
	writeFileSync(fixture, FIXTURE_SERVER);
	const context = await bootManager({ command: process.execPath, args: [fixture] });
	try {
		await context.service.adopt({ serverName: "x" });
		const stored = context.records.get("cordis:mcp-x");
		// A user toggle goes through upsert, which rebuilds the row.
		const toggled = await context.service.upsert({
			id: stored.id,
			server: {
				serverName: stored.serverName,
				transport: stored.transport,
				enabled: false,
				command: stored.command,
				args: stored.args,
				cwd: stored.cwd,
				url: stored.url,
				headers: [],
				toolCallTimeoutMs: stored.toolCallTimeoutMs,
				failOnStartupError: stored.failOnStartupError
			},
			env: []
		});
		assert.equal(toggled.ok, true, toggled.ok ? "" : toggled.error.message);
		const after = context.records.get("cordis:mcp-x");
		assert.equal(after.declaredIn, context.patch, "the save must keep the declaration provenance");
		assert.equal(after.enabled, false);
		const released = await context.service.release({ serverName: "x" });
		assert.equal(released.ok, true, released.ok ? "" : released.error.message);
		assert.deepEqual(managedIds(context.patch), [], "give-back removes the managed disable block");
		// The declaration is live again, so the same pass re-imports its mirror
		// row; in this stub there is no composition to register tools, which is
		// exactly the "restart required" case the warning reports.
		assert.equal(context.records.get("cordis:mcp-x").origin, "cordis", "the row returns to mirror state");
		assert.match(released.warning ?? "", /重启/, "give-back reports the restart when the declaration did not come back");
	} finally {
		await context.cleanup();
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test("a declaration the composition still serves is registered, not mounted", async () => {
	const context = await bootManager({ command: process.execPath, externalTools: ["mcp__x__native"] });
	try {
		const result = await context.service.adopt({ serverName: "x" });
		assert.equal(result.ok, true, result.ok ? "" : result.error.message);
		assert.equal(result.pendingRestart, true, "the takeover is registered for the next start");
		assert.equal(context.service.mounts.size, 0, "nothing may be mounted while the composition owns the name");
		assert.deepEqual(managedIds(context.patch), ["mcp-x"]);
		assert.equal(context.records.get("cordis:mcp-x").origin, "plugin");
		const listed = await context.service.list();
		const row = listed.servers.find((server) => server.serverName === "x");
		assert.equal(row.pendingTakeover, true, "the page must show the pending state");
	} finally {
		await context.cleanup();
	}
});

test("a mirror is dropped once its declaration is gone", async () => {
	const context = await bootManager({ command: process.execPath });
	try {
		assert.equal(context.records.get("cordis:mcp-x")?.origin, "cordis", "the declaration was imported");
		writeFileSync(context.patch, "[]\n");
		await context.service.list();
		assert.equal(context.records.has("cordis:mcp-x"), false, "an orphaned mirror must not accumulate");
	} finally {
		await context.cleanup();
	}
});

test("a hard mount failure rolls the takeover back to the declaration", async () => {
	const context = await bootManager({ command: "/nonexistent-dsh-mcp-binary", failOnStartupError: true });
	try {
		const result = await context.service.adopt({ serverName: "x" });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "MCP_ADOPT_FAILED");
		assert.equal(readFileSync(context.patch, "utf8"), context.original, "the patch file is restored byte for byte");
		assert.equal(context.records.get("cordis:mcp-x").origin, "cordis", "the row returns to mirror state");
	} finally {
		await context.cleanup();
	}
});

test("a declaration the composition cannot authenticate reads as failed and needs the plugin", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-needsplugin-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	// One placeholder header (only the plugin substitutes it) and one literal
	// header (the composition can send it as-is).
	writeFileSync(join(profileDir, "cordis.patch.yml"), `- insert:
    - id: mcp-oauthish
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: oauthish
        url: http://127.0.0.1:9/mcp
        headers: { Authorization: ADA_TOKEN }
    - id: mcp-literal
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: literalrow
        url: http://127.0.0.1:9/mcp
        headers: { Authorization: 'Bearer literal' }
`);
	const servers = new Map();
	const env = new Map([["ADA_TOKEN", { name: "ADA_TOKEN", secret: true, value: "" }]]);
	const serversTable = {
		get: (key) => servers.get(key),
		entries: () => servers.entries(),
		keys: () => servers.keys(),
		put: async (key, value) => { servers.set(key, value); },
		delete: async (key) => servers.delete(key)
	};
	const envTable = {
		get: (key) => env.get(key),
		entries: () => env.entries(),
		keys: () => env.keys(),
		put: async () => {},
		delete: async () => {}
	};
	const root = new Context();
	root.provide("storageDomain", { open: async () => ({ table: (name) => name === "global_env" ? envTable : serversTable, close: async () => {} }) });
	root.provide("credentials", { describe: async () => ({ configured: false }), resolve: async () => undefined });
	root.provide("tools", { register: () => () => {}, schemas: () => [] });
	root.provide("dshHomePath", () => home);
	root.baseUrl = pathToFileURL(join(profileDir, "cordis.yml")).href;
	await root.plugin(McpManagerService, { probeTimeoutMs: 1e3, allowBrowserOnMount: false });
	const service = root.get("mcpManager");
	try {
		const listed = await service.list();
		const oauthish = listed.servers.find((server) => server.serverName === "oauthish");
		assert.equal(oauthish.needsPlugin, true, "a placeholder header can only be resolved by the plugin");
		assert.equal(oauthish.status.phase, "failed", "it must not read as forever-connecting");
		assert.match(oauthish.status.error ?? "", /接管/);
		const literal = listed.servers.find((server) => server.serverName === "literalrow");
		assert.equal(literal.needsPlugin, undefined, "a literal header works natively");
		assert.equal(literal.status.phase, "mounting");
	} finally {
		await service.teardownAll();
		await root.fiber.dispose();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a declaration without an id cannot be taken over", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-noid-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	writeFileSync(join(profileDir, "cordis.patch.yml"), `- insert:
    - name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: noid, command: node, args: [] }
`);
	const records = new Map();
	const table = {
		get: (key) => records.get(key),
		entries: () => records.entries(),
		keys: () => records.keys(),
		put: async (key, value) => { records.set(key, value); },
		delete: async (key) => records.delete(key)
	};
	const root = new Context();
	root.provide("storageDomain", { open: async () => ({ table: () => table, close: async () => {} }) });
	root.provide("credentials", { describe: async () => ({ configured: false }), resolve: async () => undefined });
	root.provide("tools", { register: () => () => {}, schemas: () => [] });
	root.provide("dshHomePath", () => home);
	root.baseUrl = pathToFileURL(join(profileDir, "cordis.yml")).href;
	await root.plugin(McpManagerService, { probeTimeoutMs: 1e3, allowBrowserOnMount: false });
	const service = root.get("mcpManager");
	try {
		await service.list();
		const result = await service.adopt({ serverName: "noid" });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, "MCP_ADOPT_NO_ID");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
