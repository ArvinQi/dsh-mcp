/**
 * Host-side copy for dsh-mcp: the strings the Host renders for operators and
 * the model. The settings UI already routes every client string through the
 * browser locale service (`src/client/locales.ts`); this module gives the
 * host half the same zh/en split, resolved from the same DSH settings
 * document (`locale.preference`), so an English deployment reads English end
 * to end — including the model-facing `mcp_tool_search` description, its
 * search-result text, and the injected `mcp-tool-control` system prompt.
 *
 * Lookup is template-based: `{name}` placeholders are substituted from the
 * caller's vars object. Unknown keys and any settings-read failure fall back
 * to Simplified Chinese, which matches the pre-i18n behavior.
 * @module
 */

/** Simplified Chinese host dictionary (source of truth). */
const zh = {
	// lib/index.js — model-facing copy.
	toolSearchDesc: "检索当前启用的 MCP 工具：给出关键词返回匹配工具的名称/描述/参数 schema，并把命中项加入热注入集（下一轮可直接调用）；只给 server 可只看某台服务器的工具；list=true 或不给 query 时按服务器列出工具清单（只有名称+一行描述，省 token）。需要某个 MCP 工具但不知道确切名称时使用。",
	toolSearchQuery: "检索关键词，如 gitlab merge request、feishu 文档、hive 表、提交/评审（服务器别名也算命中）",
	toolSearchServer: "只在这台服务器里找（serverName，如 gitlab-mcp）；省略表示全部",
	toolSearchList: "true 时列出工具清单而非按关键词打分，常与 server 搭配",
	toolSearchLimit: "最多返回条数，默认 8；检索最大 20，清单最大 60",
	searchHit: "匹配 MCP 工具（已热启用，下一轮可直接调用）：\n{lines}",
	searchMiss: "未找到匹配的 MCP 工具，可换关键词重试。",
	searchList: "共 {count} 个 MCP 工具（可用 server 参数只看一台；参数 schema 需按名称检索后返回）：\n{lines}",
	searchAliasHint: "（{servers} 的命中来自服务器别名：要看该服务器的完整工具清单，用 list=true 加 server 参数。）",
	toolControlPrompt: "MCP 工具按需可用：需要某个 MCP 工具时先调用 mcp_tool_search(query) 检索，命中后该工具会自动注入当前对话；当前可用 MCP 服务器：{servers}。",
	noServers: "(无)",
	commandDesc: "查看 MCP 状态，或快速启停服务器 / 切换注入模式 / 固定常用工具",
	commandHint: "status | on <server> | off <server> | mode search|full | pin <tool 或 server> | unpin <tool 或 server>",
	commandUsage: "用法：/mcp · /mcp on|off <server> · /mcp mode search|full · /mcp pin|unpin <mcp__server__tool 或 server>",
	commandStatus: "MCP · {mode} 模式 · {servers} 台服务器 / {tools} 个工具 · 固定 {pinned}\n{lines}",
	commandLive: "已连接 · {count} 个工具",
	commandIdle: "已启用，未挂载",
	commandOff: "已停用",
	commandMode: "注入模式已切换为 {mode}。",
	commandOn: "已启用 {server}。",
	commandOffDone: "已停用 {server}。",
	commandNoServer: "没有名为 {server} 的受管服务器。",
	commandNoTool: "没找到 {target} 对应的工具。",
	commandPinned: "已固定 {count} 个工具（共 {total} 个）。",
	commandUnpinned: "已取消固定 {count} 个工具（剩余 {total} 个）。",
	// lib/oauth.js — operator-facing OAuth copy.
	oauthNeedLink: "服务器 \"{serverId}\" 需要 OAuth 授权，请在浏览器打开以下链接完成授权后重试（也可在 Settings → MCP 点击「测试连接」）：\n{url}",
	oauthFailPage: "授权失败：{error}，可关闭此页面并返回 DSH。",
	oauthOkPage: "授权成功，可关闭此页面并返回 DSH。",
	oauthExchangeFail: "OAuth 授权失败：{error}",
	// lib/mcp-client.js — operator-facing tool-call copy.
	oauthToolLink: "服务器 \"{serverName}\" 需要 OAuth 授权，请在浏览器打开以下链接完成授权后重试：\n{url}",
	oauthToolFallback: "服务器 \"{serverName}\" 需要 OAuth 授权：请在 Settings → MCP 编辑该服务器并点击「测试连接」完成授权后重试",
};

/** English host dictionary; every zh key must exist here. */
const en = {
	toolSearchDesc: "Search the enabled MCP tools: with a query, return matching tool names/descriptions/parameter schemas and hot-inject the matches for the next model request; with only a server, search that server; with list=true (or no query) list tools per server as name + one-line description (cheap). Use when you need an MCP tool but do not know its exact name.",
	toolSearchQuery: "Search keywords, e.g. gitlab merge request, feishu document, hive table, submit/review (server aliases count too)",
	toolSearchServer: "Restrict to one server (serverName, e.g. gitlab-mcp); omit for all",
	toolSearchList: "true lists tools instead of scoring keywords; useful with server",
	toolSearchLimit: "Maximum number of results; default 8 (search max 20, list max 60)",
	searchHit: "Matching MCP tools (hot-enabled, callable in the next request):\n{lines}",
	searchMiss: "No matching MCP tools found; try different keywords.",
	searchList: "{count} MCP tools (pass server to narrow; parameter schemas come from a name search):\n{lines}",
	searchAliasHint: "({servers} matched through a server alias: use list=true with server to see that server's full tool list.)",
	toolControlPrompt: "MCP tools are available on demand: when you need an MCP tool, first call mcp_tool_search(query); a hit is hot-injected into the current conversation. Enabled MCP servers: {servers}.",
	noServers: "(none)",
	commandDesc: "Show MCP status, or quickly toggle servers / injection mode / pinned tools",
	commandHint: "status | on <server> | off <server> | mode search|full | pin <tool or server> | unpin <tool or server>",
	commandUsage: "Usage: /mcp · /mcp on|off <server> · /mcp mode search|full · /mcp pin|unpin <mcp__server__tool or server>",
	commandStatus: "MCP · {mode} mode · {servers} servers / {tools} tools · {pinned} pinned\n{lines}",
	commandLive: "connected · {count} tools",
	commandIdle: "enabled, not mounted",
	commandOff: "disabled",
	commandMode: "Injection mode is now {mode}.",
	commandOn: "Enabled {server}.",
	commandOffDone: "Disabled {server}.",
	commandNoServer: "No managed server named {server}.",
	commandNoTool: "No tool matches {target}.",
	commandPinned: "Pinned {count} tool(s) ({total} total).",
	commandUnpinned: "Unpinned {count} tool(s) ({total} left).",
	oauthNeedLink: "Server \"{serverId}\" requires OAuth authorization — open the link below to authorize and retry (or edit the server in Settings → MCP and click \"Test connection\"):\n{url}",
	oauthFailPage: "Authorization failed: {error}. You can close this page and return to DSH.",
	oauthOkPage: "Authorization succeeded. You can close this page and return to DSH.",
	oauthExchangeFail: "OAuth authorization failed: {error}",
	oauthToolLink: "Server \"{serverName}\" requires OAuth authorization — open the link below to authorize and retry:\n{url}",
	oauthToolFallback: "Server \"{serverName}\" requires OAuth authorization: edit the server in Settings → MCP and click \"Test connection\" to complete authorization",
};

/** Key table of every host copy key. */
const KEYS = Object.keys(zh);

/**
 * Substitute `{name}` placeholders with the given vars.
 * @param template - template text containing `{name}` tokens.
 * @param vars - placeholder values; unknown tokens are left verbatim.
 * @returns the rendered string.
 */
function render(template, vars) {
	if (!vars) return template;
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
		const value = vars[name];
		return value === void 0 || value === null ? match : String(value);
	});
}

/**
 * Resolve the DSH locale preference from the Host settings document.
 * @param ctx - optional Host context whose `settings` service owns the
 *   `locale` section; when absent or unreadable, falls back to zh.
 * @returns `'zh'` or `'en'`.
 */
export function hostLocale(ctx) {
	try {
		const settings = ctx && typeof ctx.get === "function" ? ctx.get("settings") : void 0;
		if (settings && typeof settings.get === "function") {
			const section = settings.get("locale");
			const preference = section && typeof section === "object" ? section.preference : void 0;
			if (preference === "en" || preference === "zh") return preference;
		}
	} catch {
		// settings unavailable (tests, headless, provider detached): keep zh.
	}
	return "zh";
}

/**
 * Render one host copy string for the current DSH locale.
 * @param ctx - Host context used to resolve the locale preference.
 * @param key - copy key (see KEYS).
 * @param vars - optional `{name}` placeholder values.
 * @returns the localized string; unknown keys fall back to the zh template.
 */
export function hostText(ctx, key, vars) {
	const locale = hostLocale(ctx);
	const table = locale === "en" ? en : zh;
	const template = table[key] ?? zh[key] ?? "";
	return render(template, vars);
}

export { en, zh };
export const __hostLocaleKeys = KEYS;
