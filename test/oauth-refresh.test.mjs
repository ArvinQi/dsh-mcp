/**
 * Silent token refresh: an expired access token plus a stored refresh token
 * must refresh through the SDK instead of asking the user to authorize again.
 *
 * Access tokens on real MCP OAuth servers live ~1h. Before this suite the
 * provider deleted the credentials as soon as the access token's `exp` passed,
 * so the SDK never reached `refreshAuthorization`: every mount and every tool
 * call after expiry started a fresh browser authorization (the reported
 * "每次都要重新授权，过段时间就失效" symptom). These tests pin the provider
 * contract that makes the silent path work — the SDK's `auth()` is the exact
 * entry the HTTP transport uses on a 401, and it retries the request once after
 * a successful refresh.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { auth } from "@modelcontextprotocol/client";
import { createOAuthProvider, oauthCredentialRefs, oauthTokenStatus } from "../lib/oauth.js";

/** Base64url JSON, as JWT segments are encoded. */
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An unsigned JWT whose payload carries `exp`, i.e. the shape `jwtExp` reads.
 * The signature is never verified by the client; only the payload matters.
 */
const jwt = (expSeconds) => `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds })}.sig`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A per-test server id keeps the stable loopback ports of concurrent tests apart. */
const serverIdFor = (name) => `${name}${process.pid}`;

/**
 * A fake OAuth authorization server with dynamic registration, an
 * authorization-code grant and a refresh grant. Records every `/token` call so
 * a test can prove whether a refresh actually happened.
 * @returns the server base URL, the recorded token grants and a close helper.
 */
async function startFakeAuthorizationServer() {
	const tokenGrants = [];
	const server = createServer(async (request, response) => {
		const base = `http://127.0.0.1:${server.address().port}`;
		const url = new URL(request.url ?? "/", base);
		const json = (status, body) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString("utf8");
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			json(200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
			return;
		}
		if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) {
			json(200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
			});
			return;
		}
		if (url.pathname === "/register") {
			const parsed = body.length === 0 ? {} : JSON.parse(body);
			json(201, { client_id: "test-client", redirect_uris: parsed.redirect_uris ?? [], token_endpoint_auth_method: "none" });
			return;
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(body);
			const grant = form.get("grant_type");
			tokenGrants.push({ grant_type: grant, refresh_token: form.get("refresh_token"), client_id: form.get("client_id") });
			// Both grants mint a fresh 1h token; the refresh grant keeps the same
			// refresh token (servers may rotate it, the client must accept both).
			json(200, {
				access_token: jwt(nowSeconds() + 3600),
				refresh_token: grant === "refresh_token" ? form.get("refresh_token") : "test-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
			});
			return;
		}
		json(404, { error: "not_found" });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		tokenGrants,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/**
 * A host context over an in-memory credentials store, plus the log lines the
 * provider emits (a test asserts the refreshable path stays quiet).
 */
function fakeHost() {
	const secrets = new Map();
	const logs = [];
	return {
		secrets,
		logs,
		ctx: {
			credentials: {
				resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref) } : undefined),
				set: async (ref, value) => { secrets.set(ref, value); },
				unset: async (ref) => { secrets.delete(ref); },
			},
			logger: {
				info: (line) => logs.push({ level: "info", line }),
				warn: (line) => logs.push({ level: "warn", line }),
				error: (line) => logs.push({ level: "error", line }),
			},
		},
	};
}

/**
 * Seed one server's credentials the way a completed authorization leaves them:
 * a registered client bound to the provider's stable redirect URI, plus one
 * token set. The caller chooses the access token so a test can simulate expiry.
 * @returns the provider under test and both credential refs.
 */
function seedCredentials(serverId, host, { serverUrl, accessToken, refreshToken }) {
	const provider = createOAuthProvider(serverId, host.ctx, { serverUrl, allowBrowser: false });
	// A test must fail fast if the SDK decides to hand over to the browser: the
	// real provider would bind a 5-minute loopback listener here, which keeps
	// the test process alive instead of reporting the regression.
	provider.redirectedToAuthorization = false;
	provider.redirectToAuthorization = async () => {
		provider.redirectedToAuthorization = true;
		throw new Error("test: the SDK asked for interactive authorization");
	};
	const [tokenRef, clientRef] = oauthCredentialRefs(serverId);
	host.secrets.set(clientRef, JSON.stringify({
		client_id: "test-client",
		redirect_uris: [provider.redirectUrl],
		token_endpoint_auth_method: "none",
	}));
	host.secrets.set(tokenRef, JSON.stringify({
		access_token: accessToken,
		...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
		token_type: "Bearer",
		expires_in: 3600,
	}));
	return { provider, tokenRef, clientRef };
}

test("an expired access token refreshes silently with the stored refresh token", async () => {
	const oauth = await startFakeAuthorizationServer();
	const host = fakeHost();
	const serverId = serverIdFor("refresh");
	try {
		const { provider } = seedCredentials(serverId, host, {
			serverUrl: `${oauth.base}/mcp`,
			accessToken: jwt(nowSeconds() - 300),
			refreshToken: "test-refresh-token",
		});

		// Exactly what the HTTP transport does on a 401.
		const outcome = await auth(provider, { serverUrl: `${oauth.base}/mcp` });
		assert.equal(provider.redirectedToAuthorization, false, "the SDK never handed over to the browser");
		assert.equal(outcome, "AUTHORIZED", "the SDK refreshed instead of handing over to the browser");
		assert.deepEqual(
			oauth.tokenGrants.map(({ grant_type }) => grant_type),
			["refresh_token"],
			"exactly one refresh grant, no new authorization-code exchange",
		);
		assert.equal(oauth.tokenGrants[0].refresh_token, "test-refresh-token", "the stored refresh token was used");
		assert.equal(oauth.tokenGrants[0].client_id, "test-client", "the persisted client authenticates the refresh");

		// The refreshed token set is persisted: the status now reports a future
		// expiry, and the refreshable credential was never dropped.
		const status = await oauthTokenStatus(serverId, host.ctx);
		assert.equal(status.authorized, true);
		assert.ok(
			status.expiresAt !== undefined && status.expiresAt > Date.now(),
			"the stored access token now expires in the future",
		);
		assert.ok(
			host.logs.every((entry) => !entry.line.includes("clearing for re-authorization")),
			"the refreshable credential is never cleared",
		);
	} finally {
		await oauth.close();
	}
});

test("a credential with no refresh token is cleared so a fresh authorization can start", async () => {
	const host = fakeHost();
	const serverId = serverIdFor("norefresh");
	const { provider, tokenRef } = seedCredentials(serverId, host, {
		serverUrl: "http://127.0.0.1:9/mcp",
		accessToken: jwt(nowSeconds() - 300),
		refreshToken: undefined,
	});
	assert.equal(await provider.tokens(), undefined, "an unrefreshable expired credential is reported as absent");
	assert.equal(host.secrets.has(tokenRef), false, "and is removed from the store");
	assert.ok(host.logs.some((entry) => entry.line.includes("no refresh token is stored")));
	assert.deepEqual(await oauthTokenStatus(serverId, host.ctx), { authorized: false });
});

test("oauthTokenStatus keeps a refreshable credential authorized after access-token expiry", async () => {
	const host = fakeHost();
	const serverId = serverIdFor("statusrefresh");
	const { provider } = seedCredentials(serverId, host, {
		serverUrl: "http://127.0.0.1:9/mcp",
		accessToken: jwt(nowSeconds() - 300),
		refreshToken: "test-refresh-token",
	});
	// The provider must still hand the tokens out — that is what enables the
	// silent refresh — even though the access token itself has expired.
	const tokens = await provider.tokens();
	assert.equal(tokens.refresh_token, "test-refresh-token");
	assert.deepEqual(await oauthTokenStatus(serverId, host.ctx), { authorized: true });
});
