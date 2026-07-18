# pi-local-otel

Local, metadata-only OpenTelemetry tracing for the [Pi coding agent](https://github.com/earendil-works/pi).

The extension maps Pi lifecycle events to spans using the official OpenTelemetry JavaScript API and trace SDK. `ConsoleSpanExporter` output is selectively captured in private JSONL files under `~/.pi/agent/debug/`; no collector, OTLP exporter, telemetry server, or network endpoint is configured.

## Install

Pin installations to an immutable commit:

```bash
pi install git:github.com/robobryce/pi-local-otel@COMMIT
```

## Data policy

Spans contain lifecycle names, session/model/tool identifiers, durations, status, token usage, cache usage, and reported cost. They never include prompts, responses, message content, tool arguments, tool results, headers, raw provider payloads, working directories, or error text.

Each Pi process writes a unique mode-`0600` JSONL file in a mode-`0700` directory. Set `PI_OTEL_LOG_DIR` to choose another directory or `PI_OTEL_TEE_CONSOLE=1` to retain the exporter output on the console as well. Set `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` to disable the extension.

## Development

```bash
npm ci
npm test
npm run test:audit
```
