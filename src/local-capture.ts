import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalSpanCapture = {
	logFile: string;
	restore(): void;
};

let activeCapture: LocalSpanCapture | undefined;

const ALLOWED_SPAN_NAMES = new Set([
	"pi.agent",
	"pi.llm.response",
	"pi.model.select",
	"pi.provider.request",
	"pi.session",
	"pi.session.compact",
	"pi.thinking.select",
	"pi.tool",
	"pi.turn",
]);

const ALLOWED_ATTRIBUTES = new Set([
	"deployment.environment.name",
	"gen_ai.operation.name",
	"gen_ai.provider.name",
	"gen_ai.request.model",
	"gen_ai.response.finish_reason",
	"gen_ai.response.model",
	"gen_ai.tool.call.id",
	"gen_ai.tool.name",
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.output_tokens",
	"http.response.status_code",
	"pi.compaction.reason",
	"pi.compaction.will_retry",
	"pi.cost.cache_read",
	"pi.cost.cache_write",
	"pi.cost.input",
	"pi.cost.output",
	"pi.cost.total",
	"pi.mode",
	"pi.model.api",
	"pi.model.selection_source",
	"pi.session.id",
	"pi.session.shutdown_reason",
	"pi.session.start_reason",
	"pi.thinking.level",
	"pi.thinking.previous_level",
	"pi.tool.is_error",
	"pi.turn.index",
	"pi.turn.tool_result_count",
	"pi.usage.cache_read_tokens",
	"pi.usage.cache_write_tokens",
	"pi.usage.reasoning_tokens",
	"pi.usage.total_tokens",
	"service.name",
	"service.namespace",
	"telemetry.destination",
	"telemetry.sdk.language",
	"telemetry.sdk.name",
	"telemetry.sdk.version",
]);

function safeAttributes(value: unknown): Record<string, string | number | boolean> {
	if (!value || typeof value !== "object") return {};
	const attributes: Record<string, string | number | boolean> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!ALLOWED_ATTRIBUTES.has(key)) continue;
		if (typeof item === "string" || typeof item === "boolean") attributes[key] = item;
		if (typeof item === "number" && Number.isFinite(item)) attributes[key] = item;
	}
	return attributes;
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeLocalOtelSpan(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const scope = record.instrumentationScope as Record<string, unknown> | undefined;
	const resource = record.resource as Record<string, unknown> | undefined;
	const duration = safeNumber(record.duration);
	const timestamp = safeNumber(record.timestamp);
	if (
		scope?.name !== "pi-local-otel" ||
		typeof record.traceId !== "string" ||
		!/^[0-9a-f]{32}$/i.test(record.traceId) ||
		typeof record.id !== "string" ||
		!/^[0-9a-f]{16}$/i.test(record.id) ||
		typeof record.name !== "string" ||
		!ALLOWED_SPAN_NAMES.has(record.name) ||
		duration === undefined ||
		timestamp === undefined
	) {
		return undefined;
	}
	return {
		resource: { attributes: safeAttributes(resource?.attributes) },
		instrumentationScope: {
			name: "pi-local-otel",
			version: scope.version === "0.1.0" ? "0.1.0" : undefined,
		},
		traceId: record.traceId,
		id: record.id,
		name: record.name,
		kind: safeNumber(record.kind),
		timestamp,
		duration,
		attributes: safeAttributes(record.attributes),
		status: {
			code: safeNumber((record.status as Record<string, unknown> | undefined)?.code) ?? 0,
		},
	};
}

function validateLogDirectory(logDir: string): void {
	const stats = fs.lstatSync(logDir);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error("The telemetry log path is not a directory.");
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error("The telemetry log directory has a different owner.");
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new Error("The telemetry log directory is not private.");
	}
}

export function installLocalSpanCapture(): LocalSpanCapture {
	if (activeCapture) return activeCapture;

	const logDir = process.env.PI_OTEL_LOG_DIR || path.join(os.homedir(), ".pi", "agent", "debug");
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	validateLogDirectory(logDir);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const nonce = crypto.randomBytes(4).toString("hex");
	const logFile = path.join(logDir, `pi-otel-${stamp}-${process.pid}-${nonce}.jsonl`);
	fs.closeSync(fs.openSync(logFile, "wx", 0o600));
	process.env.PI_OTEL_LOG_FILE = logFile;

	const originalDir = console.dir;
	const capture: LocalSpanCapture = {
		logFile,
		restore() {
			if (activeCapture !== capture) return;
			console.dir = originalDir;
			activeCapture = undefined;
		},
	};
	activeCapture = capture;

	console.dir = (value: unknown, options?: Parameters<typeof console.dir>[1]) => {
		const record = sanitizeLocalOtelSpan(value);
		if (!record) {
			originalDir.call(console, value, options);
			return;
		}
		try {
			fs.appendFileSync(
				logFile,
				`${JSON.stringify({ timestamp: new Date().toISOString(), signal: "traces", record })}\n`,
			);
		} catch {
			// Telemetry logging must never break Pi startup or execution.
		}
		if (process.env.PI_OTEL_TEE_CONSOLE === "1") originalDir.call(console, value, options);
	};

	return capture;
}
