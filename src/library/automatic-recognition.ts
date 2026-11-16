import { randomUUID } from "node:crypto";
import type { Work } from "../shared/model";
import type {
  RecognitionRequest,
  RecognitionResponse,
} from "../shared/recognition";
import type { LibraryStore } from "./store";
import type { SettingsService } from "./settings";
import { automaticCandidate } from "./automatic-match";

interface Recognizer {
  run(
    value: RecognitionRequest,
    prepare: () => Promise<never[]>,
  ): Promise<RecognitionResponse>;
  cancel(id: string): void;
}
/** Persisted work states form the queue. One background request at a time. */
export class AutomaticRecognition {
  private task?: Promise<void>;
  private stopped = false;
  private suspended = false;
  private job?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  constructor(
    private store: LibraryStore,
    private settings: Pick<SettingsService, "snapshot">,
    private recognizer: Recognizer,
    private emit: () => void,
    private delay = 700,
  ) {}
  start() {
    for (const work of this.store.snapshot().works)
      if (work.recognition?.status === "running")
        this.store.setRecognition(work.id, {
          ...work.recognition,
          status: "queued",
        });
    this.schedule();
  }
  schedule(retryIds: string[] = []) {
    if (this.stopped || this.suspended) return;
    const config = this.settings.snapshot().recognition;
    if (config.automatic === false) {
      if (this.job) this.recognizer.cancel(this.job);
      return;
    }
    this.store.queueRecognition(config.defaultSourceId, retryIds);
    this.emit();
    if (!this.task)
      this.task = this.drain().finally(() => {
        this.task = undefined;
      });
  }
  private async drain() {
    while (
      !this.stopped &&
      !this.suspended &&
      this.settings.snapshot().recognition.automatic !== false
    ) {
      const work = this.store
        .snapshot()
        .works.find(
          (w) =>
            w.recognition?.status === "queued" &&
            w.episodes.some((e) => !e.missing),
        );
      if (!work) return;
      const state = { ...work.recognition!, status: "running" as const };
      work.recognition = state;
      this.store.setRecognition(work.id, state);
      this.emit();
      try {
        const sourceId = state.sourceId;
        this.job = `auto-${randomUUID()}`;
        const request: RecognitionRequest = {
          jobId: this.job,
          sourceId,
          scope: "work",
          query: work.title.slice(0, 500),
          candidate: state.candidate,
          draft: {
            id: work.id,
            title: work.title.slice(0, 500),
            description: work.description,
            tags: work.tags,
            removedEpisodeIds: [],
            attachments: [],
            episodes: work.episodes.map(
              ({ id, number, title, description }) => ({
                id,
                number,
                title,
                description,
              }),
            ),
          },
        };
        let response = await this.recognizer.run(request, async () => []);
        for (
          let round = 0;
          response.kind === "candidates" && round < 2;
          round++
        ) {
          const candidate = automaticCandidate(
            work,
            response.candidates,
            this.settings.snapshot().recognition.parser,
          );
          if (!candidate) break;
          request.candidate = candidate;
          state.candidate = candidate;
          response = await this.recognizer.run(request, async () => []);
        }
        if (
          this.stopped ||
          this.suspended ||
          this.settings.snapshot().recognition.automatic === false
        ) {
          this.finish(work, { ...state, status: "queued" });
          return;
        }
        if (response.kind === "candidates")
          this.finish(work, {
            ...state,
            status: response.candidates.length ? "needs-choice" : "no-match",
          });
        else
          this.store.applyAutomatic(work, response.result, {
            ...state,
            status:
              sourceId === "filename"
                ? "local"
                : response.result.work?.description ||
                    response.result.work?.cover ||
                    response.result.work?.tags?.length ||
                    response.result.files.some((f) => f.title || f.description)
                  ? "complete"
                  : "no-match",
            artworkError: response.artworkError,
            artworkSource: response.artworkSource,
          });
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "recognitionFailed";
        const cancelled =
          this.stopped ||
          this.suspended ||
          this.settings.snapshot().recognition.automatic === false;
        this.finish(work, {
          ...state,
          status: cancelled || code === "recognitionBusy" ? "queued" : "failed",
          error: cancelled ? undefined : code,
        });
        if (cancelled) return;
      } finally {
        this.job = undefined;
        this.emit();
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, this.delay);
      });
      this.timer = undefined;
      this.wake = undefined;
    }
  }
  private finish(work: Work, next: NonNullable<Work["recognition"]>) {
    const current = this.store.snapshot().works.find((w) => w.id === work.id);
    if (
      current?.recognition?.signature === work.recognition?.signature &&
      current?.recognition?.status === "running"
    )
      this.store.setRecognition(work.id, next);
  }
  async pause() {
    this.suspended = true;
    if (this.job) this.recognizer.cancel(this.job);
    clearTimeout(this.timer);
    this.wake?.();
    await this.task;
  }
  resume() {
    this.suspended = false;
    this.schedule();
  }
  async close() {
    this.stopped = true;
    if (this.job) this.recognizer.cancel(this.job);
    clearTimeout(this.timer);
    this.wake?.();
    await this.task;
  }
}
