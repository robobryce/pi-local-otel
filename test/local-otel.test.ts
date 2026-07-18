import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import localOtel from "../src/index.ts";
import { installLocalSpanCapture } from "../src/local-capture.ts";

test("selective capture writes private local span JSONL", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-capture-"));
	process.env.PI_OTEL_LOG_DIR = logDir;
	const capture = installLocalSpanCapture();
	console.dir({
		resource: { attributes: { "service.name": "pi-coding-agent" } },
		instrumentationScope: { name: "pi-local-otel", version: "test" },
		traceId: "0123456789abcdef0123456789abcdef",
		id: "0123456789abcdef",
		duration: [0, 1],
		name: "pi.test",
	});
	capture.restore();

	assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(capture.logFile).mode & 0o777, 0o600);
	const records = fs
		.readFileSync(capture.logFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(records.length, 1);
	assert.equal(records[0].signal, "traces");
	assert.equal(records[0].record.name, "pi.test");
});

test("lifecycle spans exclude prompts, payloads, headers, results, and error text", async () => {
	const secret = "SUPERSECRET-PAYLOAD-MUST-NOT-BE-LOGGED";
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-lifecycle-"));
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.OTEL_SDK_DISABLED = "false";
	process.env.OTEL_TRACES_EXPORTER = "console";

	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
	};
	localOtel(pi as any);

	const ctx = {
		mode: "print",
		sessionManager: { getSessionId: () => "session-test-id" },
		model: { api: "openai-responses", id: "test-model", provider: "test-provider" },
	};
	const emit = async (name: string, event: Record<string, unknown>) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	};

	await emit("session_start", { reason: "startup" });
	await emit("before_agent_start", { prompt: secret, images: [{ data: secret }], systemPrompt: secret });
	await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
	await emit("before_provider_request", { payload: { secret } });
	await emit("after_provider_response", { status: 200, headers: { authorization: secret } });
	await emit("tool_execution_start", { toolCallId: "call-1", toolName: "read", args: { secret } });
	await emit("tool_execution_end", {
		toolCallId: "call-1",
		toolName: "read",
		result: { content: secret },
		isError: false,
	});
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: secret }],
			provider: "test-provider",
			model: "test-model",
			stopReason: "stop",
			errorMessage: secret,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				reasoning: 3,
				totalTokens: 18,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
			},
		},
	});
	await emit("turn_end", {
		turnIndex: 0,
		message: { content: secret },
		toolResults: [{ content: secret }],
	});
	await emit("agent_settled", {});
	await emit("session_shutdown", { reason: "quit", targetSessionFile: secret });

	const files = fs.readdirSync(logDir).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 1);
	const output = fs.readFileSync(path.join(logDir, files[0]), "utf8");
	assert.ok(!output.includes(secret));
	const records = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const names = new Set(records.map((record) => record.record.name));
	for (const name of ["pi.session", "pi.agent", "pi.turn", "pi.provider.request", "pi.llm.response", "pi.tool"]) {
		assert.ok(names.has(name), `${name} span is missing`);
	}
	const response = records.find((record) => record.record.name === "pi.llm.response").record;
	assert.equal(response.attributes["gen_ai.usage.input_tokens"], 10);
	assert.equal(response.attributes["gen_ai.usage.output_tokens"], 5);
	assert.equal(response.attributes["gen_ai.response.model"], "test-model");
});
