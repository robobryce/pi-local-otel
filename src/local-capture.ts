import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalSpanCapture = {
	logFile: string;
	restore(): void;
};

let activeCapture: LocalSpanCapture | undefined;

type FileIdentity = { dev: number; ino: number };

const inactiveLogFilesSymbol = Symbol.for("pi-local-otel.inactive-log-files");
const sharedGlobalState = globalThis as unknown as Record<symbol, unknown>;
const inactiveLogFiles =
	sharedGlobalState[inactiveLogFilesSymbol] instanceof Map
		? (sharedGlobalState[inactiveLogFilesSymbol] as Map<string, FileIdentity>)
		: new Map<string, FileIdentity>();
sharedGlobalState[inactiveLogFilesSymbol] = inactiveLogFiles;
const MAX_INACTIVE_LOG_IDENTITIES = 256;

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20;
const MANAGED_LOG_FILE_PATTERN =
	/^pi-otel-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-([0-9a-f]{16})-([0-9a-f]{12})-(\d+)-[0-9a-f]{8}\.jsonl$/;

function readIdentityFile(file: string): string | undefined {
	try {
		const value = fs.readFileSync(file, "utf8").trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

function hashedIdentifier(value: string, length: number): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

const hostMaterial = [
	os.hostname(),
	os.platform(),
	readIdentityFile("/etc/machine-id") ?? readIdentityFile("/var/lib/dbus/machine-id") ?? "",
].join("\0");
const bootMaterial = readIdentityFile("/proc/sys/kernel/random/boot_id");
const HAS_STABLE_BOOT_ID = bootMaterial !== undefined;
const HOST_ID = hashedIdentifier(hostMaterial, 16);
const BOOT_ID = bootMaterial ? hashedIdentifier(`${hostMaterial}\0${bootMaterial}`, 12) : "000000000000";

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

function configuredPositiveInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function validateDirectoryStats(stats: fs.Stats): void {
	if (!stats.isDirectory()) {
		throw new Error("The telemetry log path is not a directory.");
	}
	if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
		throw new Error("The telemetry log directory has a different owner.");
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new Error("The telemetry log directory is not private.");
	}
}

function validateLogDirectory(logDir: string): fs.Stats {
	const stats = fs.lstatSync(logDir);
	if (stats.isSymbolicLink()) throw new Error("The telemetry log path is a symbolic link.");
	validateDirectoryStats(stats);
	return stats;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function validateSameLogDirectory(logDir: string, expected: fs.Stats, descriptor: number): void {
	const current = validateLogDirectory(logDir);
	const opened = fs.fstatSync(descriptor);
	validateDirectoryStats(opened);
	if (!sameFile(current, expected) || !sameFile(opened, expected)) {
		throw new Error("The telemetry log directory changed.");
	}
}

type RetainedLog = {
	bootId: string;
	name: string;
	path: string;
	pid: number;
	stats: fs.Stats;
};

function rememberInactiveLog(name: string, stats: fs.Stats): void {
	while (inactiveLogFiles.size >= MAX_INACTIVE_LOG_IDENTITIES) {
		const oldest = inactiveLogFiles.keys().next().value;
		if (oldest === undefined) break;
		inactiveLogFiles.delete(oldest);
	}
	inactiveLogFiles.set(name, { dev: stats.dev, ino: stats.ino });
}

function logProcessMayBeAlive(log: RetainedLog): boolean {
	const inactive = inactiveLogFiles.get(log.name);
	if (inactive) {
		if (inactive.dev === log.stats.dev && inactive.ino === log.stats.ino) return false;
		inactiveLogFiles.delete(log.name);
	}
	if (HAS_STABLE_BOOT_ID && log.bootId !== BOOT_ID) return false;
	try {
		process.kill(log.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function retainedLogs(logDir: string): RetainedLog[] {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const logs: RetainedLog[] = [];
	for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
		const match = MANAGED_LOG_FILE_PATTERN.exec(entry.name);
		if (!match || match[1] !== HOST_ID || entry.isSymbolicLink()) continue;
		const pid = Number(match[3]);
		if (!Number.isSafeInteger(pid) || pid <= 0) continue;
		const filePath = path.join(logDir, entry.name);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (
			stats.isSymbolicLink() ||
			!stats.isFile() ||
			stats.nlink !== 1 ||
			(uid !== undefined && stats.uid !== uid) ||
			(stats.mode & 0o077) !== 0
		) {
			continue;
		}
		logs.push({ bootId: match[2], name: entry.name, path: filePath, pid, stats });
	}
	return logs;
}

function unlinkUnchangedLog(
	log: RetainedLog,
	validateDirectory?: () => void,
	allowLiveProcess = false,
): boolean {
	if (!allowLiveProcess && logProcessMayBeAlive(log)) return false;
	validateDirectory?.();
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(
			log.path,
			fs.constants.O_RDONLY |
				(fs.constants.O_NONBLOCK ?? 0) |
				(fs.constants.O_NOFOLLOW ?? 0),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			inactiveLogFiles.delete(log.name);
			return true;
		}
		if ((error as NodeJS.ErrnoException).code === "ELOOP") return false;
		throw error;
	}
	try {
		const opened = fs.fstatSync(descriptor);
		const current = fs.lstatSync(log.path);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			current.isSymbolicLink() ||
			!opened.isFile() ||
			opened.nlink !== 1 ||
			(uid !== undefined && opened.uid !== uid) ||
			(opened.mode & 0o077) !== 0 ||
			!sameFile(opened, current) ||
			!sameFile(opened, log.stats)
		) {
			return false;
		}
		validateDirectory?.();
		try {
			fs.unlinkSync(log.path);
			inactiveLogFiles.delete(log.name);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				inactiveLogFiles.delete(log.name);
				return true;
			}
			throw error;
		}
	} finally {
		fs.closeSync(descriptor);
	}
}

function pruneLogs(
	logDir: string,
	accessLogDir: string,
	directory: fs.Stats,
	directoryDescriptor: number,
	maxFiles: number,
	maxFileBytes: number,
	protectedName?: string,
): void {
	const validateDirectory = () => validateSameLogDirectory(logDir, directory, directoryDescriptor);
	validateDirectory();
	const logs = retainedLogs(accessLogDir);
	for (const log of logs) {
		if (
			log.name !== protectedName &&
			log.stats.size > maxFileBytes &&
			!logProcessMayBeAlive(log)
		) {
			unlinkUnchangedLog(log, validateDirectory);
		}
	}
	if (
		retainedLogs(accessLogDir).some(
			(log) => log.name !== protectedName && log.stats.size > maxFileBytes,
		)
	) {
		throw new Error("The telemetry file-size retention limit could not be enforced.");
	}

	const retained = retainedLogs(accessLogDir).sort((left, right) => {
		const leftIsEmpty = left.stats.size === 0;
		const rightIsEmpty = right.stats.size === 0;
		if (leftIsEmpty !== rightIsEmpty) return leftIsEmpty ? -1 : 1;
		return left.stats.mtimeMs - right.stats.mtimeMs || left.name.localeCompare(right.name);
	});
	let excess = retained.length - maxFiles;
	for (const log of retained) {
		if (excess <= 0) break;
		if (log.name === protectedName) continue;
		if (unlinkUnchangedLog(log, validateDirectory)) excess -= 1;
	}
	if (excess > 0) throw new Error("The telemetry retention limit could not be enforced.");
	validateDirectory();
}

export function installLocalSpanCapture(): LocalSpanCapture {
	if (activeCapture) return activeCapture;
	delete process.env.PI_OTEL_LOG_FILE;

	const logDir = path.resolve(
		process.env.PI_OTEL_LOG_DIR || path.join(os.homedir(), ".pi", "agent", "debug"),
	);
	const maxFileBytes = configuredPositiveInteger("PI_OTEL_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
	const maxFiles = configuredPositiveInteger("PI_OTEL_MAX_FILES", DEFAULT_MAX_FILES);
	fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const directory = validateLogDirectory(logDir);
	const directoryDescriptor = fs.openSync(
		logDir,
		fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
	);
	const procDirectory = `/proc/self/fd/${directoryDescriptor}`;
	let accessLogDir = logDir;
	if (process.platform === "linux") {
		try {
			if (fs.statSync(procDirectory).isDirectory()) accessLogDir = procDirectory;
		} catch {
			// Pathname and held-directory identity checks remain the portable fallback.
		}
	}
	try {
		pruneLogs(
			logDir,
			accessLogDir,
			directory,
			directoryDescriptor,
			maxFiles,
			maxFileBytes,
		);
	} catch (error) {
		fs.closeSync(directoryDescriptor);
		throw error;
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const nonce = crypto.randomBytes(4).toString("hex");
	const logName = `pi-otel-${stamp}-${HOST_ID}-${BOOT_ID}-${process.pid}-${nonce}.jsonl`;
	const logFile = path.join(logDir, logName);
	const accessLogFile = path.join(accessLogDir, logName);

	const originalDir = console.dir;
	let fileDescriptor: number | undefined;
	let fileStats: fs.Stats | undefined;
	let captureStopped = false;
	let publishedLogFile = false;
	let directoryOpen = true;

	const closeDirectory = () => {
		if (!directoryOpen) return;
		directoryOpen = false;
		try {
			fs.closeSync(directoryDescriptor);
		} catch {
			// Telemetry cleanup must never change Pi behavior.
		}
	};

	const clearPublishedLogFile = () => {
		if (publishedLogFile && process.env.PI_OTEL_LOG_FILE === logFile) {
			delete process.env.PI_OTEL_LOG_FILE;
		}
		publishedLogFile = false;
	};

	const closeFile = (removeIfEmpty: boolean) => {
		const descriptor = fileDescriptor;
		const expected = fileStats;
		fileDescriptor = undefined;
		fileStats = undefined;
		if (descriptor === undefined) return;
		let finalStats: fs.Stats | undefined;
		try {
			finalStats = fs.fstatSync(descriptor);
		} catch {
			// The descriptor is still closed below.
		}
		let publishedPathIsValid = false;
		if (expected && finalStats && finalStats.nlink === 1) {
			try {
				validateSameLogDirectory(logDir, directory, directoryDescriptor);
				const current = fs.lstatSync(logFile);
				const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
				publishedPathIsValid =
					!current.isSymbolicLink() &&
					current.isFile() &&
					(uid === undefined || current.uid === uid) &&
					(current.mode & 0o077) === 0 &&
					sameFile(current, expected) &&
					sameFile(current, finalStats);
			} catch {
				// A stale or replaced public path must not remain published.
			}
		}
		if (!publishedPathIsValid) clearPublishedLogFile();
		if (removeIfEmpty && expected && finalStats?.size === 0) {
			try {
				const current = fs.lstatSync(accessLogFile);
				if (
					!current.isSymbolicLink() &&
					current.isFile() &&
					sameFile(current, expected) &&
					sameFile(current, finalStats)
				) {
					fs.unlinkSync(accessLogFile);
					clearPublishedLogFile();
				}
			} catch {
				clearPublishedLogFile();
				// Races and cleanup failures are harmless; retention still counts the empty file.
			}
		}
		let descriptorClosed = false;
		try {
			fs.closeSync(descriptor);
			descriptorClosed = true;
		} catch {
			// Telemetry cleanup must never change Pi behavior.
		}
		if (descriptorClosed && publishedPathIsValid && finalStats && finalStats.size > 0) {
			rememberInactiveLog(logName, finalStats);
		}
	};

	const stopCapture = (removeIfEmpty = true, clearPublication = true) => {
		captureStopped = true;
		if (clearPublication) clearPublishedLogFile();
		closeFile(removeIfEmpty);
		closeDirectory();
	};

	const openFile = (): boolean => {
		if (captureStopped) return false;
		let descriptor: number | undefined;
		let opened: fs.Stats | undefined;
		try {
			validateSameLogDirectory(logDir, directory, directoryDescriptor);
			const noFollow = fs.constants.O_NOFOLLOW ?? 0;
			descriptor = fs.openSync(
				accessLogFile,
				fs.constants.O_WRONLY |
					fs.constants.O_CREAT |
					fs.constants.O_EXCL |
					fs.constants.O_APPEND |
					noFollow,
				0o600,
			);
			opened = fs.fstatSync(descriptor);
			const linked = fs.lstatSync(accessLogFile);
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				(uid !== undefined && opened.uid !== uid) ||
				(opened.mode & 0o077) !== 0 ||
				linked.isSymbolicLink() ||
				!sameFile(opened, linked)
			) {
				throw new Error("The telemetry log file is not private and regular.");
			}
			validateSameLogDirectory(logDir, directory, directoryDescriptor);
			fileDescriptor = descriptor;
			fileStats = opened;
			descriptor = undefined;
			pruneLogs(
				logDir,
				accessLogDir,
				directory,
				directoryDescriptor,
				maxFiles,
				maxFileBytes,
				logName,
			);
			return true;
		} catch {
			if (descriptor !== undefined) {
				if (opened) {
					try {
						unlinkUnchangedLog(
							{
								bootId: BOOT_ID,
								name: logName,
								path: accessLogFile,
								pid: process.pid,
								stats: opened,
							},
							undefined,
							true,
						);
					} catch {
						// Retention still counts an empty file left by a cleanup failure.
					}
				}
				try {
					fs.closeSync(descriptor);
				} catch {
					// Ignore cleanup failures.
				}
			}
			stopCapture();
			return false;
		}
	};

	const capture: LocalSpanCapture = {
		logFile,
		restore() {
			if (activeCapture !== capture) return;
			console.dir = originalDir;
			closeFile(true);
			closeDirectory();
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
			const line = Buffer.from(
				`${JSON.stringify({ timestamp: new Date().toISOString(), signal: "traces", record })}\n`,
			);
			if (line.byteLength > maxFileBytes) return;
			if (fileDescriptor === undefined && !openFile()) return;
			if (fileDescriptor === undefined || !fileStats) return;

			validateSameLogDirectory(logDir, directory, directoryDescriptor);
			const descriptorStats = fs.fstatSync(fileDescriptor);
			const linkedStats = fs.lstatSync(accessLogFile);
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (
				descriptorStats.nlink !== 1 ||
				!descriptorStats.isFile() ||
				(uid !== undefined && descriptorStats.uid !== uid) ||
				(descriptorStats.mode & 0o077) !== 0 ||
				linkedStats.isSymbolicLink() ||
				!sameFile(descriptorStats, linkedStats)
			) {
				stopCapture();
				return;
			}
			if (descriptorStats.size + line.byteLength > maxFileBytes) {
				stopCapture(false, false);
				return;
			}
			const originalSize = descriptorStats.size;
			let offset = 0;
			try {
				while (offset < line.byteLength) {
					const written = fs.writeSync(
						fileDescriptor,
						line,
						offset,
						line.byteLength - offset,
					);
					if (written <= 0) throw new Error("The telemetry log write made no progress.");
					offset += written;
				}
			} catch (error) {
				try {
					fs.ftruncateSync(fileDescriptor, originalSize);
				} catch {
					// A partial final line is tolerated if rollback itself fails.
				}
				throw error;
			}
			fileStats = fs.fstatSync(fileDescriptor);
			process.env.PI_OTEL_LOG_FILE = logFile;
			publishedLogFile = true;
		} catch {
			stopCapture();
			// Telemetry logging must never break Pi startup or execution.
		} finally {
			if (process.env.PI_OTEL_TEE_CONSOLE === "1") originalDir.call(console, value, options);
		}
	};

	return capture;
}
