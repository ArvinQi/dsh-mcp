import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyToolControl } from "../lib/tool-assembly.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One registered public tool. */
function tool(name) {
	return { name, description: `${name} description`, parameters: { type: "object", properties: {} } };
}

/** Live plugin state the transform receives. */
function state(overrides = {}) {
	return {
		toolSwitches: new Map(),
		toolMode: "all",
		hotTools: new Map(),
		serverOf: (name) => name.slice(5).split("__")[0],
		promptText: (key, vars) => (key === "toolControlPrompt" ? `prompt:${vars.servers}` : "(no servers)"),
		...overrides
	};
}

test("assembly without a tool list is a no-op instead of a TypeError (DSH >= 0.2.2)", () => {
	const assembly = { sections: [{ name: "persona", text: "hi" }], contexts: [], variables: {} };
	const before = JSON.stringify(assembly);
	assert.equal(applyToolControl(assembly, state()), false);
	assert.equal(JSON.stringify(assembly), before, "a degraded seam must not mutate the assembly");
	assert.equal(applyToolControl(undefined, state()), false);
	assert.equal(applyToolControl({ tools: "not-an-array" }, state()), false);
});

test("all mode drops switched-off tools and keeps a canonical order", () => {
	const assembly = {
		tools: [tool("mcp__b__z"), tool("read_file"), tool("mcp__a__y"), tool("mcp__a__x")]
	};
	const switches = new Map([["mcp__b__z", false]]);
	assert.equal(applyToolControl(assembly, state({ toolSwitches: switches })), true);
	assert.deepEqual(assembly.tools.map((entry) => entry.name), ["read_file", "mcp__a__x", "mcp__a__y"]);
});

test("search mode injects only the hot MCP tools plus the control section", () => {
	const assembly = {
		sections: [{ name: "persona", text: "p" }],
		tools: [tool("mcp__gh__search"), tool("mcp__gh__issues"), tool("read_file")]
	};
	const hot = new Map([["mcp__gh__issues", Date.now()]]);
	assert.equal(applyToolControl(assembly, state({ toolMode: "search", hotTools: hot })), true);
	assert.deepEqual(assembly.tools.map((entry) => entry.name), ["read_file", "mcp__gh__issues"]);
	const sections = assembly.sections.filter((section) => section.name === "mcp-tool-control");
	assert.equal(sections.length, 1);
	assert.equal(sections[0].text, "prompt:gh");
	// Re-running the same turn must replace, not duplicate, the control section.
	applyToolControl(assembly, state({ toolMode: "search", hotTools: hot }));
	assert.equal(assembly.sections.filter((section) => section.name === "mcp-tool-control").length, 1);
});

test("the assemble hook delegates to applyToolControl instead of reading assembly.tools raw", () => {
	const source = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
	assert.match(source, /applyToolControl\(assembly/, "hook must delegate to the guarded transform");
	assert.doesNotMatch(
		source,
		/for \(const tool of assembly\.tools\)/,
		"hook must not iterate assembly.tools directly (throws on DSH >= 0.2.2)"
	);
});
