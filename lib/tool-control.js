/**
 * dsh-mcp's tool control at the `system-prompt/assemble` waterfall.
 *
 * The plugin shapes the MCP half of the model-facing tool list from that
 * hook: the per-tool enable switches, search-mode injection (only the
 * resident + hot set, plus the `mcp-tool-control` guidance section), and a
 * canonical MCP order that keeps the prompt byte-stable so prompt-cache hits
 * survive a shifting hot set.
 *
 * DSH `0.2.1-rc.2` changed that contract. The waterfall now receives
 * sections, contexts and variables (`PromptPresentation`) **without a tool
 * array** — conditional tools are admitted per step at registration time and
 * a returned `tools` array is ignored — so `assembly.tools` is `undefined`
 * and any listener that loops over it throws `assembly.tools is not
 * iterable`, failing the turn before the first model call.
 *
 * The filtering therefore lives here, off the hook, and reports whether this
 * host could apply it at all: {@link applyToolControl} returns `false` when
 * no tool array is present, and the caller skips the work instead of dying.
 * The helper is dependency-free on purpose, so the behaviour is covered by
 * the dependency-free half of the test suite.
 * @module
 */

/**
 * Apply the tool switches, search-mode injection and canonical order to one
 * `system-prompt/assemble` payload.
 *
 * Mutates `assembly` in place and never throws: a host that passes no tool
 * array (DSH >= `0.2.1-rc.2`) gets `false` and an untouched assembly.
 *
 * @param assembly - The waterfall payload (`sections`, possibly `tools`).
 * @param state - The manager's live tool-control state.
 * @param state.toolSwitches - Per-tool switch map; `false` hides a tool.
 * @param state.toolMode - `search` (resident + hot only) or `full`.
 * @param state.hotTools - Recently searched/called tool names, in LRU order.
 * @param state.serverOf - Resolves an `mcp__<server>__<tool>` name to its server.
 * @param state.toolControlText - Builds the `mcp-tool-control` section text.
 * @returns `true` when the assembly was processed, `false` when this host
 * passes no tool array (nothing can be filtered or ordered here).
 */
export function applyToolControl(assembly, state) {
	if (!assembly || !Array.isArray(assembly.tools)) return false;
	const { toolSwitches, toolMode, hotTools, serverOf, toolControlText } = state;

	const kept = [];
	const mcpByName = {};
	for (const tool of assembly.tools) {
		if (!tool.name.startsWith("mcp__")) {
			kept.push(tool);
			continue;
		}
		if (toolSwitches.get(tool.name) === false) continue;
		mcpByName[tool.name] = tool;
		if (toolMode !== "search") kept.push(tool);
	}
	if (toolMode === "search") {
		for (const name of hotTools.keys()) {
			const tool = mcpByName[name];
			if (tool) kept.push(tool);
		}
		const servers = [...new Set(Object.keys(mcpByName).map((name) => serverOf(name)))].sort();
		assembly.sections = (assembly.sections || []).filter((section) => section.name !== "mcp-tool-control");
		assembly.sections.push({
			name: "mcp-tool-control",
			text: toolControlText(servers)
		});
	}
	assembly.tools = kept;
	// Canonical tool order: render MCP tools sorted by name so the system
	// prompt stays byte-stable for the same tool set no matter the
	// registration or hot-set order (hot tools move on every call, and
	// servers may reorder tools/list) — stable output is what preserves
	// prompt-cache hits.
	const mcpKept = [];
	const otherKept = [];
	for (const tool of assembly.tools) (tool.name.startsWith("mcp__") ? mcpKept : otherKept).push(tool);
	mcpKept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	assembly.tools = [...otherKept, ...mcpKept];
	return true;
}
