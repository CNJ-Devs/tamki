import { videoQualityLabel } from "../shared/capture";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  stat,
  rename,
  rm,
  open,
  readdir,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ProviderError } from "../providers/provider";
import { logEvent, diagnosticError } from "../diagnostics";
import {
  safeDownloadName,
  type CaptureResource,
  type CaptureGroup,
  type CaptureMetadata,
  type VideoDownloadJob,
  type VideoDownloadItem,
} from "../shared/capture";
import {
  defaultDownloadLimits,
  type DownloadLimits,
  type SaveTarget,
} from "../shared/settings";
import { Slots } from "./slots";
import { mediaURL, type ResolvedMedia } from "./bilibili";

interface Store {
  downloadJobs(): VideoDownloadJob[];
  saveDownloadJob(job: VideoDownloadJob): void;
  removeDownloadJob(id: string): void;
}
interface Options {
  limits?(): DownloadLimits | undefined;
  store: Store;
  cache: string;
  request: typeof fetch;
  resolve(
    resource: CaptureResource,
    signal: AbortSignal,
  ): Promise<ResolvedMedia>;
  mux(
    media: ResolvedMedia,
    inputs: string[],
    output: string,
    signal: AbortSignal,
  ): Promise<void>;
  target(
    target: SaveTarget,
    name: string,
    series: boolean,
  ): Promise<SaveTarget>;
  publish(
    file: string,
    target: SaveTarget,
    name: string,
    id: string,
    signal: AbortSignal,
    progress?: (bytes: number, total: number) => void,
  ): Promise<string>;
  completed(
    job: VideoDownloadJob,
    item: VideoDownloadItem,
  ): Promise<string | undefined>;
  emit(): void;
}
interface Track {
  key: string;
  bytes: number;
  total: number;
  etag?: string;
  complete: boolean;
}
export async function muxMedia(
  executable: string,
  media: ResolvedMedia,
  inputs: string[],
  output: string,
  signal: AbortSignal,
) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  const list = output + ".txt";
  if (media.kind === "segments" && inputs.length > 1) {
    // Only application-generated numeric filenames, never page/user input.
    await writeFile(
      list,
      inputs.map((p) => `file '${path.basename(p)}'`).join("\n"),
      { mode: 0o600 },
    );
    args.push(
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "concat,mov,flv,mpegts",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      list,
    );
  } else
    for (const input of inputs)
      args.push(
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,flv,mpegts",
        "-i",
        input,
      );
  if (media.kind === "dash")
    args.push("-map", "0:v:0", ...(inputs.length > 1 ? ["-map", "1:a:0"] : []));
  args.push("-c", "copy", "-movflags", "+faststart", output);
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill();
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      timer.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    // Drain stderr without logging paths or private media information.
    child.stderr.resume();
    child.once("error", () =>
      reject(new ProviderError("downloadMuxUnavailable")),
    );
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0) reject(new ProviderError("downloadMuxFailed"));
      else resolve();
    });
  });
  if (!(await stat(output)).size) throw new ProviderError("downloadMuxFailed");
}
export class VideoDownloads {
  private jobs = new Map<string, VideoDownloadJob>();
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private merging = new Slots(() => 1);
  private saving = new Slots(() => this.limits.saves);
  private destinations = new Map<string, Slots>();
  private pumping = false;
  private timer: ReturnType<typeof setInterval>;
  private get limits() {
    return this.options.limits?.() || defaultDownloadLimits;
  }
  private closed = false;
  private creating = false;
  constructor(private options: Options) {
    this.timer = setInterval(() => this.pump(), 2000);
    this.timer.unref();
    for (const job of options.store.downloadJobs()) {
      for (const item of job.items)
        if (["running", "queued"].includes(item.state)) item.state = "paused";
      this.jobs.set(job.id, job);
      options.store.saveDownloadJob(job);
    }
  }
  async reconcile() {
    for (const job of this.jobs.values()) {
      for (const item of job.items) {
        if (this.closed) return;
        if (item.state !== "failed" || item.stage !== "saving") continue;
        if (
          !(
            await stat(
              path.join(this.options.cache, job.id, item.id, "output.mp4"),
            ).catch(() => null)
          )?.size
        )
          continue;
        this.command(job.id, "retry", item.id);
      }
    }
  }
  private save(job: VideoDownloadJob) {
    if (this.jobs.get(job.id) !== job) return;
    this.options.store.saveDownloadJob(job);
    this.options.emit();
  }
  async enqueue(
    name: string,
    resources: CaptureResource[],
    target: SaveTarget,
    series: boolean,
    qualities: number[] = [0],
    groups?: CaptureGroup[],
    metadata?: CaptureMetadata,
  ) {
    if (this.closed || this.creating) throw new ProviderError("downloadBusy");
    if (
      !resources.length ||
      resources.length > 10000 ||
      new Set(resources.map((r) => r.id)).size !== resources.length
    )
      throw new ProviderError("captureInvalid");
    if (
      groups &&
      (!groups.length ||
        groups.some((g) => !g.resources.length || g.incomplete) ||
        new Set(groups.map((g) => g.id)).size !== groups.length ||
        groups
          .flatMap((g) => g.resources)
          .some((r) => !resources.some((source) => source.id === r.id)) ||
        resources.some(
          (r) =>
            !groups.some((g) =>
              g.resources.some((member) => member.id === r.id),
            ),
        ))
    )
      throw new ProviderError("captureInvalid");
    this.creating = true;
    try {
      series = series || !!groups || qualities.length > 1;
      const destination = await this.options.target(target, name, series);
      if (this.closed) throw new ProviderError("cancelled");
      const resourceGroups = new Map<string, { id: string; index: number }>();
      const savedGroups: NonNullable<VideoDownloadJob["groups"]> = [];
      const folderNames = new Set<string>();
      for (const [index, group] of (groups || []).entries()) {
        let folderName = safeDownloadName(group.title);
        if (
          folderName === name ||
          folderNames.has(folderName.toLocaleLowerCase())
        )
          folderName = safeDownloadName(`${folderName} [${index + 1}]`);
        while (folderNames.has(folderName.toLocaleLowerCase()))
          folderName = safeDownloadName(`${index + 1}-${folderName}`);
        folderNames.add(folderName.toLocaleLowerCase());
        savedGroups.push({
          id: group.id,
          title: group.title,
          metadata: group.metadata,
          target: await this.options.target(destination, folderName, true),
        });
        group.resources.forEach((r, index) => {
          if (!resourceGroups.has(r.id))
            resourceGroups.set(r.id, { id: group.id, index });
        });
      }
      const job: VideoDownloadJob = {
        id: randomUUID(),
        name,
        target: destination,
        ...(savedGroups.length ? { groups: savedGroups } : {}),
        series,
        metadata,
        createdAt: Date.now(),
        items: resources.flatMap((resource, index) =>
          [...new Set(qualities)].map((quality) => ({
            id: randomUUID(),
            resource: { ...resource, quality: quality || undefined },
            groupId: resourceGroups.get(resource.id)?.id,
            name: series
              ? `${String((resourceGroups.get(resource.id)?.index ?? index) + 1).padStart(3, "0")} · ${safeDownloadName(resource.title)}${quality ? ` [${videoQualityLabel(quality)}]` : ""}.mp4`
              : `${safeDownloadName(name.replace(/\.mp4$/i, ""))}${quality ? ` [${videoQualityLabel(quality)}]` : ""}.mp4`,
            state: "queued",
            stage: "resolving",
            received: 0,
            total: 0,
          })),
        ),
      };
      if (
        [...this.jobs.values()].some(
          (j) =>
            j.target.connectionId === destination.connectionId &&
            j.items.some(
              (i) =>
                !["cancelled", "failed"].includes(i.state) &&
                job.items.some(
                  (n) =>
                    n.name === i.name &&
                    (job.groups?.find((g) => g.id === n.groupId)?.target.path ||
                      job.target.path) ===
                      (j.groups?.find((g) => g.id === i.groupId)?.target.path ||
                        j.target.path),
                ),
            ),
        )
      )
        throw new ProviderError("downloadExists");
      this.jobs.set(job.id, job);
      this.save(job);
      this.pump();
      return job;
    } finally {
      this.creating = false;
    }
  }
  async remove(id: string, itemId?: string) {
    const job = this.jobs.get(id);
    const items = job?.items.filter((i) => !itemId || i.id === itemId);
    if (
      !job ||
      !items?.length ||
      items.some((i) => !["completed", "cancelled", "failed"].includes(i.state))
    )
      throw new ProviderError("transferUnavailable");
    const ids = new Set(items.map((i) => i.id));
    job.items = job.items.filter((i) => !ids.has(i.id));
    if (job.items.length) this.save(job);
    else {
      this.jobs.delete(id);
      this.options.store.removeDownloadJob(id);
      this.options.emit();
    }
    logEvent("download.action", {
      jobId: id,
      operation: "remove",
      files: items.length,
    });
    await Promise.allSettled(items.map((i) => this.active.get(i.id)?.done));
    // Delete only our temporary transfer cache, never destination media or library records.
    await Promise.all(
      items.map((i) =>
        rm(path.join(this.options.cache, id, i.id), {
          recursive: true,
          force: true,
        }),
      ),
    );
  }
  command(
    id: string,
    action: "pause" | "resume" | "retry" | "cancel",
    itemId?: string,
  ) {
    const job = this.jobs.get(id);
    if (!job) throw new ProviderError("transferUnavailable");
    const items = itemId ? job.items.filter((i) => i.id === itemId) : job.items;
    if (!items.length) throw new ProviderError("transferUnavailable");
    logEvent("download.action", {
      jobId: id,
      operation: action,
      files: items.length,
    });
    for (const item of items) {
      if (item.state === "completed") continue;
      if (action === "pause" && ["queued", "running"].includes(item.state)) {
        item.state = "paused";
        this.active.get(item.id)?.controller.abort();
      }
      if (action === "cancel" && item.state !== "cancelled") {
        item.state = "cancelled";
        this.active.get(item.id)?.controller.abort();
      }
      if (
        (action === "resume" && item.state === "paused") ||
        (action === "retry" && ["failed", "cancelled"].includes(item.state))
      ) {
        item.state = "queued";
        delete item.error;
      }
    }
    this.save(job);
    this.pump();
  }
  private pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    void this.schedule()
      .catch((error) => {
        logEvent("download.schedule-failed", diagnosticError(error), "error");
      })
      .finally(() => {
        this.pumping = false;
      });
  }
  private async cacheBytes(directory: string): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    let bytes = 0;
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) bytes += await this.cacheBytes(file);
      else if (entry.isFile())
        bytes += (await stat(file).catch(() => null))?.size || 0;
    }
    return bytes;
  }
  private async diskSpace(required = 0) {
    const disk = await statfs(this.options.cache);
    if (disk.bavail * disk.bsize < required + 2 * 1024 ** 3)
      throw new ProviderError("downloadDiskSpace");
  }
  private async schedule() {
    await mkdir(this.options.cache, { recursive: true, mode: 0o700 });
    const cached = await this.cacheBytes(this.options.cache);
    if (this.closed) return;
    const limits = this.limits;
    const downstream = [...this.jobs.values()]
      .flatMap((job) => job.items)
      .filter(
        (item) =>
          this.active.has(item.id) &&
          !["resolving", "transferring"].includes(item.stage),
      ).length;
    // Bounded read-ahead; slow or offline destinations cannot create an unbounded queue.
    const buffered =
      cached >= limits.cacheGiB * 1024 ** 3 || downstream >= limits.saves + 2;
    if (this.closed) return;
    let downloading = [...this.jobs.values()]
      .flatMap((job) => job.items)
      .filter(
        (item) =>
          this.active.has(item.id) &&
          ["resolving", "transferring"].includes(item.stage),
      ).length;
    for (const job of this.jobs.values())
      for (const item of job.items) {
        if (this.active.size >= limits.downloads + limits.saves + 2) return;
        if (item.state !== "queued" || this.active.has(item.id)) continue;
        const ready = !!(
          await stat(
            path.join(this.options.cache, job.id, item.id, "output.mp4"),
          ).catch(() => null)
        )?.size;
        if (this.closed) return;
        if (item.state !== "queued") continue;
        if (!ready && (buffered || downloading >= limits.downloads)) continue;
        if (!ready) {
          try {
            await this.diskSpace();
          } catch (error) {
            if (
              !(error instanceof ProviderError) ||
              error.code !== "downloadDiskSpace"
            )
              throw error;
            item.state = "paused";
            item.error = error.code;
            this.save(job);
            continue;
          }
        }
        if (this.closed || item.state !== "queued") return;
        const controller = new AbortController();
        item.state = "running";
        item.stage = ready ? "waitingSave" : "resolving";
        if (!ready) downloading++;
        const done = Promise.resolve()
          .then(() => this.run(job, item, controller.signal))
          .finally(() => {
            this.active.delete(item.id);
            this.pump();
          });
        this.active.set(item.id, { controller, done });
      }
  }
  private async transfer(
    url: string,
    file: string,
    track: Track,
    changed: () => Promise<void>,
    signal: AbortSignal,
  ) {
    // An idle limit, not a whole-file timeout: large downloads may run for hours.
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => idle.abort(new ProviderError("downloadNetwork")),
        45000,
      );
      timer.unref();
    };
    reset();
    try {
      await this.transferBody(
        url,
        file,
        track,
        async () => {
          reset();
          await changed();
        },
        AbortSignal.any([signal, idle.signal]),
      );
    } finally {
      clearTimeout(timer!);
    }
  }
  private async transferBody(
    url: string,
    file: string,
    track: Track,
    changed: () => Promise<void>,
    signal: AbortSignal,
  ) {
    const disk = await stat(file).catch(() => null);
    if (track.complete && disk?.size === track.total && track.total > 0) {
      track.bytes = track.total;
      return;
    }
    let offset = disk?.size || 0;
    if (
      offset !== track.bytes &&
      (!track.etag ||
        offset < track.bytes ||
        (track.total > 0 && offset > track.total))
    ) {
      offset = 0;
      track.bytes = 0;
      track.complete = false;
    }
    track.bytes = offset;
    let target = mediaURL(url);
    let response: Response | undefined;
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await this.options.request(target, {
        signal,
        redirect: "manual",
        headers: {
          Referer: "https://www.bilibili.com/",
          ...(offset
            ? {
                Range: `bytes=${offset}-`,
                ...(track.etag ? { "If-Range": track.etag } : {}),
              }
            : {}),
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get("location");
        await response.body?.cancel();
        if (!next) throw new ProviderError("downloadNetwork");
        target = mediaURL(new URL(next, target).href);
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel();
      throw new ProviderError(
        response?.status === 401 || response?.status === 403
          ? "captureRestricted"
          : "downloadNetwork",
      );
    }
    const range = response.headers
      .get("content-range")
      ?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (response.status === 206) {
      if (
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) < offset ||
        Number(range[3]) <= Number(range[2])
      ) {
        await response.body.cancel();
        throw new ProviderError("downloadInvalid");
      }
      track.total = Number(range[3]);
    } else if (response.status === 200) {
      offset = 0;
      track.bytes = 0;
      track.total = Number(response.headers.get("content-length")) || 0;
    } else {
      await response.body.cancel();
      throw new ProviderError("downloadInvalid");
    }
    const etag = response.headers.get("etag") || undefined;
    if (offset && track.etag && etag && track.etag !== etag) {
      await response.body.cancel();
      throw new ProviderError("downloadChanged");
    }
    track.etag = etag;
    const handle = await open(file, offset ? "r+" : "w", 0o600);
    const reader = response.body.getReader();
    let diskCheckedAt = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (Date.now() - diskCheckedAt > 1000) {
          await this.diskSpace(value.length);
          diskCheckedAt = Date.now();
        }
        let written = 0;
        while (written < value.length) {
          const result = await handle.write(
            value,
            written,
            value.length - written,
            offset + written,
          );
          written += result.bytesWritten;
        }
        offset += value.length;
        track.bytes = offset;
        if (track.total && offset > track.total)
          throw new ProviderError("downloadInvalid");
        await changed();
      }
      if (!offset || (track.total && offset !== track.total))
        throw new ProviderError("downloadIncomplete");
      await handle.sync();
      track.total = offset;
      track.complete = true;
    } finally {
      await reader.cancel().catch(() => {});
      await handle.close();
      await changed();
    }
  }
  private async run(
    job: VideoDownloadJob,
    item: VideoDownloadItem,
    signal: AbortSignal,
  ) {
    const folder = path.join(this.options.cache, job.id, item.id);
    const metadata = path.join(folder, "tracks.json");
    const output = path.join(folder, "output.mp4");
    let releaseMerge: (() => void) | undefined;
    let releaseSave: (() => void) | undefined;
    let releaseDestination: (() => void) | undefined;
    try {
      logEvent("download.start", {
        jobId: job.id,
        provider: item.resource.provider,
      });
      if (!(await stat(output).catch(() => null))?.size) {
        item.stage = "resolving";
        this.save(job);
        const media = await this.options.resolve(item.resource, signal);
        item.quality = media.quality;
        item.qualityLabel = media.qualityLabel;
        this.save(job);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        let tracks: Track[] = JSON.parse(
          await readFile(metadata, "utf8").catch(() => "[]"),
        );
        const keys = media.streams.map((s) => s.key);
        if (
          !Array.isArray(tracks) ||
          tracks.length !== keys.length ||
          tracks.some((t, i) => t.key !== keys[i])
        ) {
          await rm(folder, { recursive: true, force: true });
          await mkdir(folder, { recursive: true, mode: 0o700 });
          tracks = keys.map((key) => ({
            key,
            bytes: 0,
            total: 0,
            complete: false,
          }));
        }
        const persist = async () => {
          await writeFile(metadata + ".tmp", JSON.stringify(tracks), {
            mode: 0o600,
          });
          await rename(metadata + ".tmp", metadata);
        };
        item.stage = "transferring";
        let updated = 0;
        const changed = async () => {
          item.received = tracks.reduce((n, t) => n + t.bytes, 0);
          item.total = tracks.reduce((n, t) => n + t.total, 0);
          item.progress =
            (tracks.reduce(
              (n, t) => n + (t.complete ? 1 : t.total ? t.bytes / t.total : 0),
              0,
            ) /
              tracks.length) *
            0.9;
          if (Date.now() - updated > 400) {
            updated = Date.now();
            await persist();
            this.save(job);
          }
        };
        const inputs = media.streams.map((_, i) =>
          path.join(folder, `${i}.media`),
        );
        for (let i = 0; i < media.streams.length; i++) {
          signal.throwIfAborted();
          try {
            await this.transfer(
              media.streams[i].url,
              inputs[i],
              tracks[i],
              changed,
              signal,
            );
          } finally {
            await persist();
          }
        }
        signal.throwIfAborted();
        item.stage = "waitingMerge";
        this.save(job);
        this.pump();
        releaseMerge = await this.merging.acquire(signal);
        signal.throwIfAborted();
        item.stage = "merging";
        item.progress = 0.9;
        this.save(job);
        if (!(await stat(output).catch(() => null))?.size) {
          await this.diskSpace(item.received);
          const temp = path.join(folder, "output.partial.mp4");
          try {
            await this.options.mux(media, inputs, temp, signal);
            signal.throwIfAborted();
            await rename(temp, output);
          } finally {
            await rm(temp, { force: true });
          }
        }
        signal.throwIfAborted();
        releaseMerge();
        releaseMerge = undefined;
      }
      item.stage = "waitingSave";
      this.save(job);
      const connectionId = job.target.connectionId;
      let destination = this.destinations.get(connectionId);
      if (!destination) {
        destination = new Slots(() => 1);
        this.destinations.set(connectionId, destination);
      }
      releaseDestination = await destination.acquire(signal);
      releaseSave = await this.saving.acquire(signal);
      signal.throwIfAborted();
      item.stage = "saving";
      delete item.uploaded;
      item.progress = 0.9;
      this.save(job);
      item.path = await this.options.publish(
        output,
        job.groups?.find((g) => g.id === item.groupId)?.target || job.target,
        item.name,
        item.id,
        signal,
        (bytes, total) => {
          if (signal.aborted || item.state !== "running") return;
          item.uploaded = bytes;
          item.uploadTotal = total;
          item.progress = 0.9 + 0.09 * Math.min(1, bytes / Math.max(1, total));
          this.save(job);
        },
      );
      // Once publication succeeds, cancellation cannot pretend the final file vanished.
      item.state = "completed";
      item.progress = 1;
      item.received = item.total;
      delete item.error;
      this.save(job);
      try {
        item.episodeId = await this.options.completed(job, item);
        this.save(job);
      } catch (e) {
        logEvent(
          "download.index-failed",
          { jobId: job.id, ...diagnosticError(e) },
          "error",
        );
      }
      await rm(folder, { recursive: true, force: true });
      logEvent("download.complete", { jobId: job.id, bytes: item.total });
    } catch (error) {
      if (
        item.state !== "completed" &&
        item.state !== "paused" &&
        item.state !== "cancelled" &&
        item.state !== "queued"
      ) {
        item.state = "failed";
        item.error =
          error instanceof ProviderError
            ? error.code
            : item.stage === "saving"
              ? "downloadSaveFailed"
              : "downloadNetwork";
      }
      this.save(job);
      if (!signal.aborted)
        logEvent(
          "download.failed",
          { jobId: job.id, phase: item.stage, ...diagnosticError(error) },
          "error",
        );
    } finally {
      releaseMerge?.();
      releaseSave?.();
      releaseDestination?.();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.jobs.values())
      for (const item of job.items)
        if (["queued", "running"].includes(item.state)) item.state = "paused";
    for (const job of this.jobs.values()) this.save(job);
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
