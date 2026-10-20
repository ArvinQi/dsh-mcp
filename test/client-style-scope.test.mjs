/**
 * Client styles must never escape the plugin, and must never match an element
 * by tag.
 *
 * Contrary to what the file names suggest, nothing in this package scopes a
 * `.module.css` file: `scripts/build.mjs` inlines the stylesheet text verbatim
 * into a `<style data-plugin="dsh-mcp">` tag appended to the host page's
 * `<head>`, and the class map it exports is the identity. Every selector is
 * therefore global and can match host DOM.
 *
 * Issue #14 was that failure mode in its worst form: two bare `button {}` rules
 * restyled every button of the DSH shell, and the composer's 28px/34px icon
 * buttons — which declare no padding of their own — lost their centering
 * (`padding: 5px 12px` shrank their content box, pushing the SVG right).
 *
 * The package now styles controls by class only. Shared control classes live in
 * `src/client/controls.module.css` and are defined exactly once (with an
 * identity class map a second definition would silently retarget every control
 * in the plugin); component sheets keep layout and variants, all class-based.
 *
 * Three gates keep it that way:
 *  1. every selector in `src/client/*.module.css` is a chain of class
 *     compounds — no type selector, no `*`, no `:root`, no `.root element`;
 *  2. the same holds for what `lib/client.js` actually injects, so a stale
 *     build cannot pass while the sources are fixed;
 *  3. `controls.module.css` is injected before the component sheets and each
 *     shared class is defined exactly once, so the cascade stays predictable.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENT = join(ROOT, "src", "client");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** Shared control classes; defined in controls.module.css only. */
const SHARED_CLASSES = ["button", "buttonSmall", "primary", "control", "controlMono", "checkbox"];

/** Platform modules the shell injects; every other import must be inlined. */
const PLATFORM = {
	react: {
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial }),
		createElement: () => null,
		Fragment: Symbol("Fragment"),
	},
	"react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: Symbol("Fragment") },
	"react-dom": {},
	"react-dom/client": {},
	"@deepseek-ai/cordis": {},
	"@deepseek-ai/dsh-client-store": { defineStore: (spec) => ({ spec }) },
	"@deepseek-ai/dsh-client-ui-slots": {},
	"@deepseek-ai/dsh-client-ui-primitives": {},
};

/** Style rules of a stylesheet, in source order: `{ selector, index }`. */
function rulesOf(css) {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	let cursor = 0;
	for (const block of clean.split("}")) {
		const blockStart = cursor;
		cursor += block.length + 1;
		const brace = block.lastIndexOf("{");
		if (brace === -1) continue;
		const prelude = block.slice(0, brace);
		if (prelude.trim() === "" || prelude.trim().startsWith("@")) continue;
		let offset = blockStart;
		for (const selector of prelude.split(",")) {
			if (selector.trim() !== "") rules.push({ selector: selector.trim(), index: offset });
			offset += selector.length + 1;
		}
	}
	return rules;
}

/** Split one selector into its compounds (respecting (...) and [...]). */
function compoundsOf(selector) {
	const compounds = [];
	let parens = 0;
	let brackets = 0;
	let start = 0;
	for (let index = 0; index < selector.length; index += 1) {
		const char = selector[index];
		if (char === "(") parens += 1;
		else if (char === ")") parens -= 1;
		else if (char === "[") brackets += 1;
		else if (char === "]") brackets -= 1;
		else if (parens === 0 && brackets === 0 && " \t\n>+~".includes(char)) {
			if (index > start) compounds.push(selector.slice(start, index));
			start = index + 1;
		}
	}
	if (start < selector.length) compounds.push(selector.slice(start));
	return compounds;
}

/** Whether a selector matches only elements the plugin explicitly classed. */
function isClassOnly(selector) {
	if (selector.includes("*")) return false;
	const compounds = compoundsOf(selector);
	if (compounds.length === 0) return false;
	return compounds.every((compound) => /^\.[A-Za-z_][A-Za-z0-9_-]*/.test(compound));
}

/** Evaluate lib/client.js against a fake DOM and return the injected stylesheets. */
function injectedStyles() {
	const styles = [];
	const document = {
		head: {
			appendChild: (node) => { styles.push(node); },
		},
		createElement: () => ({
			attributes: {},
			textContent: "",
			setAttribute(name, value) { this.attributes[name] = value; },
		}),
		querySelector: () => null,
	};
	const loaded = [];
	const context = vm.createContext({
		window: { __ModuleLoader__: { load: (entry) => { loaded.push(entry); } } },
		document,
		console,
	});
	vm.runInContext(readFileSync(join(ROOT, "lib", "client.js"), "utf8"), context, {
		filename: "lib/client.js",
	});
	assert.equal(loaded.length, 1, "the bundle registers exactly one loader entry");
	loaded[0].factory((id) => {
		assert.ok(id in PLATFORM, `unexpected platform import ${id}`);
		return PLATFORM[id];
	});
	return styles;
}

const moduleFiles = readdirSync(CLIENT).filter((name) => name.endsWith(".module.css")).sort();

test("every src/client/*.module.css selector is a class selector", () => {
	assert.ok(moduleFiles.length >= 6, "the client stylesheets are present");
	const offenders = [];
	for (const file of moduleFiles) {
		for (const { selector } of rulesOf(readFileSync(join(CLIENT, file), "utf8"))) {
			if (!isClassOnly(selector)) offenders.push(`${file}: ${selector}`);
		}
	}
	assert.deepEqual(offenders, [], "element selectors leak into the host shell; use a class");
});

test("the built bundle injects its stylesheets and no element selector", () => {
	// ToolControlSection.module.css is not part of the shipped bundle (its
	// component is not imported by the entry), so only assert on what is
	// actually injected — but every injected sheet must be a client stylesheet.
	const injected = [
		"ServerForm.module.css",
		"McpSettingsSection.module.css",
		"GlobalEnvEditor.module.css",
		"ServersJsonEditor.module.css",
	];
	const styles = injectedStyles();
	const files = styles.map((style) => style.attributes["data-file"]);
	for (const file of injected) {
		assert.ok(files.includes(file), `${file} is injected by the build`);
	}
	assert.equal(new Set(files).size, files.length, "no stylesheet is injected twice");
	for (const style of styles) {
		const file = style.attributes["data-file"];
		assert.ok(moduleFiles.includes(file), `${file} is a client stylesheet`);
		assert.equal(style.attributes["data-plugin"], manifest.name);
		assert.ok(style.textContent.length > 0, `${file} has content`);
		for (const { selector } of rulesOf(style.textContent)) {
			assert.ok(isClassOnly(selector), `${file} leaks an element selector: ${selector}`);
		}
	}
});

test("shared control classes are defined once and injected first", () => {
	const styles = injectedStyles();
	const files = styles.map((style) => style.attributes["data-file"]);
	const controlsIndex = files.indexOf("controls.module.css");
	assert.ok(controlsIndex >= 0, "controls.module.css is injected");
	assert.equal(controlsIndex, 0, "controls.module.css is injected before the component sheets");

	// With an identity class map, re-defining a shared class in a component
	// sheet would silently change every control using it.
	for (const name of SHARED_CLASSES) {
		const definitions = [];
		for (const style of styles) {
			const file = style.attributes["data-file"];
			for (const { selector } of rulesOf(style.textContent)) {
				if (selector === `.${name}`) definitions.push(file);
			}
		}
		assert.deepEqual(definitions, ["controls.module.css"], `.${name} must be defined only in controls.module.css`);
	}

	// The shared classes have equal specificity, so their order in that one
	// sheet is what keeps the base rule from overriding a variant.
	const controls = styles[controlsIndex].textContent;
	const order = (selector) => rulesOf(controls).findIndex((rule) => rule.selector === selector);
	assert.ok(order(".button") < order(".buttonSmall"), ".buttonSmall must override .button");
	assert.ok(order(".button") < order(".primary"), ".primary must override .button");
	assert.ok(order(".button:hover") < order(".primary:hover"), ".primary:hover must override .button:hover");
	assert.ok(order(".control") < order(".controlMono"), ".controlMono must override .control");
});

test("every client button carries the shared button class", () => {
	const offenders = [];
	for (const file of readdirSync(CLIENT).filter((name) => name.endsWith(".tsx")).sort()) {
		const source = readFileSync(join(CLIENT, file), "utf8");
		const pattern = /<button\b/g;
		for (const match of source.matchAll(pattern)) {
			if (!source.slice(match.index, match.index + 400).includes("controls.button")) {
				const line = source.slice(0, match.index).split("\n").length;
				offenders.push(`${file}:${line}`);
			}
		}
	}
	assert.deepEqual(offenders, [], "a button without controls.button would render unstyled");
});
