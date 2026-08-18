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

/** Credential reference namespace prefix for per-server OAuth client info. */
const OAUTH_CLIENT_REF_PREFIX = "DSH_MCP_OAUTH_CLIENT_";

/** Short stable hash so sanitized server ids cannot collide. */
function shortHash(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Credential ref names must match /^[A-Za-z_][A-Za-z0-9_]*$/, but managed
 * server ids may contain hyphens, slashes, spaces, etc.; sanitize the id and
 * append a short stable hash of the original so distinct ids cannot collide
 * (e.g. "a-b" and "a_b").
 */
function oauthRef(prefix, serverId) {
  const safe = serverId.replace(/[^A-Za-z0-9_]/g, "_");
  return credentialRef(`${prefix}${safe}_${shortHash(serverId)}`);
}

/** One server's OAuth token credential reference. */
function oauthTokenRef(serverId) {
  return oauthRef(OAUTH_REF_PREFIX, serverId);
}

/** One server's registered OAuth client credential reference. */
function oauthClientRef(serverId) {
  return oauthRef(OAUTH_CLIENT_REF_PREFIX, serverId);
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
 * Extract the `exp` claim from a JWT access token, when it is a JWT.
 * @param accessToken - The access token string.
 * @returns the expiry epoch seconds, or undefined when not a JWT / no exp.
 */
function jwtExp(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(accessToken).split(".")[1] ?? "", "base64url").toString("utf8")
    );
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive a stable loopback port from the server id. The redirect URI must
 * stay identical across processes because the registered OAuth client's
 * redirect_uris are fixed at registration time; a random port per process
 * would make the authorization server reject the redirect with
 * `redirect_uri_mismatch`.
 * @param serverId - Managed server id.
 * @returns a stable port in [3100, 23099].
 */
function stablePort(serverId) {
  let hash = 0;
  for (let i = 0; i < serverId.length; i += 1) {
    hash = (hash * 31 + serverId.charCodeAt(i)) >>> 0;
  }
  return 3100 + (hash % 20000);
}

/**
 * Serialize authorization flows per server: the loopback port is stable per
 * server, so two concurrent flows (e.g. mount and a test connection) would
 * both try to listen on the same port and one fails with EADDRINUSE. Queue
 * them so only one browser authorization runs at a time per server.
 */
const authLocks = /* @__PURE__ */ new Map();

function withAuthLock(serverId, fn) {
  const previous = authLocks.get(serverId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  authLocks.set(serverId, run.then(() => {}, () => {}));
  return run;
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
  const port = stablePort(serverId);
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const log = ctx?.logger ?? console;
  const tag = `mcp-oauth(${serverId})`;

  return {
    get redirectUrl() {
      return redirectUrl;
    },
    clientMetadata: {
      client_name: "dsh-mcp",
      redirect_uris: [redirectUrl],
    },
    async clientInformation() {
      if (savedClientInfo !== null) return savedClientInfo;
      const hit = await ctx.credentials.resolve(oauthClientRef(serverId));
      if (hit === undefined) return undefined;
      try {
        const info = JSON.parse(hit.value);
        // The persisted client's registered redirect_uris must cover this
        // loopback URI; otherwise the authorization server rejects the
        // redirect with `redirect_uri_mismatch`. Drop it so the SDK
        // re-registers a client for the current (stable) redirect URI.
        if (!Array.isArray(info.redirect_uris) || !info.redirect_uris.includes(redirectUrl)) {
          log.info(`${tag}: persisted client redirect_uris mismatch, re-registering`);
          return undefined;
        }
        return info;
      } catch {
        return undefined;
      }
    },
    async saveClientInformation(info) {
      savedClientInfo = info;
      // Persist the registered client (client_id) with the tokens so a later
      // token refresh uses the same client. Without this, every process
      // re-registers a fresh client and the server rejects refresh with
      // "client_id mismatch".
      if (info === undefined || info === null) {
        await ctx.credentials.unset(oauthClientRef(serverId));
      } else {
        await ctx.credentials.set(oauthClientRef(serverId), JSON.stringify(info));
      }
    },
    async invalidateCredentials(credentialType) {
      // The SDK calls this when a refresh/registration fails with an
      // unrecoverable error (InvalidClient / UnauthorizedClient / InvalidGrant)
      // so the next attempt starts a fresh authorization flow. Clearing the
      // stored tokens is what lets that flow actually open the browser again.
      if (credentialType === undefined || credentialType === "all" || credentialType === "tokens") {
        await ctx.credentials.unset(oauthTokenRef(serverId));
      }
      if (credentialType === undefined || credentialType === "all") {
        savedClientInfo = null;
        await ctx.credentials.unset(oauthClientRef(serverId));
      }
      log.info(`${tag}: credentials invalidated (${String(credentialType)})`);
    },
    async tokens() {
      const hit = await ctx.credentials.resolve(oauthTokenRef(serverId));
      if (hit === undefined) return undefined;
      let tokens;
      try {
        tokens = JSON.parse(hit.value);
      } catch {
        return undefined;
      }
      // An expired access token makes the SDK try refresh; if the refresh
      // token is also dead (short-lived servers), the SDK throws
      // InvalidTokenError and never re-authorizes. Pre-expire it here so the
      // SDK falls through to a fresh browser authorization flow instead.
      const exp = jwtExp(tokens.access_token);
      if (exp !== undefined && Date.now() / 1000 >= exp) {
        log.info(`${tag}: stored access token expired, clearing for re-authorization`);
        await ctx.credentials.unset(oauthTokenRef(serverId));
        return undefined;
      }
      return tokens;
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
      // Serialize per server: the loopback port is stable, so concurrent
      // flows (mount + test) would collide on the same port. Queue them.
      return withAuthLock(serverId, async () => {
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
            log.error(`${tag}: callback rejected: ${error}`);
            resolveResult({ error });
            return;
          }
          res.end("授权成功，可关闭此页面并返回 DSH。");
          log.info(`${tag}: authorization callback received (code)`);
          resolveResult({ code });
        });
        await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
        log.info(`${tag}: opening browser for authorization: ${authorizationUrl}`);
        openBrowser(authorizationUrl.toString());
        try {
          const result = await resultPromise;
          if (result.error) throw new Error(`OAuth 授权失败：${result.error}`);
          const authServerUrl = new URL(authorizationUrl.origin);
          log.info(`${tag}: discovering authorization server metadata at ${authServerUrl}`);
          const metadata = await discoverAuthorizationServerMetadata(authServerUrl);
          log.info(`${tag}: exchanging authorization code for tokens`);
          const tokens = await exchangeAuthorization(authServerUrl, {
            metadata,
            clientInformation: savedClientInfo,
            authorizationCode: result.code,
            codeVerifier: codeVerifierValue,
            redirectUri: redirectUrl,
          });
          await this.saveTokens(tokens);
          log.info(`${tag}: tokens saved`);
        } catch (error) {
          log.error(`${tag}: OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        } finally {
          server.close();
          log.info(`${tag}: callback server closed`);
        }
      });
    },
  };
}
