import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";

import localOtel from "../src/index.ts";
import { installLocalSpanCapture } from "../src/local-capture.ts";

function testSpan(attributes: Record<string, string | number | boolean> = {}) {
	return {
		resource: { attributes: { "service.name": "pi-coding-agent" } },
		instrumentationScope: { name: "pi-local-otel", version: "0.1.0" },
		traceId: "0123456789abcdef0123456789abcdef",
		id: "0123456789abcdef",
		timestamp: Date.now() * 1000,
		duration: 1,
		name: "pi.turn",
		attributes,
		status: { code: 0 },
	};
}

function restoreEnvironment(saved: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("selective capture writes private local span JSONL", () => {
	const secret = "CAPTURE-MUST-DROP-UNAPPROVED-FIELDS";
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-capture-"));
	process.env.PI_OTEL_LOG_DIR = logDir;
	const capture = installLocalSpanCapture();
	console.dir({
		resource: { attributes: { "service.name": "pi-coding-agent", "secret.resource": secret } },
		instrumentationScope: { name: "pi-local-otel", version: "0.1.0" },
		traceId: "0123456789abcdef0123456789abcdef",
		id: "0123456789abcdef",
		timestamp: Date.now() * 1000,
		duration: 1,
		name: "pi.turn",
		attributes: { "pi.mode": "test", prompt: secret },
		status: { code: 0, message: secret },
		events: [{ name: secret }],
		links: [{ attributes: { secret } }],
	});
	capture.restore();

	assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(capture.logFile).mode & 0o777, 0o600);
	const output = fs.readFileSync(capture.logFile, "utf8");
	assert.ok(!output.includes(secret));
	const records = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.equal(records.length, 1);
	assert.equal(records[0].signal, "traces");
	assert.equal(records[0].record.name, "pi.turn");
	assert.deepEqual(records[0].record.attributes, { "pi.mode": "test" });
});

test("insecure log directories disable telemetry without changing their mode", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-insecure-"));
	fs.chmodSync(logDir, 0o755);
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.OTEL_SDK_DISABLED = "false";
	process.env.OTEL_TRACES_EXPORTER = "console";
	const handlers: unknown[] = [];
	const originalWarn = console.warn;
	console.warn = () => {};
	try {
		localOtel({ on: (_name: string, handler: unknown) => handlers.push(handler) } as any);
	} finally {
		console.warn = originalWarn;
	}
	assert.equal(handlers.length, 0);
	assert.equal(fs.statSync(logDir).mode & 0o777, 0o755);
});

test("capture is restored when OpenTelemetry shutdown rejects", async () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-shutdown-"));
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.OTEL_SDK_DISABLED = "false";
	process.env.OTEL_TRACES_EXPORTER = "console";
	const originalDir = console.dir;
	const originalShutdown = ConsoleSpanExporter.prototype.shutdown;
	ConsoleSpanExporter.prototype.shutdown = async () => {
		throw new Error("Expected test failure.");
	};
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	try {
		localOtel({
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(name, [handler]);
			},
		} as any);
		assert.notEqual(console.dir, originalDir);
		const ctx = {
			mode: "print",
			sessionManager: { getSessionId: () => "shutdown-test" },
			model: undefined,
		};
		await handlers.get("session_start")?.[0]({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("session_shutdown")?.[0]({ type: "session_shutdown", reason: "quit" }, ctx);
		assert.equal(console.dir, originalDir);
	} finally {
		ConsoleSpanExporter.prototype.shutdown = originalShutdown;
		console.dir = originalDir;
	}
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

test("capture creates no empty per-process file", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-lazy-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_LOG_FILE = "/tmp/stale-pi-otel-log";
	try {
		const capture = installLocalSpanCapture();
		assert.equal(fs.existsSync(capture.logFile), false);
		assert.equal(process.env.PI_OTEL_LOG_FILE, undefined);
		capture.restore();
		assert.deepEqual(fs.readdirSync(logDir), []);
		assert.equal(process.env.PI_OTEL_LOG_FILE, undefined);
	} finally {
		restoreEnvironment(previous);
	}
});

test("sequential captures in one process can replace an inactive log", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-reload-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILES = "1";
	try {
		const first = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "first-capture" }));
		first.restore();
		assert.equal(fs.existsSync(first.logFile), true);

		const second = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "second-capture" }));
		second.restore();
		assert.equal(fs.existsSync(first.logFile), false);
		assert.equal(fs.existsSync(second.logFile), true);
		assert.equal(process.env.PI_OTEL_LOG_FILE, second.logFile);
	} finally {
		restoreEnvironment(previous);
	}
});

test("capture stops before its configured byte ceiling", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-size-limit-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_MAX_FILE_BYTES: process.env.PI_OTEL_MAX_FILE_BYTES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILE_BYTES = "1200";
	try {
		const capture = installLocalSpanCapture();
		for (let index = 0; index < 100; index += 1) {
			console.dir(testSpan({ "pi.mode": "test", "pi.turn.index": index }));
		}
		assert.equal(process.env.PI_OTEL_LOG_FILE, capture.logFile);
		capture.restore();

		const output = fs.readFileSync(capture.logFile, "utf8");
		assert.ok(Buffer.byteLength(output) <= 1200);
		const lines = output.trim().split("\n");
		assert.ok(lines.length > 0 && lines.length < 100);
		for (const line of lines) assert.equal(JSON.parse(line).record.name, "pi.turn");
	} finally {
		restoreEnvironment(previous);
	}
});

test("invalid retention settings fall back to bounded working defaults", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-invalid-limits-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILE_BYTES: process.env.PI_OTEL_MAX_FILE_BYTES,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILE_BYTES = "0";
	process.env.PI_OTEL_MAX_FILES = "garbage";
	delete process.env.PI_OTEL_LOG_FILE;
	try {
		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "fallback" }));
		capture.restore();

		assert.equal(process.env.PI_OTEL_LOG_FILE, capture.logFile);
		assert.ok(fs.statSync(capture.logFile).size > 0);
	} finally {
		restoreEnvironment(previous);
	}
});

test("one record larger than the configured ceiling creates no file", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-oversized-record-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILE_BYTES: process.env.PI_OTEL_MAX_FILE_BYTES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILE_BYTES = "128";
	delete process.env.PI_OTEL_LOG_FILE;
	try {
		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "too-large" }));
		capture.restore();

		assert.equal(fs.existsSync(capture.logFile), false);
		assert.equal(process.env.PI_OTEL_LOG_FILE, undefined);
	} finally {
		restoreEnvironment(previous);
	}
});

test("retention removes empty and oldest owned logs without following symlinks", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-retention-"));
	const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-target-"));
	const target = path.join(targetDir, "outside.jsonl");
	fs.writeFileSync(target, "do not alter\n", { mode: 0o600 });

	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILE_BYTES: process.env.PI_OTEL_MAX_FILE_BYTES,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	try {
		process.env.PI_OTEL_MAX_FILE_BYTES = "8192";
		process.env.PI_OTEL_MAX_FILES = "20";
		const fixtures: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const fixture = installLocalSpanCapture();
			console.dir(testSpan({ "pi.mode": `fixture-${index}` }));
			fixture.restore();
			fixtures.push(fixture.logFile);
		}
		const names = fixtures.slice(0, 3);
		for (const [index, file] of names.entries()) {
			fs.utimesSync(file, new Date(index + 1), new Date(index + 1));
		}
		const oversized = fixtures[3];
		fs.writeFileSync(oversized, "x".repeat(1500), { mode: 0o600 });
		const empty = fixtures[4];
		fs.truncateSync(empty, 0);

		const prospective = installLocalSpanCapture();
		const symlink = prospective.logFile;
		prospective.restore();
		fs.symlinkSync(target, symlink);
		const unrelated = path.join(logDir, "notes.jsonl");
		fs.writeFileSync(unrelated, "keep\n", { mode: 0o600 });

		process.env.PI_OTEL_MAX_FILE_BYTES = "1200";
		process.env.PI_OTEL_MAX_FILES = "2";
		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "retention" }));
		capture.restore();

		assert.equal(fs.existsSync(names[0]), false);
		assert.equal(fs.existsSync(names[1]), false);
		assert.equal(fs.existsSync(names[2]), true);
		assert.equal(fs.existsSync(oversized), false);
		assert.equal(fs.existsSync(empty), false);
		assert.equal(fs.lstatSync(symlink).isSymbolicLink(), true);
		assert.equal(fs.readFileSync(target, "utf8"), "do not alter\n");
		assert.equal(fs.readFileSync(unrelated, "utf8"), "keep\n");
		assert.equal(fs.existsSync(capture.logFile), true);
		const retainedRegularLogs = fs
			.readdirSync(logDir)
			.filter((name) => /^pi-otel-.*\.jsonl$/.test(name))
			.filter((name) => fs.lstatSync(path.join(logDir, name)).isFile());
		assert.equal(retainedRegularLogs.length, 2);
	} finally {
		restoreEnvironment(previous);
	}
});

test("retention never unlinks a log whose process may still be alive", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-live-log-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILES = "1";
	try {
		const prospective = installLocalSpanCapture();
		const liveLog = prospective.logFile;
		prospective.restore();
		fs.closeSync(fs.openSync(liveLog, "wx", 0o600));

		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "live-log" }));
		capture.restore();

		assert.equal(fs.existsSync(liveLog), true);
		assert.equal(fs.statSync(liveLog).size, 0);
		assert.equal(fs.existsSync(capture.logFile), false);
	} finally {
		restoreEnvironment(previous);
	}
});

test("closed-log identity never authorizes a same-name file in another directory", () => {
	const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-identity-a-"));
	const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-identity-b-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_MAX_FILES = "1";
	try {
		process.env.PI_OTEL_LOG_DIR = firstDir;
		const closed = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "closed-source" }));
		closed.restore();

		process.env.PI_OTEL_LOG_DIR = secondDir;
		const collision = path.join(secondDir, path.basename(closed.logFile));
		fs.copyFileSync(closed.logFile, collision);
		fs.chmodSync(collision, 0o600);
		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "identity-collision" }));
		capture.restore();

		assert.equal(fs.existsSync(collision), true);
		assert.equal(fs.existsSync(capture.logFile), false);
	} finally {
		restoreEnvironment(previous);
	}
});

test("retention excludes foreign-node and legacy logs from the local quota", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-foreign-node-"));
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
		PI_OTEL_MAX_FILES: process.env.PI_OTEL_MAX_FILES,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	process.env.PI_OTEL_MAX_FILES = "1";
	try {
		const prospective = installLocalSpanCapture();
		prospective.restore();
		const localName = path.basename(prospective.logFile);
		const foreignName = localName.replace(/(Z-)([0-9a-f])/, (_match, prefix, digit) =>
			`${prefix}${digit === "0" ? "1" : "0"}`,
		);
		assert.notEqual(foreignName, localName);
		const foreignLog = path.join(logDir, foreignName);
		fs.writeFileSync(foreignLog, "foreign\n", { mode: 0o600 });
		const legacyLog = path.join(
			logDir,
			`pi-otel-2020-01-01T00-00-00-000Z-${process.pid}-00000001.jsonl`,
		);
		fs.writeFileSync(legacyLog, "legacy\n", { mode: 0o600 });

		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "local" }));
		capture.restore();

		assert.equal(fs.readFileSync(foreignLog, "utf8"), "foreign\n");
		assert.equal(fs.readFileSync(legacyLog, "utf8"), "legacy\n");
		assert.equal(fs.existsSync(capture.logFile), true);
	} finally {
		restoreEnvironment(previous);
	}
});

test("a symlink planted at the prospective log path is never followed", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-symlink-"));
	const target = path.join(logDir, "target.txt");
	fs.writeFileSync(target, "unchanged\n", { mode: 0o600 });
	const previous = process.env.PI_OTEL_LOG_DIR;
	process.env.PI_OTEL_LOG_DIR = logDir;
	try {
		const capture = installLocalSpanCapture();
		fs.symlinkSync(target, capture.logFile);
		console.dir(testSpan({ "pi.mode": "symlink" }));
		capture.restore();

		assert.equal(fs.readFileSync(target, "utf8"), "unchanged\n");
		assert.equal(fs.lstatSync(capture.logFile).isSymbolicLink(), true);
	} finally {
		restoreEnvironment({ PI_OTEL_LOG_DIR: previous });
	}
});

test("descriptor writes stop and unpublish if an active log path is replaced", () => {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-local-otel-replaced-"));
	const target = path.join(logDir, "target.txt");
	const moved = path.join(logDir, "moved.jsonl");
	fs.writeFileSync(target, "unchanged\n", { mode: 0o600 });
	const previous = {
		PI_OTEL_LOG_DIR: process.env.PI_OTEL_LOG_DIR,
		PI_OTEL_LOG_FILE: process.env.PI_OTEL_LOG_FILE,
	};
	process.env.PI_OTEL_LOG_DIR = logDir;
	try {
		const capture = installLocalSpanCapture();
		console.dir(testSpan({ "pi.mode": "first" }));
		assert.equal(process.env.PI_OTEL_LOG_FILE, capture.logFile);
		fs.renameSync(capture.logFile, moved);
		fs.symlinkSync(target, capture.logFile);
		console.dir(testSpan({ "pi.mode": "second" }));
		capture.restore();

		assert.equal(fs.readFileSync(target, "utf8"), "unchanged\n");
		assert.equal(fs.lstatSync(capture.logFile).isSymbolicLink(), true);
		assert.ok(fs.statSync(moved).size > 0);
		assert.equal(process.env.PI_OTEL_LOG_FILE, undefined);
	} finally {
		restoreEnvironment(previous);
	}
});
