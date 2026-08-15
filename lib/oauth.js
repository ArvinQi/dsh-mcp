/**
 * OAuth 2.0 (authorization-code + PKCE) client provider for MCP servers,
 * implemented for the dsh-mcp host half.
 *
 * The MCP SDK drives the flow (metadata discovery, dynamic client registration,
 * PKCE, token refresh) and only asks this provider to: persist tokens, and
 * redirect the user agent to the authorization URL. This provider opens the
 * system browser, hosts a loopback callback server, exchanges the returned
 * code for tokens via the SDK, and stores them in the credentials document
 * (per server id), so reconnects reuse the tokens and the SDK refreshes them
 * transparently.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** Credential reference namespace prefix for per-server OAuth tokens. */
const OAUTH_REF_PREFIX = "DSH_MCP_OAUTH_";

/** One server's OAuth token credential reference. */
function oauthTokenRef(serverId) {
  return credentialRef(`${OAUTH_REF_PREFIX}${serverId}`);
}

/** Open the system browser to one URL, best effort. */
function openBrowser(url) {
  const command =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * Build one OAuthClientProvider for a managed server.
 * @param serverId - Managed server id; keys the stored token.
 * @param ctx - Host context carrying the credentials service.
 * @returns an MCP SDK `OAuthClientProvider` implementation.
 */
export function createOAuthProvider(serverId, ctx) {
  let codeVerifierValue = null;
  let savedClientInfo = null;
  const port = 3100 + Math.floor(Math.random() * 20000);
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  return {
    get redirectUrl() {
      return redirectUrl;
    },
    clientMetadata: {
      client_name: "dsh-mcp",
      redirect_uris: [redirectUrl],
    },
    async clientInformation() {
      return savedClientInfo;
    },
    async saveClientInformation(info) {
      savedClientInfo = info;
    },
    async tokens() {
      const hit = await ctx.credentials.resolve(oauthTokenRef(serverId));
      if (hit === undefined) return undefined;
      try {
        return JSON.parse(hit.value);
      } catch {
        return undefined;
      }
    },
    async saveTokens(tokens) {
      await ctx.credentials.set(oauthTokenRef(serverId), JSON.stringify(tokens));
    },
    async clearTokens() {
      await ctx.credentials.unset(oauthTokenRef(serverId));
    },
    async saveCodeVerifier(codeVerifier) {
      codeVerifierValue = codeVerifier;
    },
    async codeVerifier() {
      return codeVerifierValue;
    },
    async redirectToAuthorization(authorizationUrl) {
      let resolveResult;
      const resultPromise = new Promise((resolve) => {
        resolveResult = resolve;
      });
      const server = createServer((req, res) => {
        const url = new URL(req.url, redirectUrl);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.setHeader("content-type", "text/html; charset=utf-8");
        if (error) {
          res.end(`授权失败：${error}，可关闭此页面并返回 DSH。`);
          resolveResult({ error });
          return;
        }
        res.end("授权成功，可关闭此页面并返回 DSH。");
        resolveResult({ code });
      });
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      openBrowser(authorizationUrl.toString());
      try {
        const result = await resultPromise;
        if (result.error) throw new Error(`OAuth 授权失败：${result.error}`);
        const authServerUrl = new URL(authorizationUrl.origin);
        const metadata = await discoverAuthorizationServerMetadata(authServerUrl);
        const tokens = await exchangeAuthorization(authServerUrl, {
          metadata,
          clientInformation: savedClientInfo,
          authorizationCode: result.code,
          codeVerifier: codeVerifierValue,
          redirectUri: redirectUrl,
        });
        await this.saveTokens(tokens);
      } finally {
        server.close();
      }
    },
  };
}
