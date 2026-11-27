/**
 * The display-location feature has two halves that must agree, and one
 * resilience invariant that must not regress.
 *
 * - Every browser descriptor is routed by `<namespace>/<method>` to a host
 *   method that carries `@Remote("<method>")`. A descriptor without that
 *   decorator fails at call time with `gateway/method-unavailable`, which the
 *   settings page can only render as "temporarily unavailable" — a static
 *   check catches it before packaging instead.
 * - `mcp_servers` is validated in full when its domain opens, so one stored row
 *   outside the schema fails the whole plugin (management page *and* every
 *   `mcp__*` tool). `origin` therefore must stay a free string: an unknown
 *   provenance degrades to the writable meaning at the read sites instead of
 *   throwing. This is regression protection for the 1.16.0 fix.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = readFileSync(join(ROOT, "lib/index.js"), "utf8");
const CLIENT = readFileSync(join(ROOT, "src/client/remote-contribution.js"), "utf8");
const CLIENT_ENTRY = readFileSync(join(ROOT, "src/client/index.ts"), "utf8");
const LOCALES = readFileSync(join(ROOT, "src/client/locales.ts"), "utf8");

/** Methods the host registers as Remote endpoints. */
function hostRemoteMethods() {
	return new Set([...HOST.matchAll(/\bRemote\("([^"]+)"\)/g)].map((match) => match[1]));
}

/** Methods declared by the generated client descriptors. */
function descriptorMethods() {
	return [...CLIENT.matchAll(/^\s+method: '([^']+)',$/gm)].map((match) => match[1]);
}

test("every client descriptor has a host Remote method behind it", () => {
	const host = hostRemoteMethods();
	const missing = descriptorMethods().filter((method) => !host.has(method));
	assert.deepEqual(missing, [], "a descriptor without a host Remote method fails at call time");
});

test("the display-location endpoints are declared on both halves", () => {
	const host = hostRemoteMethods();
	for (const method of ["uiPrefs", "uiPrefsPatch"]) {
		assert.ok(host.has(method), `lib/index.js must register Remote("${method}")`);
		assert.ok(descriptorMethods().includes(method), `remote-contribution.js must declare ${method}`);
	}
});

test("the placement default is configurable and persisted outside mcp_servers", () => {
	assert.match(HOST, /placement: z\.string\(\)\.default\("sidebar"\)/, "Config must expose a placement default");
	assert.match(HOST, /name: "mcp_ui"/, "UI preferences need their own storage domain");
	assert.match(HOST, /placement: uiPlacementSchema\.default\("sidebar"\)/, "the prefs row stores one placement");
});

test("an unknown stored origin cannot fail the mcp_servers domain", () => {
	// A hand-edited `origin: "user"` bricked the plugin: the domain validates
	// every row on open and `Service.init` threw, taking the page and the tools
	// with it. Keep the field open-ended.
	assert.doesNotMatch(
		HOST,
		/origin: z\$1\.union\(\[/,
		"origin must stay a free string so unknown provenance degrades instead of failing the domain",
	);
	assert.match(HOST, /origin: z\$1\.string\(\)\.default\("plugin"\)/);
});

test("the client seats the page according to the placement", () => {
	// main is unconditional (a selected panel id must always resolve), the rail
	// entry and the Settings page follow the preference.
	assert.match(CLIENT_ENTRY, /ctx\.slots\.inject\('main'/, "the main panel is always registered");
	assert.match(CLIENT_ENTRY, /name: 'sidebar\.panellist'/, "the rail entry is a sidebar.panellist registration");
	assert.match(CLIENT_ENTRY, /name: 'settings\.section'/, "the Settings page registration is kept");
	assert.match(CLIENT_ENTRY, /const wantSettings = prefs\.placement !== 'sidebar'/);
	assert.match(CLIENT_ENTRY, /const wantSidebar = prefs\.placement !== 'settings'/);
	// Withdrawing the rail entry must not strand the user on the panel.
	assert.match(CLIENT_ENTRY, /selectPanel\?\.\(null\)/);
});

test("pins and aliases persist in the same prefs row the placement uses", () => {
	assert.match(HOST, /pins: z\$1\.array\(z\$1\.string\(\)\)\.default\(\[\]\)/, "pins are stored on the prefs row");
	assert.match(HOST, /aliases: z\$1\.record\(/, "per-server search aliases are stored on the prefs row");
	// The admission predicate runs once per model step and must not await storage.
	assert.match(HOST, /pinned = \/\* @__PURE__ \*\/ new Set\(\)/, "pins are mirrored in memory");
	assert.match(HOST, /pinned: this\.pinned/, "the admission gate reads the mirror");
});

test("the `/mcp` command is registered only when the core has a command registry", () => {
	assert.match(HOST, /installCommand\(\)/, "init must install the command");
	assert.match(HOST, /const commands = this\.ctx\.get\("commands"\)/, "commands is an optional dependency");
	assert.match(HOST, /name: "mcp",\n\s*description: hostText\(this\.ctx, "commandDesc"\)/, "the command is named mcp");
	for (const verb of ["pin", "unpin", "mode"]) {
		assert.ok(HOST.includes(`case "${verb}"`), `the command handles ${verb}`);
	}
});

test("every host copy key the feature uses exists in both dictionaries", () => {
	for (const key of ["toolSearchServer", "toolSearchList", "searchList", "searchAliasHint", "commandDesc", "commandStatus", "commandPinned"]) {
		assert.ok(HOST.includes(`"${key}"`), `lib/index.js must reference ${key}`);
	}
	// Host copy lives in lib/host-locales.js (zh is the source, en mirrors it);
	// the page's own copy lives in src/client/locales.ts.
	const HOST_LOCALES = readFileSync(join(ROOT, "lib/host-locales.js"), "utf8");
	for (const key of ["toolSearchServer", "toolSearchList", "searchList", "searchAliasHint", "commandDesc", "commandStatus", "commandPinned"]) {
		const occurrences = HOST_LOCALES.match(new RegExp(`^\\s*${key}:`, "gm")) ?? [];
		assert.equal(occurrences.length, 2, `host-locales.js must carry ${key} in zh and en`);
	}
	for (const key of ["listSearch", "pinExplainer", "pinnedTitle", "duplicateBadge", "aliasLabel"]) {
		const occurrences = LOCALES.match(new RegExp(`^\\s*${key}:`, "gm")) ?? [];
		assert.equal(occurrences.length, 2, `locales.ts must carry ${key} in zh and en`);
	}
});

test("tools live inside the server list: pin control, alias editor, duplicate hint", () => {
	// The catalog is not a second list any more: search/filter narrows the
	// server list itself and each card owns its tools.
	const section = readFileSync(join(ROOT, "src/client/McpSettingsSection.tsx"), "utf8");
	assert.ok(!section.includes("ToolDirectory"), "no separate catalog module is rendered");
	assert.match(section, /findDuplicates/, "duplicate tool sets are detected on the cards");
	assert.match(section, /const serverTools = /, "each card lists its own tools");
	// The pin is a text button ("固定" / "已固定"): the 28px icon-only control had
	// a hit area too small to hit and its meaning was unclear.
	assert.match(
		section,
		/className=\{isPinned \? `\$\{controls\.button\} \$\{css\.pinOn\}` : `\$\{controls\.button\} \$\{css\.pinOff\}`\}/,
		"the pin is a labelled button",
	);
	assert.match(section, /\{isPinned \? t\('pinActionOn'\) : t\('pinActionOff'\)\}/, "both states carry a label");
	// "?" must follow the tool name (it explains that tool), not sit far right.
	const rowStart = section.indexOf("onPointerDown={(event) => paintStart(tool, event)}");
	const row = section.slice(rowStart, section.indexOf("</li>", rowStart));
	assert.ok(
		row.indexOf("css.toolName") < row.indexOf("css.helpWrap"),
		"the help button follows the tool name",
	);
	// The row itself is the toggle: click the name, or drag across rows.
	assert.match(section, /const paintStart = /, "a drag paints the same state across rows");
	assert.match(section, /onPointerEnter=\{\(\) => paintOver\(tool\)\}/, "rows react to the pointer crossing them");
	assert.match(section, /persistEnabled\(\[\.\.\.paint\.names\], paint\.target\)/, "one batch per drag, not one per row");
	assert.match(section, /onClick=\{\(\) => applyPins\(\[tool\.name\], !isPinned\)\}/, "clicking it pins the tool");
	assert.match(section, /t\('pinnedTitle'\)/, "pinned tools are listed on their own");
	assert.match(section, /saveAliasInput/, "aliases are editable per server");
});

test("every literal t('key') used by the page exists in the dictionaries", () => {
	// A key that loses its dictionary entry silently renders as the raw key,
	// which no type check catches (the client bundle is built without tsc).
	const section = [
		readFileSync(join(ROOT, "src/client/McpSettingsSection.tsx"), "utf8"),
		readFileSync(join(ROOT, "src/client/ServerForm.tsx"), "utf8"),
	].join("\n");
	const keys = [...section.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
	// Each dictionary is checked on its own: a key present only in `en` renders
	// English inside a Chinese UI (that is how "Back to list" leaked into 返回列表).
	const enAt = LOCALES.indexOf("export const en = {");
	const zhOnly = LOCALES.slice(0, enAt);
	const enOnly = LOCALES.slice(enAt);
	const missing = [];
	for (const key of new Set(keys)) {
		const present = (source) => new RegExp(`^\\s*${key}: `, "m").test(source);
		if (!present(zhOnly)) missing.push(`${key} (zh)`);
		if (!present(enOnly)) missing.push(`${key} (en)`);
	}
	assert.deepEqual(missing.sort(), [], "both dictionaries must define every key the page uses");
});

test("the prefs write unwraps the transport carrier before touching pins", () => {
	// Reported bug: clicking pin failed with "outcome.pins is not iterable".
	// The Remote returns a carrier `{ ok, value }`, so `pins` only exists one
	// level in; reading it off the carrier spreads `undefined`.
	assert.match(
		CLIENT_ENTRY,
		/unwrap\(\(\) => manager\.uiPrefsPatch/,
		"the write must go through unwrap(), not read fields off the carrier",
	);
	assert.doesNotMatch(
		CLIENT_ENTRY,
		/pins: \[\.\.\.outcome\.pins\]/,
		"reading carrier-level pins is the crash",
	);
	assert.match(
		CLIENT_ENTRY,
		/pins: \[\.\.\.\(outcome\.pins \?\? \[\]\)\]/,
		"a partial/older Host result must degrade instead of throwing",
	);
});

test("the editor replaces the server row instead of stacking under it", () => {
	const section = readFileSync(join(ROOT, "src/client/McpSettingsSection.tsx"), "utf8");
	const form = readFileSync(join(ROOT, "src/client/ServerForm.tsx"), "utf8");
	// Returning the card AND the form made the page show the old row above the
	// editor, which read as a second server.
	assert.match(section, /if \(state\.draft !== null && state\.draft\.id === server\.id\) \{\n\s*return \[<li/, "the form takes the card's slot");
	assert.ok(!form.includes("backToList"), "the footer's Cancel covers it");
	assert.match(form, /t\('optionsTitle'\)/, "behavior switches are grouped");
	assert.match(form, /autoFocus=\{draft\.id === null\}/, "a new server focuses the name field");

	// 删除 used to sit at the title's right — exactly where the card's 编辑
	// button is, so the click that opened the editor could land on it.
	const titleStart = form.indexOf('<div className={css.titleRow}>');
	const titleBlock = form.slice(titleStart, form.indexOf('</div>', titleStart));
	assert.ok(!titleBlock.includes('removeServer'), "delete must not sit under the edit button's position");
	assert.match(form, /\$\{css\.deleteAction\}/, "delete belongs to the footer's left edge");
});
