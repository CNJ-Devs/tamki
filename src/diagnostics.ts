import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { ProviderError } from "./providers/provider";

// Deliberately allow only operational metadata. Never serialize request payloads,
// headers, raw errors, CLI arguments/stdout, prompts or provider response bodies.
const textFields = new Set([
  "connectionId",
  "jobId",
  "workId",
  "operation",
  "provider",
  "model",
  "phase",
  "field",
  "origin",
  "method",
  "errorCode",
  "errorName",
  "remoteRequestId",
  "version",
  "reason",
  "processType",
  "codecs",
]);
const numberFields = new Set([
  "durationMs",
  "quality",
  "firstEventMs",
  "firstTextMs",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedTokens",
  "status",
  "bytes",
  "eventCount",
  "terminalItems",
  "recoveredItems",
  "messageItems",
  "searchItems",
  "textLength",
  "files",
  "missingFiles",
  "duplicateFiles",
  "roots",
  "batches",
  "batch",
  "groups",
  "collections",
  "issues",
  "exitCode",
]);
export type LogDetails = Record<string, unknown>;
type Context = { traceId: string; spanId: string; parentSpanId?: string };
const context = new AsyncLocalStorage<Context>();
const sessionId = randomUUID();
let activeLog: RuntimeLog | undefined;

function metadata(details: LogDetails) {
  const result: LogDetails = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      numberFields.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      result[key] = value;
    else if (textFields.has(key) && typeof value === "string") {
      if (key === "origin") {
        try {
          result[key] = new URL(value).origin;
        } catch {
          /* no raw URL */
        }
      } else if (/^[a-zA-Z0-9_.:/ -]{1,160}$/.test(value)) result[key] = value;
    }
  }
  return result;
}
export function diagnosticError(error: unknown): LogDetails {
  const value = error as {
    name?: string;
    code?: unknown;
    cause?: { code?: unknown };
    issues?: unknown[];
  };
  const details: LogDetails = {
    errorName: [
      "Error",
      "TypeError",
      "SyntaxError",
      "AbortError",
      "TimeoutError",
      "ZodError",
    ].includes(value?.name || "")
      ? value.name
      : "Error",
  };
  if (error instanceof ProviderError && /^[a-zA-Z]{1,80}$/.test(error.code))
    details.errorCode = error.code;
  const networkCode = value?.cause?.code || value?.code;
  if (typeof networkCode === "string" && /^E[A-Z0-9_]{1,40}$/.test(networkCode))
    details.errorCode = networkCode;
  if (value?.name === "ZodError" && Array.isArray(value.issues))
    details.issues = value.issues.length;
  return details;
}

export class RuntimeLog {
  private size = 0;
  private file: string;
  constructor(
    private directory: string,
    private maxBytes = 2 * 1024 * 1024,
    private backups = 3,
  ) {
    this.file = path.join(directory, "runtime.log");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (existsSync(this.file)) this.size = statSync(this.file).size;
    } catch {
      /* logging must not prevent startup */
    }
  }
  write(
    event: string,
    details: LogDetails = {},
    level: "info" | "warn" | "error" = "info",
    trace?: Context,
  ) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(event)) return;
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        sessionId,
        ...trace,
        ...metadata(details),
      }) + "\n";
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size && this.size + bytes > this.maxBytes) {
        rmSync(path.join(this.directory, `runtime.${this.backups}.log`), {
          force: true,
        });
        for (let i = this.backups - 1; i >= 1; i--) {
          const previous = path.join(this.directory, `runtime.${i}.log`);
          if (existsSync(previous))
            renameSync(
              previous,
              path.join(this.directory, `runtime.${i + 1}.log`),
            );
        }
        if (existsSync(this.file))
          renameSync(this.file, path.join(this.directory, "runtime.1.log"));
        this.size = 0;
      }
      appendFileSync(this.file, line, { mode: 0o600 });
      this.size += bytes;
    } catch {
      /* a full disk or denied log directory must not fail the operation */
    }
  }
}
export function setRuntimeLog(log: RuntimeLog | undefined) {
  activeLog = log;
}
export function logEvent(
  event: string,
  details: LogDetails = {},
  level: "info" | "warn" | "error" = "info",
) {
  activeLog?.write(event, details, level, context.getStore());
}
export async function traced<T>(
  operation: string,
  details: LogDetails,
  run: () => Promise<T>,
): Promise<T> {
  const parent = context.getStore();
  return context.run(
    {
      traceId: parent?.traceId || randomUUID(),
      spanId: randomUUID(),
      parentSpanId: parent?.spanId,
    },
    async () => {
      const start = performance.now();
      logEvent(`${operation}.start`, details);
      try {
        const result = await run();
        logEvent(`${operation}.done`, {
          ...details,
          durationMs: Math.round(performance.now() - start),
        });
        return result;
      } catch (error) {
        logEvent(
          `${operation}.failed`,
          {
            ...details,
            ...diagnosticError(error),
            durationMs: Math.round(performance.now() - start),
          },
          "error",
        );
        throw error;
      }
    },
  );
}
export function observedFetch(request: typeof fetch): typeof fetch {
  return (input, init) => {
    let origin = "";
    try {
      origin = new URL(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url,
      ).origin;
    } catch {
      /* no URL logging */
    }
    const details = {
      origin,
      method: init?.method || (input instanceof Request ? input.method : "GET"),
    };
    return traced("http", details, async () => {
      const response = await request(input, init);
      // This duration covers response headers. The surrounding operation span
      // includes consuming/parsing the body and records stream failures too.
      logEvent(
        "http.headers",
        {
          ...details,
          status: response.status,
          remoteRequestId:
            response.headers.get("x-request-id") ||
            response.headers.get("request-id"),
        },
        response.ok ? "info" : "warn",
      );
      return response;
    });
  };
}
