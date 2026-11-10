/**
 * Registration-time admission gate: search mode and per-tool switches on the
 * DSH cores that filter tools *before* the system prompt is built.
 *
 * Why this exists
 * ---------------
 * DSH ≤ 0.2.1 handed `system-prompt/assemble` an assembly with `tools` already
 * attached, so `lib/tool-assembly.js` could filter that list in the waterfall.
 *
 * DSH ≥ 0.2.2 does not: `@deepseek-ai/dsh-tools` publishes the model-facing
 * tool list through a `systemPrompt.tools()` contributor built from a
 * **per-step admission set** (`tools.resolve()` → `registration.when(context)`),
 * and the waterfall runs without a tool list. Filtering an already-built list
 * therefore cannot work — a tool outside the admission set never reaches the
 * prompt, and a tool inside it cannot be removed afterwards.
 *
 * The only seam that still carries a decision is the registration itself:
 * `register(definition, { when })` stores a condition that `resolve()` evaluates
 * once per step. So the plugin declares `when` at registration time and lets the
 * core do the admission — which is also cheaper, because the model never sees
 * the tool it was not admitted for.
 *
 * Bare core compatibility: `register` on ≤ 0.2.1 takes a single argument and
 * ignores the extra one, so the waterfall transform in `tool-assembly.js` keeps
 * working there untouched. This gate is installed only when the core actually
 * exposes the admission seam (`tools.resolve`).
 * @module dsh-mcp/tool-admission
 */

/** Marks one wrapper as this plugin's gate, so a reload cannot stack a second. */
const GATE_MARK = Symbol.for("dsh-mcp.admission-gate");

/**
 * Whether one MCP tool may enter a step's model-facing tool set.
 *
 * - a switched-off tool is never admitted;
 * - `search` mode admits only the hot set (recently searched or called) plus
 *   whatever `mcp_tool_search` injected for the next step;
 * - `full` mode admits every tool that is not switched off.
 *
 * The hot set is read live: `when` is evaluated per step, so a tool that
 * `mcp_tool_search` just recorded becomes admissible on the very next step.
 * @param {string} name - public tool name (`mcp__<server>__<tool>`).
 * @param {object} state - live plugin state.
 * @param {string} state.toolMode - `search` or `full`.
 * @param {Map<string, boolean>} state.toolSwitches - public name → enabled.
 * @param {Map<string, number>} state.hotTools - the resident/hot tool names.
 * @returns {boolean} whether the tool may be shown to the model this step.
 */
export function shouldAdmitTool(name, state) {
	const { toolMode, toolSwitches, hotTools } = state;
	if (toolSwitches.get(name) === false) return false;
	if (toolMode === "search") return hotTools.has(name);
	return true;
}

/**
 * Install the admission gate on a tool registry, or report that this core does
 * not need it.
 *
 * Every `mcp__*` registration is wrapped so the core receives a `when`
 * condition built from `isAdmitted`. A caller-supplied `when` is preserved and
 * still wins: the plugin's admission is ANDed after it, never in front of it.
 * Registrations outside the `mcp__` namespace — notably `mcp_tool_search`
 * itself, which must stay callable to admit anything at all — pass through
 * untouched.
 *
 * @param {object} tools - the core's `tools` service (`ctx.tools`).
 * @param {(name: string) => boolean} isAdmitted - live admission decision.
 * @returns {(() => void) | undefined} a disposer restoring the original
 *   `register`, or `undefined` when this core has no admission seam (in which
 *   case the waterfall transform remains the only filter and nothing is
 *   monkey-patched).
 */
export function installAdmissionGate(tools, isAdmitted) {
	if (tools === null || typeof tools !== "object") return undefined;
	if (typeof tools.register !== "function") return undefined;
	// `tools.resolve()` is the per-step admission pass introduced with the
	// `when` option; without it the extra argument would be dead weight and the
	// waterfall transform is still the working path.
	if (typeof tools.resolve !== "function") return undefined;
	if (tools.register[GATE_MARK] === true) return () => {};

	const original = tools.register;
	const hadOwnRegister = Object.prototype.hasOwnProperty.call(tools, "register");

	const gate = function registerWithAdmission(definition, options) {
		const name = definition !== null && typeof definition === "object" && typeof definition.name === "string"
			? definition.name
			: undefined;
		if (name === undefined || !name.startsWith("mcp__")) {
			return original.call(this, definition, options);
		}
		const base = options !== null && typeof options === "object" ? options : {};
		const callerWhen = base.when;
		const when = typeof callerWhen === "function"
			? async (context) => (await callerWhen(context)) && isAdmitted(name)
			: () => isAdmitted(name);
		return original.call(this, definition, { ...base, when });
	};
	gate[GATE_MARK] = true;
	tools.register = gate;

	return () => {
		// Only undo our own patch: a later plugin may have wrapped register in
		// turn, and deleting their wrapper would re-open the admission hole.
		if (tools.register !== gate) return;
		if (hadOwnRegister) tools.register = original;
		else delete tools.register;
	};
}
