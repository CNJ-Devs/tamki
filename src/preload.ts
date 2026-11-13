import { contextBridge, ipcRenderer } from "electron";
const subscribe = (channel: string, callback: (value: unknown) => void) => {
  const listener = (_event: unknown, value: unknown) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("tamki", {
  action: (type: string, value?: unknown) =>
    ipcRenderer.invoke("browser:action", { type, value }),
  library: async (type: string, value?: unknown) => {
    const result = await ipcRenderer.invoke("library:action", { type, value });
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
  onState: (callback: (state: unknown) => void) =>
    subscribe("browser:state", callback),
  onLibrary: (callback: (state: unknown) => void) =>
    subscribe("library:state", callback),
  onFocusAddress: (callback: () => void) =>
    subscribe("browser:focus-address", callback),
  onFocusTabs: (callback: () => void) =>
    subscribe("browser:focus-tabs", callback),
});
