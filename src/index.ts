import { SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
	BasicTracerProvider,
	ConsoleSpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";

import { installLocalSpanCapture, type LocalSpanCapture } from "./local-capture.ts";

type EventContext = {
	mode: string;
	sessionManager: { getSessionId(): string };
	model?: {
		api?: string;
		id?: string;
		provider?: string;
	};
};

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
};

function isDisabled(): boolean {
	return (
		/^(1|true|yes)$/i.test(process.env.OTEL_SDK_DISABLED ?? "") ||
		process.env.OTEL_TRACES_EXPORTER?.toLowerCase() === "none"
	);
}

function contextAttributes(ctx: EventContext): Attributes {
	const attributes: Attributes = {
		"pi.mode": ctx.mode,
		"pi.session.id": ctx.sessionManager.getSessionId(),
		"telemetry.destination": "local",
	};
	if (ctx.model?.provider) attributes["gen_ai.provider.name"] = ctx.model.provider;
	if (ctx.model?.id) attributes["gen_ai.request.model"] = ctx.model.id;
	if (ctx.model?.api) attributes["pi.model.api"] = ctx.model.api;
	return attributes;
}

function usageAttributes(usage: Usage): Attributes {
	const attributes: Attributes = {};
	const values: Array<[string, number | undefined]> = [
		["gen_ai.usage.input_tokens", usage.input],
		["gen_ai.usage.output_tokens", usage.output],
		["pi.usage.cache_read_tokens", usage.cacheRead],
		["pi.usage.cache_write_tokens", usage.cacheWrite],
		["pi.usage.reasoning_tokens", usage.reasoning],
		["pi.usage.total_tokens", usage.totalTokens],
		["pi.cost.input", usage.cost?.input],
		["pi.cost.output", usage.cost?.output],
		["pi.cost.cache_read", usage.cost?.cacheRead],
		["pi.cost.cache_write", usage.cost?.cacheWrite],
		["pi.cost.total", usage.cost?.total],
	];
	for (const [key, value] of values) {
		if (typeof value === "number" && Number.isFinite(value)) attributes[key] = value;
	}
	return attributes;
}

function finishSpan(span: Span | undefined, isError = false, attributes?: Attributes): void {
	if (!span) return;
	if (attributes) span.setAttributes(attributes);
	if (isError) span.setStatus({ code: SpanStatusCode.ERROR });
	span.end();
}

type EventOf<T extends ExtensionEvent["type"]> = Extract<ExtensionEvent, { type: T }>;

function guard<T extends ExtensionEvent["type"]>(handler: (event: EventOf<T>, ctx: EventContext) => void) {
	return (event: EventOf<T>, ctx: EventContext) => {
		try {
			handler(event, ctx);
		} catch {
			// Telemetry must never change Pi behavior.
		}
	};
}

export default function localOtel(pi: ExtensionAPI): void {
	if (isDisabled()) return;

	let capture: LocalSpanCapture;
	try {
		capture = installLocalSpanCapture();
	} catch {
		console.warn("[pi-local-otel] Local JSONL capture is unavailable; telemetry is disabled.");
		return;
	}

	const resource = defaultResource().merge(
		resourceFromAttributes({
			[ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "pi-coding-agent",
			"service.namespace": "aab",
			"deployment.environment.name": "local",
		}),
	);
	const provider = new BasicTracerProvider({
		resource,
		spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
	});
	const tracer = provider.getTracer("pi-local-otel", "0.1.0");

	let sessionSpan: Span | undefined;
	let agentSpan: Span | undefined;
	let turnSpan: Span | undefined;
	let providerSpan: Span | undefined;
	const toolSpans = new Map<string, Span>();

	pi.on(
		"session_start",
		guard<"session_start">((event, ctx) => {
			finishSpan(sessionSpan);
			sessionSpan = tracer.startSpan("pi.session", {
				attributes: { ...contextAttributes(ctx), "pi.session.start_reason": event.reason },
			});
		}),
	);

	pi.on(
		"before_agent_start",
		guard<"before_agent_start">((_event, ctx) => {
			finishSpan(agentSpan, true);
			agentSpan = tracer.startSpan("pi.agent", { attributes: contextAttributes(ctx) });
		}),
	);

	pi.on(
		"turn_start",
		guard<"turn_start">((event, ctx) => {
			finishSpan(turnSpan, true);
			turnSpan = tracer.startSpan("pi.turn", {
				attributes: { ...contextAttributes(ctx), "pi.turn.index": event.turnIndex },
				startTime: event.timestamp,
			});
		}),
	);

	pi.on(
		"turn_end",
		guard<"turn_end">((event) => {
			finishSpan(turnSpan, false, { "pi.turn.tool_result_count": event.toolResults.length });
			turnSpan = undefined;
		}),
	);

	pi.on(
		"before_provider_request",
		guard<"before_provider_request">((_event, ctx) => {
			finishSpan(providerSpan, true);
			providerSpan = tracer.startSpan("pi.provider.request", {
				attributes: { ...contextAttributes(ctx), "gen_ai.operation.name": "chat" },
			});
		}),
	);

	pi.on(
		"after_provider_response",
		guard<"after_provider_response">((event) => {
			finishSpan(providerSpan, event.status >= 400, { "http.response.status_code": event.status });
			providerSpan = undefined;
		}),
	);

	pi.on(
		"message_end",
		guard<"message_end">((event, ctx) => {
			const message = event.message;
			if (message?.role !== "assistant") return;
			const attributes: Attributes = {
				...contextAttributes(ctx),
				...usageAttributes(message.usage ?? {}),
				"gen_ai.operation.name": "chat",
				"gen_ai.response.finish_reason": message.stopReason,
				"gen_ai.response.model": message.responseModel || message.model,
			};
			const span = tracer.startSpan("pi.llm.response", { attributes });
			finishSpan(span, message.stopReason === "error");
		}),
	);

	pi.on(
		"tool_execution_start",
		guard<"tool_execution_start">((event, ctx) => {
			const existing = toolSpans.get(event.toolCallId);
			finishSpan(existing, true);
			toolSpans.set(
				event.toolCallId,
				tracer.startSpan("pi.tool", {
					attributes: {
						...contextAttributes(ctx),
						"gen_ai.tool.call.id": event.toolCallId,
						"gen_ai.tool.name": event.toolName,
					},
				}),
			);
		}),
	);

	pi.on(
		"tool_execution_end",
		guard<"tool_execution_end">((event) => {
			const span = toolSpans.get(event.toolCallId);
			finishSpan(span, event.isError, {
				"gen_ai.tool.call.id": event.toolCallId,
				"gen_ai.tool.name": event.toolName,
				"pi.tool.is_error": event.isError,
			});
			toolSpans.delete(event.toolCallId);
		}),
	);

	pi.on(
		"session_compact",
		guard<"session_compact">((event, ctx) => {
			const span = tracer.startSpan("pi.session.compact", {
				attributes: {
					...contextAttributes(ctx),
					"pi.compaction.reason": event.reason,
					"pi.compaction.will_retry": event.willRetry,
				},
			});
			span.end();
		}),
	);

	pi.on(
		"model_select",
		guard<"model_select">((event, ctx) => {
			const span = tracer.startSpan("pi.model.select", {
				attributes: {
					...contextAttributes(ctx),
					"gen_ai.request.model": event.model.id,
					"gen_ai.provider.name": event.model.provider,
					"pi.model.selection_source": event.source,
				},
			});
			span.end();
		}),
	);

	pi.on(
		"thinking_level_select",
		guard<"thinking_level_select">((event, ctx) => {
			const span = tracer.startSpan("pi.thinking.select", {
				attributes: {
					...contextAttributes(ctx),
					"pi.thinking.level": event.level,
					"pi.thinking.previous_level": event.previousLevel,
				},
			});
			span.end();
		}),
	);

	pi.on(
		"agent_settled",
		guard<"agent_settled">((_event) => {
			finishSpan(providerSpan, true);
			providerSpan = undefined;
			finishSpan(turnSpan, true);
			turnSpan = undefined;
			for (const span of toolSpans.values()) finishSpan(span, true);
			toolSpans.clear();
			finishSpan(agentSpan);
			agentSpan = undefined;
		}),
	);

	pi.on("session_shutdown", async (event) => {
		try {
			finishSpan(providerSpan, true);
			finishSpan(turnSpan, true);
			for (const span of toolSpans.values()) finishSpan(span, true);
			toolSpans.clear();
			finishSpan(agentSpan, true);
			finishSpan(sessionSpan, false, { "pi.session.shutdown_reason": event.reason });
			await provider.forceFlush();
			await provider.shutdown();
		} catch {
			// Telemetry shutdown must never change Pi behavior.
		} finally {
			capture.restore();
		}
	});
}
