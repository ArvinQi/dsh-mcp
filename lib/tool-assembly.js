/**
 * Tool-control transform for the `system-prompt/assemble` waterfall.
 *
 * Kept out of `lib/index.js` on purpose: this transform is the part that broke
 * when DSH moved the tool list outside the seam, and it has to stay testable
 * without the DSH module closure (`lib/index.js` imports `@deepseek-ai/*`).
 *
 * Context: DSH ≤ 0.2.1 handed `assembly` to the waterfall with `tools` already
 * attached. DSH ≥ 0.2.2 attaches the tool list **after** the waterfall runs, so
 * an assembly reaching this hook has `sections` / `contexts` / `variables` but
 * no `tools`. The old inline hook iterated `assembly.tools` unconditionally, so
 * every turn threw `TypeError: assembly.tools is not iterable` during pre-step
 * assembly — the model was never called and the UI showed "本轮运行失败".
 *
 * On such a core this seam simply cannot filter tools (the core overwrites the
 * list afterwards anyway), so the transform reports "not applied" instead of
 * throwing, and the host logs the degraded state once.
 * @module dsh-mcp/tool-assembly
 */

/**
 * Apply per-tool switches, search-mode hot-tool injection and the canonical
 * (prompt-cache friendly) tool order.
 *
 * @param {object} assembly - the `system-prompt/assemble` payload. It may or
 *   may not carry `tools`; when it does not, nothing is mutated.
 * @param {object} state - live plugin state / helpers.
 * @param {Map<string, boolean>} state.toolSwitches - public tool name → enabled.
 * @param {'all'|'search'} state.toolMode - injection mode.
 * @param {Map<string, number>} state.hotTools - recently used MCP tool names.
 * @param {(name: string) => string} state.serverOf - server namespace of a tool.
 * @param {(key: string, vars?: object) => string} state.promptText - localized
 *   host copy for the injected `mcp-tool-control` section.
 * @returns {boolean} `true` when the transform ran; `false` when this core does
 *   not expose the tool list at this seam (degraded, not an error).
 */
export function applyToolControl(assembly, state) {
	if (!assembly || !Array.isArray(assembly.tools)) return false;
	const { toolSwitches, toolMode, hotTools, serverOf, promptText } = state;
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
			text: promptText("toolControlPrompt", { servers: servers.join(", ") || promptText("noServers") })
		});
	}
	// Canonical tool order: render MCP tools sorted by name so the system prompt
	// stays byte-stable for the same tool set no matter the registration or
	// hot-set order (hot tools move on every call, and servers may reorder
	// tools/list) — stable output is what preserves prompt-cache hits.
	const mcpKept = [];
	const otherKept = [];
	for (const tool of kept) (tool.name.startsWith("mcp__") ? mcpKept : otherKept).push(tool);
	mcpKept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	assembly.tools = [...otherKept, ...mcpKept];
	return true;
}
