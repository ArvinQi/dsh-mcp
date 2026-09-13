/**
 * Read the MCP servers that a Cordis patch layer declares natively.
 *
 * `@deepseek-ai/dsh-mcp-client` rows mount straight from the composition, so
 * those servers never pass through this plugin's storage domain. Reading the
 * two user patch layers — the profile's own `cordis.patch.yml` and the
 * machine-wide `$DSH_HOME/cordis.patch.yml` — lets the Settings page show
 * every MCP server the model can actually call, and lets the manager stay out
 * of the way of rows it does not own (a second mount under the same
 * `serverName` is a hard tool-registry conflict, not an override).
 *
 * Parsing reuses the include package's own YAML dialect (`entryListSchema`),
 * so `!!js` scalars decode exactly as they do at boot; they are rendered back
 * as `!!js <source>` text because the source is what the file holds.
 *
 * Rows are also replayed through `applyEntryPatches` across the layers in
 * application order, so the reported state is the EFFECTIVE one: an
 * id-targeted `disabled: true` (the shape this plugin writes when it takes a
 * server over) or a config override in a later layer is reflected instead of
 * the declaration's original text.
 * @module dsh-mcp/cordis-servers
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import * as includeModule from "@deepseek-ai/cordis-plugin-include";

/** Row names that declare one MCP server row in a composition. */
export const MCP_CLIENT_ROW_NAMES = new Set([
	"@deepseek-ai/dsh-mcp-client",
	"dsh-mcp-client"
]);
/** File name of every Cordis user patch layer. */
export const PATCH_FILE_NAME = "cordis.patch.yml";
/** Native client default, mirrored for rows that omit the field. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;

/** Keep a thrown value readable for diagnostics. */
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Render one decoded YAML scalar as display text; `!!js` keeps its source. */
function scalarText(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value !== null && typeof value === "object" && typeof value.__jsExpr === "string") return `!!js ${value.__jsExpr}`;
	return "";
}

/**
 * Whether a decoded config subtree holds a `!!js` expression anywhere. Such a
 * value is resolved by the Loader at entry activation and cannot be imported
 * as data.
 * @param value - any decoded YAML value.
 * @returns true when an expression node is present.
 */
export function containsJsExpr(value) {
	if (Array.isArray(value)) return value.some((item) => containsJsExpr(item));
	if (value !== null && typeof value === "object") {
		if (typeof value.__jsExpr === "string") return true;
		return Object.values(value).some((item) => containsJsExpr(item));
	}
	return false;
}

/** Collect every row a patch entry can contribute, in application order. */
function collectRows(node, out) {
	if (Array.isArray(node)) {
		for (const item of node) collectRows(item, out);
		return;
	}
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node.insert)) {
		for (const row of node.insert) if (row !== null && typeof row === "object" && !Array.isArray(row)) out.push(row);
	}
	if (typeof node.name === "string" && node.config !== void 0) out.push(node);
}

/**
 * Parse one patch file into its loader patch list.
 * @param content - the patch file's text.
 * @returns the parsed patch list.
 * @throws when the file is not a top-level YAML array or the dialect is missing.
 */
export function parsePatchArray(content) {
	// Read the dialect off the namespace so a future package that stops
	// exporting it degrades into a diagnostic instead of a load-time crash.
	const schema = includeModule.entryListSchema;
	if (schema === void 0) throw new Error("the Cordis include package does not export entryListSchema");
	const parsed = yaml.load(content, { schema });
	if (!Array.isArray(parsed)) throw new Error("the patch file must be a top-level YAML array");
	return parsed;
}

/** The MCP-client rows one patch list declares. */
function collectDeclaredRows(patches) {
	const rows = [];
	collectRows(patches, rows);
	return rows.filter((row) => typeof row.name === "string" && MCP_CLIENT_ROW_NAMES.has(row.name));
}

/**
 * Extract the MCP-client rows of one patch file.
 * @param content - the patch file's text.
 * @returns the declared rows, each with its row id and raw config.
 * @throws when the file is not a top-level YAML array.
 */
export function parseDeclaredRows(content) {
	return collectDeclaredRows(parsePatchArray(content));
}

/**
 * Project one declared row into the manager's server vocabulary.
 * @param row - one decoded `@deepseek-ai/dsh-mcp-client` row.
 * @param layer - the patch layer the row was read from.
 * @returns the server entry, or undefined when the row carries no usable name.
 */
export function toDeclaredServer(row, layer) {
	const config = row.config !== null && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {};
	const serverName = typeof config.serverName === "string" ? config.serverName : "";
	if (serverName.length === 0) return void 0;
	const transport = config.transport === "stdio" ? "stdio" : "streamable-http";
	const headers = Object.entries(config.headers !== null && typeof config.headers === "object" ? config.headers : {}).map(([name, value]) => ({
		name,
		value: scalarText(value)
	}));
	const env = Object.entries(config.env !== null && typeof config.env === "object" ? config.env : {}).map(([name, value]) => ({
		name,
		secret: false,
		configured: true,
		value: scalarText(value)
	}));
	return {
		rowId: typeof row.id === "string" ? row.id : void 0,
		serverName,
		transport,
		enabled: row.disabled !== true,
		command: scalarText(config.command),
		args: Array.isArray(config.args) ? config.args.map((arg) => scalarText(arg)) : [],
		cwd: scalarText(config.cwd),
		url: scalarText(config.url),
		headers,
		env,
		toolCallTimeoutMs: typeof config.toolCallTimeoutMs === "number" ? config.toolCallTimeoutMs : DEFAULT_TOOL_CALL_TIMEOUT_MS,
		failOnStartupError: config.failOnStartupError === true,
		hasJsExpr: containsJsExpr(config),
		declaredIn: layer.path,
		layer: layer.kind
	};
}

/**
 * Project one declared server into the durable storage record shape.
 *
 * The mirror is a read-only copy owned by the composition: `origin` keeps it
 * apart from rows this manager created, `declaredIn`/`declaredRowId` record
 * where it came from, and `stale` marks a mirror whose declaration is gone.
 * The caller validates the result with the domain record schema.
 * @param entry - one declared server from {@link readDeclaredServers}.
 * @returns the storage record (not yet validated).
 */
export function toMirrorRecord(entry) {
	return {
		id: `cordis:${entry.rowId ?? entry.serverName}`,
		serverName: entry.serverName,
		transport: entry.transport,
		enabled: entry.enabled,
		command: entry.command,
		args: entry.args,
		cwd: entry.cwd,
		url: entry.url,
		headers: entry.headers,
		env: entry.env.map((item) => ({
			name: item.name,
			secret: false,
			value: item.value ?? ""
		})),
		toolCallTimeoutMs: entry.toolCallTimeoutMs,
		failOnStartupError: entry.failOnStartupError,
		origin: "cordis",
		declaredIn: entry.declaredIn,
		declaredRowId: entry.rowId,
		stale: false
	};
}

/** Resolve the Harness home, preferring the service the boot layer provides. */export function resolveHarnessHome(ctx) {
	const helper = ctx?.get?.("dshHomePath");
	if (typeof helper === "function") {
		try {
			const home = helper();
			if (typeof home === "string" && home.length > 0) return home;
		} catch {
			/* fall through to the documented environment default */
		}
	}
	const configured = process.env.DSH_HOME;
	return configured !== void 0 && configured.trim().length > 0 ? configured : join(homedir(), ".dsh");
}

/**
 * Resolve the user patch layers in application order (profile, then home
 * machine-wide layer, which outranks it).
 * @param ctx - Host context carrying `dshHomePath` and `baseUrl`.
 * @returns one descriptor per layer.
 */
export function resolvePatchLayers(ctx) {
	const layers = [];
	const baseUrl = typeof ctx?.baseUrl === "string" ? ctx.baseUrl : void 0;
	if (baseUrl !== void 0 && baseUrl.startsWith("file:")) {
		try {
			layers.push({
				kind: "profile",
				path: join(fileURLToPath(new URL(".", baseUrl)), PATCH_FILE_NAME)
			});
		} catch {
			/* a non-file baseUrl leaves only the machine-wide layer */
		}
	}
	layers.push({
		kind: "home",
		path: join(resolveHarnessHome(ctx), PATCH_FILE_NAME)
	});
	return layers;
}

/**
 * Read every MCP server declared by the user patch layers.
 *
 * Later layers win: the machine-wide `$DSH_HOME/cordis.patch.yml` overrides a
 * profile's row for the same `serverName`, matching the composition order.
 * @param ctx - Host context used for layer resolution.
 * @returns declared servers plus per-layer read diagnostics.
 */
export function readDeclaredServers(ctx) {
	const servers = new Map();
	const warnings = [];
	const layers = [];
	// Replay the layers the way the Loader does so the reported state is the
	// effective one: a later id-targeted patch (an override, or the
	// `disabled: true` this plugin writes on takeover) wins over the row text.
	let entries = [];
	const effective = new Map();
	const declared = [];
	for (const layer of resolvePatchLayers(ctx)) {
		const info = {
			kind: layer.kind,
			path: layer.path,
			exists: existsSync(layer.path),
			count: 0,
			error: void 0
		};
		layers.push(info);
		if (!info.exists) continue;
		let patches;
		try {
			patches = parsePatchArray(readFileSync(layer.path, "utf8"));
		} catch (error) {
			info.error = errorText(error);
			warnings.push(`${layer.path}: ${info.error}`);
			continue;
		}
		try {
			const apply = includeModule.applyEntryPatches;
			if (typeof apply === "function") entries = apply(entries, patches, () => {});
		} catch (error) {
			// The Loader already fails loudly on a patch that cannot apply;
			// here the raw rows still describe what the file declares.
			info.error = errorText(error);
			warnings.push(`${layer.path}: ${info.error}`);
		}
		for (const entry of entries) if (typeof entry.id === "string") effective.set(entry.id, entry);
		for (const row of collectDeclaredRows(patches)) declared.push({
			row,
			layer
		});
	}
	// Resolve every declaration against the fully merged entry list, so a
	// disable or override from any later layer is reflected regardless of
	// which layer carried the row.
	for (const { row, layer } of declared) {
		const id = typeof row.id === "string" ? row.id : void 0;
		const merged = id === void 0 ? void 0 : effective.get(id);
		const source = merged === void 0 ? row : {
			...row,
			config: merged.config ?? row.config,
			disabled: merged.disabled === true ? true : row.disabled
		};
		const entry = toDeclaredServer(source, layer);
		if (entry === void 0) continue;
		const previous = servers.get(entry.serverName);
		if (previous !== void 0 && previous.declaredIn === layer.path) warnings.push(`${layer.path}: duplicate serverName "${entry.serverName}" — the later row wins`);
		servers.set(entry.serverName, entry);
		const info = layers.find((item) => item.path === layer.path);
		if (info !== void 0) info.count += 1;
	}
	return {
		servers: [...servers.values()],
		layers,
		warnings
	};
}
