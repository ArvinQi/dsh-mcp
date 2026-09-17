import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
function buildChildEnv(extra) {
  return { ...scrubbedParentEnv(), ...extra };
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
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: { headers: config.headers },
          ...(config.authProvider === void 0 ? {} : { authProvider: config.authProvider })
        }
      );
  }
}
export {
  createTransport
};
