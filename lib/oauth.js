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
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/client";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { hostText } from "./host-locales.js";
import { systemFetch } from "./system-ca.js";

/**
 * Error code marking an "OAuth authorization required" failure. Throwers set
 * `error.code` to this value so control flow (re-throw decisions) keys on a
 * stable code, never on localized message text.
 */
export const OAUTH_REQUIRED_CODE = "MCP_OAUTH_REQUIRED";

/** Set the OAuth-required marker on an Error and return it. */
function oauthRequired(error) {
  error.code = OAUTH_REQUIRED_CODE;
  return error;
}

/** Build a localized "authorization required" Error carrying the stable code. */
export function oauthRequiredError(message) {
  return oauthRequired(new Error(message));
}

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

/**
 * The credential references one server's OAuth flow writes (token + client).
 * Recognising servers that demonstrably completed a flow is how stored rows
 * migrate to the explicit OAuth switch: the switch replaced a header
 * heuristic, and a server with stored OAuth credentials really does need
 * authorization.
 * @param serverId - the server name the flow is keyed by.
 * @returns both credential reference names.
 */
export function oauthCredentialRefs(serverId) {
  return [oauthTokenRef(serverId), oauthClientRef(serverId)];
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
 * Open the authorization page in the user's browser. The host does this for a
 * user-clicked "authorize" button: a client-side `window.open` is denied (or
 * flashes and closes) inside the DSH shell, while the host's own opener starts
 * the system browser reliably — the same path `allowBrowserOnMount` uses.
 * @param url - the authorization URL.
 */
export function openAuthorizationUrl(url) {
  openBrowser(url);
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
 * Serialize ALL authorization flows globally: each server's loopback port is
 * stable, so concurrent flows (multiple mounts, mount + test, several OAuth
 * servers at startup) would otherwise each open a browser tab at once. A
 * single global queue means at most one browser authorization is running at
 * any time; a flow that gets the lock after another one stored fresh tokens
 * skips the browser entirely (see redirectToAuthorization).
 */
let authQueue = Promise.resolve();

function withAuthLock(fn) {
  const run = authQueue.then(fn, fn);
  authQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Build one OAuthClientProvider for a managed server.
 * @param serverId - Managed server id; keys the stored token.
 * @param ctx - Host context carrying the credentials service.
 * @returns an MCP SDK `OAuthClientProvider` implementation.
 */
export function createOAuthProvider(serverId, ctx, options = {}) {
  let codeVerifierValue = null;
  let savedClientInfo = null;
  const allowBrowser = options.allowBrowser !== false;
  const serverUrl = options.serverUrl;
  // Called whenever the flow hands over to the user (URL known, tokens still
  // missing). Mounts use it to mark their entry "waiting for authorization":
  // the mcp-client wrapper replaces the thrown error, so the stable code does
  // not survive to the caller.
  const onAuthorizationRequired = typeof options.onAuthorizationRequired === "function"
    ? options.onAuthorizationRequired
    : undefined;
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
      if (!allowBrowser && serverUrl !== void 0) {
        // Non-interactive attempt (a mount with browser prompts disabled, or a
        // test connection): never open a browser and never queue behind another
        // server's interactive flow — just make sure this server's pending
        // listener exists and hand its URL to the caller, who owns the button
        // and the status polling.
        const url = await createToolAuthorizationUrl(serverId, ctx, serverUrl);
        log.info(`${tag}: authorization required, not opening browser`);
        onAuthorizationRequired?.(url);
        throw oauthRequired(new Error(hostText(ctx, "oauthNeedLink", { serverId, url })));
      }
      // Global serialization: at most one browser authorization runs at a
      // time (stable per-server ports would otherwise collide, and several
      // OAuth servers at startup would open many tabs at once).
      return withAuthLock(async () => {
        // Another queued flow may have just completed authorization and
        // stored fresh tokens while we waited. If so, skip the browser — the
        // SDK will throw on this attempt and the next connect uses the token.
        const existing = await ctx.credentials.resolve(oauthTokenRef(serverId));
        if (existing !== void 0) {
          try {
            const stored = JSON.parse(existing.value);
            const exp = jwtExp(stored.access_token);
            if (exp === void 0 || Date.now() / 1000 < exp) {
              log.info(`${tag}: tokens already refreshed by another flow, skipping browser`);
              return;
            }
          } catch {
            // malformed stored token — fall through and authorize
          }
        }
        if (serverUrl !== void 0) {
          // One shared pending-callback listener per server:
          // createToolAuthorizationUrl deduplicates by serverId, so a mount
          // failure and a test connection reuse the same loopback listener
          // instead of both binding the stable port (an unhandled EADDRINUSE
          // on listen would crash the Host).
          const url = await createToolAuthorizationUrl(serverId, ctx, serverUrl);
          onAuthorizationRequired?.(url);
          if (!allowBrowser) {
            // Mount-time connections must not pop the browser on their own;
            // fail with the clickable authorization link. The shared
            // listener keeps running so opening the URL completes the flow.
            log.info(`${tag}: mount requires authorization, not opening browser`);
            throw oauthRequired(new Error(hostText(ctx, "oauthNeedLink", { serverId, url })));
          }
          log.info(`${tag}: opening browser for authorization: ${url}`);
          openBrowser(url);
          const pending = pendingCallbacks.get(serverId);
          if (pending !== void 0) await pending.done;
          return;
        }
        // Fallback (no server URL known): legacy loopback listener with an
        // error handler so a bind failure can never crash the Host.
        let resolveResult;
        const resultPromise = new Promise((resolve) => {
          resolveResult = resolve;
        });
        const server = createServer((req, res) => {
          const url = new URL(req.url, redirectUrl);
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");
          res.setHeader("content-type", "text/html; charset=utf-8");
          // No keep-alive: the stable port may be reused by the next flow (see
          // closeCallbackServer).
          res.setHeader("connection", "close");
          if (error) {
            res.end(hostText(ctx, "oauthFailPage", { error }));
            recordAuthResult(serverId, error);
            log.error(`${tag}: callback rejected: ${error}`);
            resolveResult({ error });
            return;
          }
          res.end(hostText(ctx, "oauthOkPage"));
          log.info(`${tag}: authorization callback received (code)`);
          resolveResult({ code });
        });
        server.on("error", (error) => {
          log.error(`${tag}: callback server error: ${error instanceof Error ? error.message : String(error)}`);
          resolveResult({ error: error instanceof Error ? error.message : String(error) });
        });
        await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
        log.info(`${tag}: opening browser for authorization: ${authorizationUrl}`);
        openBrowser(authorizationUrl.toString());
        try {
          const result = await resultPromise;
          if (result.error) throw oauthRequired(new Error(hostText(ctx, "oauthExchangeFail", { error: result.error })));
          const authServerUrl = new URL(authorizationUrl.origin);
          log.info(`${tag}: discovering authorization server metadata at ${authServerUrl}`);
          const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: systemFetch() });
          log.info(`${tag}: exchanging authorization code for tokens`);
          // Use the provider accessors, not the closure fields: when the
          // client was loaded from persistence the SDK never calls
          // saveClientInformation, so the closure copy is null and the token
          // request would lack client_id (CAS: "... are required").
          const clientInformation = await this.clientInformation();
          const codeVerifier = await this.codeVerifier();
          const tokens = await exchangeAuthorization(authServerUrl, {
            metadata,
            clientInformation,
            authorizationCode: result.code,
            codeVerifier,
            redirectUri: redirectUrl,
            fetchFn: systemFetch(),
          });
          await this.saveTokens(tokens);
          recordAuthResult(serverId);
          log.info(`${tag}: tokens saved`);
        } catch (error) {
          recordAuthResult(serverId, error instanceof Error ? error.message : String(error));
          log.error(`${tag}: OAuth exchange failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        } finally {
          closeCallbackServer(server);
          log.info(`${tag}: callback server closed`);
        }
      });
    },
  };
}

/**
 * Stop one loopback callback listener for good: stop accepting, then drop any
 * connection still open (a graceful `close()` alone waits for keep-alive
 * sockets and can leave the stable port bound across a retry).
 * @param server - the loopback http server.
 */
function closeCallbackServer(server) {
  try {
    server.close();
  } catch {
    /* already closed */
  }
  server.closeAllConnections?.();
}

/** Pending background authorization callbacks per server (one at a time). */
const pendingCallbacks = /* @__PURE__ */ new Map();

/**
 * In-flight authorization-URL creations per server. Two callers (a mount and a
 * test connection, or the settings-page button) can ask for the same server's
 * URL at once; without this they would both run discovery/registration and
 * both bind the stable loopback port.
 */
const pendingCreations = /* @__PURE__ */ new Map();

/**
 * Outcome of the most recent authorization flow per server: the `error` the
 * authorization server reported on the callback (e.g. `access_denied`), or the
 * token exchange failure. The settings page polls this so "did authorization
 * fail, and why" is visible instead of silence.
 */
const lastAuthResults = /* @__PURE__ */ new Map();

/** Record one flow's outcome (no error = the flow completed). */
function recordAuthResult(serverId, error) {
  lastAuthResults.set(serverId, {
    ...error === undefined ? {} : { error: String(error) },
    at: Date.now()
  });
}

/**
 * The error of the most recent authorization flow, when it failed.
 * @param serverId - managed server id / server name the flow is keyed by.
 */
export function lastAuthorizationError(serverId) {
  return lastAuthResults.get(serverId)?.error;
}

/**
 * Forget the previous flow outcome so a fresh attempt does not report a stale
 * failure while it is still running.
 * @param serverId - managed server id / server name the flow is keyed by.
 */
export function clearAuthorizationResult(serverId) {
  lastAuthResults.delete(serverId);
}

/**
 * Build an authorization URL for a tool call that needs authorization and
 * start a background loopback listener that completes the flow when the user
 * opens the URL. The browser is NOT opened automatically — the caller returns
 * the URL to the model/user to click. Concurrent requests for the same server
 * reuse the pending flow.
 * @param serverId - Managed server id (stable loopback port + token key).
 * @param ctx - Host context carrying credentials.
 * @param serverUrl - The MCP server URL (used for OAuth discovery).
 * @returns the authorization URL to present to the user.
 */
export async function createToolAuthorizationUrl(serverId, ctx, serverUrl) {
  const existing = pendingCallbacks.get(serverId);
  if (existing !== void 0) return existing.url;
  const inFlight = pendingCreations.get(serverId);
  if (inFlight !== void 0) return inFlight;
  const creation = createToolAuthorizationUrlOnce(serverId, ctx, serverUrl);
  pendingCreations.set(serverId, creation);
  try {
    return await creation;
  } finally {
    pendingCreations.delete(serverId);
  }
}

/** One server's flow, created at most once at a time (see createToolAuthorizationUrl). */
async function createToolAuthorizationUrlOnce(serverId, ctx, serverUrl) {
  const port = stablePort(serverId);
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const log = ctx?.logger ?? console;
  const tag = `mcp-oauth(${serverId})`;

  const info = await discoverOAuthServerInfo(serverUrl, { fetchFn: systemFetch() });
  let clientInfo = await ctx.credentials.resolve(oauthClientRef(serverId));
  if (clientInfo !== void 0) {
    try {
      clientInfo = JSON.parse(clientInfo.value);
    } catch {
      clientInfo = void 0;
    }
    if (clientInfo !== void 0 && (!Array.isArray(clientInfo.redirect_uris) || !clientInfo.redirect_uris.includes(redirectUrl))) {
      clientInfo = void 0; // stale redirect_uris → re-register
    }
  }
  if (clientInfo === void 0) {
    clientInfo = await registerClient(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientMetadata: {
        client_name: "dsh-mcp",
        redirect_uris: [redirectUrl],
      },
      fetchFn: systemFetch(),
    });
    await ctx.credentials.set(oauthClientRef(serverId), JSON.stringify(clientInfo));
  }
  // The SDK expects a URL object (it reads `resource.href`); passing a bare
  // string would serialize the resource parameter as "undefined". Prefer the
  // protected-resource metadata's resource when available.
  const resourceUrl = info.resourceMetadata?.resource !== void 0
    ? new URL(info.resourceMetadata.resource)
    : new URL(serverUrl);
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
    metadata: info.authorizationServerMetadata,
    clientInformation: clientInfo,
    redirectUrl,
    resource: resourceUrl,
  });
  const url = String(authorizationUrl);

  // Background listener: wait for the user to open the URL and authorize.
  const pending = {
    url,
    done: new Promise((resolve) => {
      const server = createServer(async (req, res) => {
        const callbackUrl = new URL(req.url, redirectUrl);
        const code = callbackUrl.searchParams.get("code");
        const error = callbackUrl.searchParams.get("error");
        res.setHeader("content-type", "text/html; charset=utf-8");
        // Never keep the callback connection alive: the stable loopback port is
        // reused by the next flow, and a pooled keep-alive socket would deliver
        // its callback to THIS (already closing) listener instead of the new
        // one — the retry would then poll forever.
        res.setHeader("connection", "close");
        if (error) {
          res.end(hostText(ctx, "oauthFailPage", { error }));
          recordAuthResult(serverId, error);
          log.error(`${tag}: callback rejected: ${error}`);
          resolve();
          closeCallbackServer(server);
          return;
        }
        res.end(hostText(ctx, "oauthOkPage"));
        log.info(`${tag}: tool-auth callback received (code)`);
        try {
          const authServerUrl = new URL(authorizationUrl.origin);
          const metadata = await discoverAuthorizationServerMetadata(authServerUrl, { fetchFn: systemFetch() });
          const tokens = await exchangeAuthorization(authServerUrl, {
            metadata,
            clientInformation: clientInfo,
            authorizationCode: code,
            codeVerifier,
            redirectUri: redirectUrl,
            fetchFn: systemFetch(),
          });
          await ctx.credentials.set(oauthTokenRef(serverId), JSON.stringify(tokens));
          recordAuthResult(serverId);
          log.info(`${tag}: tool-auth tokens saved`);
        } catch (exchangeError) {
          recordAuthResult(serverId, exchangeError instanceof Error ? exchangeError.message : String(exchangeError));
          log.error(`${tag}: tool-auth exchange failed: ${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`);
        }
        resolve();
        closeCallbackServer(server);
      });
      // Never let a bind failure crash the Host: resolve the pending flow so
      // callers surface a readable error instead of an unhandled event.
      server.on("error", (listenError) => {
        log.error(`${tag}: tool-auth listener error: ${listenError instanceof Error ? listenError.message : String(listenError)}`);
        resolve();
      });
      server.listen(port, "127.0.0.1", () => {
        log.info(`${tag}: tool-auth listener ready on :${port}`);
      });
      // Give up after 5 minutes so the listener never leaks.
      const timer = setTimeout(() => {
        log.info(`${tag}: tool-auth listener expired`);
        closeCallbackServer(server);
        resolve();
      }, 5 * 60e3);
      timer.unref?.();
    }),
  };
  pendingCallbacks.set(serverId, pending);
  void pending.done.finally(() => {
    if (pendingCallbacks.get(serverId) === pending) pendingCallbacks.delete(serverId);
  });
  return url;
}

/**
 * Whether a failure means "the user still has to authorize" rather than a real
 * connection failure. Two shapes reach the caller: our own marker error
 * (`MCP_OAUTH_REQUIRED`, thrown when the flow is handed over without opening a
 * browser), and the SDK's `UnauthorizedError` raised right after
 * `redirectToAuthorization` returned (the browser flow is running and this
 * attempt is expected to fail).
 * @param error - the thrown value.
 * @returns true when the failure is a pending authorization, not a defect.
 */
export function isOAuthRequired(error) {
  if (error === null || typeof error !== "object") return false;
  if (error.code === OAUTH_REQUIRED_CODE) return true;
  return error.mcpBrand === "mcp.UnauthorizedError" || error.name === "UnauthorizedError";
}

/**
 * The stored-token state of one server, without touching the network. An
 * expired access token counts as not authorized (the provider clears it so the
 * SDK starts a fresh browser flow), which is what a polling settings page must
 * see before showing "authorization complete".
 * @param serverId - managed server id / server name the tokens are keyed by.
 * @param ctx - host context carrying the credentials service.
 * @returns `authorized`, plus the JWT expiry (ms) when one is known.
 */
export async function oauthTokenStatus(serverId, ctx) {
  let hit;
  try {
    hit = await ctx.credentials.resolve(oauthTokenRef(serverId));
  } catch {
    return { authorized: false };
  }
  if (hit === undefined || hit === null) return { authorized: false };
  let tokens;
  try {
    tokens = JSON.parse(hit.value);
  } catch {
    return { authorized: false };
  }
  const exp = jwtExp(tokens?.access_token);
  if (exp !== undefined && Date.now() / 1000 >= exp) return { authorized: false, expiresAt: exp * 1000 };
  return { authorized: true, ...(exp === undefined ? {} : { expiresAt: exp * 1000 }) };
}

/**
 * Whether a background authorization callback is currently listening for one
 * server (a mount attempt or a test connection started the flow).
 * @param serverId - managed server id / server name the flow is keyed by.
 */
export function hasPendingAuthorization(serverId) {
  return pendingCallbacks.has(serverId);
}

/**
 * The authorization URL of a running pending flow, when there is one.
 * @param serverId - managed server id / server name the flow is keyed by.
 */
export function pendingAuthorizationUrl(serverId) {
  return pendingCallbacks.get(serverId)?.url;
}
