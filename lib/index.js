import { randomBytes } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import * as mcpClient from "./mcp-client.js";
import { probeConnection } from "./probe.js";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region lib/types/spec.js
/**
* Durable storage-domain declaration and wire-boundary validation for managed
* MCP server definitions. Record schemas are zod (the domain layer's language);
* request validation reuses the same field schemas so the durable and wire
* boundaries cannot drift.
* @module @deepseek-ai/dsh-mcp-manager/src/spec
*/
/** MCP tool namespace: the same contract mcp-client enforces. */
const serverNameSchema = z$1.string().regex(/^[A-Za-z0-9_-]{1,32}$/, { message: "serverName must match [A-Za-z0-9_-]{1,32}" });
/** POSIX shell identifier, the shape of an injected environment variable. */
const envVarNameSchema = z$1.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "environment variable name must be a POSIX identifier" });
const positiveIntegerSchema = z$1.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const headerSchema = z$1.object({
	name: z$1.string().min(1),
	value: z$1.string()
});
const envEntrySchema = z$1.discriminatedUnion("secret", [z$1.object({
	name: envVarNameSchema,
	secret: z$1.literal(false),
	value: z$1.string().default("")
}), z$1.object({
	name: envVarNameSchema,
	secret: z$1.literal(true),
	value: z$1.string().optional()
})]);
/** Durable sidecar record per server id. */
const mcpServersDomainSpec = defineDomain({
	name: "mcp_servers",
	version: 0,
	tables: { servers: domainTable(z$1.object({
		id: z$1.string().min(1).transform((value) => value),
		serverName: serverNameSchema,
		transport: z$1.union([z$1.literal("stdio"), z$1.literal("streamable-http")]),
		enabled: z$1.boolean(),
		command: z$1.string(),
		args: z$1.array(z$1.string()).default([]),
		cwd: z$1.string().default(""),
		url: z$1.string(),
		headers: z$1.array(headerSchema).default([]),
		env: z$1.array(envEntrySchema).default([]),
		toolCallTimeoutMs: positiveIntegerSchema,
		failOnStartupError: z$1.boolean().default(false)
	}).superRefine((row, ctx) => {
		if (row.transport === "stdio" && row.command.trim().length === 0) ctx.addIssue({
			code: "custom",
			path: ["command"],
			message: "stdio transport requires a command"
		});
		if (row.transport === "streamable-http") try {
			const parsed = new URL(row.url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("non-http protocol");
		} catch {
			ctx.addIssue({
				code: "custom",
				path: ["url"],
				message: "streamable-http requires an absolute http(s) URL"
			});
		}
		const headerNames = /* @__PURE__ */ new Set();
		row.headers.forEach((header, index) => {
			if (headerNames.has(header.name)) ctx.addIssue({
				code: "custom",
				path: [
					"headers",
					index,
					"name"
				],
				message: `duplicate header '${header.name}'`
			});
			headerNames.add(header.name);
		});
		const envNames = /* @__PURE__ */ new Set();
		row.env.forEach((entry, index) => {
			if (envNames.has(entry.name)) ctx.addIssue({
				code: "custom",
				path: [
					"env",
					index,
					"name"
				],
				message: `duplicate environment variable '${entry.name}'`
			});
			envNames.add(entry.name);
		});
	})) }
});
/** Thrown by {@link validateServerInput}; the service maps it to `MCP_INVALID_SPEC`. */
var McpServerValidationError = class extends Error {
	/** Discriminates validation failures from internal errors at the Remote boundary. */
	code = "MCP_INVALID_SPEC";
	/**
	* @param message - Human-readable reason safe to render in a management UI.
	*/
	constructor(message) {
		super(message);
		this.name = "McpServerValidationError";
	}
};
/**
* Validate one upsert/test request at the wire boundary.
* @param server - The submitted definition.
* @param env - The submitted env rows (including values to store).
* @throws {@link McpServerValidationError} with a readable reason.
*/
function validateServerInput(server, env) {
	if (!serverNameSchema.safeParse(server.serverName).success) throw new McpServerValidationError("serverName must match [A-Za-z0-9_-]{1,32}");
	if (server.transport === "stdio") {
		if (server.command.trim().length === 0) throw new McpServerValidationError("stdio transport requires a command");
		if (server.cwd.length > 0 && !/^[/\\]/.test(server.cwd)) throw new McpServerValidationError("cwd must be an absolute path or empty");
	} else try {
		const parsed = new URL(server.url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("non-http protocol");
	} catch {
		throw new McpServerValidationError("streamable-http requires an absolute http(s) URL");
	}
	if (!Number.isInteger(server.toolCallTimeoutMs) || server.toolCallTimeoutMs <= 0) throw new McpServerValidationError("toolCallTimeoutMs must be a positive integer");
	const headerNames = /* @__PURE__ */ new Set();
	for (const header of server.headers) {
		if (header.name.trim().length === 0) throw new McpServerValidationError("header names must not be blank");
		if (headerNames.has(header.name)) throw new McpServerValidationError(`duplicate header '${header.name}'`);
		headerNames.add(header.name);
	}
	const envNames = /* @__PURE__ */ new Set();
	for (const entry of env) {
		if (!envVarNameSchema.safeParse(entry.name).success) throw new McpServerValidationError(`environment variable name '${entry.name}' must be a POSIX identifier`);
		if (envNames.has(entry.name)) throw new McpServerValidationError(`duplicate environment variable '${entry.name}'`);
		envNames.add(entry.name);
	}
}
/**
* Build the durable row for one request, stripping secret values so they can
* only ever live in the credentials document.
* @param id - Server id (existing or freshly minted).
* @param server - The validated definition.
* @param env - The validated env rows.
* @returns The row to persist.
*/
function toServerRow(id, server, env) {
	return {
		id,
		serverName: server.serverName,
		transport: server.transport,
		enabled: server.enabled,
		command: server.command,
		args: [...server.args],
		cwd: server.cwd,
		url: server.url,
		headers: server.headers.map((header) => ({
			name: header.name,
			value: header.value
		})),
		env: env.map((entry) => entry.secret ? {
			name: entry.name,
			secret: true
		} : {
			name: entry.name,
			secret: false,
			value: entry.value ?? ""
		}),
		toolCallTimeoutMs: server.toolCallTimeoutMs,
		failOnStartupError: server.failOnStartupError
	};
}
//#endregion
//#region lib/types/index.js
/**
* MCP manager service: owns persisted MCP server definitions, mounts one
* `mcp-client` instance per enabled server at runtime, injects each server's
* environment variables (plain values from the definition, secrets from the
* credentials document) into its stdio child, and exposes list/upsert/remove/
* test to the browser through the `mcpManager` Remote namespace.
*
* Lifecycle: a definition change reconciles the live mount without a Host
* restart; a secret written through any surface restarts the affected server
* so the new value reaches the next spawned child.
* @module @deepseek-ai/dsh-mcp-manager
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Credential reference namespace prefix for secret env values. */
const SECRET_REF_PREFIX = "DSH_MCP_";
const Config = z.object({ probeTimeoutMs: z.number().min(1).default(15e3) });
/** The mcp-client plugin as a Cordis object plugin, mounted per server. */
const MCP_CLIENT_PLUGIN = {
	name: mcpClient.name,
	inject: mcpClient.inject,
	Config: mcpClient.Config,
	apply: mcpClient.apply
};
/** Keep a thrown value readable for Remote failures and logs. */
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The managed server id a credential reference belongs to, when the reference
* is one of this manager's secret env refs.
* @param ref - A credential reference.
* @returns the server id, or undefined when the ref is not managed.
*/
function managedServerId(ref) {
	if (!ref.startsWith(SECRET_REF_PREFIX)) return void 0;
	const rest = ref.slice(8);
	const separator = rest.lastIndexOf("_");
	if (separator <= 0) return void 0;
	return rest.slice(0, separator);
}
/** Credential reference holding one secret env value. */
function secretRef(id, name) {
	return credentialRef(`${SECRET_REF_PREFIX}${id}_${name}`);
}
/** Brand a fresh random server id at the minting boundary. */
function mintServerId(existing) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = `mcp_${randomBytes(6).toString("hex")}`;
		if (!existing.has(id)) return id;
	}
	throw new Error("mcp-manager: failed to mint a unique server id");
}
/**
* The managed MCP server registry, exposed to the browser as the `mcpManager`
* Remote namespace.
*/
let McpManagerService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _upsert_decorators;
	let _delete_decorators;
	let _test_decorators;
	let _toolsList_decorators;
	let _toolsSet_decorators;
	let _toolsMode_decorators;
	return class McpManagerService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_upsert_decorators = [Remote("upsert")];
			_delete_decorators = [Remote("delete")];
			_test_decorators = [Remote("test")];
			_toolsList_decorators = [Remote("toolsList")];
			_toolsSet_decorators = [Remote("toolsSet")];
			_toolsMode_decorators = [Remote("toolsMode")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _upsert_decorators, {
				kind: "method",
				name: "upsert",
				static: false,
				private: false,
				access: {
					has: (obj) => "upsert" in obj,
					get: (obj) => obj.upsert
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _delete_decorators, {
				kind: "method",
				name: "delete",
				static: false,
				private: false,
				access: {
					has: (obj) => "delete" in obj,
					get: (obj) => obj.delete
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _test_decorators, {
				kind: "method",
				name: "test",
				static: false,
				private: false,
				access: {
					has: (obj) => "test" in obj,
					get: (obj) => obj.test
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _toolsList_decorators, {
				kind: "method",
				name: "toolsList",
				static: false,
				private: false,
				access: {
					has: (obj) => "toolsList" in obj,
					get: (obj) => obj.toolsList
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _toolsSet_decorators, {
				kind: "method",
				name: "toolsSet",
				static: false,
				private: false,
				access: {
					has: (obj) => "toolsSet" in obj,
					get: (obj) => obj.toolsSet
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _toolsMode_decorators, {
				kind: "method",
				name: "toolsMode",
				static: false,
				private: false,
				access: {
					has: (obj) => "toolsMode" in obj,
					get: (obj) => obj.toolsMode
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"storageDomain",
			"credentials",
			"tools"
		];
		static Config = Config;
		table = __runInitializers(this, _instanceExtraInitializers);
		/** Live mcp-client mounts keyed by server id. */
		mounts = /* @__PURE__ */ new Map();
		/** Per-id operation chain serializing reconcile, remove, and restart jobs. */
		operationTails = /* @__PURE__ */ new Map();
		/** Server ids whose secret writes are this manager's own; skip restart echoes. */
		suppressRestart = /* @__PURE__ */ new Set();
		probeTimeoutMs;
		/** Per-tool enable switches: a stored `false` disables that tool; absent means enabled. */
		toolSwitches = /* @__PURE__ */ new Map();
		/** Injection mode: `search` (default) injects only resident + hot tools; `full` injects every enabled tool. */
		toolMode = "search";
		/** Recently searched or called MCP tools, LRU-bounded; injected under search mode. */
		hotTools = /* @__PURE__ */ new Map();
		/** LRU bound for {@link hotTools}. */
		static HOT_LIMIT = 60;
		/**
		* @param ctx - Host context carrying storage, credentials, and the tool registry.
		* @param config - Resolved manager configuration.
		*/
		constructor(ctx, config) {
			super(ctx, "mcpManager");
			this.probeTimeoutMs = config.probeTimeoutMs;
		}
		/** Open the storage domain, mount stored servers, and subscribe to secret changes. */
		async [Service.init]() {
			const domain = await this.ctx.storageDomain.open(mcpServersDomainSpec);
			this.ctx.effect(() => async () => {
				await this.teardownAll();
				await domain.close();
			}, "mcp-manager.domainClose");
			this.table = domain.table("servers");
			for (const [id, row] of this.table.entries()) if (row.enabled) this.mount(id, row);
			this.installToolControl();
			this.ctx.on("credentials/updated", (ref) => {
				const id = managedServerId(ref);
				if (id === void 0 || this.suppressRestart.has(id)) return;
				this.serialize(id, async () => {
					if (this.requireTable().get(id) !== void 0) await this.reconcileMount(id);
				});
			});
		}
		/** Queue one job on a server's own operation chain. */
		serialize(id, job) {
			const run = (this.operationTails.get(id) ?? Promise.resolve()).then(job);
			this.operationTails.set(id, run.then(() => {}, () => {}));
			return run;
		}
		/** Resolve the table after the domain is open; a missing table is a boot bug. */
		requireTable() {
			if (this.table === void 0) throw new Error("mcp-manager: storage domain is not open");
			return this.table;
		}
		/** Resolve the full env map for one row: plain values plus credentials. */
		async resolveEnv(row) {
			const env = {};
			for (const entry of row.env) if (entry.secret) {
				const hit = await this.ctx.credentials.resolve(secretRef(row.id, entry.name));
				if (hit !== void 0) env[entry.name] = hit.value;
			} else if (entry.value !== void 0) env[entry.name] = entry.value;
			return env;
		}
		/** Map a server spec + resolved env to the mcp-client plugin config. */
		toClientConfig(spec, env) {
			if (spec.transport === "stdio") return {
				transport: "stdio",
				serverName: spec.serverName,
				command: spec.command,
				args: [...spec.args],
				cwd: spec.cwd,
				env,
				toolCallTimeoutMs: spec.toolCallTimeoutMs,
				failOnStartupError: spec.failOnStartupError
			};
			return {
				transport: "streamable-http",
				serverName: spec.serverName,
				url: spec.url,
				headers: Object.fromEntries(spec.headers.map((header) => [header.name, header.value])),
				toolCallTimeoutMs: spec.toolCallTimeoutMs,
				failOnStartupError: spec.failOnStartupError
			};
		}
		/**
		* Mount one server's mcp-client instance without awaiting activation, so a
		* hung server cannot block a Remote call. The mount entry's phase flips via
		* the fiber settlement callbacks.
		* @param id - Server id.
		* @param row - The stored definition.
		*/
		mount(id, row) {
			this.serialize(id, async () => {
				await this.disposeMount(id);
				const entry = {
					phase: "mounting",
					error: void 0
				};
				this.mounts.set(id, entry);
				let handle;
				try {
					const env = await this.resolveEnv(row);
					handle = this.ctx.plugin(MCP_CLIENT_PLUGIN, this.toClientConfig(row, env));
				} catch (error) {
					entry.phase = "failed";
					entry.error = errorText(error);
					this.ctx.logger.error(`mcp-manager(${id}): mount failed: ${entry.error}`);
					return;
				}
				entry.handle = handle;
				handle.await().then(() => {
					entry.phase = "live";
					entry.error = void 0;
				}, (error) => {
					entry.phase = "failed";
					entry.error = errorText(error);
					this.ctx.logger.error(`mcp-manager(${id}): mount failed: ${entry.error}`);
				});
			});
		}
		/** Stop and forget one live mount. */
		async disposeMount(id) {
			const entry = this.mounts.get(id);
			if (entry === void 0) return;
			this.mounts.delete(id);
			if (entry.handle !== void 0) await entry.handle.dispose();
		}
		/** Dispose every live mount (domain teardown). */
		async teardownAll() {
			const ids = [...this.mounts.keys()];
			for (const id of ids) await this.disposeMount(id);
		}
		/** Stop the current mount and start one from the stored row, when enabled. */
		async reconcileMount(id) {
			const row = this.requireTable().get(id);
			if (row === void 0 || !row.enabled) {
				await this.disposeMount(id);
				return;
			}
			await this.disposeMount(id);
			this.mount(id, row);
		}
		/** Build the client-facing projection of one stored row. */
		async view(id, row) {
			const mount = this.mounts.get(id);
			const prefix = `mcp__${row.serverName}__`;
			const tools = this.ctx.tools.schemas().map((schema) => schema.name).filter((name) => name.startsWith(prefix));
			const env = [];
			for (const entry of row.env) {
				const configured = entry.secret ? (await this.ctx.credentials.describe(secretRef(id, entry.name))).configured : (entry.value ?? "").length > 0;
				env.push({
					name: entry.name,
					secret: entry.secret,
					configured
				});
			}
			return {
				id,
				serverName: row.serverName,
				transport: row.transport,
				enabled: row.enabled,
				command: row.command,
				args: [...row.args],
				cwd: row.cwd,
				url: row.url,
				headers: row.headers.map((header) => ({
					name: header.name,
					value: header.value
				})),
				env,
				toolCallTimeoutMs: row.toolCallTimeoutMs,
				failOnStartupError: row.failOnStartupError,
				status: {
					phase: mount?.phase ?? "stopped",
					tools,
					...mount?.error === void 0 ? {} : { error: mount.error }
				}
			};
		}
		/** A not-found failure for one id. */
		notFound(id) {
			return {
				code: "MCP_SERVER_NOT_FOUND",
				message: `no managed MCP server with id "${id}"`
			};
		}
		/**
		* Read every stored definition with its live status.
		* @returns the current server list.
		*/
		async list() {
			const table = this.requireTable();
			const servers = [];
			for (const [id, row] of table.entries()) servers.push(await this.view(id, row));
			return {
				ok: true,
				servers
			};
		}
		/**
		* Create or replace one server definition and reconcile its live mount.
		* Secret env values are written to the credentials document; a secret entry
		* with no submitted value keeps the stored one.
		* @param request - Server id (existing) or absent (create) plus the definition and env rows.
		* @returns the updated server view or an explicit failure.
		*/
		async upsert(request) {
			const table = this.requireTable();
			try {
				validateServerInput(request.server, request.env);
			} catch (error) {
				if (error instanceof McpServerValidationError) return {
					ok: false,
					error: {
						code: "MCP_INVALID_SPEC",
						message: error.message
					}
				};
				throw error;
			}
			if (request.id !== void 0 && table.get(request.id) === void 0) return {
				ok: false,
				error: this.notFound(request.id)
			};
			const id = request.id ?? mintServerId(new Set(table.keys()));
			for (const [otherId, row] of table.entries()) if (otherId !== id && row.serverName === request.server.serverName) return {
				ok: false,
				error: {
					code: "MCP_SERVER_NAME_CONFLICT",
					message: `serverName "${request.server.serverName}" is already used by another managed server`
				}
			};
			const previous = table.get(id);
			await this.applyEnv(id, previous, request.env);
			const row = toServerRow(id, request.server, request.env);
			await table.put(id, row);
			await this.serialize(id, () => this.reconcileMount(id));
			return {
				ok: true,
				server: await this.view(id, row)
			};
		}
		/**
		* Persist env values for one server: set new secret values (suppressing the
		* restart echo of our own writes), unset secrets whose rows were removed.
		* @param id - Server id.
		* @param previous - Previously stored row, when one exists.
		* @param inputs - The submitted env rows.
		*/
		async applyEnv(id, previous, inputs) {
			const previousSecrets = new Set((previous?.env ?? []).filter((entry) => entry.secret).map((entry) => entry.name));
			const currentSecrets = new Set(inputs.filter((entry) => entry.secret).map((entry) => entry.name));
			for (const name of previousSecrets) if (!currentSecrets.has(name)) await this.ctx.credentials.unset(secretRef(id, name));
			this.suppressRestart.add(id);
			try {
				for (const entry of inputs) {
					if (!entry.secret || entry.value === void 0 || entry.value.length === 0) continue;
					await this.ctx.credentials.set(secretRef(id, entry.name), entry.value);
				}
			} finally {
				this.suppressRestart.delete(id);
			}
		}
		/**
		* Delete one server definition, stop its mount, and unset its secret refs.
		* Named `delete` (wire `mcpManager/delete`): the Remote namespace service
		* base class already owns a `remove` method for uninstalling methods, so a
		* Remote method named `remove` conflicts with it.
		* @param request - Server id to remove.
		* @returns success, or not-found when the id is unknown.
		*/
		async delete(request) {
			const table = this.requireTable();
			const row = table.get(request.id);
			if (row === void 0) return {
				ok: false,
				error: this.notFound(request.id)
			};
			await this.serialize(request.id, async () => {
				await this.disposeMount(request.id);
				await table.delete(request.id);
			});
			for (const entry of row.env) if (entry.secret) await this.ctx.credentials.unset(secretRef(request.id, entry.name));
			return { ok: true };
		}
		/**
		* Probe one server configuration without persisting or mounting anything.
		* Secret env values resolve from the submitted values, or from the stored
		* credentials when the request carries an existing server id.
		* @param request - The definition, env rows, and optional existing id.
		* @returns the probe outcome and elapsed time; probing a broken server is a
		* successful test call carrying a failure view.
		*/
		async test(request) {
			try {
				validateServerInput(request.server, request.env);
			} catch (error) {
				if (error instanceof McpServerValidationError) return {
					ok: true,
					probe: {
						ok: false,
						message: error.message
					},
					elapsedMs: 0
				};
				throw error;
			}
			const env = {};
			for (const entry of request.env) if (entry.secret) {
				if (entry.value !== void 0 && entry.value.length > 0) env[entry.name] = entry.value;
				else if (request.id !== void 0) {
					const hit = await this.ctx.credentials.resolve(secretRef(request.id, entry.name));
					if (hit !== void 0) env[entry.name] = hit.value;
				}
			} else if (entry.value !== void 0) env[entry.name] = entry.value;
			const startedAt = Date.now();
			const probe = await probeConnection(this.toClientConfig(request.server, env), { timeoutMs: this.probeTimeoutMs });
			const elapsedMs = Date.now() - startedAt;
			return {
				ok: true,
				probe: probe.ok ? {
					ok: true,
					tools: probe.tools
				} : {
					ok: false,
					message: probe.message
				},
				elapsedMs
			};
		}
		/** Server namespace of one `mcp__<server>__<tool>` public name. */
		serverOf(name) {
			const rest = name.slice(5);
			const i = rest.indexOf("__");
			return i < 0 ? rest : rest.slice(0, i);
		}
		/** Every registered MCP tool schema (global view). */
		toolSnapshot() {
			return this.ctx.tools.schemas().filter((tool) => tool.name.startsWith("mcp__"));
		}
		/** Record one tool as hot (most-recently-used), LRU-bounded. */
		touchHot(name) {
			this.hotTools.delete(name);
			this.hotTools.set(name, Date.now());
			while (this.hotTools.size > McpManagerService.HOT_LIMIT) {
				const oldest = this.hotTools.keys().next().value;
				if (oldest === void 0) break;
				this.hotTools.delete(oldest);
			}
		}
		/** Keyword score of one tool against query tokens: server name +2, tool name +3, description +1. */
		score(tokens, name, description) {
			const lowerName = name.toLowerCase();
			const hay = `${name} ${description ?? ""}`.toLowerCase();
			const server = this.serverOf(name);
			let s = 0;
			for (const token of tokens) {
				if (server.includes(token)) s += 2;
				else if (lowerName.includes(token)) s += 3;
				else if (hay.includes(token)) s += 1;
			}
			return s;
		}
		/**
		* Register the `mcp_tool_search` model tool and the injection-layer
		* hooks: per-tool disable filtering plus search-mode hot-tool injection,
		* both inside the `system-prompt/assemble` waterfall (no agent-loop
		* change), and hot-set tracking on real tool calls.
		*/
		installToolControl() {
			this.ctx.tools.register({
				name: "mcp_tool_search",
				description: "按关键词检索当前启用的 MCP 工具，返回匹配工具的名称/描述/参数 schema，并将命中的工具加入热注入集（下一轮模型请求即可直接调用）。需要某个 MCP 工具但不知道确切名称时使用。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "检索关键词，如 gitlab merge request、feishu 文档、hive 表等" },
						limit: { type: "number", description: "最多返回条数，默认 8，最大 20" }
					},
					required: ["query"],
					additionalProperties: false
				},
				output: {
					schema: {
						type: "object",
						properties: { content: { type: "array", items: {} } },
						required: ["content"],
						additionalProperties: false
					},
					render(_args, value) {
						const content = value && Array.isArray(value.content) ? value.content : [];
						return [{ type: "text", text: content.map((block) => block.text ?? "").join("\n") || "(no results)" }];
					}
				},
				execute: async (args) => {
					const q = String(args?.query ?? "").toLowerCase();
					const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 20);
					const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
					const pool = this.toolSnapshot().filter((tool) => this.toolSwitches.get(tool.name) !== false);
					const picked = tokens.length > 0
						? pool
							.map((tool) => ({ tool, s: this.score(tokens, tool.name, tool.description) }))
							.filter((entry) => entry.s > 0)
							.sort((a, b) => b.s - a.s)
							.slice(0, limit)
							.map((entry) => entry.tool)
						: pool.slice(0, limit);
					for (const tool of picked) this.touchHot(tool.name);
					const lines = picked.map((tool) => JSON.stringify({
						name: tool.name,
						description: String(tool.description ?? "").slice(0, 220),
						parameters: tool.parameters
					}));
					return {
						content: [{
							type: "text",
							text: lines.length > 0
								? "匹配 MCP 工具（已热启用，下一轮可直接调用）：\n" + lines.join("\n")
								: "未找到匹配的 MCP 工具，可换关键词重试。"
						}]
					};
				}
			});
			this.ctx.on("system-prompt/assemble", (assembly, _context, next) => {
				const kept = [];
				const mcpByName = {};
				for (const tool of assembly.tools) {
					if (!tool.name.startsWith("mcp__")) {
						kept.push(tool);
						continue;
					}
					if (this.toolSwitches.get(tool.name) === false) continue;
					mcpByName[tool.name] = tool;
					if (this.toolMode !== "search") kept.push(tool);
				}
				if (this.toolMode === "search") {
					for (const name of this.hotTools.keys()) {
						const tool = mcpByName[name];
						if (tool) kept.push(tool);
					}
					const servers = [...new Set(Object.keys(mcpByName).map((name) => this.serverOf(name)))].sort();
					assembly.sections = (assembly.sections || []).filter((section) => section.name !== "mcp-tool-control");
					assembly.sections.push({
						name: "mcp-tool-control",
						text: "MCP 工具按需可用：需要某个 MCP 工具时先调用 mcp_tool_search(query) 检索，命中后该工具会自动注入当前对话；当前可用 MCP 服务器：" + (servers.join(", ") || "(无)") + "。"
					});
				}
				assembly.tools = kept;
				return next();
			});
			this.ctx.on("tools/result", (exec) => {
				if (exec && typeof exec.name === "string" && exec.name.startsWith("mcp__")) this.touchHot(exec.name);
			});
		}
		/**
		* Read every registered MCP tool with its enable switch and the current
		* injection mode / hot-set size, for the Settings page.
		* @returns the tool-control state.
		*/
		async toolsList() {
			const tools = this.toolSnapshot().map((tool) => ({
				name: tool.name,
				server: this.serverOf(tool.name),
				description: String(tool.description ?? "").slice(0, 140),
				enabled: this.toolSwitches.get(tool.name) !== false
			}));
			return {
				ok: true,
				tools,
				mode: this.toolMode,
				hotSize: this.hotTools.size
			};
		}
		/**
		* Set the enable switch of one MCP tool.
		* @param request - Tool name plus the desired enabled state.
		* @returns success or a failure.
		*/
		async toolsSet(request) {
			if (typeof request?.name !== "string" || !request.name.startsWith("mcp__")) {
				return {
					ok: false,
					error: {
						code: "MCP_TOOL_NOT_FOUND",
						message: `invalid MCP tool name "${String(request?.name ?? "")}"`
					}
				};
			}
			this.toolSwitches.set(request.name, request.enabled === true);
			return { ok: true };
		}
		/**
		* Switch the injection mode between `full` (every enabled tool per
		* request) and `search` (resident + hot tools only). Switching clears
		* the hot set.
		* @param request - The mode to apply.
		* @returns the applied mode, or a failure.
		*/
		async toolsMode(request) {
			const mode = request?.mode;
			if (mode !== "full" && mode !== "search") {
				return {
					ok: false,
					error: {
						code: "MCP_TOOL_INVALID_MODE",
						message: "mode must be full|search"
					}
				};
			}
			this.toolMode = mode;
			this.hotTools.clear();
			return { ok: true, mode };
		}
	};
})();
//#endregion
export { Config, McpManagerService, McpManagerService as default };
