import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Same bridge name as the desktop app so shared UI conventions carry over.
contextBridge.exposeInMainWorld("falconInstaller", {
  minimize: () => ipcRenderer.invoke("window-minimize"),
  close: () => ipcRenderer.invoke("window-close"),
  platform: process.platform,
  startInstall: () => ipcRenderer.invoke("install:start") as Promise<{ ok: true }>,
  getInstallProgress: () =>
    ipcRenderer.invoke("install:get-progress") as Promise<
      import("../shared/install-types").InstallProgress
    >,
  onInstallProgress: (
    listener: (progress: import("../shared/install-types").InstallProgress) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      progress: import("../shared/install-types").InstallProgress,
    ) => listener(progress);
    ipcRenderer.on("install:progress", handler);
    return () => ipcRenderer.removeListener("install:progress", handler);
  },
  launchFalcon: () =>
    ipcRenderer.invoke("install:launch") as Promise<{ ok: boolean; path: string | null }>,
});
