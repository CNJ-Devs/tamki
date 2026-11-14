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
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isWebURL, resolveAddress } from "./navigation";
import { LibraryService } from "./library/service";
import type { BrowserState, Transfer } from "./shared/model";
import { id } from "./shared/validation";

if (process.env.TAMKI_TEST_PROFILE)
  app.setPath("userData", process.env.TAMKI_TEST_PROFILE);
app.setName("Tamki");
protocol.registerSchemesAsPrivileged([
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
let tabPicker: WebContentsView | undefined;
let pickerOpen = false;
let pickerReady: Promise<void> | undefined;
let active = 0,
  nextId = 1,
  closing = false;
type Tab =
  | { kind: "web"; view: WebContentsView; error: string }
  | { kind: "player"; workId: string };
const tabs = new Map<number, Tab>();
const downloads = new Map<string, DownloadItem>();
function snapshot(): BrowserState {
  return {
    active,
    pickerOpen,
    tabs: [...tabs].map(([id, tab]) => {
      if (tab.kind === "player")
        return {
          id,
          kind: "player",
          workId: tab.workId,
          title:
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
function emit() {
  if (!closing && shell && !shell.webContents.isDestroyed())
    shell.webContents.send("browser:state", snapshot());
  emitPicker();
}
function pickerState() {
  return { browser: snapshot(), preferences: library.store.preferences() };
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
async function openPicker() {
  if (pickerOpen) {
    dismissPicker(true);
    return;
  }
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
    x: Math.max(8, width - 368),
    y: 40,
    width: Math.min(360, width - 16),
    height: Math.min(390, height - 56, 104 + tabs.size * 56),
  });
}
function select(id: number) {
  if (id !== 0 && !tabs.has(id)) return;
  dismissPicker();
  active = id;
  layout();
  shell.webContents.focus();
  emit();
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
  const tab: Extract<Tab, { kind: "web" }> = { kind: "web", view, error: "" };
  tabs.set(id, tab);
  window.contentView.addChildView(view);
  if (tabPicker) window.contentView.addChildView(tabPicker);
  const wc = view.webContents;
  wc.on("focus", () => dismissPicker());
  wc.on("before-mouse-event", (_event, input) => {
    if (input.type === "mouseDown") dismissPicker();
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
  wc.on("did-navigate", updated);
  wc.on("did-navigate-in-page", updated);
  wc.on("did-start-loading", updated);
  wc.on("did-stop-loading", updated);
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
  if (lower === "l") {
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
      },
    });
    window.contentView.addChildView(shell);
    shell.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    shell.webContents.on("will-navigate", (event) => event.preventDefault());
    shell.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    shell.webContents.on("before-input-event", (event, input) => {
      if (shortcut(input.key, input.meta || input.control, input.shift))
        event.preventDefault();
    });
    ipcMain.handle("tabs:action", (event, payload: unknown) => {
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
        ])
        .parse(payload);
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
        return {
          ok: true,
          data: await library.request(action.type, action.value),
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
      closing = true;
      for (const tab of tabs.values())
        if (tab.kind === "web" && !tab.view.webContents.isDestroyed())
          tab.view.webContents.close();
      shell.webContents.close();
      tabPicker?.webContents.close();
      void library.close().finally(() => app.quit());
    });
    await shell.webContents.loadURL(
      pathToFileURL(path.join(__dirname, "ui/index.html")).href,
    );
    layout();
    emit();
    emitLibrary();
    library.automatic.start();
    if (library.store.preferences().refreshOnOpen) void library.refresh();
  })
  .catch(() => app.quit());
app.on("window-all-closed", () => {
  if (!closing) app.quit();
});
