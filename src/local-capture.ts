import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalSpanCapture = {
	logFile: string;
	restore(): void;
};

let activeCapture: LocalSpanCapture | undefined;

function isLocalOtelSpan(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const scope = record.instrumentationScope as Record<string, unknown> | undefined;
	const resource = record.resource as Record<string, unknown> | undefined;
	return (
		scope?.name === "pi-local-otel" &&
		typeof resource?.attributes === "object" &&
		typeof record.traceId === "string" &&
		typeof record.id === "string" &&
		(typeof record.duration === "number" || Array.isArray(record.duration))
	);
}

function stringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, item) => {
		if (typeof item === "bigint") return item.toString();
		if (item && typeof item === "object") {
			if (seen.has(item)) return "[Circular]";
			seen.add(item);
		}
		return item;
	});
}

export function installLocalSpanCapture(): LocalSpanCapture {
	if (activeCapture) return activeCapture;

	const logDir = process.env.PI_OTEL_LOG_DIR || path.join(os.homedir(), ".pi", "agent", "debug");
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	fs.chmodSync(logDir, 0o700);

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const nonce = crypto.randomBytes(4).toString("hex");
	const logFile = path.join(logDir, `pi-otel-${stamp}-${process.pid}-${nonce}.jsonl`);
	fs.closeSync(fs.openSync(logFile, "wx", 0o600));
	process.env.PI_OTEL_LOG_FILE = logFile;

	const originalDir = console.dir.bind(console);
	const capture: LocalSpanCapture = {
		logFile,
		restore() {
			if (activeCapture !== capture) return;
			console.dir = originalDir;
			activeCapture = undefined;
		},
	};
	activeCapture = capture;

	console.dir = (value: unknown, ...options: unknown[]) => {
		if (!isLocalOtelSpan(value)) {
			originalDir(value, ...options);
			return;
		}
		try {
			fs.appendFileSync(
				logFile,
				`${stringify({ timestamp: new Date().toISOString(), signal: "traces", record: value })}\n`,
			);
		} catch {
			// Telemetry logging must never break Pi startup or execution.
		}
		if (process.env.PI_OTEL_TEE_CONSOLE === "1") originalDir(value, ...options);
	};

	return capture;
}
