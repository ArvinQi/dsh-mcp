import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bridgePath = new URL("../lib/mcp-client.js", import.meta.url);

async function loadImageProjection() {
	const source = await readFile(bridgePath, "utf8");
	const toolsEnd = source.search(/\/\/#endregion\r?\n\/\/#region lib\/types\/connection\.js/);
	assert.notEqual(toolsEnd, -1, "mcp-client tools module boundary must exist");
	const toolsRegion = source.slice(0, toolsEnd);
	const executable = toolsRegion.replace(/^import .*;\r?\n/gm, "");
	const factory = new Function("Buffer", "isImageAdmissionError", `
		const z$1 = { record: () => null, string: () => null, unknown: () => null };
		const z = {};
		const MAX_TIMER_DELAY_MS = 0;
		const assertSupportedJsonSchema = () => {};
		${executable}
		return { decodeImage, prepareImageProjection, projectContent };
	`);
	return factory(Buffer, () => false);
}

function createExec() {
	return {
		signal: new AbortController().signal,
		agent: {
			session: {
				requestHeader() {
					return { config: { provider: "test-provider", model: "vision-model" } };
				}
			},
			options: {}
		}
	};
}

test("projects admitted MCP images between adjacent text blocks", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const attachments = {
		async saveImages(images) {
			assert.equal(images.length, 1);
			assert.equal(images[0].mediaType, "image/png");
			return ["attachment-1"];
		}
	};
	const ctx = {
		get(name) {
			if (name === "attachments") return attachments;
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) };
			return undefined;
		}
	};
	const output = await prepareImageProjection(ctx, createExec(), [
		{ type: "text", text: "before" },
		{ type: "image", mimeType: "image/png", data: "AQ==" },
		{ type: "text", text: "after" }
	], "camera");
	assert.deepEqual(output, [
		{ type: "text", text: "before" },
		{ type: "image", attachment: "attachment-1" },
		{ type: "text", text: "after" }
	]);
});

test("keeps invalid image data out of projected text", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const output = await prepareImageProjection({ get: () => undefined }, createExec(), [
		{ type: "image", mimeType: "image/png", data: "not base64" }
	], "camera");
	assert.equal(output.length, 1);
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /image data is not canonical base64/);
	assert.doesNotMatch(output[0].text, /not base64/);
});

test("uses a diagnostic fallback when the routed model is not image-capable", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const ctx = {
		get(name) {
			if (name === "attachments") return { saveImages: async () => ["unexpected"] };
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
			return undefined;
		}
	};
	const output = await prepareImageProjection(ctx, createExec(), [
		{ type: "image", mimeType: "image/png", data: "AQ==" }
	], "camera");
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /does not declare image input/);
	assert.doesNotMatch(output[0].text, /AQ==/);
});
