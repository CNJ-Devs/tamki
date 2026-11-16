import { contextBridge, ipcRenderer } from "electron";
// Only the application's isolated capture surfaces receive this bridge.
contextBridge.exposeInMainWorld("tamkiCapture", {
  action: async (type: string, value?: unknown) => {
    const result = await ipcRenderer.invoke("capture:action", { type, value });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("capture:state", listener);
    return () => ipcRenderer.removeListener("capture:state", listener);
  },
});
