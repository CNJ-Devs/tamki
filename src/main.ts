import {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  session,
  protocol,
  type DownloadItem,
} from "electron";
import path from "node:path";
import {
  RuntimeLog,
  setRuntimeLog,
  logEvent,
  diagnosticError,
  traced,
} from "./diagnostics";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isWebURL, resolveAddress } from "./navigation";
import { LibraryService } from "./library/service";
import type { BrowserState, Transfer } from "./shared/model";
import { id } from "./shared/validation";
import { Bilibili, biliPage } from "./capture/bilibili";
import { capturePageContextScript } from "./capture/page-context";
import { MediaCapture } from "./capture/providers";
import { CapturePlayback } from "./capture/playback";
import { VideoDownloads, muxMedia } from "./capture/downloads";
import { CaptureOverlay } from "./capture/overlay";
import { downloadActionSchema } from "./shared/capture";

if (process.env.TAMKI_TEST_PROFILE)
  app.setPath("userData", process.env.TAMKI_TEST_PROFILE);
app.setName("Tamki");
setRuntimeLog(new RuntimeLog(path.join(app.getPath("userData"), "logs")));
logEvent("app.start", { version: app.getVersion() });
process.on("uncaughtExceptionMonitor", (error) =>
  logEvent("app.uncaught", diagnosticError(error), "error"),
);
app.on("render-process-gone", (_event, _contents, details) =>
  logEvent(
    "app.renderer-gone",
    { reason: details.reason, exitCode: details.exitCode },
    "error",
  ),
);
app.on("child-process-gone", (_event, details) =>
  logEvent(
    "app.child-gone",
    {
      reason: details.reason,
      exitCode: details.exitCode,
      processType: details.type,
    },
    "error",
  ),
);
app.on("will-quit", () => logEvent("app.quit"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tamki-stream",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "tamki-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
let window: BaseWindow, shell: WebContentsView, library: LibraryService;
let capture: CaptureOverlay | undefined,
  videoDownloads: VideoDownloads | undefined;
let onlinePlayback: CapturePlayback;
let tabPicker: WebContentsView | undefined;
let pickerOpen = false;
let pickerMode: "tabs" | "history" | "tasks" = "tabs";
let restoredSession = false;
let pickerReady: Promise<void> | undefined;
let active = 0,
  nextId = 1,
  closing = false;
type Tab =
  | {
      kind: "web";
      view: WebContentsView;
      error: string;
    }
  | {
      kind: "player";
      workId: string;
      onlineWork?: import("./shared/model").OnlineWork;
    };
const tabs = new Map<number, Tab>();
const downloads = new Map<string, DownloadItem>();
function snapshot(): BrowserState {
  return {
    active,
    pickerOpen,
    pickerMode,
    tabs: [...tabs].map(([id, tab]) => {
      if (tab.kind === "player")
        return {
          id,
          kind: "player",
          workId: tab.workId,
          onlineWork: tab.onlineWork,
          title:
            tab.onlineWork?.title ||
            library.snapshot().works.find((w) => w.id === tab.workId)?.title ||
            "",
          url: "",
          loading: false,
          back: false,
          forward: false,
          error: "",
        };
      const wc = tab.view.webContents;
      return {
        id,
        kind: "web",
        title: wc.getTitle(),
        url: wc.getURL(),
        loading: wc.isLoading(),
        back: wc.navigationHistory.canGoBack(),
        forward: wc.navigationHistory.canGoForward(),
        error: tab.error,
      };
    }),
  };
}
function persistSession() {
  if (!restoredSession || closing || !library) return;
  const entries = [...tabs.entries()].filter(([, tab]) => tab.kind === "web");
  library.store.setConfig(
    "browserSession",
    JSON.stringify({
      urls: entries.map(([, tab]) =>
        tab.kind === "web"
          ? tab.view.webContents.getURL() || "about:blank"
          : "about:blank",
      ),
      active: entries.findIndex(([id]) => id === active),
    }),
  );
}
function browserHistory(): import("./shared/model").BrowserVisit[] {
  try {
    return JSON.parse(library.store.config("browserHistory") || "[]");
  } catch {
    return [];
  }
}
function emit() {
  persistSession();
  if (!closing && shell && !shell.webContents.isDestroyed())
    shell.webContents.send("browser:state", snapshot());
  emitPicker();
}
function pickerState() {
  return {
    browser: snapshot(),
    preferences: library.store.preferences(),
    mode: pickerMode,
    history: pickerMode === "history" ? browserHistory() : [],
    jobs: pickerMode === "tasks" ? library.store.downloadJobs() : [],
    transfers: pickerMode === "tasks" ? library.snapshot().transfers : [],
  };
}
function emitPicker() {
  if (!closing && tabPicker && !tabPicker.webContents.isDestroyed())
    tabPicker.webContents.send("tabs:state", pickerState());
}
function dismissPicker(restoreFocus = false) {
  if (!pickerOpen) return;
  pickerOpen = false;
  tabPicker?.setVisible(false);
  emit();
  if (restoreFocus) {
    shell.webContents.focus();
    shell.webContents.send("browser:focus-tabs");
  }
}
async function openPicker(mode: "tabs" | "history" | "tasks" = "tabs") {
  capture?.dismiss();
  if (pickerOpen && pickerMode === mode) {
    dismissPicker(true);
    return;
  }
  pickerMode = mode;
  pickerOpen = true;
  if (!tabPicker) {
    tabPicker = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "tab-picker-preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    tabPicker.setVisible(false);
    tabPicker.setBorderRadius(12);
    tabPicker.setBackgroundColor("#00000000");
    window.contentView.addChildView(tabPicker);
    const wc = tabPicker.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        dismissPicker(true);
      }
    });
    pickerReady = wc.loadURL(
      pathToFileURL(path.join(__dirname, "ui/tab-picker.html")).href,
    );
  }
  try {
    await pickerReady;
  } catch {
    dismissPicker(true);
    return;
  }
  if (!pickerOpen || closing) return;
  window.contentView.addChildView(tabPicker);
  layout();
  tabPicker.setVisible(true);
  tabPicker.webContents.focus();
  emit();
}
function emitLibrary() {
  if (!closing && library && shell && !shell.webContents.isDestroyed())
    shell.webContents.send("library:state", library.snapshot());
  emitPicker();
  capture?.emit();
}
function layout() {
  if (!window || closing) return;
  const { width, height } = window.getContentBounds();
  shell.setBounds({ x: 0, y: 0, width, height });
  for (const [id, tab] of tabs) {
    if (tab.kind !== "web") continue;
    tab.view.setVisible(
      id === active &&
        !tab.error &&
        tab.view.webContents.getURL() !== "about:blank",
    );
    tab.view.setBounds({
      x: 8,
      y: 82,
      width: Math.max(1, width - 16),
      height: Math.max(1, height - 90),
    });
  }
  tabPicker?.setBounds({
    x: Math.max(8, width - (pickerMode === "tasks" ? 448 : 368)),
    y: 40,
    width: Math.min(pickerMode === "tasks" ? 440 : 360, width - 16),
    height: Math.min(
      height - 56,
      pickerMode === "tabs" ? Math.min(390, 104 + tabs.size * 56) : 520,
    ),
  });
  const tab = currentWeb();
  capture?.sync(tab ? active : 0, tab?.view.webContents.getURL() || "");
  if (tabPicker && pickerOpen) window.contentView.addChildView(tabPicker);
}
function select(id: number) {
  if (id !== 0 && !tabs.has(id)) return;
  dismissPicker();
  capture?.dismiss();
  active = id;
  layout();
  shell.webContents.focus();
  emit();
}
async function capturePageContext(
  tabId: number,
  pageURL: string,
): Promise<unknown> {
  const tab = tabs.get(tabId);
  const page = biliPage(pageURL);
  if (
    tab?.kind !== "web" ||
    tab.view.webContents.isDestroyed() ||
    tab.view.webContents.getURL() !== pageURL ||
    page?.kind !== "season" ||
    !!page.episodeId
  )
    return {};
  return tab.view.webContents.executeJavaScript(capturePageContextScript);
}
function createTab(url = "about:blank") {
  if (url !== "about:blank" && !isWebURL(url)) return;
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:tamki-browser",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  // Remote pages are native views above the shell; shell CSS cannot clip them.
  view.setBorderRadius(8);
  const tab: Extract<Tab, { kind: "web" }> = { kind: "web", view, error: "" };
  tabs.set(id, tab);
  window.contentView.addChildView(view);
  if (tabPicker) window.contentView.addChildView(tabPicker);
  const wc = view.webContents;
  wc.on("focus", () => {
    dismissPicker();
    capture?.dismiss();
  });
  wc.on("before-mouse-event", (_event, input) => {
    if (input.type === "mouseDown") {
      dismissPicker();
      capture?.dismiss();
    }
  });
  wc.setWindowOpenHandler(({ url: target }) => {
    if (isWebURL(target)) createTab(target);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, target) => {
    if (!isWebURL(target)) event.preventDefault();
  });
  wc.on("will-redirect", (event, target) => {
    if (!isWebURL(target)) event.preventDefault();
  });
  wc.on("will-frame-navigate", (event) => {
    if (!isWebURL(event.url) && event.url !== "about:blank")
      event.preventDefault();
  });
  const updated = () => {
    layout();
    emit();
  };
  wc.on("page-title-updated", updated);
  const recordVisit = () => {
    const url = wc.getURL();
    if (!isWebURL(url)) return;
    const previous = browserHistory().filter((entry) => entry.url !== url);
    previous.unshift({ url, title: wc.getTitle() || url, time: Date.now() });
    library.store.setConfig(
      "browserHistory",
      JSON.stringify(previous.slice(0, 1000)),
    );
  };
  wc.on("did-navigate", () => {
    recordVisit();
    updated();
  });
  wc.on("did-stop-loading", recordVisit);
  wc.on("did-navigate-in-page", updated);
  wc.on("did-start-loading", updated);
  wc.on("did-stop-loading", updated);
  const refreshCaptureContext = () => {
    if (active !== id) return;
    const url = wc.getURL();
    void capturePageContext(id, url)
      .then((context) => capture?.updateCurrent(id, url, context))
      .catch(() => {});
  };
  wc.on("dom-ready", refreshCaptureContext);
  wc.on("did-stop-loading", refreshCaptureContext);
  wc.on("did-navigate-in-page", refreshCaptureContext);
  wc.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && tabs.has(id)) {
      tab.error = "pageFailed";
      updated();
    }
  });
  wc.on("render-process-gone", () => {
    if (tabs.has(id)) {
      tab.error = "pageFailed";
      updated();
    }
  });
  wc.on("before-input-event", (event, input) => {
    if (shortcut(input.key, input.meta || input.control, input.shift))
      event.preventDefault();
  });
  void wc.loadURL(url).catch(() => {});
  select(id);
}

function closeTab(id: number) {
  const tab = tabs.get(id);
  if (!tab) return;
  const ids = [...tabs.keys()],
    index = ids.indexOf(id);
  if (tab?.kind === "player" && tab.onlineWork)
    onlinePlayback.close(tab.workId);
  tabs.delete(id);
  if (tab.kind === "web") {
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  if (active === id) active = ids[index + 1] || ids[index - 1] || 0;
  layout();
  emit();
}
function currentWeb() {
  const tab = tabs.get(active);
  return tab?.kind === "web" ? tab : undefined;
}
function shortcut(key: string, modifier: boolean, shift: boolean) {
  if (!modifier) return false;
  const lower = key.toLowerCase();
  if (lower === "d" && shift && currentWeb()) {
    capture?.open(true);
  } else if (lower === "h") {
    void openPicker("history");
  } else if (lower === "l") {
    if (!currentWeb()) createTab();
    shell.webContents.focus();
    shell.webContents.send("browser:focus-address");
  } else if (lower === "t") createTab();
  else if (lower === "w") closeTab(active);
  else if (lower === "r") {
    const tab = currentWeb();
    if (tab) {
      tab.error = "";
      tab.view.webContents.reload();
    }
  } else if (lower === "tab") {
    const ids = [0, ...tabs.keys()];
    select(
      ids[(ids.indexOf(active) + (shift ? ids.length - 1 : 1)) % ids.length],
    );
  } else return false;
  return true;
}

app
  .whenReady()
  .then(async () => {
    await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
    library = new LibraryService(emitLibrary);
    library.registerMedia();
    const profile = session.fromPartition("persist:tamki-browser");
    profile.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    profile.setPermissionCheckHandler(() => false);
    profile.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({
        defaultPath: path.join(
          app.getPath("downloads"),
          path.basename(item.getFilename()),
        ),
      });
      const transfer: Transfer = {
        id: randomUUID(),
        name: item.getFilename(),
        destination: "",
        state: "running",
        received: 0,
        total: item.getTotalBytes(),
        createdAt: Date.now(),
      };
      downloads.set(transfer.id, item);
      let savedAt = 0;
      const update = (force = false) => {
        if (closing || (!force && Date.now() - savedAt < 250)) return;
        savedAt = Date.now();
        transfer.destination = item.getSavePath();
        transfer.received = item.getReceivedBytes();
        transfer.total = item.getTotalBytes();
        library.store.saveTransfer(transfer);
        emitLibrary();
      };
      item.on("updated", (_event, state) => {
        transfer.state =
          state === "interrupted"
            ? "interrupted"
            : item.isPaused()
              ? "paused"
              : "running";
        update();
      });
      item.once("done", (_event, state) => {
        transfer.state = state;
        update(true);
        downloads.delete(transfer.id);
      });
    });
    window = new BaseWindow({
      title: "Tamki",
      show: process.env.TAMKI_BACKGROUND_TEST !== "1",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hidden" as const,
            trafficLightPosition: { x: 14, y: 15 },
          }
        : {}),
      width: 1280,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      backgroundColor: "#eee9e1",
    });
    shell = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        disableHtmlFullscreenWindowResize:
          process.env.TAMKI_BACKGROUND_TEST === "1",
      },
    });
    window.contentView.addChildView(shell);
    const mediaCapture = new MediaCapture([
      new Bilibili(profile.fetch.bind(profile) as typeof fetch),
    ]);
    onlinePlayback = new CapturePlayback(
      (resource, signal) => mediaCapture.resolve(resource, signal),
      profile.fetch.bind(profile) as typeof fetch,
    );
    protocol.handle("tamki-stream", (request) =>
      onlinePlayback.handle(request),
    );
    videoDownloads = new VideoDownloads({
      limits: () => library.settings.snapshot().downloadLimits,
      store: library.store,
      cache: path.join(app.getPath("userData"), "video-downloads"),
      request: profile.fetch.bind(profile) as typeof fetch,
      resolve: (resource, signal) => mediaCapture.resolve(resource, signal),
      mux: (media, inputs, output, signal) =>
        muxMedia(
          path.join(
            __dirname.replace(/app\.asar(?=[/\\])/, "app.asar.unpacked"),
            "tools",
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
          ),
          media,
          inputs,
          output,
          signal,
        ),
      target: (target, name, series) =>
        library.downloadStorage.target(target, name, series),
      publish: (file, target, name, id, signal, progress) =>
        library.downloadStorage.publish(
          file,
          target,
          name,
          id,
          signal,
          progress,
        ),
      completed: (job, item) => library.completeDownload(job, item),
      emit: () => {
        emitPicker();
        if (!closing && !shell.webContents.isDestroyed())
          shell.webContents.send(
            "library:downloads",
            library.store.downloadJobs(),
          );
      },
    });
    capture = new CaptureOverlay({
      window,
      base: __dirname,
      media: mediaCapture,
      pageContext: capturePageContext,
      play: (result, selected, title) => {
        // User-initiated handoff: stop the source page's media before opening our player.
        void currentWeb()
          ?.view.webContents.executeJavaScript(
            "document.querySelectorAll('video,audio').forEach(media => media.pause())",
          )
          .catch(() => {});
        const work = onlinePlayback.createContext(result, selected, title);
        const tabId = nextId++;
        tabs.set(tabId, { kind: "player", workId: work.id, onlineWork: work });
        select(tabId);
      },
      downloads: videoDownloads,
      library,
      shortcut,
      settings: () => {
        select(0);
        shell.webContents.send("browser:open-page", "settings");
      },
    });
    shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    shell.webContents.on("will-navigate", (event) => event.preventDefault());
    shell.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    shell.webContents.on("before-input-event", (event, input) => {
      if (shortcut(input.key, input.meta || input.control, input.shift))
        event.preventDefault();
    });
    ipcMain.handle("tabs:action", async (event, payload: unknown) => {
      if (
        !tabPicker ||
        event.sender !== tabPicker.webContents ||
        event.senderFrame !== tabPicker.webContents.mainFrame
      )
        throw new Error("Untrusted IPC sender");
      const action = z
        .discriminatedUnion("type", [
          z
            .object({
              type: z.literal("state"),
              value: z.undefined().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("dismiss"),
              value: z.undefined().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("select"),
              value: z.number().int().nonnegative(),
            })
            .strict(),
          z
            .object({
              type: z.literal("open-history"),
              value: z.string().url().max(8192),
            })
            .strict(),
          z
            .object({
              type: z.literal("all-tasks"),
              value: z.undefined().optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("play-download"),
              value: z
                .object({
                  jobId: z.string().uuid(),
                  itemId: z.string().uuid(),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              type: z.literal("download-action"),
              value: downloadActionSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal("transfer-action"),
              value: z
                .object({ id, action: z.enum(["pause", "resume"]) })
                .strict(),
            })
            .strict(),
          z
            .object({
              type: z.literal("clear-history"),
              value: z.undefined().optional(),
            })
            .strict(),
        ])
        .parse(payload);
      if (action.type === "play-download") {
        const job = library.store
          .downloadJobs()
          .find((job) => job.id === action.value.jobId);
        const item = job?.items.find(
          (item) =>
            item.state === "completed" && item.id === action.value.itemId,
        );
        const work =
          item &&
          library
            .snapshot()
            .works.find((work) =>
              work.episodes.some((episode) => episode.id === item.episodeId),
            );
        if (!work || !item?.episodeId) throw new Error("mediaMissing");
        const version = work.episodes
          .find((e) => e.id === item.episodeId)
          ?.versions?.find((v) => v.files.some((f) => f.path === item.path));
        if (version) {
          library.store.selectVersion(item.episodeId, version.id);
          emitLibrary();
        }
        dismissPicker();
        shell.webContents.send("browser:play-download", {
          workId: work.id,
          episodeId: item.episodeId,
        });
      }
      if (action.type === "download-action") {
        if (action.value.action === "remove")
          await videoDownloads!.remove(action.value.id, action.value.itemId);
        else
          videoDownloads!.command(
            action.value.id,
            action.value.action,
            action.value.itemId,
          );
      }
      if (action.type === "transfer-action") {
        const item = downloads.get(action.value.id);
        if (!item) throw new Error("transferUnavailable");
        if (action.value.action === "pause") item.pause();
        else if (item.canResume()) item.resume();
        else throw new Error("transferUnavailable");
      }
      if (action.type === "open-history") {
        if (
          !isWebURL(action.value) ||
          !browserHistory().some((entry) => entry.url === action.value)
        )
          throw new Error("invalidInput");
        createTab(action.value);
      }
      if (action.type === "clear-history") {
        library.store.setConfig("browserHistory", "[]");
        emitPicker();
      }
      if (action.type === "all-tasks") {
        select(0);
        shell.webContents.send("browser:open-page", "tasks");
      }
      if (action.type === "select") select(action.value);
      if (action.type === "dismiss") dismissPicker(true);
      return pickerState();
    });
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (
        event.sender !== shell.webContents ||
        event.senderFrame !== shell.webContents.mainFrame
      )
        throw new Error("Untrusted IPC sender");
    };
    ipcMain.handle("browser:action", async (event, payload: unknown) => {
      trusted(event);
      const action = z
          .object({ type: z.string(), value: z.unknown().optional() })
          .strict()
          .parse(payload),
        tab = currentWeb(),
        wc = tab?.view.webContents;
      switch (action.type) {
        case "history-open":
          await openPicker("history");
          break;
        case "tasks-open":
          await openPicker("tasks");
          break;
        case "tabs-open":
          await openPicker();
          break;
        case "tabs-dismiss":
          dismissPicker();
          break;
        case "state":
          break;
        case "new":
          createTab();
          break;
        case "select":
          select(z.number().int().nonnegative().parse(action.value));
          break;
        case "close":
          closeTab(z.number().int().positive().parse(action.value));
          break;
        case "navigate": {
          const url = resolveAddress(z.string().max(8192).parse(action.value));
          if (wc && tab) {
            tab.error = "";
            void wc.loadURL(url).catch(() => {});
          } else createTab(url);
          break;
        }
        case "back":
          if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
          break;
        case "forward":
          if (wc?.navigationHistory.canGoForward())
            wc.navigationHistory.goForward();
          break;
        case "reload":
          if (wc && tab) {
            tab.error = "";
            wc.reload();
          }
          break;
        case "stop":
          wc?.stop();
          break;
        case "play": {
          const workId = id.parse(action.value);
          if (!library.snapshot().works.some((w) => w.id === workId))
            throw new Error("mediaMissing");
          const existing = [...tabs].find(
            ([, t]) => t.kind === "player" && t.workId === workId,
          );
          if (existing) select(existing[0]);
          else {
            const tabId = nextId++;
            tabs.set(tabId, { kind: "player", workId });
            select(tabId);
          }
          break;
        }
        default:
          throw new Error("invalidInput");
      }
      layout();
      emit();
      return snapshot();
    });
    ipcMain.handle("library:action", async (event, payload: unknown) => {
      trusted(event);
      try {
        const action = z
          .object({ type: z.string().max(50), value: z.unknown().optional() })
          .strict()
          .parse(payload);
        if (action.type === "transfer") {
          const input = z
            .object({ id, action: z.enum(["pause", "resume", "cancel"]) })
            .strict()
            .parse(action.value);
          const item = downloads.get(input.id);
          if (!item) throw new Error("transferUnavailable");
          if (input.action === "pause") item.pause();
          else if (input.action === "resume" && item.canResume()) item.resume();
          else if (input.action === "cancel") item.cancel();
          else throw new Error("transferUnavailable");
          return { ok: true, data: library.snapshot() };
        }
        if (action.type === "video-download-action") {
          const input = downloadActionSchema.parse(action.value);
          if (input.action === "remove")
            await videoDownloads!.remove(input.id, input.itemId);
          else videoDownloads!.command(input.id, input.action, input.itemId);
          return { ok: true, data: library.snapshot() };
        }
        if (action.type === "online-player-error") {
          const detail = z
            .object({
              episodeId: z.string().max(100),
              stage: z.enum(["dash", "video"]),
              code: z.string().max(100),
            })
            .strict()
            .parse(action.value);
          logEvent(
            "playback.player-failed",
            {
              workId: detail.episodeId,
              phase: detail.stage,
              errorCode: detail.code,
            },
            "error",
          );
          return { ok: true };
        }
        if (action.type === "online-media") {
          const input = z
            .union([
              z
                .string()
                .max(100)
                .transform((episodeId) => ({ episodeId, quality: undefined })),
              z
                .object({
                  episodeId: z.string().max(100),
                  quality: z.number().int().min(0).max(1000).optional(),
                })
                .strict(),
            ])
            .parse(action.value);
          return {
            ok: true,
            data: await traced(
              "playback.resolve",
              { workId: input.episodeId },
              () => onlinePlayback.source(input.episodeId, input.quality),
            ),
          };
        }
        return {
          ok: true,
          data: [
            "state",
            "progress",
            "organize-progress",
            "source-authorization",
            "source-account-status",
          ].includes(action.type)
            ? await library.request(action.type, action.value)
            : await traced("library.action", { operation: action.type }, () =>
                library.request(action.type, action.value),
              ),
        };
      } catch (e) {
        const message =
          e instanceof Error && /^[a-zA-Z]+$/.test(e.message)
            ? e.message
            : "requestFailed";
        return { ok: false, error: message };
      }
    });
    window.on("resize", layout);
    window.on("blur", () => dismissPicker());
    window.on("close", () => {
      if (closing) return;
      persistSession();
      closing = true;
      for (const tab of tabs.values())
        if (tab.kind === "web" && !tab.view.webContents.isDestroyed())
          tab.view.webContents.close();
      shell.webContents.close();
      tabPicker?.webContents.close();
      capture?.close();
      void videoDownloads
        ?.close()
        .finally(() => library.close().finally(() => app.quit()));
    });
    await shell.webContents.loadURL(
      pathToFileURL(path.join(__dirname, "ui/index.html")).href,
    );
    try {
      const previous = z
        .object({
          urls: z.array(z.string().max(8192)).max(200),
          active: z.number().int(),
        })
        .parse(JSON.parse(library.store.config("browserSession") || "{}"));
      const ids: number[] = [];
      for (const url of previous.urls)
        if (url === "about:blank" || isWebURL(url)) {
          createTab(url);
          ids.push(active);
        }
      select(ids[previous.active] || 0);
    } catch {
      /* No previous session, or invalid saved data. */
    }
    restoredSession = true;
    layout();
    emit();
    emitLibrary();
    void videoDownloads.reconcile();
    library.automatic.start();
    void library.repairMissingArtwork();
    if (library.store.preferences().refreshOnOpen) void library.refresh();
  })
  .catch((error) => {
    logEvent("app.start-failed", diagnosticError(error), "error");
    app.quit();
  });
app.on("window-all-closed", () => {
  if (!closing) app.quit();
});
