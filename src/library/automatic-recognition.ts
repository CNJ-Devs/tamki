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
/** Persisted work states form the queue: one automatic request, up to three explicit batch requests. */
export class AutomaticRecognition {
  private task?: Promise<void>;
  private stopped = false;
  private suspended = false;
  private active = new Map<
    string,
    { workId: string; requested: boolean; task: Promise<void> }
  >();
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
      for (const [job, active] of this.active)
        if (!active.requested) this.recognizer.cancel(job);
    } else this.store.queueRecognition(config.defaultSourceId, retryIds);
    this.emit();
    this.wake?.();
    this.kick();
  }
  enqueue(workIds: string[], sourceId: string) {
    if (this.stopped) return;
    this.store.queueRecognition(sourceId, workIds, true);
    this.emit();
    this.wake?.();
    this.kick();
  }
  cancel(workIds: string[]) {
    const selected = new Set(workIds);
    for (const work of this.store.snapshot().works) {
      if (
        !selected.has(work.id) ||
        !work.recognition?.requested ||
        !["queued", "running"].includes(work.recognition.status)
      )
        continue;
      this.store.setRecognition(work.id, {
        ...work.recognition,
        status: "failed",
        error: "recognitionCancelled",
      });
    }
    for (const [job, active] of this.active)
      if (active.requested && selected.has(active.workId))
        this.recognizer.cancel(job);
    this.emit();
  }
  private queued() {
    const automatic = this.settings.snapshot().recognition.automatic !== false;
    return this.store
      .snapshot()
      .works.filter(
        (w) =>
          w.recognition?.status === "queued" &&
          (w.recognition.requested || automatic) &&
          w.episodes.some((e) => !e.missing) &&
          ![...this.active.values()].some((a) => a.workId === w.id),
      );
  }
  private kick() {
    if (this.stopped || this.suspended || this.task) return;
    this.task = this.drain().finally(() => {
      this.task = undefined;
      if (!this.stopped && !this.suspended && this.queued().length) this.kick();
    });
  }
  private async drain() {
    while (!this.stopped && !this.suspended) {
      const queued = this.queued().sort(
        (a, b) =>
          Number(!!b.recognition?.requested) -
          Number(!!a.recognition?.requested),
      );
      for (const work of queued) {
        if (this.active.size >= 3) break;
        const requested = !!work.recognition?.requested;
        if (!requested && [...this.active.values()].some((a) => !a.requested))
          continue;
        const job = `auto-${randomUUID()}`;
        const task = this.identify(work, job).finally(() =>
          this.active.delete(job),
        );
        this.active.set(job, { workId: work.id, requested, task });
      }
      if (!this.active.size) return;
      await Promise.race([
        ...[...this.active.values()].map((a) => a.task),
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
      ]);
      this.wake = undefined;
      if (this.stopped || this.suspended) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, this.delay);
      });
      this.timer = undefined;
      this.wake = undefined;
    }
    await Promise.all([...this.active.values()].map((a) => a.task));
  }
  private async identify(work: Work, job: string) {
    const state = { ...work.recognition!, status: "running" as const };
    work.recognition = state;
    this.store.setRecognition(work.id, state);
    this.emit();
    try {
      const sourceId = state.sourceId;
      const request: RecognitionRequest = {
        jobId: job,
        sourceId,
        scope: "work",
        batch: state.requested,
        query: work.title.slice(0, 500),
        candidate: state.candidate,
        draft: {
          id: work.id,
          title: work.title.slice(0, 500),
          description: work.description,
          tags: work.tags,
          removedEpisodeIds: [],
          attachments: [],
          episodes: work.episodes.map(({ id, number, title, description }) => ({
            id,
            number,
            title,
            description,
          })),
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
        (!state.requested &&
          this.settings.snapshot().recognition.automatic === false)
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
      const code = error instanceof Error ? error.message : "recognitionFailed";
      const cancelled =
        this.stopped ||
        this.suspended ||
        (!state.requested &&
          this.settings.snapshot().recognition.automatic === false);
      this.finish(work, {
        ...state,
        status: cancelled || code === "recognitionBusy" ? "queued" : "failed",
        error: cancelled ? undefined : code,
      });
      if (cancelled) return;
    } finally {
      this.emit();
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
    for (const job of this.active.keys()) this.recognizer.cancel(job);
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
    for (const job of this.active.keys()) this.recognizer.cancel(job);
    clearTimeout(this.timer);
    this.wake?.();
    await this.task;
  }
}
