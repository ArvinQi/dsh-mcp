import assert from "node:assert/strict";
import test from "node:test";
import { applyToolControl } from "../lib/tool-control.js";

/** A manager state good enough for the pure helper. */
function managerState(overrides = {}) {
	return {
		toolSwitches: new Map(),
		toolMode: "search",
		hotTools: new Map(),
		serverOf: (name) => name.split("__")[1],
		toolControlText: (servers) => `control:${servers.join(",")}`,
		...overrides
	};
}

/** Tool declarations shaped like the ones DSH passes to the waterfall. */
function tool(name) {
	return { name, description: `${name} description`, parameters: { type: "object" } };
}

test("hosts without a tool array are left untouched (DSH >= 0.2.1-rc.2)", () => {
	// The regression: this payload used to reach `for (const tool of
	// assembly.tools)` and throw `assembly.tools is not iterable`, failing
	// the turn before the first model call.
	const assembly = {
		sections: [{ name: "persona", text: "you are dsh" }],
		contexts: [],
		variables: {}
	};
	const before = JSON.stringify(assembly);
	assert.equal(applyToolControl(assembly, managerState()), false);
	assert.equal(JSON.stringify(assembly), before, "the assembly must not be mutated");
	assert.equal("tools" in assembly, false, "no tools array may be invented");
});

test("a missing or non-array tools field is reported, never thrown on", () => {
	for (const tools of [undefined, null, "mcp__a__b", {}, 42]) {
		const assembly = { sections: [], tools };
		assert.equal(applyToolControl(assembly, managerState()), false, `tools=${String(tools)}`);
	}
	assert.equal(applyToolControl(undefined, managerState()), false);
});

test("full mode drops disabled MCP tools and keeps the shiftable order stable", () => {
	const state = managerState({
		toolMode: "full",
		toolSwitches: new Map([["mcp__b__off", false]]),
		hotTools: new Map([["mcp__b__hot", 1]])
	});
	const assembly = {
		sections: [{ name: "persona", text: "x" }],
		tools: [tool("mcp__b__zeta"), tool("read_file"), tool("mcp__a__alpha"), tool("mcp__b__off")]
	};

	assert.equal(applyToolControl(assembly, state), true);
	assert.deepEqual(assembly.tools.map((entry) => entry.name), ["read_file", "mcp__a__alpha", "mcp__b__zeta"]);
	assert.deepEqual(assembly.sections.map((section) => section.name), ["persona"], "full mode injects no control section");
});

test("search mode injects only resident + hot tools and the control section", () => {
	const state = managerState({
		hotTools: new Map([["mcp__b__hot", 2], ["mcp__missing__gone", 1]]),
		toolSwitches: new Map([["mcp__b__hot", false]])
	});
	const assembly = {
		sections: [{ name: "persona", text: "x" }, { name: "mcp-tool-control", text: "stale" }],
		tools: [tool("mcp__b__shy"), tool("mcp__b__hot"), tool("edit_file"), tool("mcp__a__shy")]
	};

	assert.equal(applyToolControl(assembly, state), true);
	assert.deepEqual(
		assembly.tools.map((entry) => entry.name),
		["edit_file"],
		"a hot tool whose switch is off stays hidden; non-hot MCP tools are hidden in search mode"
	);
	const control = assembly.sections.filter((section) => section.name === "mcp-tool-control");
	assert.equal(control.length, 1, "the previous control section is replaced, not duplicated");
	assert.equal(control[0].text, "control:a,b", "servers are de-duplicated and sorted");
});

test("search mode re-adds a hot tool and sorts it canonically after the plain tools", () => {
	const state = managerState({ hotTools: new Map([["mcp__b__hot", 1]]) });
	const assembly = { sections: [], tools: [tool("mcp__b__hot"), tool("write_file"), tool("mcp__a__other")] };

	assert.equal(applyToolControl(assembly, state), true);
	assert.deepEqual(assembly.tools.map((entry) => entry.name), ["write_file", "mcp__b__hot"]);
});
