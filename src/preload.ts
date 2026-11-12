import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("tamki", {
  action: (type: string, value?: string | number | boolean) =>
    ipcRenderer.invoke("browser:action", { type, value }),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  onFocusAddress: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("browser:focus-address", listener);
    return () => ipcRenderer.removeListener("browser:focus-address", listener);
  },
});
