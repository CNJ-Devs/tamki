import { WebContentsView, ipcMain, type BaseWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  captureSelectionSchema,
  downloadSubmitSchema,
  downloadNameSchema,
  safeDownloadName,
  type CaptureSnapshot,
  type CaptureViewState,
  type CaptureResource,
  type CaptureResult,
  type CaptureGroup,
  type CaptureMetadata,
  type DownloadDraft,
} from "../shared/capture";
import { targetSchema } from "../shared/settings";
import { ProviderError } from "../providers/provider";
import { MediaCapture } from "./providers";
import type { VideoDownloads } from "./downloads";
import type { LibraryService } from "../library/service";
import { logEvent, diagnosticError } from "../diagnostics";

export class CaptureOverlay {
  private reel?: WebContentsView;
  private panel?: WebContentsView;
  private loaded?: Promise<void>;
  private current = "";
  private pageContext?: { episodeId?: number; cid?: number };
  private visible = false;
  private controller?: AbortController;
  private snapshot: CaptureSnapshot = { status: "empty" };
  private opened = false;
  private pinned = false;
  private timer?: ReturnType<typeof setTimeout>;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private offset = { right: 16, bottom: 16 };
  private draft?: {
    value: DownloadDraft;
    resources: CaptureResource[];
    groups?: CaptureGroup[];
    metadata?: CaptureMetadata;
  };
  private closed = false;
  private submitting = false;
  private panelHeight = 200;
  constructor(
    private options: {
      window: BaseWindow;
      base: string;
      media: MediaCapture;
      downloads: VideoDownloads;
      library: LibraryService;
      settings(): void;
      onLayout?(): void;
      pageContext?(tabId: number, pageURL: string): Promise<unknown>;
      play(
        result: CaptureResult,
        selected: CaptureResource,
        title?: string,
      ): void;
      shortcut(key: string, modifier: boolean, shift: boolean): boolean;
    },
  ) {
    ipcMain.handle("capture:action", async (event, payload: unknown) => {
      const surface =
        event.sender === this.reel?.webContents
          ? "reel"
          : event.sender === this.panel?.webContents
            ? "panel"
            : undefined;
      if (!surface || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Untrusted IPC sender");
      try {
        const { type, value } = z
          .object({ type: z.string().max(40), value: z.unknown().optional() })
          .strict()
          .parse(payload);
        let data: unknown;
        switch (type) {
          case "state":
            data = this.state(surface);
            break;
          case "hover":
            this.hover(z.boolean().parse(value));
            break;
          case "measure":
            this.panelHeight = z
              .number()
              .finite()
              .min(100)
              .max(2000000)
              .parse(value);
            this.layout();
            break;
          case "pin":
            this.open(true);
            break;
          case "close":
            if (!this.submitting) {
              this.draft = undefined;
              this.dismiss();
            }
            break;
          case "retry": {
            const [tab, url] = JSON.parse(this.current);
            this.current = "";
            this.sync(tab, url);
            break;
          }
          case "drag": {
            const delta = z
              .object({
                x: z.number().finite().min(-10000).max(10000),
                y: z.number().finite().min(-10000).max(10000),
              })
              .strict()
              .parse(value);
            this.dismiss();
            const { width, height } = this.options.window.getContentBounds();
            this.offset.right = Math.max(
              8,
              Math.min(width - 64, this.offset.right - delta.x),
            );
            this.offset.bottom = Math.max(
              8,
              Math.min(height - 138, this.offset.bottom - delta.y),
            );
            this.layout();
            break;
          }
          case "play":
          case "prepare": {
            const selection = captureSelectionSchema.parse(value),
              result = this.snapshot.result;
            if (!result || selection.resultId !== result.id)
              throw new ProviderError("captureChanged");
            const series = selection.seriesId
              ? result.series?.find((s) => s.id === selection.seriesId)
              : undefined;
            const seriesGroups = series
              ? series.groupIds
                  .map((id) => result.groups.find((g) => g.id === id)!)
                  .filter(Boolean)
              : undefined;
            const group = selection.groupId
              ? result.groups
                  .flatMap((g) => [g, ...(g.sections || [])])
                  .find((g) => g.id === selection.groupId)
              : undefined;
            if (group?.incomplete || seriesGroups?.some((g) => g.incomplete))
              throw new ProviderError("captureIncomplete");
            const resource = selection.resourceId
              ? [
                  result.current,
                  ...result.groups.flatMap((g) => g.resources),
                ].find((r) => r?.id === selection.resourceId)
              : undefined;
            const resources = seriesGroups
              ? [
                  ...new Map(
                    seriesGroups
                      .flatMap((g) => g.resources)
                      .map((r) => [r.id, r]),
                  ).values(),
                ]
              : group?.resources || (resource ? [resource] : []);
            if (!resources.length) throw new ProviderError("captureChanged");
            logEvent("capture.selection", {
              operation: type,
              files: resources.length,
            });
            if (type === "play") {
              this.options.play(
                result,
                resource || resources[0],
                series?.title,
              );
              this.dismiss();
              break;
            }
            const rule =
              this.options.library.settings.snapshot().downloads[
                group || series ? "series" : "video"
              ];
            const candidate =
              rule.mode === "fixed" ? rule.fixed : rule.last || rule.fixed;
            const fallback = this.options.library.store
              .connections()
              .find((c) => c.status !== "offline" && c.roots.length);
            const target =
              candidate ||
              (fallback
                ? { connectionId: fallback.id, path: fallback.roots[0] }
                : null);
            this.draft = {
              resources,
              groups: seriesGroups,
              metadata: series
                ? undefined
                : group?.metadata ||
                  resource?.workMetadata ||
                  result.groups.find((g) =>
                    g.resources.some((r) => r.id === resource?.id),
                  )?.metadata ||
                  result.metadata,
              value: {
                id: randomUUID(),
                name: safeDownloadName(
                  series?.title || group?.title || resource!.title,
                ),
                count: resources.length,
                series: !!group || !!series,
                hierarchy: seriesGroups?.map((g) => ({
                  title: g.title,
                  count: g.resources.length,
                })),
                target,
              },
            };
            const prepared = this.draft;
            this.open(true);
            this.emit();
            try {
              const media = await this.options.media.resolve(
                resources[0],
                AbortSignal.timeout(15000),
              );
              prepared.value.qualities = media.qualities || [];
            } catch (error) {
              prepared.value.qualityError =
                error instanceof Error ? error.message : "captureUnavailable";
            }
            if (this.draft !== prepared)
              throw new ProviderError("captureChanged");
            this.open(true);
            data = this.draft.value;
            break;
          }
          case "list":
            data = await this.options.library.request("list", value);
            break;
          case "roots":
            data = await this.options.library.request("browse-roots", value);
            break;
          case "mkdir": {
            const input = z
              .object({ target: targetSchema, name: downloadNameSchema })
              .strict()
              .parse(value);
            data = await this.options.library.downloadStorage.mkdir(
              input.target,
              input.name,
            );
            break;
          }
          case "settings":
            if (!this.submitting) {
              this.draft = undefined;
              this.dismiss();
              this.options.settings();
            }
            break;
          case "submit": {
            const input = downloadSubmitSchema.parse(value),
              draft = this.draft;
            if (!draft || input.draftId !== draft.value.id)
              throw new ProviderError("captureChanged");
            if (
              input.qualities?.some(
                (id) =>
                  id !== 0 && !draft.value.qualities?.some((q) => q.id === id),
              )
            )
              throw new ProviderError("captureInvalid");
            if (this.submitting) throw new ProviderError("downloadBusy");
            this.submitting = true;
            try {
              const job = await this.options.downloads.enqueue(
                input.name,
                draft.resources,
                input.target,
                draft.value.series,
                input.qualities,
                draft.groups,
                draft.metadata,
              );
              const settings = this.options.library.settings.snapshot();
              const connection = this.options.library.store.connection(
                input.target.connectionId,
              );
              const paths = connection.type === "local" ? path : path.posix;
              settings.downloads[draft.value.series ? "series" : "video"].last =
                {
                  ...input.target,
                  path:
                    draft.value.series &&
                    paths.basename(input.target.path) === input.name
                      ? paths.dirname(input.target.path)
                      : input.target.path,
                };
              this.options.library.settings.save(settings);
              this.draft = undefined;
              this.dismiss();
              data = { id: job.id };
            } finally {
              this.submitting = false;
            }
            break;
          }
          default:
            throw new ProviderError("invalidInput");
        }
        return { ok: true, data };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof ProviderError
              ? error.code
              : error instanceof z.ZodError
                ? "invalidInput"
                : "downloadNetwork",
        };
      }
    });
  }
  private state(surface: "reel" | "panel"): CaptureViewState {
    return {
      surface,
      open: this.opened,
      pinned: this.pinned,
      snapshot: this.snapshot,
      preferences: this.options.library.store.preferences(),
      draft: this.draft?.value,
      connections: this.options.library.store.connections(),
    };
  }
  emit() {
    for (const [view, surface] of [
      [this.reel, "reel"],
      [this.panel, "panel"],
    ] as const)
      if (view && !view.webContents.isDestroyed())
        view.webContents.send("capture:state", this.state(surface));
  }
  private ensure() {
    if (this.loaded) return this.loaded;
    const create = () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: path.join(this.options.base, "capture-preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      view.setBackgroundColor("#00000000");
      view.setVisible(false);
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", (e) => e.preventDefault());
      wc.on("will-attach-webview", (e) => e.preventDefault());
      wc.on("before-input-event", (event, input) => {
        if (
          this.options.shortcut(
            input.key,
            input.meta || input.control,
            input.shift,
          )
        )
          event.preventDefault();
      });
      this.options.window.contentView.addChildView(view);
      return view;
    };
    this.reel = create();
    this.panel = create();
    this.loaded = Promise.all(
      [this.reel, this.panel].map((v) =>
        v.webContents.loadURL(
          pathToFileURL(path.join(this.options.base, "ui/capture.html")).href,
        ),
      ),
    ).then(() => {
      if (!this.closed) {
        this.emit();
        this.layout();
      }
    });
    return this.loaded;
  }
  updateCurrent(tabId: number, pageURL: string, value: unknown) {
    if (this.current !== JSON.stringify([tabId, pageURL])) return;
    const parsed = z
      .object({
        episodeId: z.number().int().positive().safe().optional(),
        cid: z.number().int().positive().safe().optional(),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) return;
    this.pageContext = parsed.data;
    this.applyPageContext();
  }
  private applyPageContext() {
    const result = this.snapshot.result,
      context = this.pageContext;
    if (!result || !context) return;
    const resource = result.groups
      .flatMap((g) => g.resources)
      .find((r) =>
        context.episodeId
          ? r.episodeId === context.episodeId
          : context.cid && r.cid === context.cid,
      );
    if (resource && result.current?.id !== resource.id) {
      result.current = resource;
      this.emit();
    }
  }
  sync(tabId: number, pageURL: string) {
    this.visible = !!tabId && !!pageURL && pageURL !== "about:blank";
    const next = JSON.stringify([tabId, pageURL]);
    if (next !== this.current) {
      this.current = next;
      this.pageContext = undefined;
      this.controller?.abort();
      if (!this.submitting) this.draft = undefined;
      this.dismiss();
      this.snapshot = {
        status: this.options.media.supports(pageURL) ? "loading" : "empty",
      };
      if (this.visible && this.options.media.supports(pageURL)) {
        const controller = new AbortController();
        this.controller = controller;
        void this.options
          .pageContext?.(tabId, pageURL)
          .then((context) => {
            if (!controller.signal.aborted)
              this.updateCurrent(tabId, pageURL, context);
          })
          .catch(() => {});
        void this.options.media
          .discover(pageURL, controller.signal)
          .then((result) => {
            if (controller.signal.aborted || this.current !== next) return;
            this.snapshot =
              result &&
              (result.current || result.groups.some((g) => g.resources.length))
                ? { status: "ready", result }
                : { status: "empty" };
            this.applyPageContext();
            if (result)
              logEvent("capture.discovered", {
                groups: result.groups.length,
                files: new Set(
                  [result.current, ...result.groups.flatMap((g) => g.resources)]
                    .filter(Boolean)
                    .map((r) => r!.id),
                ).size,
              });
            this.emit();
          })
          .catch((error) => {
            if (controller.signal.aborted || this.current !== next) return;
            this.snapshot = {
              status: "failed",
              error:
                error instanceof ProviderError ? error.code : "captureNetwork",
            };
            this.emit();
            logEvent("capture.failed", diagnosticError(error), "error");
          });
      }
      if (this.visible)
        void this.ensure().catch((error) =>
          logEvent("capture.surface-failed", diagnosticError(error), "error"),
        );
      this.emit();
    }
    this.layout();
  }
  private hover(inside: boolean) {
    if (this.timer) clearTimeout(this.timer);
    if (inside) this.open(false);
    else if (!this.pinned && !this.draft)
      this.timer = setTimeout(() => this.dismiss(), 220);
  }
  open(pin = false) {
    if (!this.visible) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.opened = true;
    this.pinned = this.pinned || pin;
    this.emit();
    this.layout();
    if (pin) this.panel?.webContents.focus();
  }
  dismiss() {
    if (this.draft) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.opened = false;
    this.pinned = false;
    this.emit();
    this.layout();
    this.hideTimer = setTimeout(() => {
      if (!this.opened) this.panel?.setVisible(false);
    }, 160);
  }
  layout() {
    if (!this.reel || !this.panel || this.closed) return;
    const { width, height } = this.options.window.getContentBounds();
    const x = Math.max(8, Math.min(width - 64, width - this.offset.right - 56)),
      y = Math.max(90, Math.min(height - 64, height - this.offset.bottom - 56));
    this.reel.setBounds({ x, y, width: 56, height: 56 });
    this.reel.setVisible(this.visible && !this.draft);
    if (this.draft)
      this.panel.setBounds({
        x: 8,
        y: 42,
        width: Math.max(1, width - 16),
        height: Math.max(1, height - 50),
      });
    else {
      const w = Math.min(380, width - 16),
        h = Math.min(this.panelHeight, 460, height - 106);
      this.panel.setBounds({
        x: Math.max(8, Math.min(width - w - 8, x + 56 - w)),
        y: Math.max(90, y - h + 8),
        width: w,
        height: h,
      });
    }
    if (this.opened) this.panel.setVisible(this.visible);
    else if (!this.visible) this.panel.setVisible(false);
    this.options.window.contentView.addChildView(this.reel);
    this.options.window.contentView.addChildView(this.panel);
    this.options.onLayout?.();
  }
  close() {
    this.closed = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    ipcMain.removeHandler("capture:action");
    this.reel?.webContents.close();
    this.panel?.webContents.close();
  }
}
