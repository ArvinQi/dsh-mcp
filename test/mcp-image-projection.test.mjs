import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

const bridgePath = new URL("../lib/mcp-client.js", import.meta.url);

async function loadImageProjection() {
	const source = await readFile(bridgePath, "utf8");
	const toolsEnd = source.search(/\/\/#endregion\r?\n\/\/#region lib\/types\/connection\.js/);
	assert.notEqual(toolsEnd, -1, "mcp-client tools module boundary must exist");
	const toolsRegion = source.slice(0, toolsEnd);
	const executable = toolsRegion.replace(/^import .*;\r?\n/gm, "");
	const factory = new Function("Buffer", "isImageAdmissionError", "isDeepStrictEqual", `
		const z$1 = { record: () => null, string: () => null, unknown: () => null };
		const z = {};
		const MAX_TIMER_DELAY_MS = 0;
		const assertSupportedJsonSchema = () => {};
		${executable}
		return { createDefinition, decodeImage, prepareImageProjection, projectContent, admissionDiagnostic };
	`);
	return factory(Buffer, (error) => error?.code !== undefined, isDeepStrictEqual);
}

function imageLimits(overrides = {}) {
	return {
		maxImageBytes: 8,
		maxImagesPerMessage: 2,
		maxMessageImageBytes: 12,
		mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		...overrides
	};
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
		imageLimits: imageLimits(),
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
	const output = await prepareImageProjection({
		get(name) {
			if (name === "attachments") return { imageLimits: imageLimits(), saveImages: async () => ["unexpected"] };
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
			return undefined;
		}
	}, createExec(), [
		{ type: "image", mimeType: "image/png", data: "not base64" }
	], "camera");
	assert.equal(output.length, 1);
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /invalid image data/);
	assert.doesNotMatch(output[0].text, /not base64/);
});

test("uses a diagnostic fallback when the routed model is not image-capable", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const ctx = {
		get(name) {
			if (name === "attachments") return { imageLimits: imageLimits(), saveImages: async () => ["unexpected"] };
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["text"] }) };
			return undefined;
		}
	};
	const output = await prepareImageProjection(ctx, createExec(), [
		{ type: "image", mimeType: "image/png", data: "AQ==" }
	], "camera");
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /model route is not image-capable/);
	assert.doesNotMatch(output[0].text, /AQ==/);
});

test("falls back safely when attachment storage rejects an image", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const ctx = {
		get(name) {
			if (name === "attachments") return { imageLimits: imageLimits(), saveImages: async () => { throw new Error("storage unavailable"); } };
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
			return undefined;
		}
	};
	const output = await prepareImageProjection(ctx, createExec(), [
		{ type: "image", mimeType: "image/png", data: "AQ==" }
	], "camera");
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /image storage unavailable/);
	assert.doesNotMatch(output[0].text, /AQ==/);
});

test("keeps audio and resource fallbacks bounded", async () => {
	const { projectContent } = await loadImageProjection();
	const output = projectContent([
		{ type: "audio", mimeType: "audio/wav", data: "raw-audio" },
		{ type: "resource", resource: { blob: "raw-resource" } }
	], "multimedia");
	assert.equal(output.length, 1);
	assert.equal(output[0].type, "text");
	assert.match(output[0].text, /audio bytes were not added to text context/);
	assert.match(output[0].text, /resource bytes were not added to text context/);
	assert.doesNotMatch(output[0].text, /raw-audio|raw-resource/);
});

test("preflights image byte, aggregate, and count limits before storage", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	for (const [name, content, limits] of [
		["single image", [{ type: "image", mimeType: "image/png", data: "AQIDBAUGBwg=" }], imageLimits({ maxImageBytes: 7 })],
		["aggregate", [{ type: "image", mimeType: "image/png", data: "AQIDBAUG" }, { type: "image", mimeType: "image/png", data: "BwgJCgsM" }], imageLimits({ maxMessageImageBytes: 11 })],
		["count", [{ type: "image", mimeType: "image/png", data: "AQ==" }, { type: "image", mimeType: "image/png", data: "Ag==" }], imageLimits({ maxImagesPerMessage: 1 })]
	]) {
		let saves = 0;
		const ctx = {
			get(key) {
				if (key === "attachments") return { imageLimits: limits, saveImages: async () => { saves += 1; return []; } };
				if (key === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
				return undefined;
			}
		};
		const output = await prepareImageProjection(ctx, createExec(), content, name);
		assert.equal(saves, 0, `${name} must not persist a preflight rejection`);
		assert.match(output[0].text, /image bytes were not added to text context/);
		for (const block of content) assert.doesNotMatch(output[0].text, new RegExp(block.data));
	}
});

test("allows an exact image byte limit", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	let saves = 0;
	const ctx = {
		get(key) {
			if (key === "attachments") return { imageLimits: imageLimits({ maxImageBytes: 3, maxMessageImageBytes: 3 }), saveImages: async () => { saves += 1; return ["attachment-1"]; } };
			if (key === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
			return undefined;
		}
	};
	const output = await prepareImageProjection(ctx, createExec(), [{ type: "image", mimeType: "image/png", data: "AQID" }], "camera");
	assert.equal(saves, 1);
	assert.deepEqual(output, [{ type: "image", attachment: "attachment-1" }]);
});

test("finalizes only matching successful projections", async () => {
	const { createDefinition } = await loadImageProjection();
	const client = { request: async () => ({ content: [{ type: "image", mimeType: "image/png", data: "AQ==" }] }) };
	const ctx = {
		get(key) {
			if (key === "attachments") return { imageLimits: imageLimits(), saveImages: async () => ["attachment-1"] };
			if (key === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
			return undefined;
		}
	};
	const definition = createDefinition(client, ctx, "mcp__srv__camera", "camera", "", { type: "object" }, undefined, false, { toolCallTimeoutMs: 1 });
	const exec = createExec();
	const value = await definition.execute({}, exec);
	const fallback = definition.output.render({}, value);
	assert.deepEqual(definition.finalizeContent(exec, { value, content: fallback, isError: false }), [{ type: "image", attachment: "attachment-1" }]);

	const changedExec = createExec();
	const changedValue = await definition.execute({}, changedExec);
	const changedFallback = definition.output.render({}, changedValue);
	assert.equal(definition.finalizeContent(changedExec, { value: { content: [] }, content: changedFallback, isError: false }), undefined);

	const fallbackExec = createExec();
	const fallbackValue = await definition.execute({}, fallbackExec);
	assert.equal(definition.finalizeContent(fallbackExec, { value: fallbackValue, content: [{ type: "text", text: "changed" }], isError: false }), undefined);

	const firstExec = createExec();
	const secondExec = createExec();
	const [firstValue, secondValue] = await Promise.all([definition.execute({}, firstExec), definition.execute({}, secondExec)]);
	assert.deepEqual(definition.finalizeContent(firstExec, { value: firstValue, content: definition.output.render({}, firstValue), isError: false }), [{ type: "image", attachment: "attachment-1" }]);
	assert.deepEqual(definition.finalizeContent(secondExec, { value: secondValue, content: definition.output.render({}, secondValue), isError: false }), [{ type: "image", attachment: "attachment-1" }]);

	const errorExec = createExec();
	const errorValue = await definition.execute({}, errorExec);
	assert.equal(definition.finalizeContent(errorExec, { value: errorValue, content: definition.output.render({}, errorValue), isError: true }), undefined);
});

test("maps attachment admission codes to bounded diagnostics", async () => {
	const { admissionDiagnostic } = await loadImageProjection();
	const cases = [
		["TOO_MANY_IMAGES", "image batch exceeds the active count limit"],
		["IMAGES_TOO_LARGE", "image batch exceeds the active size limit"],
		["IMAGE_TOO_LARGE", "image exceeds the active size limit"],
		["UNSUPPORTED_IMAGE_TYPE", "image type is not accepted"],
		["IMAGE_TYPE_MISMATCH", "declared image type does not match image bytes"],
		["INVALID_IMAGE_BASE64", "invalid image Base64"],
		["INVALID_IMAGE", "malformed or unsupported image data"],
		["IMAGE_TOO_MANY_PIXELS", "image exceeds the decoded-pixel limit"],
		["IMAGE_DIMENSION_TOO_LARGE", "image exceeds the maximum side dimension"]
	];
	for (const [code, reason] of cases) assert.equal(admissionDiagnostic({ code }), reason, code);
	assert.equal(admissionDiagnostic(new Error("storage secret")), "image storage unavailable");
});

test("projects dimension admission failures without leaking storage details", async () => {
	const { prepareImageProjection } = await loadImageProjection();
	const output = await prepareImageProjection({
		get(name) {
			if (name === "attachments") return {
				imageLimits: imageLimits(),
				async saveImages() {
					throw Object.assign(new Error("private attachment path"), { code: "IMAGE_DIMENSION_TOO_LARGE" });
				}
			};
			if (name === "llm") return { resolveModelInfo: async () => ({ inputModalities: ["image"] }) };
			return undefined;
		}
	}, createExec(), [
		{ type: "image", mimeType: "image/png", data: "AQ==" }
	], "camera");
	assert.equal(output.length, 1);
	assert.match(output[0].text, /maximum side dimension/);
	assert.doesNotMatch(output[0].text, /private attachment path/);
});
