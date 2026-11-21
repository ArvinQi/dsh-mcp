import assert from "node:assert/strict";
import test from "node:test";
import { authorizationServerBaseUrl } from "../lib/oauth-server-url.js";

// The authorization URL the browser is sent to; its origin is NOT the issuer.
const authorizationUrl = new URL("https://fra.cloud.appwrite.io/v1/oauth2/console/authorize?response_type=code&client_id=abc");

test("authorizationServerBaseUrl keeps the path of a discovered path-based issuer", () => {
  // Appwrite: issuer is https://fra.cloud.appwrite.io/v1/oauth2/console
  const discovered = new URL("https://fra.cloud.appwrite.io/v1/oauth2/console");
  const resolved = authorizationServerBaseUrl(discovered, authorizationUrl);
  assert.equal(resolved.href, "https://fra.cloud.appwrite.io/v1/oauth2/console");
  // The metadata URL the SDK derives from it must keep the issuer path.
  assert.equal(
    new URL(".well-known/oauth-authorization-server", `${resolved.href.replace(/\/?$/, "/")}`).href,
    "https://fra.cloud.appwrite.io/v1/oauth2/console/.well-known/oauth-authorization-server",
  );
  // ...and must not regress to the origin, which answers 404 for this issuer.
  assert.notEqual(resolved.origin, resolved.href.replace(/\/$/, ""));
});

test("authorizationServerBaseUrl accepts the discovered URL as a string", () => {
  const resolved = authorizationServerBaseUrl("https://keycloak.example.com/realms/demo", authorizationUrl);
  assert.equal(resolved.href, "https://keycloak.example.com/realms/demo");
});

test("authorizationServerBaseUrl falls back to the authorization page origin without discovery", () => {
  const resolved = authorizationServerBaseUrl(void 0, authorizationUrl);
  assert.equal(resolved.href, "https://fra.cloud.appwrite.io/");
});

test("authorizationServerBaseUrl falls back when the discovered value is not a URL", () => {
  for (const broken of ["", "not a url"]) {
    assert.equal(authorizationServerBaseUrl(broken, authorizationUrl).href, "https://fra.cloud.appwrite.io/");
  }
});
