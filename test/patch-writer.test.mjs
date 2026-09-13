import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { BACKUP_SUFFIX, managedIds, writeManagedIds } from "../lib/patch-writer.js";

/** A patch file with two declared rows. */
const PATCH = `# 我的 patch 层
- insert:
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: streamable-http, serverName: web, url: http://declared.test/mcp }
    - id: mcp-fs
      name: '@deepseek-ai/dsh-mcp-client'
      config: { transport: stdio, serverName: fs, command: npx, args: ['-y', 'x'] }
`;

/** A temporary patch file plus its cleanup. */
function fixture(text) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-patch-"));
	const path = join(dir, "cordis.patch.yml");
	if (text !== undefined) writeFileSync(path, text);
	return {
		path,
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

/** Apply the file's own patch list the way the Loader does. */
function effectiveRows(path) {
	const patches = yaml.load(readFileSync(path, "utf8"), { schema: entryListSchema });
	return applyEntryPatches([], patches, () => {});
}

test("the managed block disables the declared row and keeps a backup", () => {
	const f = fixture(PATCH);
	try {
		const result = writeManagedIds(f.path, ["mcp-web"]);
		assert.equal(result.ok, true);
		assert.equal(result.changed, true);
		assert.equal(result.backupPath, `${f.path}${BACKUP_SUFFIX}`);
		assert.equal(readFileSync(result.backupPath, "utf8"), PATCH, "the backup holds the original file");
		const rows = effectiveRows(f.path);
		const web = rows.find((row) => row.id === "mcp-web");
		const fs = rows.find((row) => row.id === "mcp-fs");
		assert.equal(web.disabled, true, "the composition now skips the declared row");
		assert.equal(fs.disabled, undefined, "other declarations stay untouched");
		assert.equal(web.config.serverName, "web", "the declaration itself is preserved");
		assert.deepEqual(managedIds(f.path), ["mcp-web"]);
	} finally {
		f.cleanup();
	}
});

test("a second write is a no-op and never duplicates the block", () => {
	const f = fixture(PATCH);
	try {
		writeManagedIds(f.path, ["mcp-web", "mcp-fs"]);
		const once = readFileSync(f.path, "utf8");
		const again = writeManagedIds(f.path, ["mcp-fs", "mcp-web"]);
		assert.equal(again.changed, false, "an already-matching block is left alone");
		assert.equal(readFileSync(f.path, "utf8"), once);
		assert.equal(once.split("dsh-mcp managed (takeover) >>>").length - 1, 1, "exactly one managed block");
		assert.deepEqual(managedIds(f.path), ["mcp-fs", "mcp-web"]);
	} finally {
		f.cleanup();
	}
});

test("removing the last id restores the file body byte for byte", () => {
	const f = fixture(PATCH);
	try {
		writeManagedIds(f.path, ["mcp-web"]);
		const restored = writeManagedIds(f.path, []);
		assert.equal(restored.changed, true);
		assert.equal(readFileSync(f.path, "utf8"), PATCH, "only the managed block was ever added");
		assert.deepEqual(managedIds(f.path), []);
		assert.equal(existsSync(`${f.path}${BACKUP_SUFFIX}`), true, "the one-time backup stays");
	} finally {
		f.cleanup();
	}
});

test("a comments-only file with [] stays a valid array through add and remove", () => {
	const f = fixture("# 我的 patch 层\n[]\n");
	try {
		writeManagedIds(f.path, ["mcp-web"]);
		const withBlock = readFileSync(f.path, "utf8");
		assert.ok(Array.isArray(yaml.load(withBlock, { schema: entryListSchema })), "the file stays a patch list");
		assert.equal(withBlock.includes("# 我的 patch 层"), true, "the user's comment survives");
		assert.deepEqual(managedIds(f.path), ["mcp-web"]);
		writeManagedIds(f.path, []);
		const restored = readFileSync(f.path, "utf8");
		assert.ok(Array.isArray(yaml.load(restored, { schema: entryListSchema })), "removing the block leaves a valid list");
		assert.equal(restored.includes("[]"), true, "an empty layer keeps its empty-array literal");
	} finally {
		f.cleanup();
	}
});

test("a patch file that does not exist yet is created valid, with no backup", () => {
	const f = fixture(undefined);
	try {
		const result = writeManagedIds(f.path, ["mcp-web"]);
		assert.equal(result.ok, true);
		assert.equal(result.changed, true);
		assert.equal(result.backupPath, undefined, "nothing to back up on a new file");
		const text = readFileSync(f.path, "utf8");
		assert.ok(Array.isArray(yaml.load(text, { schema: entryListSchema })));
		assert.deepEqual(managedIds(f.path), ["mcp-web"]);
		assert.equal(existsSync(`${f.path}${BACKUP_SUFFIX}`), false);
	} finally {
		f.cleanup();
	}
});
