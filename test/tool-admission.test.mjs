import assert from "node:assert/strict";
import test from "node:test";
import { installAdmissionGate, shouldAdmitTool } from "../lib/tool-admission.js";

/** Live plugin state the admission predicate reads. */
function state(overrides = {}) {
	return {
		toolMode: "search",
		toolSwitches: new Map(),
		hotTools: new Map(),
		...overrides
	};
}

/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools` 0.2.2: `register` keeps a
 * per-tool `when`, `resolve` evaluates them once per step (exactly the seam the
 * gate depends on).
 */
function makeRegistry() {
	const registrations = new Map();
	const calls = [];
	const tools = {
		register(definition, options = {}) {
			calls.push({ definition, options });
			registrations.set(definition.name, { definition, when: options.when });
			return () => registrations.delete(definition.name);
		},
		async resolve(context) {
			const admitted = new Set();
			for (const [name, registration] of registrations) {
				const enabled = registration.when === undefined ? true : await registration.when(context);
				if (enabled) admitted.add(name);
			}
			return admitted;
		}
	};
	return { tools, registrations, calls };
}

test("search mode admits only the hot set, and never a switched-off tool", () => {
	const switches = new Map([["mcp__a__off", false]]);
	const hot = new Map([["mcp__a__hot", 1], ["mcp__a__off", 2]]);
	const s = state({ toolSwitches: switches, hotTools: hot });
	assert.equal(shouldAdmitTool("mcp__a__hot", s), true);
	assert.equal(shouldAdmitTool("mcp__a__cold", s), false, "a tool nobody searched for must stay out");
	assert.equal(shouldAdmitTool("mcp__a__off", s), false, "an explicit switch always wins over the hot set");
});

test("full mode admits every tool that is not switched off", () => {
	const switches = new Map([["mcp__a__off", false]]);
	const s = state({ toolMode: "full", toolSwitches: switches });
	assert.equal(shouldAdmitTool("mcp__a__cold", s), true);
	assert.equal(shouldAdmitTool("mcp__a__off", s), false);
});

test("the gate declares `when` at registration, only for the mcp__ namespace", () => {
	const { tools, registrations } = makeRegistry();
	const dispose = installAdmissionGate(tools, () => true);
	assert.equal(typeof dispose, "function");

	tools.register({ name: "mcp__a__x" });
	tools.register({ name: "mcp_tool_search" });
	tools.register({ name: "read_file" });

	assert.equal(typeof registrations.get("mcp__a__x").when, "function", "an MCP tool must carry an admission condition");
	assert.equal(registrations.get("mcp_tool_search").when, undefined, "the search tool must stay callable to admit anything");
	assert.equal(registrations.get("read_file").when, undefined, "tools outside the namespace are not ours");
	dispose();
});

test("a step resolves the live admission decision (search → hot → next step)", async () => {
	const { tools } = makeRegistry();
	const hot = new Map();
	const switches = new Map();
	const dispose = installAdmissionGate(tools, (name) => shouldAdmitTool(name, {
		toolMode: "search",
		toolSwitches: switches,
		hotTools: hot
	}));
	tools.register({ name: "mcp__a__x" });
	tools.register({ name: "mcp__a__y" });
	tools.register({ name: "mcp_tool_search" });

	assert.deepEqual([...(await tools.resolve({}))].sort(), ["mcp_tool_search"], "search mode starts with no MCP tools");

	// `mcp_tool_search` admitting a tool is what the hot set records.
	hot.set("mcp__a__x", 1);
	assert.deepEqual([...(await tools.resolve({}))].sort(), ["mcp__a__x", "mcp_tool_search"], "a hot tool joins the very next step");

	// The switch and the mode are read live, not captured at registration.
	switches.set("mcp__a__x", false);
	assert.deepEqual([...(await tools.resolve({}))].sort(), ["mcp_tool_search"], "switching a tool off removes it from the next step");

	const full = installAdmissionGate(tools, () => true);
	const gatedRegister = tools.register;
	assert.equal(typeof full, "function", "installing twice yields an inert disposer");
	assert.equal(tools.register, gatedRegister, "installing twice must not stack wrappers");
	full();
	assert.equal(tools.register, gatedRegister, "the inert disposer must not unwrap the live gate");
	dispose();
});

test("a caller-supplied `when` is preserved and still wins", async () => {
	const { tools, registrations } = makeRegistry();
	const dispose = installAdmissionGate(tools, () => true);
	tools.register({ name: "mcp__a__x" }, { when: () => false });
	tools.register({ name: "mcp__a__y" }, { when: async () => true });

	assert.equal(await registrations.get("mcp__a__x").when({}), false, "the caller's own condition may still veto");
	assert.equal(await registrations.get("mcp__a__y").when({}), true);
	dispose();
});

test("a core without the admission seam is left untouched", () => {
	const seen = [];
	const legacy = { register(definition, options) { seen.push({ definition, options }); return () => {}; } };
	assert.equal(installAdmissionGate(legacy, () => false), undefined, "no tools.resolve() means the waterfall transform is the filter");
	legacy.register({ name: "mcp__a__x" });
	assert.equal(seen[0].options, undefined, "the legacy single-argument call shape must not change");
});

test("the disposer restores register without clobbering a later wrapper", () => {
	const { tools } = makeRegistry();
	const original = tools.register;
	const dispose = installAdmissionGate(tools, () => true);
	assert.notEqual(tools.register, original);
	dispose();
	assert.equal(tools.register, original);

	const disposable = installAdmissionGate(tools, () => true);
	const later = () => {};
	tools.register = later;
	disposable();
	assert.equal(tools.register, later, "restoring must not delete someone else's wrapper");
});
