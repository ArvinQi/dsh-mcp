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
	toolSearchDesc: "按关键词检索当前启用的 MCP 工具，返回匹配工具的名称/描述/参数 schema，并将命中的工具加入热注入集（下一轮模型请求即可直接调用）。需要某个 MCP 工具但不知道确切名称时使用。",
	toolSearchQuery: "检索关键词，如 gitlab merge request、feishu 文档、hive 表等",
	toolSearchLimit: "最多返回条数，默认 8，最大 20",
	searchHit: "匹配 MCP 工具（已热启用，下一轮可直接调用）：\n{lines}",
	searchMiss: "未找到匹配的 MCP 工具，可换关键词重试。",
	toolControlPrompt: "MCP 工具按需可用：需要某个 MCP 工具时先调用 mcp_tool_search(query) 检索，命中后该工具会自动注入当前对话；当前可用 MCP 服务器：{servers}。",
	noServers: "(无)",
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
	toolSearchDesc: "Search the enabled MCP tools by keyword and return matching tool names/descriptions/parameter schemas; matches are hot-injected for the next model request. Use when you need an MCP tool but do not know its exact name.",
	toolSearchQuery: "Search keywords, e.g. gitlab merge request, feishu document, hive table",
	toolSearchLimit: "Maximum number of results; default 8, max 20",
	searchHit: "Matching MCP tools (hot-enabled, callable in the next request):\n{lines}",
	searchMiss: "No matching MCP tools found; try different keywords.",
	toolControlPrompt: "MCP tools are available on demand: when you need an MCP tool, first call mcp_tool_search(query); a hit is hot-injected into the current conversation. Enabled MCP servers: {servers}.",
	noServers: "(none)",
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
