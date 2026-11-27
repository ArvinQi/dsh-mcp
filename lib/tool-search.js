/**
 * Keyword matching for `mcp_tool_search`, kept dependency-free on purpose:
 * `lib/index.js` imports `@deepseek-ai/*` and therefore cannot be unit-tested
 * outside a DSH installation, while the matching rules are exactly what needs
 * tests (Chinese queries, server scoping, alias keywords).
 *
 * Why not the obvious `split(/\W+/)`: a Chinese query has no spaces, so
 * `提交代码` used to become one token that could only match a literal
 * substring of an English tool description — i.e. never. CJK runs are
 * expanded into overlapping bigrams instead, which degrades gracefully for
 * Chinese descriptions and still works for a phrase like `飞书 文档`.
 * @module dsh-mcp/tool-search
 */

/**
 * Split a query into matchable tokens.
 *
 * Latin/digit runs stay whole. A CJK run is kept whole *and* expanded into
 * overlapping bigrams, so `提交代码` matches `提交` and `代码` independently.
 *
 * @param {string} query - the model's raw query.
 * @returns {string[]} distinct, lowercased tokens (empty for a blank query).
 */
export function tokenizeQuery(query) {
	const text = String(query ?? "").toLowerCase();
	if (text.trim().length === 0) return [];
	const seen = new Set();
	const tokens = [];
	const push = (token) => {
		if (token.length === 0 || seen.has(token)) return;
		seen.add(token);
		tokens.push(token);
	};
	for (const run of text.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/)) {
		if (run.length === 0) continue;
		if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(run)) {
			push(run);
			continue;
		}
		push(run);
		for (let index = 0; index + 1 < run.length; index += 1) push(run.slice(index, index + 2));
	}
	return tokens;
}

/**
 * Score one tool against the tokens.
 *
 * Precedence mirrors how a person would judge a hit: the server name answers
 * "which system", the tool name answers "which action", the description and
 * the operator's own aliases answer everything else. Aliases are the escape
 * hatch for Chinese habits over English tool names.
 *
 * @param {string[]} tokens - output of {@link tokenizeQuery}.
 * @param {{ name: string, server?: string, description?: string, aliases?: readonly string[] }} entry - one tool.
 * @returns {number} 0 when nothing matched; higher is better.
 */
export function scoreTool(tokens, entry) {
	const name = String(entry?.name ?? "").toLowerCase();
	const server = String(entry?.server ?? "").toLowerCase();
	const description = String(entry?.description ?? "").toLowerCase();
	const aliases = (entry?.aliases ?? []).join(" ").toLowerCase();
	const haystack = `${name} ${description} ${aliases}`;
	let score = 0;
	for (const token of tokens) {
		if (server.length > 0 && server.includes(token)) score += 2;
		else if (name.includes(token)) score += 3;
		else if (haystack.includes(token)) score += 1;
	}
	return score;
}

/**
 * Rank a pool of tools, dropping non-matches and returning the best `limit`.
 *
 * Ties keep pool order, so a canonical registration order produces a stable
 * result (prompt-cache friendly and reproducible in tests).
 *
 * @param {readonly object[]} pool - tools with `name` plus optional description.
 * @param {string} query - raw model query.
 * @param {{ limit?: number, server?: string, serverOf?: (name: string) => string, aliasesOf?: (server: string) => readonly string[] }} [options] -
 *   `server` restricts the pool before scoring; `serverOf`/`aliasesOf`
 *   project those fields for scoring.
 * @returns {object[]} ranked tools.
 */
export function rankTools(pool, query, options = {}) {
	const { limit = 8, server, serverOf, aliasesOf } = options;
	const tokens = tokenizeQuery(query);
	const scoped = server === undefined || server.length === 0
		? pool
		: pool.filter((tool) => (serverOf ? serverOf(tool.name) : String(tool.server ?? "")) === server);
	if (tokens.length === 0) return scoped.slice(0, limit);
	const scored = [];
	for (const tool of scoped) {
		const serverName = serverOf ? serverOf(tool.name) : String(tool.server ?? "");
		const score = scoreTool(tokens, {
			name: tool.name,
			server: serverName,
			description: tool.description,
			aliases: aliasesOf ? aliasesOf(serverName) : undefined,
		});
		if (score > 0) scored.push({ tool, score });
	}
	scored.sort((left, right) => right.score - left.score);
	return scored.slice(0, limit).map((entry) => entry.tool);
}
