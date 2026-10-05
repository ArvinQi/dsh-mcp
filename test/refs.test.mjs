import assert from "node:assert/strict";
import test from "node:test";
import { managedServerId } from "../lib/refs.js";

const ID = "mcp_0e7ce02df6f7";

// The ref format is DSH_MCP_<id>_<name>, where the id is mcp_<12 hex> and the
// env name may itself contain underscores. Regression: the id used to be
// recovered by splitting on the last "_", which truncated it whenever the
// name had an underscore (TAVILY_API_KEY -> mcp_0e7ce02df6f7_TAVILY_API).
test("resolves the server id whatever the env name contains", () => {
	for (const name of ["TOKEN", "API_KEY", "TAVILY_API_KEY", "MY_VAR", "A_B_C_D_E"]) {
		assert.equal(managedServerId(`DSH_MCP_${ID}_${name}`), ID, `env name ${name}`);
	}
});

test("rejects references that are not managed secret env refs", () => {
	assert.equal(managedServerId(""), void 0);
	assert.equal(managedServerId("OTHER_PREFIX_KEY"), void 0, "different namespace");
	assert.equal(managedServerId(`DSH_MCP_ENV_${"TAVILY_API_KEY"}`), void 0, "process-level env refs carry no server id");
	assert.equal(managedServerId("DSH_MCP_OAUTH_octop_memory_prod_ab12"), void 0, "OAuth refs carry no server id");
	assert.equal(managedServerId(`DSH_MCP_${ID}`), void 0, "missing env name");
	assert.equal(managedServerId("DSH_MCP_mcp_nothex1234_NAME"), void 0, "id must be mcp_ + 12 hex characters");
	assert.equal(managedServerId(void 0), void 0, "non-string input");
});
