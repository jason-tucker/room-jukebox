import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preload: only `electron` may be required here; everything else goes over IPC.
contextBridge.exposeInMainWorld('jukebox', {
  selfcheck: (): Promise<unknown> => ipcRenderer.invoke('jukebox:selfcheck'),
  lastBeacon: (): Promise<unknown> => ipcRenderer.invoke('jukebox:lastBeacon'),
});
