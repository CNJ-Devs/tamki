import { contextBridge, ipcRenderer } from "electron";

// This surface can only inspect tabs and activate one. Never expose library IPC.
contextBridge.exposeInMainWorld("tamkiTabs", {
  action: (type: string, value?: unknown) =>
    ipcRenderer.invoke("tabs:action", { type, value }),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("tabs:state", listener);
    return () => ipcRenderer.removeListener("tabs:state", listener);
  },
});
