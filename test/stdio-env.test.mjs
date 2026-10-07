/**
 * Issue #11: `global_env` (the settings page's 进程级环境变量) must reach stdio
 * MCP servers' child processes.
 *
 * The regression is invisible to pure unit tests — `toClientConfig()` simply
 * dropped its `globalEnv` argument on the stdio branch — so these tests spawn a
 * real child process through the real `@deepseek-ai/dsh-mcp-client` mount and
 * have the child write down the environment it actually received. The parent
 * process environment cannot stand in for the table: `dsh-mcp-client` merges the
 * spec env over a parent env scrubbed of credential-shaped names, so
 * `TAVILY_API_KEY` can only arrive through the injected spec env.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { McpManagerService } from "../lib/index.js";

/** Keys the fixture reports back; a missing key is dumped as null. */
const OBSERVED_KEYS = ["TAVILY_API_KEY", "ADHOC_TOKEN", "MCP_PLAIN_VALUE"];

/**
 * A stdio MCP server that records the environment it was started with. The
 * dump lands in the file given as argv[2] during the initialize handshake, so
 * the assertion reads the child's own view of its environment.
 */
const FIXTURE_SERVER = `import { writeFileSync } from 'node:fs'
const out = process.argv[2]
const keys = ${JSON.stringify(OBSERVED_KEYS)}
let buffer = ''
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
    if (message.method === 'initialize') {
      const seen = {}
      for (const key of keys) seen[key] = process.env[key] === undefined ? null : process.env[key]
      writeFileSync(out, JSON.stringify(seen))
      respond(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-fixture', version: '1.0.0' } })
    } else if (message.method === 'tools/list') respond(message.id, { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] })
    else respond(message.id, {})
  }
})
function respond (id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
`;

/** One stdio declaration, as the composition would carry it. */
function declaration(command, args, serverName = "x") {
	return `- insert:
    - id: mcp-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: ${serverName}, command: '${command}', args: ${JSON.stringify(args)}, failOnStartupError: false }
`;
}

/** The `servers`/`global_env` tables a storage domain would hand back. */
function tableFor(map) {
	return {
		get: (key) => map.get(key),
		entries: () => map.entries(),
		keys: () => map.keys(),
		put: async (key, value) => { map.set(key, value); },
		delete: async (key) => map.delete(key)
	};
}

/**
 * Boot the manager over a temp home with one declaration and a pre-seeded
 * `global_env` table, then wait for the mounted child to report its environment.
 * @param options.fixture - absolute path to the fixture stdio server.
 * @param options.dock - absolute path the fixture writes its env dump to.
 * @param options.globalEnv - `[name, row]` entries for the global env table.
 */
async function boot(options) {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-stdio-env-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const patch = join(profileDir, "cordis.patch.yml");
	writeFileSync(patch, declaration(options.command, [options.fixture, options.dock]));
	const records = new Map();
	const envRecords = new Map(options.globalEnv ?? []);
	const registered = [];
	const serverTable = tableFor(records);
	const envTable = tableFor(envRecords);
	const root = new Context();
	root.provide("storageDomain", {
		open: async () => ({
			table: (name) => name === "global_env" ? envTable : serverTable,
			close: async () => {}
		})
	});
	root.provide("credentials", { describe: async () => ({ configured: false }), resolve: async () => undefined });
	root.provide("tools", {
		register: (definition) => {
			registered.push(definition.name);
			return () => {
				const index = registered.indexOf(definition.name);
				if (index >= 0) registered.splice(index, 1);
			};
		},
		schemas: () => registered.map((name) => ({ name }))
	});
	root.provide("dshHomePath", () => home);
	root.baseUrl = pathToFileURL(join(profileDir, "cordis.yml")).href;
	await root.plugin(McpManagerService, { probeTimeoutMs: 5e3, allowBrowserOnMount: false });
	const service = root.get("mcpManager");
	await service.list();
	return {
		service,
		registered,
		cleanup: async () => {
			await service.teardownAll();
			await root.fiber.dispose();
			rmSync(home, { recursive: true, force: true });
		}
	};
}

/** The environment a freshly spawned child reported, once its dump exists. */
async function childEnv(dock) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (existsSync(dock)) return JSON.parse(readFileSync(dock, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the stdio fixture never reported its environment (${dock})`);
}

/** Undo a process-env mutation after the test. */
function restoreEnv(name, previous) {
	if (previous === void 0) delete process.env[name];
	else process.env[name] = previous;
}

test("global_env reaches a stdio child process", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-env-fixture-"));
	const fixture = join(dir, "server.mjs");
	const dock = join(dir, "env.json");
	writeFileSync(fixture, FIXTURE_SERVER);
	// A process-env key must not stand in for the table: scrub it so the
	// assertion can only pass through the injected global_env.
	const previous = process.env.TAVILY_API_KEY;
	delete process.env.TAVILY_API_KEY;
	const context = await boot({
		command: process.execPath,
		fixture,
		dock,
		globalEnv: [
			["TAVILY_API_KEY", { name: "TAVILY_API_KEY", secret: false, value: "tvly-from-global-env" }],
			["ADHOC_TOKEN", { name: "ADHOC_TOKEN", secret: false, value: "adhoc-from-global-env" }]
		]
	});
	try {
		// A declaration is a read-only mirror and is mounted by the composition,
		// not by this manager: adopting it hands the mount (and its env) to us.
		const adopted = await context.service.adopt({ serverName: "x" });
		assert.equal(adopted.ok, true, adopted.ok ? "" : adopted.error.message);
		const env = await childEnv(dock);
		assert.equal(env.TAVILY_API_KEY, "tvly-from-global-env", "a credential-shaped global_env name must still reach the child");
		assert.equal(env.ADHOC_TOKEN, "adhoc-from-global-env");
		assert.equal(env.MCP_PLAIN_VALUE, null, "keys outside the table stay unset");
	} finally {
		await context.cleanup();
		restoreEnv("TAVILY_API_KEY", previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a per-server env entry overrides the same global_env name", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-env-fixture-"));
	const fixture = join(dir, "server.mjs");
	writeFileSync(fixture, FIXTURE_SERVER);
	delete process.env.TAVILY_API_KEY;
	const declaredDock = join(dir, "x-env.json");
	const context = await boot({
		command: process.execPath,
		fixture,
		dock: declaredDock,
		globalEnv: [["MCP_PLAIN_VALUE", { name: "MCP_PLAIN_VALUE", secret: false, value: "from-global-env" }]]
	});
	try {
		const adopted = await context.service.adopt({ serverName: "x" });
		assert.equal(adopted.ok, true, adopted.ok ? "" : adopted.error.message);
		assert.equal((await childEnv(declaredDock)).MCP_PLAIN_VALUE, "from-global-env");
		const serverDock = join(dir, "y-env.json");
		const created = await context.service.upsert({
			server: {
				serverName: "y",
				transport: "stdio",
				enabled: true,
				command: process.execPath,
				args: [fixture, serverDock],
				cwd: "",
				url: "",
				headers: [],
				toolCallTimeoutMs: 60e3,
				failOnStartupError: false
			},
			env: [{ name: "MCP_PLAIN_VALUE", secret: false, value: "from-server-env" }]
		});
		assert.equal(created.ok, true, created.ok ? "" : created.error.message);
		assert.equal((await childEnv(serverDock)).MCP_PLAIN_VALUE, "from-server-env", "the per-server env value must win over the global one");
	} finally {
		await context.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});
