/**
 * Credential-reference parsing for the manager's own secret env refs.
 *
 * Kept free of `@deepseek-ai/*` imports so its regression test can run
 * without a DSH installation, like the other dependency-free suites listed
 * in `scripts/test.mjs`.
 * @module dsh-mcp/refs
 */
/** Credential reference namespace prefix for secret env values. */
const SECRET_REF_PREFIX = "DSH_MCP_";
/**
 * A managed server id, as minted by the manager: `mcp_` + 12 hex characters
 * (`mintServerId()`). The id itself contains an underscore, so a reference
 * cannot be split on `_` alone to separate the id from the env name.
 */
const MANAGED_REF = /^(mcp_[0-9a-f]{12})_/;
/**
 * The managed server id a credential reference belongs to, when the reference
 * is one of this manager's secret env refs.
 *
 * The reference format is `<SECRET_REF_PREFIX><id>_<name>`, and the env name
 * may itself contain `_` (e.g. `TAVILY_API_KEY`). The id is therefore matched
 * by its exact shape rather than split on the last `_`.
 * @param ref - A credential reference.
 * @returns the server id, or undefined when the ref is not a managed secret env ref.
 */
function managedServerId(ref) {
	if (typeof ref !== "string" || !ref.startsWith(SECRET_REF_PREFIX)) return void 0;
	const match = MANAGED_REF.exec(ref.slice(SECRET_REF_PREFIX.length));
	return match ? match[1] : void 0;
}
export { SECRET_REF_PREFIX, managedServerId };
