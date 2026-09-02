import assert from "node:assert/strict";
import test from "node:test";
import { en, hostLocale, hostText, zh } from "../lib/host-locales.js";

/** A Host ctx whose settings service answers the locale section. */
function ctxWith(preference) {
	return {
		get(name) {
			return name === "settings"
				? { get(ns) { return ns === "locale" ? { preference } : void 0; } }
				: void 0;
		}
	};
}

const zhCtx = ctxWith("zh");
const enCtx = ctxWith("en");
const bareCtx = { get() { return void 0; } };

test("zh and en dictionaries cover the same keys", () => {
	const zhKeys = Object.keys(zh).sort();
	const enKeys = Object.keys(en).sort();
	assert.deepEqual(enKeys, zhKeys, "every host copy key must exist in both dictionaries");
	assert.ok(zhKeys.length >= 13, "host copy table must keep its full key set");
});

test("hostLocale resolves the DSH locale preference", () => {
	assert.equal(hostLocale(zhCtx), "zh");
	assert.equal(hostLocale(enCtx), "en");
	assert.equal(hostLocale(bareCtx), "zh", "no settings service falls back to zh");
});

test("hostText renders the localized copy for the current locale", () => {
	assert.match(hostText(zhCtx, "toolSearchDesc"), /按关键词检索/);
	assert.match(hostText(enCtx, "toolSearchDesc"), /Search the enabled MCP tools/);
	assert.match(hostText(bareCtx, "toolSearchDesc"), /按关键词检索/, "unresolvable locale keeps zh");
});

test("hostText substitutes {placeholders}", () => {
	assert.equal(hostText(enCtx, "oauthToolFallback", { serverName: "octop-memory-prod" }),
		'Server "octop-memory-prod" requires OAuth authorization: edit the server in Settings → MCP and click "Test connection" to complete authorization');
	assert.match(hostText(zhCtx, "toolControlPrompt", { servers: "a, b" }), /当前可用 MCP 服务器：a, b。/);
});

test("unknown keys fall back to the zh template verbatim", () => {
	assert.equal(hostText(enCtx, "doesNotExist"), "");
	assert.equal(hostText(zhCtx, "doesNotExist"), "");
});
