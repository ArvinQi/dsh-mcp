/**
 * `mcp_tool_search` matching rules.
 *
 * The regression these lock down: a Chinese query has no spaces, so plain
 * `split(/\W+/)` produced one token that could never match an English tool
 * description — the model "searched" and got nothing. CJK bigrams plus
 * operator aliases are what make a Chinese habit find an English tool.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rankTools, scoreTool, tokenizeQuery } from "../lib/tool-search.js";

/** A small pool shaped like the Host's tool snapshot. */
const POOL = [
	{
		name: "mcp__gitlab-mcp__create_merge_request",
		description: "Create a merge request in a GitLab project",
		parameters: { type: "object" },
	},
	{
		name: "mcp__gitlab-mcp__list_pipelines",
		description: "List CI pipelines of a project",
		parameters: { type: "object" },
	},
	{
		name: "mcp__feishu-mcp__fetch-doc",
		description: "读取飞书文档正文",
		parameters: { type: "object" },
	},
];

const serverOf = (name) => name.slice(5, name.indexOf("__", 5));

test("a Chinese phrase is split into bigrams instead of one opaque token", () => {
	const tokens = tokenizeQuery("提交代码");
	assert.ok(tokens.includes("提交"), "the bigram 提交 must be searchable");
	assert.ok(tokens.includes("代码"), "the bigram 代码 must be searchable");
});

test("latin queries keep whole words and drop punctuation", () => {
	assert.deepEqual(tokenizeQuery("gitlab, merge-request!"), ["gitlab", "merge", "request"]);
	assert.deepEqual(tokenizeQuery("   "), []);
});

test("a Chinese description matches a Chinese query", () => {
	const tokens = tokenizeQuery("飞书文档");
	assert.ok(scoreTool(tokens, {
		name: "mcp__feishu-mcp__fetch-doc",
		server: "feishu-mcp",
		description: "读取飞书文档正文",
	}) > 0);
});

test("aliases make a Chinese habit find an English tool", () => {
	const tokens = tokenizeQuery("提交");
	assert.equal(scoreTool(tokens, {
		name: "mcp__gitlab-mcp__create_merge_request",
		server: "gitlab-mcp",
		description: "Create a merge request in a GitLab project",
	}), 0, "without aliases an English description does not match");
	assert.ok(scoreTool(tokens, {
		name: "mcp__gitlab-mcp__create_merge_request",
		server: "gitlab-mcp",
		description: "Create a merge request in a GitLab project",
		aliases: ["提交", "MR"],
	}) > 0, "an operator alias supplies the missing vocabulary");
});

test("rankTools scopes to one server before scoring", () => {
	const ranked = rankTools(POOL, "pipeline", { serverOf });
	assert.deepEqual(ranked.map((tool) => tool.name), ["mcp__gitlab-mcp__list_pipelines"]);
	const scopedOut = rankTools(POOL, "pipeline", { serverOf, server: "feishu-mcp" });
	assert.deepEqual(scopedOut, [], "a server scope that cannot match returns nothing");
});

test("rankTools honours the limit and keeps pool order on ties", () => {
	const many = Array.from({ length: 30 }, (_, index) => ({
		name: `mcp__srv__tool_${String(index).padStart(2, "0")}`,
		description: "shared keyword",
	}));
	const ranked = rankTools(many, "shared", { limit: 5, serverOf: () => "srv" });
	assert.equal(ranked.length, 5);
	assert.deepEqual(ranked.map((tool) => tool.name), many.slice(0, 5).map((tool) => tool.name));
});

test("rankTools returns nothing when no token matches", () => {
	assert.deepEqual(rankTools(POOL, "nonexistent-phrase", { serverOf }), []);
});
