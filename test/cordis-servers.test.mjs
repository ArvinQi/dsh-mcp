import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	MCP_CLIENT_ROW_NAMES,
	parseDeclaredRows,
	readDeclaredServers,
	resolveHarnessHome,
	resolvePatchLayers,
	toDeclaredServer,
	toMirrorRecord
} from "../lib/cordis-servers.js";

/** One profile patch declaring two native MCP rows. */
const PROFILE_PATCH = `- id: unrelated
  disabled: true

- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: github
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: web
        url: http://localhost:3000/mcp
        headers:
          Authorization: 'Bearer static'
`;

/** A temporary harness home plus profile directory. */
function fixtureHome(profilePatch = PROFILE_PATCH, homePatch) {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-cordis-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	if (profilePatch !== undefined) writeFileSync(join(profileDir, "cordis.patch.yml"), profilePatch);
	if (homePatch !== undefined) writeFileSync(join(home, "cordis.patch.yml"), homePatch);
	const ctx = {
		baseUrl: pathToFileURL(join(profileDir, "cordis.yml")).href,
		get(name) {
			return name === "dshHomePath" ? () => home : void 0;
		}
	};
	return { home, profileDir, ctx, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("parseDeclaredRows keeps only mcp-client rows, from any insert list", () => {
	const rows = parseDeclaredRows(PROFILE_PATCH);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((row) => row.id), ["mcp-github", "mcp-web"]);
	assert.ok(rows.every((row) => MCP_CLIENT_ROW_NAMES.has(row.name)));
});

test("toDeclaredServer maps an http row into the manager vocabulary", () => {
	const rows = parseDeclaredRows(PROFILE_PATCH);
	const web = toDeclaredServer(rows[1], { kind: "profile", path: "/tmp/cordis.patch.yml" });
	assert.equal(web.serverName, "web");
	assert.equal(web.transport, "streamable-http");
	assert.equal(web.enabled, true);
	assert.deepEqual(web.headers, [{ name: "Authorization", value: "Bearer static" }]);
	assert.equal(web.declaredIn, "/tmp/cordis.patch.yml");
	assert.equal(web.layer, "profile");
});

test("a !!js scalar keeps its source text instead of a runtime value", () => {
	const rows = parseDeclaredRows(PROFILE_PATCH);
	const github = toDeclaredServer(rows[0], { kind: "profile", path: "/tmp/cordis.patch.yml" });
	assert.deepEqual(github.env, [{
		name: "GITHUB_TOKEN",
		secret: false,
		configured: true,
		value: "!!js process.env.GITHUB_TOKEN"
	}]);
});

test("readDeclaredServers reads both layers and the home layer wins by name", () => {
	const homePatch = `- insert:
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: web
        url: https://example.test/mcp
`;
	const fixture = fixtureHome(PROFILE_PATCH, homePatch);
	try {
		const read = readDeclaredServers(fixture.ctx);
		assert.deepEqual(read.layers.map((layer) => layer.kind), ["profile", "home"]);
		assert.deepEqual(read.layers.map((layer) => layer.exists), [true, true]);
		assert.equal(read.servers.length, 2);
		const web = read.servers.find((entry) => entry.serverName === "web");
		assert.equal(web.url, "https://example.test/mcp", "the machine-wide layer must override the profile row");
		assert.equal(web.layer, "home");
		assert.deepEqual(read.warnings, []);
	} finally {
		fixture.cleanup();
	}
});

test("a malformed layer becomes a diagnostic, never a throw", () => {
	const fixture = fixtureHome("not: [a, top-level, array\n");
	try {
		const read = readDeclaredServers(fixture.ctx);
		assert.equal(read.servers.length, 0);
		assert.equal(read.warnings.length, 1);
		assert.equal(read.layers[0].exists, true);
		assert.ok(read.layers[0].error !== undefined);
	} finally {
		fixture.cleanup();
	}
});

test("duplicate serverName rows in one layer warn and keep the later row", () => {
	const duplicate = `- insert:
    - id: mcp-a
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: streamable-http, serverName: web, url: http://a.test/mcp }
    - id: mcp-b
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: streamable-http, serverName: web, url: http://b.test/mcp }
`;
	const fixture = fixtureHome(duplicate);
	try {
		const read = readDeclaredServers(fixture.ctx);
		assert.equal(read.servers.length, 1);
		assert.equal(read.servers[0].url, "http://b.test/mcp");
		assert.equal(read.warnings.length, 1);
		assert.match(read.warnings[0], /duplicate serverName "web"/);
	} finally {
		fixture.cleanup();
	}
});

test("a disabled row is reported disabled; absent layers are not warnings", () => {
	const disabled = `- insert:
    - id: mcp-off
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
      config: { transport: stdio, serverName: off, command: node, args: ['server.js'] }
`;
	const fixture = fixtureHome(disabled);
	try {
		const read = readDeclaredServers(fixture.ctx);
		assert.equal(read.servers.length, 1);
		assert.equal(read.servers[0].enabled, false);
		assert.equal(read.layers[1].exists, false, "the absent home layer is a plain fact, not a warning");
		assert.deepEqual(read.warnings, []);
	} finally {
		fixture.cleanup();
	}
});

test("toMirrorRecord projects a declaration into a mirror record", () => {
	const rows = parseDeclaredRows(PROFILE_PATCH);
	const web = toDeclaredServer(rows[1], { kind: "home", path: "/home/u/.dsh/cordis.patch.yml" });
	const record = toMirrorRecord(web);
	assert.equal(record.id, "cordis:mcp-web");
	assert.equal(record.serverName, "web");
	assert.equal(record.origin, "cordis");
	assert.equal(record.declaredRowId, "mcp-web");
	assert.equal(record.declaredIn, "/home/u/.dsh/cordis.patch.yml");
	assert.equal(record.stale, false);
	assert.deepEqual(record.env, []);
	assert.deepEqual(record.headers, [{ name: "Authorization", value: "Bearer static" }]);
});

test("a !!js value anywhere marks the declaration as not importable", () => {
	const layer = { kind: "profile", path: "/tmp/cordis.patch.yml" };
	const rows = parseDeclaredRows(PROFILE_PATCH);
	assert.equal(toDeclaredServer(rows[0], layer).hasJsExpr, true, "the env token is a !!js expression");
	assert.equal(toDeclaredServer(rows[1], layer).hasJsExpr, false);
	const jsCommand = parseDeclaredRows(`- insert:
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: x, command: !!js process.execPath, args: [] }
`);
	assert.equal(toDeclaredServer(jsCommand[0], layer).hasJsExpr, true);
});

test("an id-targeted disable in the same layer marks the declaration disabled", () => {
	const patch = `- insert:
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: streamable-http, serverName: web, url: http://x/mcp, headers: { Authorization: 'Bearer s' } }
- id: mcp-web
  disabled: true
`;
	const fixture = fixtureHome(patch);
	try {
		const read = readDeclaredServers(fixture.ctx);
		assert.equal(read.servers.length, 1);
		assert.equal(read.servers[0].enabled, false, "the managed takeover block must read as disabled");
		assert.equal(read.servers[0].declaredIn, join(fixture.profileDir, "cordis.patch.yml"));
	} finally {
		fixture.cleanup();
	}
});

test("a machine-wide layer can disable a row the profile declared", () => {
	const fixture = fixtureHome(PROFILE_PATCH, `- id: mcp-web
  disabled: true
`);
	try {
		const read = readDeclaredServers(fixture.ctx);
		const web = read.servers.find((entry) => entry.serverName === "web");
		assert.equal(web.enabled, false, "the later layer wins");
		assert.equal(web.declaredIn, join(fixture.profileDir, "cordis.patch.yml"), "attribution stays with the declaring layer");
	} finally {
		fixture.cleanup();
	}
});

test("resolvePatchLayers falls back to the machine-wide home layer", () => {
	const bare = { get() { return void 0; } };
	const layers = resolvePatchLayers(bare);
	assert.equal(layers.length, 1);
	assert.equal(layers[0].kind, "home");
	assert.equal(basename(layers[0].path), "cordis.patch.yml");
	assert.ok(resolveHarnessHome(bare).length > 0);
});
