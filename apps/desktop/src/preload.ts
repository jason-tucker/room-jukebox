import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// Sandboxed preload: only `electron` may be required here; everything else goes over IPC.
// The main process checks the sender of every call (hub origin; adminToken: settings window only).

interface Toast {
  level: 'info' | 'warn' | 'error';
  message: string;
  ttlMs: number;
}

// Renderer -> main heartbeat; the TV window is reloaded after 30 s of silence (hung page).
setInterval(() => ipcRenderer.send('jukebox:heartbeat'), 5000);

contextBridge.exposeInMainWorld('jukebox', {
  selfcheck: (): Promise<unknown> => ipcRenderer.invoke('jukebox:selfcheck'),
  lastBeacon: (): Promise<unknown> => ipcRenderer.invoke('jukebox:lastBeacon'),
  version: (): Promise<string> => ipcRenderer.invoke('jukebox:version'),
  /** Owner bearer token; resolves to undefined outside the settings window. */
  adminToken: (): Promise<string | undefined> => ipcRenderer.invoke('jukebox:adminToken'),
  /** Opens the settings window (asks for the owner password unless it is cached). */
  openSettings: (): Promise<boolean> => ipcRenderer.invoke('jukebox:openSettings'),
  /** "Update now": checks, downloads and installs (password-gated). */
  installUpdate: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('jukebox:installUpdate'),
  checkForUpdates: (): Promise<{ ok: boolean; message: string; version?: string }> =>
    ipcRenderer.invoke('jukebox:checkForUpdates'),
  /** Quits the app after the owner password. */
  quit: (): Promise<boolean> => ipcRenderer.invoke('jukebox:quit'),
  /** The setup page calls this after `POST /api/setup` succeeded; the TV window moves to /tv. */
  setupComplete: (reply?: {
    token?: string;
    playerToken?: string;
    playerId?: string;
  }): Promise<boolean> => ipcRenderer.invoke('jukebox:setupComplete', reply),
  /** Subscribes to `jukebox:toast`; returns an unsubscribe function. */
  onToast: (cb: (toast: Toast) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, toast: Toast): void => cb(toast);
    ipcRenderer.on('jukebox:toast', listener);
    return () => ipcRenderer.removeListener('jukebox:toast', listener);
  },
});
