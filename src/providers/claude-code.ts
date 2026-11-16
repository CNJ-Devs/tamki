import { traced, logEvent } from "../diagnostics";
import type { StructuredTask, StructuredResponse } from "./ai-recognition";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type {
  SourceConfig,
  OAuthAccount,
  ModelOption,
} from "../shared/settings";
import {
  recognitionPrompt,
  recognitionSystem,
  recognitionOutputSchema,
  type RecognitionInput,
  type RecognitionResponse,
  type Citation,
} from "../shared/recognition";
import { parseAIResult } from "./ai-recognition";
import { ProviderError } from "./provider";

export interface RuntimeCall {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  input?: string;
  capture?: boolean;
  controlId?: string;
}
export type RuntimeRunner = (
  call: RuntimeCall,
) => Promise<{ code: number; output: string }>;

/** Never invokes a shell or forwards raw child-process errors to the renderer. */
export const runOfficialCLI: RuntimeRunner = (call) =>
  traced("ai.cli", { provider: "claude-code" }, async () => {
    const result = await executeOfficialCLI(call);
    logEvent(
      "ai.cli.exit",
      { exitCode: result.code },
      result.code === 0 ? "info" : "warn",
    );
    return result;
  });
const executeOfficialCLI: RuntimeRunner = (call) =>
  new Promise((resolve, reject) => {
    call.signal.throwIfAborted();
    const child = spawn(call.executable, call.args, {
      cwd: call.cwd,
      env: call.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      line = "",
      bytes = 0,
      failure: string | undefined;
    const decoder = new StringDecoder("utf8");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => {
      failure = "oauthCancelled";
      stop();
    };
    call.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        failure = "recognitionTooLarge";
        stop();
        return;
      }
      if (call.capture === false) return;
      const text = decoder.write(chunk);
      output += text;
      if (call.controlId) {
        line += text;
        for (;;) {
          const end = line.indexOf("\n");
          if (end < 0) break;
          const item = line.slice(0, end);
          line = line.slice(end + 1);
          try {
            const event = JSON.parse(item);
            if (
              event.type === "control_response" &&
              event.response?.request_id === call.controlId
            )
              child.stdin.end();
          } catch {
            /* bounded protocol output is validated by the caller */
          }
        }
      }
    });
    // Auth output may contain codes; never retain or expose it. stderr is bounded as well.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        failure = "recognitionTooLarge";
        stop();
      }
    });
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      call.signal.removeEventListener("abort", abort);
    };
    child.on("error", () => {
      cleanup();
      reject(new ProviderError("claudeRuntimeUnavailable"));
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      cleanup();
      output += decoder.end();
      failure
        ? reject(new ProviderError(failure))
        : resolve({ code: code ?? 1, output });
    });
    if (call.controlId) child.stdin.write(call.input || "");
    else child.stdin.end(call.input);
  });

interface Options {
  root: string;
  runner?: RuntimeRunner;
  resolve?: (configured: string) => Promise<string>;
}
export class ClaudeCode {
  private jobs = new Map<string, Set<AbortController>>();
  private auth = new Set<string>();
  constructor(private options: Options) {}
  cancel(id: string) {
    for (const job of this.jobs.get(id) || []) job.abort();
  }
  close() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }
  private async executable(configured: string) {
    if (this.options.resolve) return this.options.resolve(configured);
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    const candidates = configured
      ? [configured]
      : [
          path.join(os.homedir(), ".local", "bin", name),
          ...[
            ...(process.env.PATH || "").split(path.delimiter),
            "/opt/homebrew/bin",
            "/usr/local/bin",
          ]
            .filter(Boolean)
            .map((p) => path.join(p, name)),
        ];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* try next installed location */
      }
    }
    throw new ProviderError("claudeNotInstalled");
  }
  private async run(
    source: SourceConfig,
    args: string[],
    signal?: AbortSignal,
    extra: Partial<RuntimeCall> = {},
  ) {
    const controller = new AbortController();
    const jobs = this.jobs.get(source.id) || new Set<AbortController>();
    jobs.add(controller);
    this.jobs.set(source.id, jobs);
    const timeout = AbortSignal.timeout(source.timeoutSeconds * 1000);
    const combined = AbortSignal.any([
      controller.signal,
      timeout,
      ...(signal ? [signal] : []),
    ]);
    try {
      if (!this.options.root)
        throw new ProviderError("claudeRuntimeUnavailable");
      const executable = await this.executable(source.runtimePath);
      const directory = path.join(
        this.options.root,
        createHash("sha256").update(source.id).digest("hex"),
      );
      const cwd = path.join(directory, "work");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      await mkdir(path.join(directory, "config"), {
        recursive: true,
        mode: 0o700,
      });
      combined.throwIfAborted();
      const env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: path.join(directory, "config"),
        PATH: [
          process.env.PATH || "",
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
        ].join(path.delimiter),
      };
      return await (this.options.runner || runOfficialCLI)({
        ...extra,
        executable,
        args,
        cwd,
        env,
        signal: combined,
      });
    } catch (e) {
      if (combined.aborted)
        throw new ProviderError(
          timeout.aborted ? "requestTimeout" : "oauthCancelled",
        );
      throw e instanceof ProviderError
        ? e
        : new ProviderError("claudeRuntimeUnavailable");
    } finally {
      jobs.delete(controller);
      if (!jobs.size) this.jobs.delete(source.id);
    }
  }
  async status(
    source: SourceConfig,
    signal?: AbortSignal,
  ): Promise<OAuthAccount> {
    const response = await this.run(
      { ...source, timeoutSeconds: Math.min(30, source.timeoutSeconds) },
      ["auth", "status"],
      signal,
    );
    try {
      const data = z
        .object({
          loggedIn: z.boolean(),
          authMethod: z.string(),
          email: z.string().max(320).nullish(),
          subscriptionType: z.string().nullish(),
        })
        .parse(JSON.parse(response.output));
      return {
        email: data.email || "",
        status:
          response.code === 0 && data.loggedIn ? "connected" : "signedOut",
        billing: data.authMethod === "claude.ai" ? "subscription" : "api",
      };
    } catch {
      throw new ProviderError("claudeRuntimeUnavailable");
    }
  }
  async signIn(source: SourceConfig) {
    if (this.auth.has(source.id)) throw new ProviderError("oauthBusy");
    this.auth.add(source.id);
    try {
      const result = await this.run(source, ["auth", "login"], undefined, {
        capture: false,
      });
      if (result.code) throw new ProviderError("authorizationFailed");
      return await this.status(source);
    } finally {
      this.auth.delete(source.id);
    }
  }
  async signOut(source: SourceConfig) {
    this.cancel(source.id);
    // Wait for any in-flight official login to stop before its logout can run.
    for (let n = 0; this.auth.has(source.id) && n < 100; n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.auth.has(source.id)) return false;
    try {
      return (
        (
          await this.run(source, ["auth", "logout"], undefined, {
            capture: false,
          })
        ).code === 0
      );
    } catch {
      return false;
    }
  }
  private flags() {
    return [
      "-p",
      "--restricted",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-session-persistence",
    ];
  }
  async models(source: SourceConfig): Promise<ModelOption[]> {
    const status = await this.status(source);
    if (status.status !== "connected")
      throw new ProviderError("accountSignInRequired");
    const requestId = randomUUID();
    const response = await this.run(
      source,
      [
        ...this.flags(),
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
      ],
      undefined,
      {
        controlId: requestId,
        input:
          JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request: { subtype: "initialize" },
          }) + "\n",
      },
    );
    try {
      if (response.code) throw new Error();
      const event = response.output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (e) =>
            e.type === "control_response" &&
            e.response?.request_id === requestId,
        );
      if (event?.response?.subtype !== "success") throw new Error();
      return z
        .array(
          z.object({
            value: z.string().min(1).max(200),
            displayName: z.string().min(1).max(300),
          }),
        )
        .min(1)
        .max(1000)
        .parse(event.response.response.models)
        .map((m) => ({ id: m.value, name: m.displayName }));
    } catch {
      throw new ProviderError("claudeModelsFailed");
    }
  }
  async structured(
    source: SourceConfig,
    task: StructuredTask,
    signal: AbortSignal,
  ): Promise<StructuredResponse> {
    const status = await this.status(source, signal);
    if (status.status !== "connected")
      throw new ProviderError("accountSignInRequired");
    const schema = { ...task.schema };
    delete schema.$schema;
    const searching = source.searchMode === "native";
    const tools = searching
      ? ["WebSearch", ...(source.readPages ? ["WebFetch"] : [])]
      : [];
    const response = await this.run(
      source,
      [
        ...this.flags(),
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        source.model,
        "--tools",
        tools.join(","),
        ...(tools.length ? ["--allowedTools", tools.join(",")] : []),
        "--append-system-prompt",
        task.system +
          (searching
            ? " Use WebSearch to verify facts before returning metadata."
            : ""),
        "--json-schema",
        JSON.stringify(schema),
      ],
      signal,
      { input: task.prompt },
    );
    let result: any;
    const searches = new Set<string>(),
      completed = new Set<string>(),
      citations: Citation[] = [];
    try {
      for (const line of response.output.split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.type === "result") {
          if (result) throw new Error();
          result = event;
        }
        if (event.type === "assistant")
          for (const part of event.message?.content || [])
            if (part.type === "tool_use" && part.name === "WebSearch")
              searches.add(part.id);
        if (event.type === "user")
          for (const part of event.message?.content || []) {
            if (
              part.type !== "tool_result" ||
              part.is_error ||
              !searches.has(part.tool_use_id)
            )
              continue;
            const text =
              typeof part.content === "string"
                ? part.content
                : JSON.stringify(part.content);
            const links = text.match(/https?:\/\/[^\s<>"\\)\]]+/g) || [];
            for (const url of links) {
              try {
                const u = new URL(url);
                if (u.username || u.password || url.length > 8192) continue;
              } catch {
                continue;
              }
              if (!citations.some((c) => c.url === url))
                citations.push({ url, title: url });
            }
            if (links.length) completed.add(part.tool_use_id);
          }
      }
    } catch {
      throw new ProviderError("recognitionInvalid");
    }
    if (response.code || result?.is_error || result?.subtype !== "success")
      throw new ProviderError(
        result?.subtype === "error_max_structured_output_retries"
          ? "recognitionInvalid"
          : "recognitionFailed",
      );
    signal.throwIfAborted();
    if (searching && (!completed.size || !citations.length))
      throw new ProviderError("oauthSearchUnverified");
    const text = result.structured_output
      ? JSON.stringify(result.structured_output)
      : result.result;
    if (typeof text !== "string" || !text)
      throw new ProviderError("recognitionInvalid");
    return { text, citations: citations.slice(0, 100) };
  }
  async recognize(
    source: SourceConfig,
    input: RecognitionInput,
    template: string,
    signal: AbortSignal,
  ): Promise<RecognitionResponse> {
    const response = await this.structured(
      source,
      {
        system: recognitionSystem(input),
        prompt: recognitionPrompt(input, template),
        schema: z.toJSONSchema(recognitionOutputSchema),
        name: "tamki_metadata",
        queries: [],
      },
      signal,
    );
    return {
      kind: "result",
      result: parseAIResult(response.text, input),
      citations: response.citations,
    };
  }
}
