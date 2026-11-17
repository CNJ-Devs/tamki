import { ThumbnailCache, thumbnailKey } from "./thumbnails";
import { providerArtworkFetch } from "./artwork-fetch";
import {
  observedFetch,
  traced,
  logEvent,
  diagnosticError,
} from "../diagnostics";
import {
  app,
  dialog,
  protocol,
  net,
  safeStorage,
  clipboard,
  shell as systemShell,
} from "electron";
import { realpath, readdir, stat } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { RecognitionService } from "./recognition";
import { AutomaticRecognition } from "./automatic-recognition";
import { ArtworkCache } from "./artwork";
import { LibraryStore } from "./store";
import { scanScopes } from "./scan";
import { LocalProvider } from "../providers/local";
import { ZSpaceCLI, ZSpaceProvider } from "../providers/zspace";
import {
  containsRemote,
  containsPath,
  isVideo,
  ProviderError,
  type StorageProvider,
} from "../providers/provider";
import {
  collectionSchema,
  seriesSchema,
  connectionSchema,
  editSchema,
  id,
  location,
  preferencesSchema,
  progressSchema,
  mediaSelectionSchema,
} from "../shared/validation";
import type { Connection, Entry } from "../shared/model";
import { mediaType, parseRange } from "./range";
import { SettingsService } from "./settings";
import {
  downloadLimitsSchema,
  saveRuleSchema,
  targetSchema,
} from "../shared/settings";
import { OrganizationService } from "./organization";
import { organizeRequestSchema } from "../shared/organization";
import { batchRecognitionSchema } from "../shared/recognition";
import { CaptureStorage } from "../capture/storage";
import type { VideoDownloadJob, VideoDownloadItem } from "../shared/capture";

interface Draft {
  id: string;
  type: "local" | "zspace";
  roots: string[];
  authorized: boolean;
  url?: string;
}
export class LibraryService {
  readonly store: LibraryStore;
  readonly settings: SettingsService;
  readonly recognition: RecognitionService;
  readonly automatic: AutomaticRecognition;
  readonly artwork: ArtworkCache;
  readonly thumbnails: ThumbnailCache;
  readonly organization: OrganizationService;
  readonly downloadStorage: CaptureStorage;
  private organizing = false;
  private organizationTask?: Promise<unknown>;
  private organizationRequest?: { id: string; cancelled: boolean };
  private refreshing = false;
  private refreshTask?: Promise<void>;
  private artworkTask?: Promise<void>;
  private artworkAgain = false;
  private controller = new AbortController();
  private drafts = new Map<string, Draft>();
  private cli?: ZSpaceCLI;
  private ticket = randomBytes(32).toString("hex");
  constructor(private emit: () => void) {
    this.store = new LibraryStore(
      path.join(app.getPath("userData"), "library.sqlite"),
      app.getLocale().startsWith("zh") ? "zh" : "en",
    );
    this.settings = new SettingsService(this.store, {
      request: observedFetch(net.fetch.bind(net) as typeof fetch),
      openBrowser: (url) => systemShell.openExternal(url),
      writeClipboard: (value) => clipboard.writeText(value),
      secureStorage: safeStorage,
      runtimeRoot: path.join(app.getPath("userData"), "source-runtimes"),
    });
    this.thumbnails = new ThumbnailCache(
      path.join(app.getPath("userData"), "thumbnails"),
    );
    this.artwork = new ArtworkCache(
      path.join(app.getPath("userData"), "artwork"),
      observedFetch(providerArtworkFetch(net.fetch.bind(net) as typeof fetch)),
    );
    this.recognition = new RecognitionService(
      this.store,
      this.settings,
      this.artwork,
    );
    this.automatic = new AutomaticRecognition(
      this.store,
      this.settings,
      this.recognition,
      emit,
    );
    this.organization = new OrganizationService(
      this.store,
      this.settings,
      (c) => this.provider(c),
      () => this.automatic.resume(),
    );
    this.downloadStorage = new CaptureStorage({
      connection: (id) => this.store.connection(id),
      provider: (connection) => this.provider(connection),
      upload: async (id, args, signal) =>
        (await this.runtime()).runner(id, 2 * 60 * 60 * 1000)(args, signal),
    });
  }
  snapshot() {
    return {
      ...this.store.snapshot(this.refreshing),
      settings: this.settings.snapshot(),
      videoDownloads: this.store.downloadJobs(),
    };
  }
  repairMissingArtwork(): Promise<void> {
    this.artworkAgain = true;
    if (this.artworkTask) return this.artworkTask;
    this.artworkTask = (async () => {
      const attempted = new Set<string>();
      do {
        this.artworkAgain = false;
        await this.repairArtworkPass(attempted);
      } while (this.artworkAgain && !this.controller.signal.aborted);
    })().finally(() => {
      this.artworkTask = undefined;
    });
    return this.artworkTask;
  }
  private async repairArtworkPass(attempted: Set<string>) {
    const captured = async (id: string, source: string, episode = false) => {
      if (this.controller.signal.aborted) return;
      try {
        // Several new versions can share artwork; the cache handles successful
        // repeats, while a failed address is attempted only once per pass queue.
        if (attempted.has(source)) {
          if (episode) {
            this.store.failCapturedEpisodeArtwork(id, source);
            this.emit();
          }
          return;
        }
        const key = await this.artwork.cache(source, this.controller.signal);
        if (!this.controller.signal.aborted) {
          this.store.repairCapturedArtwork(id, source, key, episode);
          this.emit();
        }
      } catch (error) {
        attempted.add(source);
        if (episode && !this.controller.signal.aborted) {
          this.store.failCapturedEpisodeArtwork(id, source);
          this.emit();
        }
        if (!this.controller.signal.aborted)
          logEvent(
            "artwork.capture.failed",
            { ...diagnosticError(error) },
            "warn",
          );
      }
    };
    for (const work of this.store.snapshot().works) {
      if (this.controller.signal.aborted) return;
      if (!work.cover && work.captureSource?.cover)
        await captured(work.id, work.captureSource.cover);
      const recognition = work.recognition;
      if (
        work.cover ||
        !recognition?.artworkError ||
        recognition.status !== "complete"
      )
        continue;
      try {
        let source = recognition.artworkSource;
        // Older records did not retain artwork URLs. Recover the known subject,
        // without repeating recognition or sending a new LLM request.
        if (
          !source &&
          recognition.sourceId === "bangumi" &&
          /^bangumi:\d+$/.test(recognition.candidate || "")
        ) {
          const response = await net.fetch(
            `https://api.bgm.tv/v0/subjects/${recognition.candidate!.split(":")[1]}`,
            {
              credentials: "omit",
              signal: AbortSignal.any([
                this.controller.signal,
                AbortSignal.timeout(15000),
              ]),
            },
          );
          if (!response.ok) continue;
          const metadata = (await response.json()) as {
            images?: { large?: string };
          };
          if (metadata.images?.large)
            source = { cover: metadata.images.large, coverPage: null };
        }
        if (!source) continue;
        const key = await this.artwork.resolve(
          source.cover,
          source.coverPage,
          this.controller.signal,
        );
        if (this.controller.signal.aborted) return;
        this.store.repairArtwork(work.id, recognition.signature, key);
        this.emit();
        logEvent("artwork.repair.done", { workId: work.id });
      } catch (error) {
        if (this.controller.signal.aborted) return;
        logEvent(
          "artwork.repair.failed",
          { workId: work.id, ...diagnosticError(error) },
          "warn",
        );
      }
    }
    for (const work of this.store.snapshot().works)
      for (const episode of work.episodes)
        if (!episode.cover && episode.artworkSource)
          await captured(episode.id, episode.artworkSource, true);
  }
  async completeDownload(job: VideoDownloadJob, item: VideoDownloadItem) {
    if (!item.path) return;
    const group = job.groups?.find((g) => g.id === item.groupId);
    const target = group?.target || job.target;
    const connection = this.store.connection(target.connectionId);
    const provider = await this.provider(connection);
    const entries = await provider.list(target.path);
    const files = entries.filter(
      (e) =>
        !e.directory &&
        job.items.some((i) => i.path === e.path && i.state === "completed"),
    );
    const file = files.find((e) => e.path === item.path);
    if (!file) throw new ProviderError("mediaMissing");
    const root =
      connection.roots.find((r) =>
        connection.type === "local"
          ? containsPath(r, item.path!)
          : containsRemote(r, item.path!),
      ) || target.path;
    const matchingWorks = this.store
      .snapshot()
      .works.filter(
        (w) => w.connectionId === connection.id && w.path === target.path,
      );
    const existingWork =
      matchingWorks.length === 1 ? matchingWorks[0] : undefined;
    this.store.applyScan(
      connection.id,
      root,
      {
        groups: [
          {
            path: job.series || existingWork ? target.path : item.path,
            name: existingWork?.title || group?.title || job.name,
            files: job.series ? files : [file],
          },
        ],
        completeDirectories: [],
        failures: [],
      },
      true,
    );
    this.store.linkDownloadedVersions(
      connection.id,
      job.items
        .filter(
          (other) =>
            other.path &&
            other.resource.provider === item.resource.provider &&
            other.resource.aid === item.resource.aid &&
            other.resource.cid === item.resource.cid,
        )
        .map((other) => ({
          path: other.path!,
          label: other.qualityLabel || "",
          releaseKey: other.quality ? `bilibili:${other.quality}` : "",
        })),
    );
    this.store.applyCapturedMetadata(
      connection.id,
      item.path,
      group?.metadata || job.metadata,
      item.resource.metadata,
      existingWork ? undefined : group?.title || job.name,
    );
    const episode = this.store
      .snapshot()
      .works.flatMap((w) => w.episodes)
      .find((e) =>
        e.versions?.some((v) =>
          v.files.some(
            (f) => f.connectionId === connection.id && f.path === item.path,
          ),
        ),
      );
    if (episode && item.resource.duration)
      this.store.setProgress(episode.id, 0, item.resource.duration, false);
    if (job.groups && !job.librarySeriesCreated) {
      const state = this.store.snapshot();
      const members = job.groups.map((g) =>
        state.works.find(
          (w) =>
            w.connectionId === g.target.connectionId &&
            w.path === g.target.path,
        ),
      );
      if (
        members.every(Boolean) &&
        !state.series?.some((s) =>
          s.workIds.some((id) => members.some((w) => w?.id === id)),
        )
      ) {
        this.store.saveSeries(
          {
            id: job.id,
            name: job.name,
            workIds: members.map((w) => w!.id),
          },
          false,
        );
        job.librarySeriesCreated = true;
      }
    }
    this.emit();
    void this.repairMissingArtwork().catch((error) =>
      logEvent("artwork.capture.failed", diagnosticError(error), "warn"),
    );
    this.automatic.schedule();
    return episode?.id;
  }
  private async selectedFiles(
    connectionId: string,
    paths: string[],
  ): Promise<Entry[]> {
    const connection = this.store.connection(connectionId);
    const provider = await this.provider(connection);
    const entries = new Map<string, Entry[]>();
    for (const target of paths) {
      const directory =
        connection.type === "local"
          ? path.dirname(target)
          : path.posix.dirname(target);
      if (!entries.has(directory))
        entries.set(
          directory,
          await provider.list(directory, this.controller.signal),
        );
    }
    return paths.map((target) => {
      const file = [...entries.values()]
        .flat()
        .find((e) => e.path === target && isVideo(e));
      if (!file) throw new ProviderError("mediaMissing");
      return file;
    });
  }
  private async runtime() {
    if (this.cli) return this.cli;
    let executable = this.store.config("zspaceExecutable");
    if (!executable) {
      const cache =
        process.platform === "darwin"
          ? path.join(os.homedir(), "Library/Caches/zspace-nas-agent-toolkit")
          : process.platform === "win32"
            ? path.join(
                process.env.LOCALAPPDATA ||
                  path.join(os.homedir(), "AppData/Local"),
                "ZSpace/AgentToolkit/cache",
              )
            : path.join(
                process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
                "zspace-nas-agent-toolkit",
              );
      try {
        const versions = (await readdir(cache))
          .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
          const candidate = path.join(
            cache,
            version,
            platform,
            `zspace-cli-v${version}-${platform}${process.platform === "win32" ? ".exe" : ""}`,
          );
          if ((await stat(candidate).catch(() => null))?.isFile()) {
            executable = candidate;
            break;
          }
        }
      } catch {}
    }
    if (!executable) throw new ProviderError("cliUnavailable");
    this.cli = new ZSpaceCLI(
      executable,
      path.join(app.getPath("userData"), "zspace"),
      (id) =>
        this.store.snapshot().connections.find((c) => c.id === id)
          ?.allowLANHTTP === true,
    );
    return this.cli;
  }
  private async provider(
    connection: Pick<Connection, "id" | "type" | "roots" | "browseRoots">,
  ): Promise<StorageProvider> {
    return connection.type === "local"
      ? new LocalProvider(connection.browseRoots || connection.roots)
      : new ZSpaceProvider(
          (await this.runtime()).runner(connection.id),
          connection.browseRoots || connection.roots,
        );
  }
  refresh() {
    if (this.organizing || this.organization.busy)
      return Promise.reject(new ProviderError("organizationBusy"));
    if (this.refreshTask) return this.refreshTask;
    this.refreshing = true;
    this.emit();
    this.refreshTask = traced("library.scan", {}, async () => {
      for (const connection of this.store.connections()) {
        if (this.controller.signal.aborted) break;
        this.store.saveConnection({
          ...connection,
          status: "scanning",
          error: null,
        });
        this.emit();
        let failed = false;
        logEvent("library.scan-source", {
          provider: connection.type,
          connectionId: connection.id,
          roots: connection.roots.length,
        });
        try {
          const provider = await this.provider(connection);
          const result = await scanScopes(
            provider,
            connection.roots.map((root) => ({
              root,
              depth: connection.scanDepths?.[root] ?? 1,
            })),
            this.controller.signal,
          );
          this.store.applyScan(connection.id, connection.roots[0], result);
          this.automatic.schedule();
          failed = result.failures.length > 0;
          logEvent(
            "library.scan-source-result",
            {
              provider: connection.type,
              connectionId: connection.id,
              issues: result.failures.length,
            },
            failed ? "warn" : "info",
          );
          this.store.saveConnection({
            ...connection,
            status: failed ? "offline" : "connected",
            error: failed ? "scanPartial" : null,
            scannedAt: failed ? connection.scannedAt : Date.now(),
          });
        } catch (error) {
          logEvent(
            "library.scan-source-failed",
            { connectionId: connection.id, ...diagnosticError(error) },
            "error",
          );
          this.store.saveConnection({
            ...connection,
            status: "offline",
            error: "connectionFailed",
          });
        }
        this.emit();
      }
    }).finally(() => {
      this.refreshing = false;
      this.refreshTask = undefined;
      this.emit();
    });
    return this.refreshTask;
  }
  async request(type: string, value: unknown): Promise<unknown> {
    switch (type) {
      case "ai-feature-models":
        try {
          return await this.settings.featureModels(id.parse(value));
        } finally {
          this.emit();
        }
      case "organize-draft": {
        const plan = this.organization.resume();
        if (plan) await this.automatic.pause();
        return plan;
      }
      case "organize-review":
        return this.organization.saveSelection(value);
      case "organize-progress":
        return this.organization.progress(value);
      case "organize-cancel": {
        const jobId = id.parse(value);
        if (this.organizationRequest?.id === jobId)
          this.organizationRequest.cancelled = true;
        this.organization.cancel(jobId);
        return;
      }
      case "organize": {
        if (this.refreshing) throw new ProviderError("scanBusy");
        if (this.organizing || this.organization.busy)
          throw new ProviderError("organizationBusy");
        const input = organizeRequestSchema.parse(value);
        this.settings.featureRuntime(
          input.connectionId,
          input.model,
          input.webSearch,
        );
        this.organizing = true;
        const pending = { id: input.jobId, cancelled: false };
        this.organizationRequest = pending;
        this.organizationTask = (async () => {
          try {
            await this.automatic.pause();
            if (pending.cancelled)
              throw new ProviderError("recognitionCancelled");
            const preferences = this.settings.snapshot();
            preferences.organization = {
              connectionId: input.connectionId,
              model: input.model,
              webSearch: input.webSearch,
              instructions: input.instructions,
            };
            this.settings.save(preferences);
            return await this.organization.run(input);
          } catch (e) {
            this.automatic.resume();
            throw e;
          } finally {
            this.organizing = false;
            this.organizationRequest = undefined;
            this.organizationTask = undefined;
            this.emit();
          }
        })();
        return this.organizationTask;
      }
      case "organize-refine": {
        if (this.refreshing) throw new ProviderError("scanBusy");
        if (this.organizing) throw new ProviderError("organizationBusy");
        this.organizing = true;
        this.organizationTask = this.organization.refine(value).finally(() => {
          this.organizing = false;
          this.organizationTask = undefined;
          this.emit();
        });
        return this.organizationTask;
      }
      case "organize-apply":
        try {
          return await this.organization.apply(value);
        } finally {
          this.emit();
        }
      case "recognize":
        return this.recognition.run(value, async (input) => {
          const additions = [];
          for (const connectionId of new Set(
            input.attachments.map((a) => a.connectionId),
          )) {
            const files = await this.selectedFiles(
              connectionId,
              input.attachments
                .filter((a) => a.connectionId === connectionId)
                .map((a) => a.path),
            );
            additions.push(
              ...this.store.prepareEpisodes(input.id, connectionId, files),
            );
          }
          return additions;
        });
      case "recognize-batch": {
        const input = batchRecognitionSchema.parse(value);
        const config = this.settings.snapshot().recognition;
        if (
          ![
            "bangumi",
            "bilibili",
            "tmdb",
            "filename",
            ...config.sources.map((s) => s.id),
          ].includes(input.sourceId)
        )
          throw new ProviderError("recognitionSourceMissing");
        if (input.sourceId === "tmdb" && !config.tmdbConfigured)
          throw new ProviderError("tmdbKeyRequired");
        const source = this.settings.recognitionSelection(input.sourceId);
        if (source && !source.model) throw new ProviderError("chooseModel");
        const works = this.store.snapshot().works;
        const byId = new Map(works.map((w) => [w.id, w]));
        if (input.workIds.some((id) => !byId.has(id)))
          throw new ProviderError("mediaMissing");
        const queued = input.workIds.filter((id) => {
          const work = byId.get(id)!;
          return (
            work.recognition?.status !== "running" &&
            work.episodes.some((e) => !e.missing)
          );
        });
        this.automatic.enqueue(queued, input.sourceId);
        logEvent("recognition.batch.queued", {
          groups: queued.length,
          issues: input.workIds.length - queued.length,
          provider: source?.provider || input.sourceId,
        });
        return { queued, skipped: input.workIds.length - queued.length };
      }
      case "cancel-recognition-batch": {
        const input = batchRecognitionSchema
          .pick({ workIds: true })
          .parse(value);
        this.automatic.cancel(input.workIds);
        logEvent("recognition.batch.cancelled", {
          groups: input.workIds.length,
        });
        return true;
      }
      case "cancel-recognition":
        this.recognition.cancel(id.parse(value));
        return true;
      case "retry-recognition": {
        const workId = value == null ? null : id.parse(value);
        const works = this.store.snapshot().works;
        if (workId && !works.some((w) => w.id === workId))
          throw new ProviderError("mediaMissing");
        const previous =
          workId && works.find((w) => w.id === workId)?.recognition;
        if (workId && previous && previous.requested) {
          this.automatic.enqueue([workId], previous.sourceId);
          break;
        }
        this.automatic.schedule(
          works
            .filter((w) =>
              workId
                ? w.id === workId
                : ["failed", "needs-choice", "no-match", "local"].includes(
                    w.recognition?.status || "",
                  ) || w.recognition?.artworkError,
            )
            .map((w) => w.id),
        );
        break;
      }
      case "open-citation": {
        const url = z.string().url().max(8192).parse(value),
          parsed = new URL(url);
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new ProviderError("invalidInput");
        await systemShell.openExternal(url);
        return true;
      }
      case "source-authorization":
      case "source-authorization-open":
      case "source-authorization-copy":
      case "source-authorization-cancel":
        return this.settings.request(type, value);
      case "tmdb-credentials":
      case "recognition-preferences":
      case "source-models":
      case "recognition-source-models":
      case "recognition-source-search":
      case "save-recognition-source":
      case "ai-connection-login":
      case "ai-connection-projects":
      case "ai-connection-test":
      case "ai-connection-save":
      case "ai-connection-remove":
      case "ai-connection-logout":
      case "ai-connection-discard":
      case "source-account-login":
      case "source-account-status":
      case "source-account-projects":
      case "source-account-search":
      case "source-account-logout":
      case "source-account-discard":
      case "source-oauth-login":
      case "source-oauth-profiles":
      case "source-oauth-select":
      case "source-oauth-logout":
      case "source-oauth-cancel":
      case "source-oauth-discard":
      case "source-oauth-search":
      case "source-oauth-welcome":
      case "save-source":
      case "remove-source": {
        try {
          const result = await this.settings.request(type, value);
          if (
            [
              "save-source",
              "save-recognition-source",
              "remove-source",
              "recognition-preferences",
              "tmdb-credentials",
            ].includes(type)
          )
            this.automatic.schedule();
          return result;
        } finally {
          this.emit();
        }
      }
      case "download-limits": {
        const limits = downloadLimitsSchema.parse(value);
        const settings = this.settings.snapshot();
        settings.downloadLimits = limits;
        this.settings.save(settings);
        this.emit();
        return;
      }
      case "save-preference": {
        const input = z
          .object({
            kind: z.enum(["series", "video"]),
            mode: z.enum(["fixed", "last"]),
            fixed: targetSchema.nullable(),
          })
          .strict()
          .parse(value);
        const previous = this.settings.snapshot().downloads[input.kind].fixed;
        // Switching modes must remain available while storage is offline.
        // Validate remote access only when the user selects a new target.
        if (
          input.fixed &&
          (previous?.connectionId !== input.fixed.connectionId ||
            previous.path !== input.fixed.path)
        ) {
          const connection = this.store.connection(input.fixed.connectionId);
          await (
            await this.provider(connection)
          ).list(input.fixed.path, this.controller.signal);
        }
        const settings = this.settings.snapshot();
        settings.downloads[input.kind] = saveRuleSchema.parse({
          ...settings.downloads[input.kind],
          mode: input.mode,
          fixed: input.fixed,
        });
        this.settings.save(settings);
        break;
      }
      case "state":
        return this.snapshot();
      case "preferences":
        this.store.setPreferences(preferencesSchema.parse(value));
        break;
      case "refresh":
        void this.refresh();
        break;
      case "choose-local": {
        const sourceId = value == null ? undefined : id.parse(value);
        const previous = sourceId
          ? this.drafts.get(sourceId) || this.store.connection(sourceId)
          : undefined;
        if (previous && previous.type !== "local")
          throw new ProviderError("invalidInput");
        const choice = await dialog.showOpenDialog({
          properties: ["openDirectory", "multiSelections"],
        });
        if (choice.canceled) return null;
        const picked = [
          ...new Set(
            await Promise.all(choice.filePaths.map((p) => realpath(p))),
          ),
        ];
        const roots = [
          ...new Set([
            ...(previous
              ? ("browseRoots" in previous && previous.browseRoots) ||
                previous.roots
              : []),
            ...picked,
          ]),
        ];
        const draft: Draft = {
          id: previous && "authorized" in previous ? previous.id : randomUUID(),
          type: "local",
          roots,
          authorized: true,
        };
        this.drafts.set(draft.id, draft);
        return { ...draft, selectedRoots: picked };
      }
      case "choose-cli": {
        const choice = await dialog.showOpenDialog({
          properties: ["openFile"],
        });
        if (choice.canceled) return false;
        const chosen = await realpath(choice.filePaths[0]);
        if (!/^zspace-cli(?:[-.\w]+)?(?:\.exe)?$/.test(path.basename(chosen)))
          throw new ProviderError("cliUnavailable");
        this.cli?.close();
        this.cli = undefined;
        this.store.setConfig("zspaceExecutable", chosen);
        return true;
      }
      case "zspace-begin": {
        const draft: Draft = {
          id: randomUUID(),
          type: "zspace",
          roots: [],
          authorized: false,
        };
        this.drafts.set(draft.id, draft);
        try {
          const auth = await (await this.runtime()).begin(draft.id);
          draft.url = auth.url;
          return { draftId: draft.id, ...auth };
        } catch (error) {
          this.drafts.delete(draft.id);
          throw error;
        }
      }
      case "zspace-open": {
        const draft = this.drafts.get(id.parse(value));
        if (!draft?.url) throw new ProviderError("authExpired");
        await systemShell.openExternal(draft.url);
        return true;
      }
      case "zspace-finish": {
        const input = z
          .object({ draftId: id, code: z.string().max(100) })
          .strict()
          .parse(value);
        const draft = this.drafts.get(input.draftId);
        if (!draft || draft.type !== "zspace")
          throw new ProviderError("authExpired");
        const cli = await this.runtime();
        await cli.finish(draft.id, input.code.trim());
        draft.roots = await ZSpaceProvider.spaces(cli.runner(draft.id));
        draft.authorized = true;
        return draft;
      }
      case "cancel-draft": {
        const key = id.parse(value);
        this.cli?.cancel(key);
        this.drafts.delete(key);
        return true;
      }
      case "list": {
        const input = z.object({ id, path: location }).strict().parse(value);
        const source =
          this.drafts.get(input.id) || this.store.connection(input.id);
        if ("authorized" in source && !source.authorized)
          throw new ProviderError("authExpired");
        return (await this.provider(source)).list(
          input.path,
          this.controller.signal,
        );
      }
      case "browse-roots": {
        const source =
          this.drafts.get(id.parse(value)) ||
          this.store.connection(id.parse(value));
        if ("authorized" in source) {
          if (!source.authorized) throw new ProviderError("authExpired");
          return source.roots;
        }
        const roots =
          source.type === "zspace"
            ? await ZSpaceProvider.spaces(
                (await this.runtime()).runner(source.id),
              )
            : source.browseRoots || source.roots;
        this.store.saveConnection({
          ...this.store.connection(source.id),
          browseRoots: roots,
        });
        return roots;
      }
      case "save-connection": {
        if (this.refreshing) throw new ProviderError("scanBusy");
        const input = connectionSchema.parse(value);
        const previous = input.id ? this.store.connection(input.id) : null;
        const draft = input.draftId ? this.drafts.get(input.draftId) : null;
        if (
          previous &&
          (previous.type !== input.type || (draft && draft.type !== "local"))
        )
          throw new ProviderError("invalidInput");
        const source =
          draft &&
          previous &&
          draft.type === "local" &&
          previous.type === "local"
            ? {
                ...draft,
                roots: [
                  ...new Set([
                    ...(previous.browseRoots || previous.roots),
                    ...draft.roots,
                  ]),
                ],
              }
            : draft || previous;
        if (
          !source ||
          source.type !== input.type ||
          (draft && !draft.authorized)
        )
          throw new ProviderError("invalidInput");
        const roots = [...new Set(input.roots)];
        const provider = await this.provider(source);
        for (const root of roots) {
          if (
            !(
              ("browseRoots" in source && source.browseRoots) ||
              source.roots
            ).some((r) =>
              source.type === "local"
                ? containsPath(r, root)
                : containsRemote(r, root),
            )
          )
            throw new ProviderError("outsideRoot");
          await provider.list(root, this.controller.signal);
        }
        const normalized = roots;
        this.store.saveConnection({
          id: previous?.id || source.id,
          name: input.name,
          allowLANHTTP: input.allowLANHTTP ?? previous?.allowLANHTTP ?? false,
          type: source.type,
          roots: normalized,
          scanDepths: Object.fromEntries(
            normalized.map((root) => [
              root,
              input.scanDepths?.[root] ??
                (previous?.roots.includes(root)
                  ? (previous.scanDepths?.[root] ?? 1)
                  : 3),
            ]),
          ),
          browseRoots:
            ("browseRoots" in source && source.browseRoots) || source.roots,
          status: "connected",
          error: null,
          scannedAt: previous?.scannedAt || null,
        });
        if (draft) this.drafts.delete(draft.id);
        void this.refresh();
        break;
      }
      case "test-connection": {
        const connection = this.store.connection(id.parse(value));
        for (const root of connection.roots)
          await (
            await this.provider(connection)
          ).list(root, this.controller.signal);
        this.store.saveConnection({
          ...connection,
          status: "connected",
          error: null,
        });
        break;
      }
      case "remove-connection":
        if (this.refreshing) throw new ProviderError("scanBusy");
        this.store.removeConnection(id.parse(value));
        break;
      case "add-files": {
        const input = z
          .object({
            connectionId: id,
            paths: z.array(location).min(1).max(1000),
          })
          .strict()
          .parse(value);
        const connection = this.store.connection(input.connectionId),
          provider = await this.provider(connection);
        const entries = new Map<
          string,
          Awaited<ReturnType<StorageProvider["list"]>>
        >();
        for (const target of input.paths) {
          const directory =
            connection.type === "local"
              ? path.dirname(target)
              : path.posix.dirname(target);
          if (!entries.has(directory))
            entries.set(directory, await provider.list(directory));
        }
        const files = input.paths.map((target) =>
          [...entries.values()]
            .flat()
            .find((e) => e.path === target && isVideo(e)),
        );
        if (files.some((file) => !file))
          throw new ProviderError("mediaMissing");
        this.store.applyScan(
          connection.id,
          connection.roots[0],
          {
            groups: files.map((file) => ({
              path: file!.path,
              name: file!.name.replace(/\.[^.]+$/, ""),
              files: [file!],
            })),
            completeDirectories: [],
            failures: [],
          },
          true,
        );
        this.automatic.schedule();
        break;
      }
      case "prepare-episodes": {
        const input = z
          .object({
            workId: id,
            connectionId: id,
            paths: z.array(location).min(1).max(1000),
          })
          .strict()
          .parse(value);
        return this.store.prepareEpisodes(
          input.workId,
          input.connectionId,
          await this.selectedFiles(input.connectionId, input.paths),
        );
      }
      case "edit": {
        const input = editSchema.parse(value);
        if (input.cover) await this.artwork.read(input.cover);
        const additions = [];
        for (const connectionId of new Set(
          input.attachments.map((a) => a.connectionId),
        )) {
          const files = await this.selectedFiles(
            connectionId,
            input.attachments
              .filter((a) => a.connectionId === connectionId)
              .map((a) => a.path),
          );
          additions.push(
            ...this.store.prepareEpisodes(input.id, connectionId, files),
          );
        }
        this.store.edit(input, additions);
        this.automatic.schedule();
        break;
      }
      case "remove-work":
        this.store.removeWork(id.parse(value));
        break;
      case "reorder":
        this.store.reorder(z.array(id).max(100000).parse(value));
        break;
      case "save-series":
        this.store.saveSeries(seriesSchema.parse(value));
        break;
      case "remove-series":
        this.store.removeSeries(id.parse(value));
        break;
      case "save-collection":
        this.store.saveCollection(collectionSchema.parse(value));
        break;
      case "remove-collection":
        this.store.removeCollection(id.parse(value));
        break;
      case "progress": {
        const input = progressSchema.parse(value);
        this.store.setProgress(
          input.id,
          input.position,
          input.duration,
          input.resume,
          input.versionId,
          input.fileId,
        );
        break;
      }
      case "media": {
        const input = mediaSelectionSchema.parse(
          typeof value === "string" ? { id: value } : value,
        );
        const episode = this.store.media(
          input.id,
          input.versionId,
          input.fileId,
        );
        if (episode.missing) throw new ProviderError("mediaMissing");
        this.store.connection(episode.connectionId);
        return `tamki-media://video/${episode.id}?ticket=${this.ticket}`;
      }
      case "select-version": {
        const input = mediaSelectionSchema
          .required({ versionId: true })
          .parse(value);
        this.store.selectVersion(input.id, input.versionId);
        break;
      }
      case "thumbnail":
      case "thumbnail-save": {
        const input = (
          type === "thumbnail-save"
            ? mediaSelectionSchema
                .extend({
                  key: z.string().regex(/^[a-f0-9]{64}$/),
                  data: z.string().max(700000),
                })
                .strict()
            : mediaSelectionSchema
        ).parse(value);
        const file = this.store.media(input.id, input.versionId, input.fileId);
        const key = thumbnailKey(file);
        if (type === "thumbnail-save") {
          const saved = input as typeof input & { key: string; data: string };
          if (saved.key !== key) throw new ProviderError("mediaMissing");
          await this.thumbnails.save(key, saved.data);
        }
        const cached = await this.thumbnails.read(key).catch(() => null);
        return {
          key,
          url: cached
            ? `tamki-media://thumbnail/${key}?ticket=${this.ticket}`
            : null,
        };
      }
      case "cover": {
        const key = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(value);
        await this.artwork.read(key);
        return `tamki-media://cover/${key}?ticket=${this.ticket}`;
      }
      default:
        throw new ProviderError("invalidInput");
    }
    this.emit();
    return this.snapshot();
  }
  registerMedia() {
    protocol.handle("tamki-media", async (request) => {
      try {
        const url = new URL(request.url);
        if (
          !["video", "cover", "thumbnail"].includes(url.hostname) ||
          url.searchParams.get("ticket") !== this.ticket ||
          !["GET", "HEAD"].includes(request.method)
        )
          return new Response(null, { status: 403 });
        if (url.hostname === "cover" || url.hostname === "thumbnail") {
          const cover = await (
            url.hostname === "cover" ? this.artwork : this.thumbnails
          ).read(url.pathname.slice(1));
          return new Response(
            request.method === "HEAD" ? null : new Uint8Array(cover.data),
            {
              headers: {
                "Content-Type": cover.type,
                "Content-Length": String(cover.data.length),
                "Cache-Control": "private, max-age=31536000, immutable",
                "X-Content-Type-Options": "nosniff",
                "Access-Control-Allow-Origin": "null",
              },
            },
          );
        }
        const episode = this.store.file(id.parse(url.pathname.slice(1)));
        if (episode.missing) return new Response(null, { status: 404 });
        const connection = this.store.connection(episode.connectionId);
        const provider = await this.provider(connection);
        let size = episode.size,
          local: string | undefined;
        if (provider instanceof LocalProvider) {
          local = await provider.resolve(episode.path);
          const info = await stat(local);
          if (!info.isFile()) return new Response(null, { status: 404 });
          size = info.size;
        }
        const range = parseRange(request.headers.get("range"), size);
        if (!range)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        const headers: Record<string, string> = {
          "Content-Type": mediaType(episode.fileName),
          "Accept-Ranges": "bytes",
          "Content-Length": String(range.end - range.start + 1),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Access-Control-Allow-Origin": "null",
        };
        if (range.partial)
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${size}`;
        if (request.method === "HEAD")
          return new Response(null, {
            status: range.partial ? 206 : 200,
            headers,
          });
        let body: ReadableStream;
        if (local) {
          const stream = createReadStream(local, {
            start: range.start,
            end: range.end,
          });
          request.signal.addEventListener("abort", () => stream.destroy(), {
            once: true,
          });
          body = Readable.toWeb(stream) as ReadableStream;
        } else {
          const abort = new AbortController();
          request.signal.addEventListener("abort", () => abort.abort(), {
            once: true,
          });
          let offset = range.start;
          body = new ReadableStream(
            {
              async pull(controller) {
                try {
                  const bytes = await (provider as ZSpaceProvider).read(
                    episode.path,
                    offset,
                    Math.min(1024 * 1024, range.end - offset + 1),
                    size,
                    abort.signal,
                  );
                  offset += bytes.length;
                  controller.enqueue(bytes);
                  if (offset > range.end) controller.close();
                } catch (e) {
                  controller.error(e);
                }
              },
              cancel() {
                abort.abort();
              },
            },
            { highWaterMark: 1 },
          );
        }
        return new Response(body, {
          status: range.partial ? 206 : 200,
          headers,
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }
  async close() {
    if (this.organizationRequest) this.organizationRequest.cancelled = true;
    this.organization.close();
    this.settings.close();
    await this.automatic.close();
    this.recognition.close();
    this.controller.abort();
    this.cli?.close();
    await this.refreshTask;
    await this.organizationTask?.catch(() => {});
    await this.artworkTask?.catch(() => {});
    this.store.close();
  }
}
