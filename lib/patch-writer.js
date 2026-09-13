/**
 * Rewrite the one managed block of a Cordis patch file.
 *
 * Taking a declared MCP server over needs the declaration to let go of the
 * name first: the composition mounts it, and a second mount under the same
 * `serverName` is a tool-registry conflict rather than an override. An
 * id-targeted `disabled: true` entry appended after the `insert` in the same
 * patch list does exactly that (`applyEntryPatches` maps inserted rows before
 * applying later patches), so the plugin never edits the user's own rows.
 *
 * The writer owns one fenced block and nothing else: everything outside the
 * markers is preserved byte for byte, the block is rewritten idempotently, and
 * the original file is backed up once before the first modification.
 * @module dsh-mcp/patch-writer
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Opening marker of the block this writer owns. */
export const MANAGED_BEGIN = "# >>> dsh-mcp managed (takeover) >>>";
/** Closing marker of the block this writer owns. */
export const MANAGED_END = "# <<< dsh-mcp managed (takeover) <<<";
/** Suffix of the one-time backup taken before the first modification. */
export const BACKUP_SUFFIX = ".dsh-mcp.bak";

/** Read a patch file, treating absence as an empty file. */
export function readPatchText(path) {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	} catch {
		return "";
	}
}

/** Whether one line holds nothing but the empty-array literal. */
function isEmptyArrayLine(line) {
	return line.trim() === "[]";
}

/** Strip the managed block, returning the remaining text and the block ids. */
function splitManagedBlock(text) {
	const lines = text.split(/\r?\n/);
	const kept = [];
	const ids = [];
	let inside = false;
	for (const line of lines) {
		if (line.trim() === MANAGED_BEGIN) {
			inside = true;
			continue;
		}
		if (line.trim() === MANAGED_END) {
			inside = false;
			continue;
		}
		if (inside) {
			const match = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
			if (match !== null) ids.push(match[1].replace(/^["']|["']$/g, ""));
			continue;
		}
		kept.push(line);
	}
	return {
		base: kept.join("\n"),
		ids
	};
}

/** Whether a stripped base still declares at least one YAML list entry. */
function hasEntries(base) {
	return base.split(/\r?\n/).some((line) => /^\s*-\s+\S/.test(line));
}

/** Render the managed block for one id set. */
function renderBlock(ids) {
	return [
		MANAGED_BEGIN,
		"# 由 dsh-mcp 接管：下列声明行为已交由插件托管，请勿手工编辑本块。",
		...ids.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
		MANAGED_END
	];
}

/**
 * Compose the next file text: preserved base, then the managed block; a base
 * that would otherwise be empty keeps a valid empty-array literal.
 * @param base - the file text without the managed block.
 * @param ids - the ids the block must disable (empty removes the block).
 * @returns the next file text.
 */
function composeText(base, ids) {
	const bare = base.split(/\r?\n/).filter((line) => !isEmptyArrayLine(line));
	const body = bare.join("\n").replace(/\s+$/, "");
	const parts = [];
	if (body.length > 0) parts.push(body);
	if (ids.length > 0) parts.push(renderBlock(ids).join("\n"));
	else if (!hasEntries(body)) parts.push("[]");
	return `${parts.join("\n\n")}\n`;
}

/** The ids one patch file's managed block currently disables. */
export function managedIds(path) {
	return splitManagedBlock(readPatchText(path)).ids;
}

/**
 * Ensure the managed block disables exactly `ids`.
 * @param path - absolute patch file path.
 * @param ids - ids to disable; an empty list removes the block.
 * @returns the write outcome, including the one-time backup path when taken.
 */
export function writeManagedIds(path, ids) {
	const current = readPatchText(path);
	const unique = [...new Set(ids)].sort();
	const next = composeText(splitManagedBlock(current).base, unique);
	if (next === current) return { ok: true, changed: false, path };
	let backupPath;
	try {
		if (current.length > 0 && !existsSync(`${path}${BACKUP_SUFFIX}`)) {
			copyFileSync(path, `${path}${BACKUP_SUFFIX}`);
			backupPath = `${path}${BACKUP_SUFFIX}`;
		}
		// Atomic replace: a reader (the HMR watcher) never observes a half write.
		const staging = `${path}.dsh-mcp.tmp-${process.pid}`;
		writeFileSync(staging, next);
		renameSync(staging, path);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
	return {
		ok: true,
		changed: true,
		path,
		...backupPath === void 0 ? {} : { backupPath }
	};
}
