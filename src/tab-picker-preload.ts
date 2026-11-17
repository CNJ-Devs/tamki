import { contextBridge, ipcRenderer } from "electron";

// This trusted surface can inspect tabs/history/tasks, manage bookmarks and select address suggestions.
// Its main-process handler validates each action; no generic library IPC is exposed.
contextBridge.exposeInMainWorld("tamkiTabs", {
  action: (type: string, value?: unknown) =>
    ipcRenderer.invoke("tabs:action", { type, value }),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("tabs:state", listener);
    return () => ipcRenderer.removeListener("tabs:state", listener);
  },
});
