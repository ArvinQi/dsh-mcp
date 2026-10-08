import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { ensureSystemCaTrust, systemFetch } from "./system-ca.js";
function buildChildEnv(extra) {
  return { ...scrubbedParentEnv(), ...extra };
}
/**
 * HTTPS servers are verified against the operating-system trust store in
 * addition to Node's bundled roots (see lib/system-ca.js): internal/corporate
 * endpoints are usually signed by a CA that only the OS knows.
 */
function trustSystemCaFor(url) {
  try {
    if (new URL(url).protocol === "https:") ensureSystemCaTrust();
  } catch {
  }
}
function createTransport(config) {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd
      });
    case "streamable-http":
      trustSystemCaFor(config.url);
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          // HTTPS verification trusts the OS store (corporate/internal roots);
          // the SDK reuses this fetch for its OAuth discovery/token calls.
          fetch: systemFetch(),
          ...(config.authProvider === void 0 ? {} : { authProvider: config.authProvider })
        }
      );
  }
}
export {
  createTransport
};
