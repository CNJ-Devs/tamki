import { BrowserSites } from "./browser-sites";
import { loadFavicon } from "./browser-favicon";
import { pageMenu, showWebMenu } from "./browser-menus";
import { browserMessages } from "./shared/browser-messages";
import {
  app,
  Menu,
  dialog,
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
import {
  isWebURL,
  resolveAddress,
  searchURL,
  searchEngines,
  type SearchEngine,
} from "./navigation";
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
type PickerMode = "tabs" | "history" | "tasks" | "bookmarks" | "address";
let pickerMode: PickerMode = "tabs";
let addressQuery = "",
  suggestionIndex = -1;
let addressBounds = { x: 112, y: 82, width: 600 };
let browserSites: BrowserSites;
let restoredSession = false;
let lastSavedSession = "";
let pickerReady: Promise<void> | undefined;
let active = 0,
  nextId = 1,
  closing = false;
type Tab =
  | {
      kind: "web";
      view: WebContentsView;
      error: string;
      favicon?: string;
      find?: {
        open: boolean;
        text: string;
        active: number;
        matches: number;
        requestId?: number;
      };
    }
  | {
      kind: "player";
      workId: string;
      onlineWork?: import("./shared/model").OnlineWork;
    };
const tabs = new Map<number, Tab>();
const downloads = new Map<string, DownloadItem>();
const closedTabs: {
  url: string;
  entries: Electron.NavigationEntry[];
  index: number;
  position: number;
}[] = [];
const bookmarkSchema = z.object({
  id: z.string().uuid(),
  url: z.string().max(8192).refine(isWebURL),
  title: z.string().trim().min(1).max(500),
});
function bookmarks(): import("./shared/model").BrowserBookmark[] {
  try {
    return z
      .array(bookmarkSchema)
      .max(1000)
      .parse(JSON.parse(library.store.config("browserBookmarks") || "[]"));
  } catch {
    return [];
  }
}
function saveBookmarks(items: import("./shared/model").BrowserBookmark[]) {
  library.store.setConfig("browserBookmarks", JSON.stringify(items));
  emit();
}
function toggleBookmark() {
  const wc = currentWeb()?.view.webContents;
  if (!wc || !isWebURL(wc.getURL())) return;
  const items = bookmarks(),
    url = wc.getURL(),
    existing = items.find((b) => b.url === url);
  if (existing) saveBookmarks(items.filter((b) => b.id !== existing.id));
  else if (items.length < 1000)
    saveBookmarks([
      ...items,
      {
        id: randomUUID(),
        url,
        title: (wc.getTitle().trim() || url).slice(0, 500),
      },
    ]);
  else
    void dialog.showMessageBox(window, {
      type: "info",
      message: labels().bookmarkLimit,
      buttons: [labels().browserOK],
    });
}
function engine(): SearchEngine {
  const value = library.store.config("browserSearchEngine");
  return Object.hasOwn(searchEngines, value || "")
    ? (value as SearchEngine)
    : "google";
}
function suggestions() {
  const q = addressQuery.trim().toLocaleLowerCase();
  const seen = new Set<string>();
  return [...bookmarks().map((b) => ({ ...b, time: 0 })), ...browserHistory()]
    .filter((b) => {
      if (
        !isWebURL(b.url) ||
        seen.has(b.url) ||
        (q && !`${b.title} ${b.url}`.toLocaleLowerCase().includes(q))
      )
        return false;
      seen.add(b.url);
      return true;
    })
    .slice(0, 8);
}
function navigateAddress(value: string) {
  const url = resolveAddress(value, engine()),
    tab = currentWeb();
  dismissPicker();
  if (tab) {
    tab.error = "";
    void tab.view.webContents.loadURL(url).catch(() => {});
    tab.view.webContents.focus();
  } else createTab(url);
}
function labels() {
  return browserMessages[library.store.preferences().language];
}
function zoomTab(id: number, direction: number) {
  const tab = tabs.get(id);
  if (tab?.kind !== "web") return;
  const wc = tab.view.webContents;
  const steps = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
    4, 5,
  ];
  const current = wc.getZoomFactor();
  wc.setZoomFactor(
    direction === 0
      ? 1
      : direction > 0
        ? steps.find((v) => v > current + 0.01) || 5
        : [...steps].reverse().find((v) => v < current - 0.01) || 0.25,
  );
  emit();
}
function openFind(id: number) {
  const tab = tabs.get(id);
  if (tab?.kind !== "web") return;
  tab.find = {
    ...(tab.find || { text: "", active: 0, matches: 0 }),
    open: true,
  };
  layout();
  emit();
  shell.webContents.focus();
  shell.webContents.send("browser:focus-find");
}
function closeFind(id: number) {
  const tab = tabs.get(id);
  if (tab?.kind !== "web") return;
  tab.view.webContents.stopFindInPage("clearSelection");
  tab.find = undefined;
  layout();
  emit();
  tab.view.webContents.focus();
}
function menuFor(id: number) {
  const tab = tabs.get(id);
  if (tab?.kind !== "web") return [];
  const t = labels();
  return [
    ...pageMenu(tab.view.webContents, t, {
      find: () => openFind(id),
      zoom: (d) => zoomTab(id, d),
      back: t.browserBack,
      forward: t.browserForward,
      reload: t.browserReload,
    }),
    { type: "separator" as const },
    {
      label: bookmarks().some((b) => b.url === tab.view.webContents.getURL())
        ? t.removeBookmark
        : t.bookmarkPage,
      click: toggleBookmark,
    },
    {
      label: t.bookmarks,
      click: () => {
        void openPicker("bookmarks");
      },
    },
    {
      label: t.sitePermissions,
      enabled: isWebURL(tab.view.webContents.getURL()),
      click: () => browserSites.show(tab.view.webContents),
    },
    {
      label: t.searchEngine,
      submenu: Object.keys(searchEngines).map((key) => ({
        label: (
          {
            google: "Google",
            bing: "Bing",
            baidu: "百度",
            duckduckgo: "DuckDuckGo",
          } as Record<string, string>
        )[key],
        type: "radio" as const,
        checked: engine() === key,
        click: () => {
          library.store.setConfig("browserSearchEngine", key);
          emit();
        },
      })),
    },
  ];
}
function reorderTab(id: number, before: number, after = false) {
  if (id === before || !tabs.has(id) || !tabs.has(before)) return;
  const entries = [...tabs];
  const moving = entries.find(([key]) => key === id)!;
  const filtered = entries.filter(([key]) => key !== id);
  filtered.splice(
    filtered.findIndex(([key]) => key === before) + (after ? 1 : 0),
    0,
    moving,
  );
  tabs.clear();
  for (const [key, value] of filtered) tabs.set(key, value);
  layout();
  emit();
}
function reopenTab() {
  const saved = closedTabs.pop();
  if (!saved) return;
  const id = createTab(saved.url, false, saved);
  const tab = id === undefined ? undefined : tabs.get(id);
  if (tab?.kind !== "web") return;
  const before = [...tabs.keys()].filter((key) => key !== id)[saved.position];
  if (before !== undefined) reorderTab(id!, before);
}
function tabMenu(id: number) {
  if (!tabs.has(id)) return;
  const t = labels(),
    keys = [...tabs.keys()],
    tab = tabs.get(id)!;
  Menu.buildFromTemplate([
    {
      label:
        tab.kind === "web" && tab.view.webContents.isAudioMuted()
          ? t.unmuteTab
          : t.muteTab,
      enabled: tab.kind === "web",
      click: () => {
        if (tab.kind === "web") {
          const wc = tab.view.webContents;
          wc.setAudioMuted(!wc.isAudioMuted());
          emit();
        }
      },
    },
    {
      label: t.duplicateTab,
      enabled: tab.kind === "web",
      click: () => {
        if (tab.kind === "web") createTab(tab.view.webContents.getURL());
      },
    },
    { label: t.browserCloseTab, click: () => closeTab(id) },
    {
      label: t.closeOtherTabs,
      enabled: keys.length > 1,
      click: () => {
        for (const key of keys) if (key !== id) closeTab(key);
      },
    },
    {
      label: t.closeRightTabs,
      enabled: keys.indexOf(id) < keys.length - 1,
      click: () => {
        for (const key of keys.slice(keys.indexOf(id) + 1)) closeTab(key);
      },
    },
    { type: "separator" },
    { label: t.reopenTab, enabled: closedTabs.length > 0, click: reopenTab },
  ]).popup({ window });
}
function snapshot(): BrowserState {
  return {
    active,
    bookmarks: bookmarks(),
    searchEngine: engine(),
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
        favicon: tab.favicon,
        audible: wc.isCurrentlyAudible(),
        muted: wc.isAudioMuted(),
        zoom: Math.round(wc.getZoomFactor() * 100),
        find: tab.find,
      };
    }),
  };
}
function persistSession() {
  if (!restoredSession || closing || !library) return;
  const entries = [...tabs.entries()].filter(([, tab]) => tab.kind === "web");
  const serialized = JSON.stringify({
    urls: entries.map(([, tab]) =>
      tab.kind === "web"
        ? tab.view.webContents.getURL() || "about:blank"
        : "about:blank",
    ),
    histories: entries.map(([, tab]) => {
      if (tab.kind !== "web") return null;
      const wc = tab.view.webContents;
      const all = wc.navigationHistory.getAllEntries();
      const index = wc.navigationHistory.getActiveIndex();
      if (
        index < 0 ||
        !all.length ||
        all.some((e) => e.url !== "about:blank" && !isWebURL(e.url))
      )
        return null;
      const start = Math.max(0, index - 50),
        end = Math.min(all.length, start + 100);
      return {
        entries: all
          .slice(start, end)
          .map((e) => ({ url: e.url, title: e.title.slice(0, 5000) })),
        index: index - start,
        muted: wc.isAudioMuted(),
        zoom: wc.getZoomFactor(),
      };
    }),
    active: entries.findIndex(([id]) => id === active),
  });
  if (serialized !== lastSavedSession) {
    library.store.setConfig("browserSession", serialized);
    lastSavedSession = serialized;
  }
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
    suggestions: pickerMode === "address" ? suggestions() : [],
    suggestionIndex,
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
async function openPicker(mode: PickerMode = "tabs") {
  capture?.dismiss();
  if (pickerOpen && pickerMode === mode) {
    if (mode === "address") {
      emitPicker();
      layout();
      return;
    }
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
  if (mode !== "address") tabPicker.webContents.focus();
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
      y: 82 + (tab.find?.open ? 42 : 0),
      width: Math.max(1, width - 16),
      height: Math.max(1, height - 90 - (tab.find?.open ? 42 : 0)),
    });
  }
  tabPicker?.setBounds({
    x:
      pickerMode === "address"
        ? Math.min(Math.max(8, addressBounds.x), width - 24)
        : Math.max(8, width - (pickerMode === "tasks" ? 448 : 368)),
    y:
      pickerMode === "address"
        ? Math.max(40, Math.min(addressBounds.y, height - 56))
        : 40,
    width:
      pickerMode === "address"
        ? Math.max(
            1,
            Math.min(
              addressBounds.width,
              width - Math.min(Math.max(8, addressBounds.x), width - 24) - 8,
            ),
          )
        : Math.min(pickerMode === "tasks" ? 440 : 360, width - 16),
    height: Math.min(
      height -
        (pickerMode === "address"
          ? Math.max(40, Math.min(addressBounds.y, height - 56)) + 8
          : 56),
      pickerMode === "address"
        ? Math.max(60, suggestions().length * 56 + 24)
        : pickerMode === "tabs"
          ? Math.min(390, 104 + tabs.size * 56)
          : 520,
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
function createTab(
  url = "about:blank",
  background = false,
  history?: { entries: Electron.NavigationEntry[]; index: number },
) {
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
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (isWebURL(target)) createTab(target, disposition === "background-tab");
    return { action: "deny" };
  });
  wc.on("context-menu", (_event, params) =>
    showWebMenu(
      wc,
      params,
      labels(),
      (target, background) => createTab(target, background),
      menuFor(id),
      (text) => searchURL(text, engine()),
    ),
  );
  wc.on("found-in-page", (_event, result) => {
    if (!tab.find?.open || result.requestId !== tab.find.requestId) return;
    tab.find.active = result.activeMatchOrdinal;
    tab.find.matches = result.matches;
    emit();
  });
  wc.on("zoom-changed", (_event, direction) =>
    zoomTab(id, direction === "in" ? 1 : -1),
  );
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
  wc.on("media-started-playing", updated);
  wc.on("media-paused", updated);
  wc.on("audio-state-changed", updated);
  let iconRequest: AbortController | undefined;
  wc.on("page-favicon-updated", (_event, urls) => {
    iconRequest?.abort();
    const controller = new AbortController();
    iconRequest = controller;
    void loadFavicon(wc, urls, controller.signal).then((icon) => {
      if (!controller.signal.aborted && !wc.isDestroyed() && tabs.has(id)) {
        tab.favicon = icon;
        updated();
      }
    });
  });
  wc.once("destroyed", () => iconRequest?.abort());
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
    iconRequest?.abort();
    tab.favicon = undefined;
    recordVisit();
    updated();
  });
  wc.on("did-stop-loading", recordVisit);
  wc.on("did-navigate-in-page", updated);
  wc.on("did-start-loading", () => {
    tab.error = "";
    if (tab.find) {
      tab.find.active = 0;
      tab.find.matches = 0;
      delete tab.find.requestId;
    }
    updated();
  });
  wc.on("did-stop-loading", () => {
    if (tab.find?.open && tab.find.text)
      tab.find.requestId = wc.findInPage(tab.find.text, { findNext: true });
  });
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
    if (input.key === "Escape" && tab.find?.open) {
      closeFind(id);
      event.preventDefault();
    } else if (shortcut(input.key, input.meta || input.control, input.shift))
      event.preventDefault();
  });
  if (history?.entries.length)
    void wc.navigationHistory.restore(history).catch(() => {
      if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => {});
    });
  else void wc.loadURL(url).catch(() => {});
  if (background) {
    layout();
    emit();
  } else select(id);
  return id;
}
function closeTab(id: number) {
  const tab = tabs.get(id);
  if (!tab) return;
  const ids = [...tabs.keys()],
    index = ids.indexOf(id);
  if (tab?.kind === "player" && tab.onlineWork)
    onlinePlayback.close(tab.workId);
  if (tab.kind === "web") {
    const wc = tab.view.webContents;
    closedTabs.push({
      url: wc.getURL() || "about:blank",
      entries: wc.navigationHistory.getAllEntries(),
      index: wc.navigationHistory.getActiveIndex(),
      position: index,
    });
    if (closedTabs.length > 20) closedTabs.shift();
  }
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
  if (lower === "d" && !shift && currentWeb()) {
    toggleBookmark();
  } else if (lower === "d" && shift && currentWeb()) {
    capture?.open(true);
  } else if (lower === "h") {
    void openPicker("history");
  } else if (lower === "l") {
    if (!currentWeb()) createTab();
    shell.webContents.focus();
    shell.webContents.send("browser:focus-address");
  } else if (lower === "f" && currentWeb()) openFind(active);
  else if (["+", "=", "-", "0"].includes(lower) && currentWeb())
    zoomTab(active, lower === "0" ? 0 : lower === "-" ? -1 : 1);
  else if (lower === "t" && shift) reopenTab();
  else if (lower === "t") createTab();
  else if (lower === "w") closeTab(active);
  else if (lower === "r") {
    const tab = currentWeb();
    if (tab) {
      tab.error = "";
      if (shift) tab.view.webContents.reloadIgnoringCache();
      else tab.view.webContents.reload();
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
    browserSites = new BrowserSites(
      library.store,
      labels,
      () => window,
      (wc) => currentWeb()?.view.webContents === wc,
    );
    browserSites.install(profile, (wc) =>
      [...tabs.values()].some(
        (tab) => tab.kind === "web" && tab.view.webContents === wc,
      ),
    );
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
      onLayout: () => {if(pickerOpen && tabPicker)window.contentView.addChildView(tabPicker);},
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
              type: z.literal("open-suggestion"),
              value: z.string().max(8192).refine(isWebURL),
            })
            .strict(),
          z
            .object({
              type: z.literal("bookmark-open"),
              value: z.string().uuid(),
            })
            .strict(),
          z
            .object({
              type: z.literal("bookmark-remove"),
              value: z.string().uuid(),
            })
            .strict(),
          z
            .object({ type: z.literal("bookmark-edit"), value: bookmarkSchema })
            .strict(),
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
      if (action.type === "open-suggestion") {
        const item =
          pickerMode === "address"
            ? suggestions().find((item) => item.url === action.value)
            : undefined;
        if (item) navigateAddress(item.url);
      }
      if (action.type === "bookmark-open") {
        const item = bookmarks().find((b) => b.id === action.value);
        if (item) createTab(item.url);
      }
      if (action.type === "bookmark-remove")
        saveBookmarks(bookmarks().filter((b) => b.id !== action.value));
      if (action.type === "bookmark-edit") {
        if (!bookmarks().some((b) => b.id === action.value.id))
          throw new Error("invalidInput");
        saveBookmarks(
          bookmarks().map((b) => (b.id === action.value.id ? action.value : b)),
        );
      }
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
        case "bookmark-toggle":
          toggleBookmark();
          break;
        case "bookmarks-open":
          await openPicker("bookmarks");
          break;
        case "site-menu":
          dismissPicker();
          if (wc) browserSites.show(wc);
          break;
        case "tab-mute": {
          const target = tabs.get(
            z.number().int().positive().parse(action.value),
          );
          if (target?.kind === "web") {
            const web = target.view.webContents;
            web.setAudioMuted(!web.isAudioMuted());
          }
          break;
        }
        case "address-suggest": {
          const input = z
            .object({
              query: z.string().max(8192),
              x: z.number().finite().min(0).max(20000),
              y: z.number().finite().min(0).max(20000),
              width: z.number().finite().positive().max(20000),
            })
            .strict()
            .parse(action.value);
          addressQuery = input.query;
          addressBounds = {
            x: Math.round(input.x),
            y: Math.round(input.y),
            width: Math.round(input.width),
          };
          suggestionIndex = -1;
          await openPicker("address");
          break;
        }
        case "address-step": {
          const step = z
            .union([z.literal(-1), z.literal(1)])
            .parse(action.value);
          if (pickerMode === "address" && pickerOpen) {
            const n = suggestions().length;
            suggestionIndex = n
              ? suggestionIndex < 0
                ? step > 0
                  ? 0
                  : n - 1
                : (suggestionIndex + step + n) % n
              : -1;
            emitPicker();
          }
          break;
        }
        case "address-accept": {
          const item =
            pickerOpen && pickerMode === "address"
              ? suggestions()[suggestionIndex]
              : undefined;
          navigateAddress(
            item?.url || z.string().max(8192).parse(action.value),
          );
          break;
        }
        case "tab-menu":
          tabMenu(z.number().int().positive().parse(action.value));
          break;
        case "tab-reorder": {
          const value = z
            .object({
              id: z.number().int().positive(),
              before: z.number().int().positive(),
              after: z.boolean().optional(),
            })
            .strict()
            .parse(action.value);
          reorderTab(value.id, value.before, value.after);
          break;
        }
        case "page-menu":
          dismissPicker();
          if (wc) Menu.buildFromTemplate(menuFor(active)).popup({ window });
          break;
        case "zoom":
          zoomTab(
            active,
            z
              .union([z.literal(-1), z.literal(0), z.literal(1)])
              .parse(action.value),
          );
          break;
        case "find-open":
          openFind(active);
          break;
        case "find-close":
          closeFind(active);
          break;
        case "find": {
          const value = z
            .object({
              text: z.string().max(1000),
              next: z.boolean().optional(),
              forward: z.boolean().optional(),
            })
            .strict()
            .parse(action.value);
          if (tab && wc && tab.find?.open) {
            if (tab.find.text !== value.text) {
              tab.find.active = 0;
              tab.find.matches = 0;
            }
            tab.find.text = value.text;
            if (!value.text) {
              wc.stopFindInPage("clearSelection");
              tab.find.active = 0;
              tab.find.matches = 0;
              delete tab.find.requestId;
            } else
              tab.find.requestId = wc.findInPage(value.text, {
                findNext: !value.next,
                forward: value.forward ?? true,
              });
          }
          break;
        }
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
          const url = resolveAddress(
            z.string().max(8192).parse(action.value),
            engine(),
          );
          dismissPicker();
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
          histories: z
            .array(
              z
                .object({
                  entries: z
                    .array(
                      z.object({
                        url: z
                          .string()
                          .max(8192)
                          .refine((v) => v === "about:blank" || isWebURL(v)),
                        title: z.string().max(5000),
                      }),
                    )
                    .max(100),
                  index: z.number().int().min(0),
                  muted: z.boolean().optional(),
                  zoom: z.number().min(0.25).max(5).optional(),
                })
                .nullable()
                .catch(null),
            )
            .max(200)
            .optional(),
        })
        .parse(JSON.parse(library.store.config("browserSession") || "{}"));
      const ids: number[] = [];
      for (const [index, url] of previous.urls.entries())
        if (url === "about:blank" || isWebURL(url)) {
          const saved = previous.histories?.[index];
          const id = createTab(
            url,
            true,
            saved && saved.entries.length && saved.index < saved.entries.length
              ? saved
              : undefined,
          );
          if (id === undefined) continue;
          ids.push(id);
          const restored = tabs.get(id);
          if (restored?.kind === "web" && saved) {
            restored.view.webContents.setAudioMuted(saved.muted || false);
            if (saved.zoom) restored.view.webContents.setZoomFactor(saved.zoom);
          }
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
