/**
 * The OAuth iteration: a settings-page button that opens the authorization
 * page, and status polling that never reports a pre-authorization failure.
 *
 * A fake authorization server (RFC 9728 protected-resource metadata + RFC 8414
 * authorization-server metadata + registration + token endpoints) stands in
 * for a real OAuth-protected MCP server, and its `/mcp` endpoint always answers
 * 401 with a Bearer challenge, so both the probe and the mount really walk the
 * SDK's authorization path instead of a stub.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { McpManagerService } from "../lib/index.js";

/** Resolve after one macrotask-ish delay. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read one JSON request body (registration/token POSTs). */
async function readJson(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

/**
 * A fake OAuth-protected MCP server: metadata discovery, dynamic client
 * registration, token exchange, and a `/mcp` endpoint that always challenges.
 * @param options.issParameterSupported - advertise RFC 9207 `iss` support in
 *   the authorization-server metadata (some servers, Notion among them,
 *   advertise it and then never send `iss`; see issue #18).
 */
async function startFakeOAuthServer({ issParameterSupported = false } = {}) {
	const calls = [];
	const server = createServer((request, response) => {
		const base = `http://127.0.0.1:${server.address().port}`;
		const url = new URL(request.url ?? "/", base);
		calls.push(`${request.method} ${url.pathname}`);
		const json = (status, body, headers = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(body));
		};
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			json(200, {
				resource: `${base}/mcp`,
				authorization_servers: [base],
				bearer_methods_supported: ["header"],
			});
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
				...(issParameterSupported ? { authorization_response_iss_parameter_supported: true } : {}),
			});
			return;
		}
		if (url.pathname === "/register") {
			void readJson(request).then((body) => {
				json(201, {
					client_id: "test-client",
					redirect_uris: body.redirect_uris ?? [],
					token_endpoint_auth_method: "none",
				});
			});
			return;
		}
		if (url.pathname === "/token") {
			void readJson(request).then(() => {
				json(200, { access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 });
			});
			return;
		}
		if (url.pathname === "/mcp") {
			json(401, { error: "unauthorized" }, {
				"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
			});
			return;
		}
		json(404, { error: "not_found" });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		calls,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/**
 * Boot the manager over a temporary home and an in-memory credentials stub, so
 * the OAuth credential writes are observable.
 */
async function bootManager() {
	const home = mkdtempSync(join(tmpdir(), "dsh-mcp-oauth-"));
	const profileDir = join(home, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const servers = new Map();
	const secrets = new Map();
	const table = {
		get: (key) => servers.get(key),
		entries: () => servers.entries(),
		keys: () => servers.keys(),
		put: async (key, value) => { servers.set(key, value); },
		delete: async (key) => servers.delete(key),
	};
	const envTable = { ...table, entries: () => new Map().entries(), keys: () => new Map().keys(), get: () => undefined };
	const root = new Context();
	root.provide("storageDomain", { open: async () => ({ table: (name) => name === "global_env" ? envTable : table, close: async () => {} }) });
	root.provide("credentials", {
		describe: async (ref) => ({ configured: secrets.has(ref) }),
		resolve: async (ref) => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
		set: async (ref, value) => { secrets.set(ref, value); },
		unset: async (ref) => { secrets.delete(ref); },
	});
	root.provide("tools", { register: () => () => {}, schemas: () => [] });
	root.provide("dshHomePath", () => home);
	root.baseUrl = pathToFileURL(join(profileDir, "cordis.yml")).href;
	await root.plugin(McpManagerService, { probeTimeoutMs: 2e3, allowBrowserOnMount: false });
	const service = root.get("mcpManager");
	// The Host opens the authorization page itself; the suite records the URLs
	// instead of spawning a real browser.
	const opened = [];
	service.openAuthorizationPage = (url) => { opened.push(url); };
	await service.list();
	return {
		service,
		secrets,
		opened,
		cleanup: async () => {
			await service.teardownAll();
			await root.fiber.dispose();
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** One streamable-http server definition for the fake server. */
function oauthRow(serverName, base, overrides = {}) {
	return {
		serverName,
		transport: "streamable-http",
		enabled: false,
		command: "",
		args: [],
		cwd: "",
		url: `${base}/mcp`,
		headers: [],
		toolCallTimeoutMs: 60000,
		failOnStartupError: true,
		oauth: true,
		...overrides,
	};
}

/**
 * Complete a running flow the way a browser would: hit the loopback callback
 * with a code (and, when given, the RFC 9207 `iss` the server decided to send).
 */
async function completeAuthorization(authorizationUrl, code, { iss } = {}) {
	const redirect = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri"));
	const query = new URLSearchParams({ code });
	if (iss !== undefined) query.set("iss", iss);
	const response = await fetch(`${redirect.origin}${redirect.pathname}?${query}`);
	assert.equal(response.status, 200, "the loopback callback answers the authorization page");
}

/** Poll oauthStatus until authorized, like the settings page does every 5s. */
async function waitForAuthorized(service, serverName, attempts = 100) {
	let status = await service.oauthStatus({ serverName });
	for (let i = 0; i < attempts && !status.authorized; i += 1) {
		await delay(25);
		status = await service.oauthStatus({ serverName });
	}
	return status;
}

test("oauthStart validates its payload and never needs a saved row", async () => {
	const context = await bootManager();
	try {
		const badName = await context.service.oauthStart({ serverName: "bad name!", url: "http://127.0.0.1:9/mcp" });
		assert.equal(badName.ok, false);
		assert.equal(badName.error.code, "MCP_OAUTH_INVALID");

		const missingUrl = await context.service.oauthStart({ serverName: "oauthsrv" });
		assert.equal(missingUrl.ok, false);
		assert.equal(missingUrl.error.code, "MCP_OAUTH_INVALID");

		const badUrl = await context.service.oauthStart({ serverName: "oauthsrv", url: "ftp://example.test/mcp" });
		assert.equal(badUrl.ok, false);
		assert.equal(badUrl.error.code, "MCP_OAUTH_INVALID");

		const badStatus = await context.service.oauthStatus({});
		assert.equal(badStatus.ok, false);
		assert.equal(badStatus.error.code, "MCP_OAUTH_INVALID");
	} finally {
		await context.cleanup();
	}
});

test("oauthStart returns the authorization URL and oauthStatus polls pending → authorized", async () => {
	const oauth = await startFakeOAuthServer();
	const context = await bootManager();
	try {
		const started = await context.service.oauthStart({ serverName: "oauthsrv", url: `${oauth.base}/mcp` });
		assert.equal(started.ok, true, started.ok ? "" : started.error.message);
		assert.equal(started.serverName, "oauthsrv");
		const authorizationUrl = new URL(started.url);
		assert.equal(authorizationUrl.origin, oauth.base, "the URL points at the discovered authorization server");
		assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
		assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
		assert.ok(authorizationUrl.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:"), "loopback redirect");

		// The button may be clicked twice: the same pending flow is reused.
		const again = await context.service.oauthStart({ serverName: "oauthsrv", url: `${oauth.base}/mcp` });
		assert.equal(again.url, started.url);
		assert.deepEqual(context.opened, [started.url, started.url], "the Host opened the authorization page itself");

		const pending = await context.service.oauthStatus({ serverName: "oauthsrv" });
		assert.deepEqual(
			{ authorized: pending.authorized, pending: pending.pending, url: pending.url },
			{ authorized: false, pending: true, url: started.url },
			"before the user authorizes: pending, not failed",
		);

		await completeAuthorization(started.url, "test-code");
		const authorized = await waitForAuthorized(context.service, "oauthsrv");
		assert.equal(authorized.authorized, true, "the callback exchanged the code and stored tokens");
		assert.equal(authorized.pending, false, "the loopback listener is gone");
		assert.ok([...context.secrets.keys()].some((ref) => ref.includes("DSH_MCP_OAUTH_")), "tokens are stored in the credentials document");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

test("a rejected authorization reports its reason instead of going quiet", async () => {
	const oauth = await startFakeOAuthServer();
	const context = await bootManager();
	try {
		const started = await context.service.oauthStart({ serverName: "deniedsrv", url: `${oauth.base}/mcp` });
		assert.equal(started.ok, true, started.ok ? "" : started.error.message);
		assert.deepEqual(context.opened, [started.url]);
		const redirect = new URL(new URL(started.url).searchParams.get("redirect_uri"));
		// The user pressed "deny" (or the authorization server rejected the request).
		const page = await fetch(`${redirect.origin}${redirect.pathname}?error=access_denied&error_description=nope`);
		assert.equal(page.status, 200);

		let status = await context.service.oauthStatus({ serverName: "deniedsrv" });
		for (let i = 0; i < 40 && status.pending; i += 1) {
			await delay(25);
			status = await context.service.oauthStatus({ serverName: "deniedsrv" });
		}
		assert.deepEqual(
			{ authorized: status.authorized, pending: status.pending, error: status.error },
			{ authorized: false, pending: false, error: "access_denied" },
			"the failure reason reaches the settings page",
		);

		// A fresh attempt starts clean: no stale failure while the new flow runs.
		const retried = await context.service.oauthStart({ serverName: "deniedsrv", url: `${oauth.base}/mcp` });
		assert.equal(retried.ok, true, retried.ok ? "" : retried.error.message);
		const running = await context.service.oauthStatus({ serverName: "deniedsrv" });
		assert.equal(running.error, undefined, "the previous failure is cleared on retry");
		assert.equal(running.pending, true);
		// Complete the retry so its listener does not outlive the test.
		await completeAuthorization(running.url, "retry-code");
		await waitForAuthorized(context.service, "deniedsrv");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

test("test connection on an OAuth server reports pending authorization, never a failure", async () => {	const oauth = await startFakeOAuthServer();
	const context = await bootManager();
	try {
		const result = await context.service.test({ server: oauthRow("probesrv", oauth.base), env: [] });
		assert.equal(result.ok, true, "the probe call itself succeeds");
		assert.equal(result.probe.ok, false);
		assert.equal(result.probe.oauthRequired, true, "the page shows the authorization button instead of a failure");

		// The flow the probe started is pollable and completable, exactly like a
		// button click: the host already keeps the loopback listener open.
		const pending = await context.service.oauthStatus({ serverName: "probesrv" });
		assert.equal(pending.pending, true);
		assert.ok(pending.url !== undefined && pending.url.length > 0, "the pending flow exposes its URL");
		await completeAuthorization(pending.url, "probe-code");
		const authorized = await waitForAuthorized(context.service, "probesrv");
		assert.equal(authorized.authorized, true);
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

test("a mount waiting for authorization reads as oauthRequired, not as a failure", async () => {
	const oauth = await startFakeOAuthServer();
	const context = await bootManager();
	try {
		const created = await context.service.upsert({ server: oauthRow("mountsrv", oauth.base, { enabled: true }), env: [] });
		assert.equal(created.ok, true, created.ok ? "" : created.error.message);

		let view;
		for (let i = 0; i < 100; i += 1) {
			view = (await context.service.list()).servers.find((server) => server.serverName === "mountsrv");
			if (view?.status.oauthRequired === true) break;
			await delay(25);
		}
		assert.equal(view?.status.oauthRequired, true, "the mount reports the pending authorization");
		assert.equal(view.oauth, true);
		assert.equal(view.oauthAuthorized, false, "no tokens are stored yet");

		// Authorizing completes the pending flow and the view flips to authorized.
		const pending = await context.service.oauthStatus({ serverName: "mountsrv" });
		assert.equal(pending.pending, true);
		await completeAuthorization(pending.url, "mount-code");
		await waitForAuthorized(context.service, "mountsrv");
		for (let i = 0; i < 100; i += 1) {
			view = (await context.service.list()).servers.find((server) => server.serverName === "mountsrv");
			if (view?.oauthAuthorized === true) break;
			await delay(25);
		}
		assert.equal(view?.oauthAuthorized, true, "stored tokens mark the server authorized");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

/**
 * Credential refs holding OAuth *tokens*. The client registration lives under a
 * different ref (`…_OAUTH_CLIENT_…`), so a flow that registers successfully but
 * never redeems its code still has no token here.
 */
function tokenRefs(secrets) {
	return [...secrets.keys()]
		.map((ref) => String(ref))
		.filter((ref) => ref.startsWith("DSH_MCP_OAUTH_") && !ref.startsWith("DSH_MCP_OAUTH_CLIENT_"));
}

/*
 * RFC 9207 `iss` in the authorization response (issue #18).
 *
 * The MCP SDK rejects a callback without `iss` when the authorization-server
 * metadata advertises `authorization_response_iss_parameter_supported: true`,
 * reading that combination as an authorization-server mix-up attack. Servers
 * exist that advertise the parameter and then never send it (Notion's
 * `https://mcp.notion.com`), which turned every completed authorization into
 * "Issuer mismatch in authorization response (RFC 9207) … received undefined".
 * A response that *does* carry `iss` must still be compared strictly, so the
 * mix-up protection is only relaxed for the case that cannot use it.
 */

test("a server that advertises RFC 9207 iss support but sends none still authorizes (#18)", async () => {
	const oauth = await startFakeOAuthServer({ issParameterSupported: true });
	const context = await bootManager();
	try {
		const started = await context.service.oauthStart({ serverName: "notionsrv", url: `${oauth.base}/mcp` });
		assert.equal(started.ok, true, started.ok ? "" : started.error.message);

		// Notion's real callback: an authorization code and no `iss`.
		await completeAuthorization(started.url, "notion-code");

		const authorized = await waitForAuthorized(context.service, "notionsrv");
		assert.equal(authorized.authorized, true, "the inaccurate advertisement must not fail a completed authorization");
		assert.equal(authorized.error, undefined, "no failure is reported to the settings page");
		assert.equal(tokenRefs(context.secrets).length, 1, "the exchanged tokens are stored");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

test("a callback carrying the discovered issuer still authorizes", async () => {
	const oauth = await startFakeOAuthServer({ issParameterSupported: true });
	const context = await bootManager();
	try {
		const started = await context.service.oauthStart({ serverName: "isssrv", url: `${oauth.base}/mcp` });
		assert.equal(started.ok, true, started.ok ? "" : started.error.message);
		await completeAuthorization(started.url, "iss-code", { iss: oauth.base });
		const authorized = await waitForAuthorized(context.service, "isssrv");
		assert.equal(authorized.authorized, true, "a matching iss passes the SDK's strict comparison");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});

test("a callback whose iss names another issuer is still rejected (RFC 9207 mix-up)", async () => {
	const oauth = await startFakeOAuthServer({ issParameterSupported: true });
	const context = await bootManager();
	try {
		const started = await context.service.oauthStart({ serverName: "mixupsrv", url: `${oauth.base}/mcp` });
		assert.equal(started.ok, true, started.ok ? "" : started.error.message);

		// Mix-up shape: a code minted here, an issuer naming a different server.
		await completeAuthorization(started.url, "attacker-code", { iss: "https://evil.example" });

		let status = await context.service.oauthStatus({ serverName: "mixupsrv" });
		for (let i = 0; i < 100 && status.pending; i += 1) {
			await delay(25);
			status = await context.service.oauthStatus({ serverName: "mixupsrv" });
		}
		assert.equal(status.authorized, false, "a mismatching issuer is not authorized");
		assert.match(status.error ?? "", /Issuer mismatch/, "the reported reason names the RFC 9207 failure");
		assert.equal(tokenRefs(context.secrets).length, 0, "the rejected code is never redeemed into tokens");
	} finally {
		await context.cleanup();
		await oauth.close();
	}
});
