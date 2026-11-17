import type { CaptureResource, DownloadDraft } from "../shared/capture";
import type { ResolvedMedia } from "./bilibili";

/** Per-dialog quality metadata only: never retain signed media URLs. */
export class CaptureQualities {
  readonly items: NonNullable<DownloadDraft["itemQualities"]> = {};
  private wanted = new Set<string>();
  private active = new Set<string>();
  private controller = new AbortController();
  private task?: Promise<void>;
  private limited = false;
  private networkFailures = 0;
  private stopError = "captureRateLimited";
  checking = false;
  constructor(
    private resources: CaptureResource[],
    private resolve: (
      r: CaptureResource,
      signal: AbortSignal,
    ) => Promise<ResolvedMedia>,
    private changed: () => void,
  ) {}
  request(ids: string[], replace = true, retry = false) {
    if (this.controller.signal.aborted) return;
    if (replace) this.wanted = new Set(ids);
    else ids.forEach((id) => this.wanted.add(id));
    if (retry) {
      this.limited = false;
      this.networkFailures = 0;
      ids.forEach((id) => {
        delete this.items[id];
      });
    }
    if (this.limited) {
      for (const id of ids)
        if (!this.items[id]) this.items[id] = { error: this.stopError };
      this.changed();
      return;
    }
    if (this.task) return;
    this.checking = true;
    this.changed();
    this.task = Promise.all(
      Array.from({ length: 2 }, async () => {
        for (;;) {
          if (this.controller.signal.aborted || this.limited) return;
          const id = [...this.wanted].find(
            (id) => !this.items[id] && !this.active.has(id),
          );
          if (!id) return;
          const resource = this.resources.find((r) => r.id === id);
          if (!resource) {
            this.wanted.delete(id);
            continue;
          }
          this.active.add(id);
          try {
            const media = await this.resolve(
              { ...resource, quality: undefined },
              AbortSignal.any([
                this.controller.signal,
                AbortSignal.timeout(15000),
              ]),
            );
            if (!this.controller.signal.aborted)
              this.items[id] = { qualities: media.qualities || [] };
            this.networkFailures = 0;
          } catch (error) {
            if (this.controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : "";
            const code = [
              "captureRateLimited",
              "captureRestricted",
              "captureUnavailable",
              "captureInvalid",
              "captureNetwork",
              "captureTooLarge",
            ].includes(message)
              ? message
              : "captureNetwork";
            if (code === "captureNetwork") this.networkFailures++;
            this.items[id] = { error: code };
            if (code === "captureRateLimited" || this.networkFailures >= 2) {
              this.limited = true;
              this.stopError = code;
              for (const pending of this.wanted)
                if (!this.items[pending] && !this.active.has(pending))
                  this.items[pending] = { error: code };
            }
          } finally {
            this.active.delete(id);
          }
          this.changed();
        }
      }),
    )
      .then(() => {})
      .finally(() => {
        this.checking = false;
        this.task = undefined;
        if (!this.controller.signal.aborted) this.changed();
      });
  }
  close() {
    this.controller.abort();
  }
}
