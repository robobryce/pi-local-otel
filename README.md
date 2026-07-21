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

Each Pi process lazily creates one mode-`0600` JSONL file in a mode-`0700` directory when its first span is ready. It does not create empty files merely because Pi started. The extension holds verified directory and file descriptors, uses exclusive/no-follow creation, and stops capture if an inode, owner, or private mode changes. On Linux, file operations are anchored through the held directory descriptor; other platforms use identity checks around pathname operations. Existing log directories must already be private, owned by the current user, and not be symbolic links; telemetry stays disabled if the local sink cannot be opened safely.

Persistent storage is controlled by two positive-integer settings:

- `PI_OTEL_MAX_FILE_BYTES` caps one process file at 8 MiB by default. Capture stops at the boundary instead of rotating into more files.
- `PI_OTEL_MAX_FILES` targets 20 managed process files for this node by default. At startup and first write, oversized and oldest inactive files are removed, with empty inactive files preferred. Files whose recorded PID may still be alive are never unlinked; PID reuse can therefore retain a stale file. Concurrent active processes may temporarily exceed the target instead of disabling every new capture. A later startup or first write repairs the count after those processes exit.

New filenames contain a one-way-hashed node identity and, when the OS supplies a stable one, boot identity. Without a stable boot ID, retention conservatively relies on PID liveness. Retention only manages files attributed to the current node; it preserves and excludes files from other nodes and the legacy pre-retention filename format because their process liveness cannot be established safely. On a shared log directory the limit is therefore per node, not directory-wide. A one-time manual cleanup is required for legacy files after confirming no old Pi process is using them. A node-local `PI_OTEL_LOG_DIR` is recommended; changing the machine identity or hostname also starts a new protected node scope.

With no active-process overage, the defaults bound this node's extension-managed private history to 160 MiB. Simultaneous active creators can temporarily exceed the file-count target; each still has its own byte ceiling, and later activity repairs the retained count. Invalid or zero limit values fall back to the bounded defaults. Retention only considers private, singly linked regular files with the extension's strict current filename format, and symbolic links are excluded. `PI_OTEL_LOG_FILE` is cleared for a new capture and published only after its first complete record is written.

Set `PI_OTEL_LOG_DIR` to choose another directory or `PI_OTEL_TEE_CONSOLE=1` to retain the exporter output on the console as well. Set `OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` to disable the extension.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:audit
```
