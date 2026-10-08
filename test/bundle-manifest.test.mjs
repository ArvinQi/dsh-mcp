/**
 * The package installs as a DSH bundle: `dsh plugin add` and the Web plugin
 * manager treat a package as a profile layer only when its manifest declares
 * `dsh.bundle.patch` — without it the client refuses the install with
 * "declares no dsh.bundle", and the CLI installs it as a plain dependency that
 * never enters the running composition.
 *
 * The declared patch must exist, must ship in the published tarball (`files`),
 * and must insert exactly the row both halves are loaded through: the host
 * manager, and — because the row's package declares `dsh.client` — the browser
 * settings page.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const declared = manifest.dsh?.bundle?.patch;
const patchFiles = typeof declared === "string" ? [declared] : declared;

test("the manifest declares a bundle layer that ships its patch", () => {
	assert.ok(
		Array.isArray(patchFiles) && patchFiles.length > 0,
		"dsh.bundle.patch must be a path or a non-empty list of paths",
	);
	for (const file of patchFiles) {
		assert.equal(typeof file, "string", "every declared patch file is a path");
		assert.ok(existsSync(join(ROOT, file)), `${file} must exist`);
		const shipped = (manifest.files ?? []).map((entry) => entry.replace(/^\.\//, ""));
		assert.ok(shipped.includes(file.replace(/^\.\//, "")), `${file} must be listed in package.json files`);
	}
	assert.equal(manifest.dsh?.client?.platform, "web", "the row's package carries the web client half");
});

test("the bundle patch inserts the plugin's own row", async (context) => {
	let loadYaml;
	try {
		({ load: loadYaml } = await import("js-yaml"));
	} catch {
		context.skip("js-yaml resolves only inside a DSH installation; run npm test there to check the patch");
		return;
	}
	const document = loadYaml(await readFile(join(ROOT, patchFiles[0]), "utf8"));
	const rows = (document ?? []).flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []));
	assert.deepEqual(rows, [{ id: manifest.name, name: manifest.name }]);
});
