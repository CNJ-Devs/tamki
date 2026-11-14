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
import { sourceConfig } from "../shared/settings";
import { builtinRecognition } from "../providers/metadata";
import { aiRecognitionBatches } from "../providers/ai-recognition";
import { parseFilename } from "./filename";
import { ProviderError } from "../providers/provider";
export class RecognitionService {
  private jobs = new Map<string, AbortController>();
  constructor(
    private store: LibraryStore,
    private settings: SettingsService,
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
    const request = recognitionRequestSchema.parse(value);
    if (this.jobs.has(request.jobId) || this.jobs.size >= 4)
      throw new ProviderError("recognitionBusy");
    const work = this.store
      .snapshot()
      .works.find((w) => w.id === request.draft.id);
    if (!work) throw new ProviderError("mediaMissing");
    const config = this.settings.snapshot().recognition;
    const source = config.sources.find((s) => s.id === request.sourceId);
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
          };
        })
        .filter((f) => request.scope === "work" || f.id === request.episodeId);
      if (!files.length || (request.scope === "file" && files.length !== 1))
        throw new ProviderError("invalidInput");
      const input: RecognitionInput = {
        title: request.query,
        scope: request.scope,
        files,
      };
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
          net.fetch.bind(net) as typeof fetch,
        );
      } else {
        if (!source) throw new ProviderError("recognitionSourceMissing");
        response = await aiRecognitionBatches(
          sourceConfig(source),
          this.settings.secret(source.id, "key"),
          this.settings.secret(source.id, "search"),
          input,
          config.aiPrompt,
          controller.signal,
          net.fetch.bind(net) as typeof fetch,
        );
      }
      controller.signal.throwIfAborted();
      if (response.kind === "result")
        response.result = validateRecognition(response.result, input);
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
