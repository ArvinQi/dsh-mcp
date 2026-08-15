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
  const client = new Client(
    { name: "dsh-mcp-client", version: "0.0.1" },
    { capabilities: {} }
  );
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`connection probe timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([runProbe(client, config), timeout]);
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
