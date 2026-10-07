/**
 * Issue #12: `managedServerId()` used to recover the server id from a secret
 * credential ref by splitting on the LAST `_`, which misreads every env name
 * that itself contains one (`TAVILY_API_KEY`). The ref format is ambiguous by
 * construction — both the id (`mcp_<12 hex>`) and the name may carry `_` — so
 * the function must match the id's fixed shape.
 *
 * The helper is read straight out of the shipped `lib/index.js` (with stubs for
 * its module-scope dependencies) rather than exported for the test: it is a
 * private helper, and pinning the shipped file is the point.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadManagedServerId() {
	const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
	const match = /^function managedServerId\(ref\) \{(?<body>[\s\S]*?)^\}/m.exec(source);
	assert.notEqual(match, null, "managedServerId must remain a top-level function in lib/index.js");
	const factory = new Function("SECRET_REF_PREFIX", "credentialRef", `
		${match[0]}
		return managedServerId;
	`);
	return factory("DSH_MCP_", (value) => value);
}

test("a server id is recovered from refs whose env name contains underscores", async () => {
	const managedServerId = await loadManagedServerId();
	const id = "mcp_0e7ce02df6f7";
	for (const name of ["TAVILY_API_KEY", "API_KEY", "TOKEN", "MY_VAR", "A", "_LEADING"]) {
		assert.equal(managedServerId(`DSH_MCP_${id}_${name}`), id, `${name} must resolve to the server id`);
	}
});

test("refs that do not carry a managed server id stay unresolved", async () => {
	const managedServerId = await loadManagedServerId();
	for (const ref of [
		// Process-level env refs share the DSH_MCP_ prefix but no server id.
		"DSH_MCP_ENV_TAVILY_API_KEY",
		"DSH_MCP_ENV_TOKEN",
		// OAuth refs carry a sanitized serverName, not an id.
		"DSH_MCP_OAUTH_tavily_8f14e45fceea",
		"DSH_MCP_OAUTH_CLIENT_tavily_8f14e45fceea",
		// Malformed ids: wrong length, non-hex, or no trailing separator.
		"DSH_MCP_mcp_0e7ce02df6f7",
		"DSH_MCP_mcp_0e7ce02df6f_TAVILY_API_KEY",
		"DSH_MCP_mcp_0e7ce02df6g7_TAVILY_API_KEY",
		"DSH_MCP_mcp__TAVILY_API_KEY",
		"OTHER_mcp_0e7ce02df6f7_TAVILY_API_KEY"
	]) assert.equal(managedServerId(ref), void 0, `${ref} must not resolve to a server id`);
});
