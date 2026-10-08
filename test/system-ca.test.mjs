/**
 * Operating-system CA trust for HTTPS MCP endpoints.
 *
 * The state pinned here is the one users hit with internal servers: a cert
 * that chains to a root only the OS trusts fails through Node's bundled store,
 * and `ensureSystemCaTrust()` makes the process-wide fetch (undici) accept it —
 * without dropping Node's bundled roots.
 *
 * The test needs `tls.getCACertificates`/`setDefaultCACertificates` (Node >=
 * 24.9) and `openssl` to mint a throwaway self-signed cert for 127.0.0.1; it
 * skips where either is missing (CI) instead of failing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { ensureSystemCaTrust, resetSystemCaTrustState, systemCaCertificates, systemFetch } from "../lib/system-ca.js";

/** Node's default-store API (the merge target); absent before 24.9. */
const HAS_DEFAULT_STORE_API =
	typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function";

/** Mint a self-signed cert/key for 127.0.0.1 in a temp dir. */
function selfSignedCertificate() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-ca-"));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	try {
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "rsa:2048",
			"-keyout", key, "-out", cert,
			"-days", "2", "-nodes",
			"-subj", "/CN=127.0.0.1",
			"-addext", "subjectAltName=IP:127.0.0.1",
		], { stdio: "ignore" });
	} catch {
		rmSync(dir, { recursive: true, force: true });
		return null;
	}
	return { dir, key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

/** Serve one JSON response over HTTPS on a random loopback port. */
async function startHttpsServer(key, cert) {
	const server = createServer({ key, cert }, (_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ ok: true }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `https://127.0.0.1:${server.address().port}/probe`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test("merging the OS store makes fetch trust an OS-style root, keeping the bundled roots", async (t) => {
	if (!HAS_DEFAULT_STORE_API) {
		t.skip("tls.getCACertificates/setDefaultCACertificates need Node >= 24.9");
		return;
	}
	const material = selfSignedCertificate();
	if (material === null) {
		t.skip("openssl is unavailable");
		return;
	}
	const server = await startHttpsServer(material.key, material.cert);
	const originalDefaults = tls.getCACertificates("default");
	try {
		// The root is not in Node's bundled store: the request must fail first.
		await assert.rejects(fetch(server.url), /fetch failed/);
		const state = ensureSystemCaTrust({ systemCertificates: [material.cert], refresh: true });
		assert.equal(state.applied, true, "the cert is new, so the store is patched");
		assert.equal(state.added, 1);
		const response = await fetch(server.url);
		assert.equal(response.status, 200, "the patched default store trusts the OS root");
		assert.deepEqual(await response.json(), { ok: true });
		const merged = tls.getCACertificates("default");
		// Node re-serializes the store, so compare identities rather than PEM text.
		const mergedFingerprints = new Set(merged.map((pem) => new X509Certificate(pem).fingerprint256));
		for (const certificate of originalDefaults) {
			assert.ok(
				mergedFingerprints.has(new X509Certificate(certificate).fingerprint256),
				"every bundled root survives the merge",
			);
		}
		assert.ok(
			mergedFingerprints.has(new X509Certificate(material.cert).fingerprint256),
			"the OS-style root is part of the merged store",
		);
	} finally {
		// The merge is process-global: put the store back so other tests in this
		// file (and node --test's own workers) see a clean default.
		tls.setDefaultCACertificates(originalDefaults);
		resetSystemCaTrustState();
		await server.close();
		rmSync(material.dir, { recursive: true, force: true });
	}
});

test("ensureSystemCaTrust is idempotent and reports already-trusted roots", (t) => {
	if (!HAS_DEFAULT_STORE_API) {
		t.skip("tls.getCACertificates/setDefaultCACertificates need Node >= 24.9");
		return;
	}
	const defaults = tls.getCACertificates("default");
	const first = ensureSystemCaTrust({ systemCertificates: defaults, refresh: true });
	assert.deepEqual(
		{ applied: first.applied, added: first.added, reason: first.reason },
		{ applied: false, added: 0, reason: "already-trusted" },
		"roots already in the default store are not reported as added",
	);
	assert.equal(ensureSystemCaTrust({ systemCertificates: defaults }), first, "the state is memoized");
	resetSystemCaTrustState();
});

test("systemCaCertificates and systemFetch always answer without throwing", async () => {
	assert.ok(Array.isArray(systemCaCertificates()));
	const fetchFn = systemFetch();
	assert.equal(typeof fetchFn, "function");
	assert.equal(systemFetch(), fetchFn, "the scoped fetch is memoized");
	resetSystemCaTrustState();
});
