import { app, BaseWindow, WebContentsView, ipcMain, session } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isWebURL, resolveAddress } from "./navigation";
if (process.env.TAMKI_TEST_PROFILE)
  app.setPath("userData", process.env.TAMKI_TEST_PROFILE);
app.setName("Tamki");
let window: BaseWindow;
let shell: WebContentsView;
let active = 0,
  nextId = 1,
  page = "browser",
  collapsed = false;
const tabs = new Map<number, { view: WebContentsView; error: string }>();
function snapshot() {
  return {
    active,
    page,
    tabs: [...tabs].map(([id, { view, error }]) => ({
      id,
      title: view.webContents.getTitle() || "New tab",
      url: view.webContents.getURL(),
      loading: view.webContents.isLoading(),
      back: view.webContents.navigationHistory.canGoBack(),
      forward: view.webContents.navigationHistory.canGoForward(),
      error,
    })),
  };
}
function emit() {
  if (shell && !shell.webContents.isDestroyed())
    shell.webContents.send("browser:state", snapshot());
}
function layout() {
  if (!window) return;
  const { width, height } = window.getContentBounds();
  shell.setBounds({ x: 0, y: 0, width, height });
  const left = collapsed ? 64 : 184;
  for (const [id, { view }] of tabs) {
    view.setVisible(
      page === "browser" &&
        id === active &&
        !tabs.get(id)?.error &&
        view.webContents.getURL() !== "about:blank",
    );
    view.setBounds({
      x: left,
      y: 120,
      width: Math.max(1, width - left - 8),
      height: Math.max(1, height - 128),
    });
  }
}
function select(id: number) {
  if (!tabs.has(id)) return;
  active = id;
  page = "browser";
  layout();
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
  tabs.set(id, { view, error: "" });
  window.contentView.addChildView(view);
  const wc = view.webContents;
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
  wc.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && tabs.has(id)) {
      tabs.get(id)!.error = description;
      layout();
      emit();
    }
  });
  wc.on("render-process-gone", () => {
    if (tabs.has(id)) {
      tabs.get(id)!.error = "Page stopped. Reload to try again.";
      layout();
      emit();
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
  window.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  tabs.delete(id);
  if (!tabs.size) createTab();
  else if (active === id) select([...tabs.keys()].at(-1)!);
  layout();
  emit();
}
function shortcut(key: string, modifier: boolean, shift: boolean) {
  if (!modifier) return false;
  const lower = key.toLowerCase();
  if (lower === "l") {
    shell.webContents.focus();
    shell.webContents.send("browser:focus-address");
  } else if (lower === "t") createTab();
  else if (lower === "w") closeTab(active);
  else if (lower === "r") tabs.get(active)?.view.webContents.reload();
  else if (lower === "tab") {
    const ids = [...tabs.keys()];
    select(
      ids[(ids.indexOf(active) + (shift ? ids.length - 1 : 1)) % ids.length],
    );
  } else return false;
  return true;
}
app.whenReady().then(async () => {
  const profile = session.fromPartition("persist:tamki-browser");
  profile.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  profile.setPermissionCheckHandler(() => false);
  profile.on("will-download", (_event, item) =>
    item.setSaveDialogOptions({
      title: "Save download",
      defaultPath: path.join(
        app.getPath("downloads"),
        path.basename(item.getFilename()),
      ),
    }),
  );
  window = new BaseWindow({
    title: "Tamki",
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 540,
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
  shell.webContents.on("before-input-event", (event, input) => {
    if (shortcut(input.key, input.meta || input.control, input.shift))
      event.preventDefault();
  });
  ipcMain.handle("browser:action", (event, action: unknown) => {
    if (
      event.sender !== shell.webContents ||
      event.senderFrame !== shell.webContents.mainFrame
    )
      throw new Error("Untrusted IPC sender");
    if (!action || typeof action !== "object")
      throw new Error("Invalid action");
    const value = action as { type?: string; value?: unknown };
    const wc = tabs.get(active)?.view.webContents;
    switch (value.type) {
      case "state":
        return snapshot();
      case "new":
        createTab();
        break;
      case "select":
        if (typeof value.value === "number") select(value.value);
        break;
      case "close":
        if (typeof value.value === "number") closeTab(value.value);
        break;
      case "navigate": {
        if (typeof value.value !== "string" || value.value.length > 8192)
          throw new Error("Invalid address");
        const url = resolveAddress(value.value);
        if (wc) {
          tabs.get(active)!.error = "";
          void wc.loadURL(url).catch(() => {});
        }
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
        if (wc) {
          tabs.get(active)!.error = "";
          wc.reload();
        }
        break;
      case "stop":
        wc?.stop();
        break;
      case "collapse":
        collapsed = value.value === true;
        layout();
        break;
      case "page":
        if (
          ["browser", "library", "tasks", "settings"].includes(
            String(value.value),
          )
        ) {
          page = String(value.value);
          layout();
          emit();
        }
        break;
      default:
        throw new Error("Unknown action");
    }
    return snapshot();
  });
  window.on("resize", layout);
  window.on("closed", () => {
    for (const { view } of tabs.values()) view.webContents.close();
    shell.webContents.close();
    app.quit();
  });
  await shell.webContents.loadURL(
    pathToFileURL(path.join(__dirname, "ui/index.html")).href,
  );
  createTab();
  layout();
  emit();
});
app.on("window-all-closed", () => app.quit());
