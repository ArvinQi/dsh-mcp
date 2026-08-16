import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTransport } from "./transport.js";
const DEFAULT_PROBE_TIMEOUT_MS = 15e3;
function probeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function runProbe(client, config) {
  await client.connect(createTransport(config));
  const tools = [];
  let cursor;
  do {
    const response = await client.request(
      { method: "tools/list", ...cursor === void 0 ? {} : { params: { cursor } } },
      ListToolsResultSchema
    );
    for (const tool of response.tools) {
      tools.push({
        name: tool.name,
        ...tool.description === void 0 ? {} : { description: tool.description }
      });
    }
    cursor = response.nextCursor;
  } while (cursor);
  return { ok: true, tools };
}
async function probeConnection(config, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`probeConnection: timeoutMs must be a positive finite number, received ${String(timeoutMs)}`);
  }
  // OAuth authorization is interactive (browser login), so a probe with an
  // auth provider gets a generous budget; plain servers connect or fail
  // immediately and never wait out the budget. 5 minutes covers slow SSO
  // login + approval screens; an exhausted budget reports a failure view and
  // the loopback callback keeps running, so a late authorization still stores
  // the tokens and the next probe succeeds.
  const OAUTH_PROBE_BUDGET_MS = 5 * 60e3;
  const budgetMs = options.authProvider === void 0 ? timeoutMs : Math.max(timeoutMs, OAUTH_PROBE_BUDGET_MS);
  const client = new Client(
    { name: "dsh-mcp-client", version: "0.0.1" },
    {
      capabilities: {},
      ...(options.authProvider === void 0 ? {} : { authProvider: options.authProvider })
    }
  );
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`connection probe timed out after ${budgetMs}ms`)), budgetMs);
    timer.unref();
  });
  try {
    // The SDK performs OAuth in the transport layer, so the authProvider must
    // reach the transport config (not only the Client options).
    const transportConfig = {
      ...config,
      ...(options.authProvider === void 0 ? {} : { authProvider: options.authProvider })
    };
    return await Promise.race([runProbe(client, transportConfig), timeout]);
  } catch (error) {
    return { ok: false, message: probeErrorMessage(error) };
  } finally {
    try {
      await client.close();
    } catch {
    }
  }
}
export {
  probeConnection
};
