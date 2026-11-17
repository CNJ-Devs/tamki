import {
  observedFetch,
  traced,
  logEvent,
  diagnosticError,
} from "../diagnostics";
import { net } from "electron";
import {
  recognitionRequestSchema,
  validateRecognition,
  type RecognitionInput,
  type RecognitionResponse,
} from "../shared/recognition";
import type { Episode } from "../shared/model";
import type { LibraryStore } from "./store";
import type { SettingsService } from "./settings";
import { builtinRecognition } from "../providers/metadata";
import { bilibiliRecognition } from "../providers/bilibili-metadata";
import {
  aiRecognitionBatches,
  aiStructured,
  type StructuredTask,
} from "../providers/ai-recognition";
import { MetadataBatchPool, recognizeMany } from "../providers/metadata-batch";
import { parseFilename } from "./filename";
import { ProviderError } from "../providers/provider";
import type { ArtworkCache } from "./artwork";
export class RecognitionService {
  private jobs = new Map<string, AbortController>();
  private batches = new MetadataBatchPool();
  constructor(
    private store: LibraryStore,
    private settings: SettingsService,
    private artwork: ArtworkCache,
  ) {}
  cancel(id: string) {
    this.jobs.get(id)?.abort();
  }
  close() {
    for (const job of this.jobs.values()) job.abort();
  }
  async run(
    value: unknown,
    prepare: (
      draft: ReturnType<typeof recognitionRequestSchema.parse>["draft"],
    ) => Promise<Episode[]>,
  ): Promise<RecognitionResponse> {
    const input = recognitionRequestSchema.parse(value);
    return traced(
      "recognition",
      { jobId: input.jobId, workId: input.draft.id, phase: input.scope },
      () => this.execute(value, prepare),
    );
  }
  private async execute(
    value: unknown,
    prepare: (
      draft: ReturnType<typeof recognitionRequestSchema.parse>["draft"],
    ) => Promise<Episode[]>,
  ): Promise<RecognitionResponse> {
    const request = recognitionRequestSchema.parse(value);
    if (this.jobs.has(request.jobId) || this.jobs.size >= 4)
      throw new ProviderError("recognitionBusy");
    const work = this.store
      .snapshot()
      .works.find((w) => w.id === request.draft.id);
    if (!work) throw new ProviderError("mediaMissing");
    const config = this.settings.snapshot().recognition;
    const source = this.settings.recognitionSelection(
      request.sourceId,
      request.model,
    );
    const controller = new AbortController();
    this.jobs.set(request.jobId, controller);
    const timer = setTimeout(
      () => controller.abort("timeout"),
      (source?.timeoutSeconds || 300) * 1000,
    );
    try {
      const additions = await prepare(request.draft);
      controller.signal.throwIfAborted();
      const available = new Map(
        [...work.episodes, ...additions].map((e) => [e.id, e]),
      );
      const ids = new Set<string>();
      const files = request.draft.episodes
        .map((e, order) => {
          const file = available.get(e.id);
          if (!file || ids.has(e.id)) throw new ProviderError("invalidInput");
          ids.add(e.id);
          return {
            id: e.id,
            filename: file.fileName,
            duration: file.duration,
            order: order + 1,
            ...(request.batch
              ? {
                  missing: (["number", "title", "description"] as const).filter(
                    (field) => !e[field],
                  ),
                }
              : {}),
            ...(file.versions && file.versions.length > 1
              ? {
                  versions: file.versions.map((v) => ({
                    label: v.label,
                    files: v.files.map((f) => ({
                      filename: f.fileName,
                      duration: f.duration,
                    })),
                  })),
                }
              : {}),
          };
        })
        .filter((f) => request.scope === "work" || f.id === request.episodeId);
      if (!files.length || (request.scope === "file" && files.length !== 1))
        throw new ProviderError("invalidInput");
      const input: RecognitionInput = {
        title: request.query,
        scope: request.scope,
        files,
        ...(request.batch
          ? {
              missing: (["description", "tags", "cover"] as const).filter(
                (field) =>
                  field === "tags" ? !work.tags.length : !work[field],
              ),
            }
          : {}),
      };
      if (request.feedback) {
        if (!source || request.candidate)
          throw new ProviderError("invalidInput");
        const previous = validateRecognition(request.feedback.previous, input);
        if (previous.work?.cover && !previous.work.cover.startsWith("https://"))
          previous.work.cover = null;
        input.feedback = { previous, messages: request.feedback.messages };
      }
      let response: RecognitionResponse;
      if (request.sourceId === "filename") {
        response = {
          kind: "result",
          citations: [],
          result: {
            work: null,
            files: files.map((f) => {
              const parsed = parseFilename(f.filename, config.parser);
              return {
                id: f.id,
                number: parsed.number,
                title: parsed.episodeTitle,
                description: null,
              };
            }),
          },
        };
      } else if (request.sourceId === "bilibili") {
        response = await bilibiliRecognition(
          input,
          request.candidate,
          config.parser,
          controller.signal,
          observedFetch(net.fetch.bind(net) as typeof fetch),
        );
      } else if (
        request.sourceId === "bangumi" ||
        request.sourceId === "tmdb"
      ) {
        response = await builtinRecognition(
          request.sourceId,
          input,
          request.candidate,
          config.parser,
          request.sourceId === "tmdb"
            ? this.settings.secret("tmdb", "key")
            : "",
          this.store.preferences().language,
          controller.signal,
          observedFetch(net.fetch.bind(net) as typeof fetch),
        );
      } else {
        if (!source) throw new ProviderError("recognitionSourceMissing");
        const runtime = this.settings.recognitionRuntime(source);
        const managed = ["gemini-oauth", "claude-code"].includes(
          source.provider,
        );
        const requestAI =
          source.provider === "openai-oauth"
            ? this.settings.oauth.request(runtime.id)
            : observedFetch(net.fetch.bind(net) as typeof fetch);
        const key =
          source.provider === "openai-oauth"
            ? "oauth-managed"
            : this.settings.secret(runtime.id, "key");
        const searchKey = this.settings.secret(source.id, "search");
        const single = (part: RecognitionInput, signal: AbortSignal) =>
          managed
            ? this.settings.accounts.recognize(
                runtime,
                part,
                config.aiPrompt,
                signal,
              )
            : aiRecognitionBatches(
                runtime,
                key,
                searchKey,
                part,
                config.aiPrompt,
                signal,
                requestAI,
              );
        const structured = (task: StructuredTask, signal: AbortSignal) =>
          managed
            ? this.settings.accounts.structured(runtime, task, signal)
            : aiStructured(runtime, key, searchKey, task, signal, requestAI);
        response =
          request.batch && request.scope === "work"
            ? await this.batches.submit(
                JSON.stringify([request.sourceId, runtime, config.aiPrompt]),
                input,
                controller.signal,
                (inputs, signal) =>
                  recognizeMany(
                    inputs,
                    config.aiPrompt,
                    signal,
                    structured,
                    single,
                  ),
              )
            : await single(input, controller.signal);
      }
      controller.signal.throwIfAborted();
      if (response.kind === "result") {
        response.result = validateRecognition(response.result, input);
        if (response.result.work?.cover || response.result.work?.coverPage) {
          response.artworkSource = {
            cover: response.result.work.cover || null,
            coverPage: response.result.work.coverPage || null,
          };
          try {
            response.result.work.cover = await this.artwork.resolve(
              response.result.work.cover,
              response.result.work.coverPage,
              controller.signal,
            );
          } catch (error) {
            response.result.work.cover = null;
            response.artworkError = true;
            logEvent(
              "recognition.artwork.failed",
              { reason: "unavailable", ...diagnosticError(error) },
              "warn",
            );
          }
        }
      }
      controller.signal.throwIfAborted();
      return response;
    } catch (error) {
      if (controller.signal.aborted)
        throw new ProviderError(
          controller.signal.reason === "timeout"
            ? "requestTimeout"
            : "recognitionCancelled",
        );
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        error instanceof Error && error.message === "recognitionScopeInvalid"
          ? "recognitionScopeInvalid"
          : "recognitionFailed",
      );
    } finally {
      clearTimeout(timer);
      this.jobs.delete(request.jobId);
    }
  }
}
