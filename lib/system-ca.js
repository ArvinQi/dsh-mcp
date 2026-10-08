/**
 * Operating-system CA trust for HTTPS MCP endpoints.
 *
 * Node ships its own bundled root store (Mozilla's), so an HTTPS server whose
 * certificate chains to a root that only exists in the operating system store
 * — a corporate CA, an MDM/Zscaler/proxy root, a self-signed internal PKI —
 * fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `DEPTH_ZERO_SELF_SIGNED_CERT`
 * even though every browser and curl on the machine accepts it. The MCP
 * transport, its OAuth discovery/registration/token calls, and the connection
 * probe all go through the process-wide `fetch`, so the fix is to merge the
 * system anchors into the process default trust store once.
 *
 * `tls.getCACertificates('system')` is the accurate cross-platform source
 * (macOS/Windows/Linux, Node >= 24.9); when the API is absent or returns
 * nothing, the well-known OS bundle files are read as a fallback. The merge is
 * additive — Node's bundled roots stay trusted — and idempotent.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import tls from "node:tls";

/**
 * Well-known OS bundle files, used when `tls.getCACertificates('system')` is
 * unavailable (Node < 24.9) or empty.
 */
const OS_CA_FILES = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
];

/** Split a PEM bundle into individual certificates, tolerating junk between them. */
function splitPem(text) {
  return String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

/**
 * Certificates installed in the operating-system trust store.
 * @returns an array of PEM strings (possibly empty).
 */
export function systemCaCertificates() {
  const certificates = [];
  if (typeof tls.getCACertificates === "function") {
    try {
      certificates.push(...(tls.getCACertificates("system") ?? []));
    } catch {
      /* the API throws when the OS store is unreadable — fall back to files */
    }
  }
  for (const file of OS_CA_FILES) {
    try {
      certificates.push(...splitPem(readFileSync(file, "utf8")));
    } catch {
      /* an absent bundle file is not an error */
    }
  }
  return [...new Set(certificates)];
}

/** Memoized result of the last {@link ensureSystemCaTrust} call. */
let trustState;

/**
 * Merge the operating-system CA roots into the process-wide default TLS trust
 * store, once per process. Every HTTPS client that uses Node's defaults —
 * global `fetch` (undici), `node:https`, and therefore the MCP SDK's transport
 * and OAuth calls — then trusts exactly what the OS trusts.
 *
 * Safe to call from any host path: repeated calls are a no-op, and a host
 * whose Node lacks the API simply keeps its previous behaviour.
 * @param options - test/override hooks (not used by the plugin).
 * @param options.refresh - recompute instead of returning the memoized state.
 * @param options.systemCertificates - explicit system roots (tests, callers that already resolved them).
 * @returns a summary of what happened, for logging.
 */
export function ensureSystemCaTrust(options = {}) {
  if (trustState !== undefined && options.refresh !== true) return trustState;
  const canSetDefault =
    typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function";
  if (!canSetDefault) {
    trustState = { applied: false, added: 0, system: 0, reason: "node-api-unavailable" };
    return trustState;
  }
  let defaults;
  try {
    defaults = tls.getCACertificates("default") ?? [];
  } catch {
    trustState = { applied: false, added: 0, system: 0, reason: "default-store-unreadable" };
    return trustState;
  }
  let system;
  try {
    system = options.systemCertificates ?? systemCaCertificates();
  } catch {
    system = [];
  }
  if (system.length === 0) {
    trustState = { applied: false, added: 0, system: 0, reason: "no-system-ca" };
    return trustState;
  }
  const merged = [...new Set([...defaults, ...system])];
  if (merged.length === defaults.length) {
    trustState = { applied: false, added: 0, system: system.length, reason: "already-trusted" };
    return trustState;
  }
  try {
    tls.setDefaultCACertificates(merged);
  } catch {
    trustState = { applied: false, added: 0, system: system.length, reason: "set-failed" };
    return trustState;
  }
  trustState = { applied: true, added: merged.length - defaults.length, system: system.length };
  return trustState;
}

/** Test hook: forget the memoized state (the trust store itself is left as is). */
export function resetSystemCaTrustState() {
  trustState = undefined;
  scopedFetch = undefined;
}

/** Memoized scoped fetch (see {@link systemFetch}). */
let scopedFetch;

/**
 * A `fetch` that verifies HTTPS against the operating-system roots, usable on
 * every supported Node:
 *
 * - On Node >= 24.9 (Electron 44 ships 24.18) {@link ensureSystemCaTrust}
 *   patches the process default store, which global `fetch` already uses, so
 *   this returns the global fetch.
 * - On older Node the default store cannot be patched; when the `undici`
 *   package is resolvable (it always is inside a DSH installation, and plain
 *   Node's own fetch is undici), this returns a fetch bound to an Agent whose
 *   `ca` is Node's bundled roots plus the OS roots.
 * - Otherwise it returns global fetch unchanged, so the caller never breaks.
 *
 * @returns a fetch function (never undefined).
 */
export function systemFetch() {
  if (scopedFetch !== undefined) return scopedFetch;
  const summary = ensureSystemCaTrust();
  if (summary.applied) {
    scopedFetch = fetch;
    return scopedFetch;
  }
  const certificates = systemCaCertificates();
  if (certificates.length === 0) {
    scopedFetch = fetch;
    return scopedFetch;
  }
  try {
    const require = createRequire(import.meta.url);
    const { Agent, fetch: undiciFetch } = require("undici");
    const ca = [...new Set([...(tls.rootCertificates ?? []), ...certificates])];
    const agent = new Agent({ connect: { ca } });
    scopedFetch = (input, init) => undiciFetch(input, { ...init, dispatcher: agent });
  } catch {
    // No undici in reach (or an older API): stay on the global fetch rather
    // than failing the connection.
    scopedFetch = fetch;
  }
  return scopedFetch;
}
