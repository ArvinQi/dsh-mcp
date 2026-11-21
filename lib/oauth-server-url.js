/**
 * Pick the authorization-server base URL for the token exchange.
 *
 * The exchange (metadata re-discovery + `exchangeAuthorization`) must talk to
 * the authorization server the flow was STARTED against, not to the origin of
 * the authorization page: an issuer may carry a path (`https://host/v1/oauth2/
 * console`, Keycloak's `/realms/<realm>`, …), and `authorizationUrl.origin`
 * silently drops it. Rebuilding from the origin then requests
 * `<host>/.well-known/oauth-authorization-server`, which for a path-based
 * issuer answers 404 — the SDK throws before any token request is made, so a
 * completed authorization never produces stored tokens.
 *
 * The discovered URL is therefore preferred whenever it is available; the
 * authorization URL's origin remains the last-resort fallback for the legacy
 * provider path where no discovery result exists.
 * @module dsh-mcp/oauth-server-url
 */

/**
 * Resolve the authorization-server base URL used by the token exchange.
 * @param discoveredUrl - the URL returned by discovery (`info.authorizationServerUrl`), when one exists.
 * @param authorizationUrl - the authorization URL handed to the browser (URL instance).
 * @returns the URL to discover metadata from and to exchange the code against.
 */
export function authorizationServerBaseUrl(discoveredUrl, authorizationUrl) {
	if (discoveredUrl !== void 0 && discoveredUrl !== null) {
		const text = String(discoveredUrl);
		if (text.length > 0) {
			try {
				return new URL(text);
			} catch {
				/* not a URL — fall back to the authorization page's origin */
			}
		}
	}
	return new URL(authorizationUrl.origin);
}
