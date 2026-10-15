import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// Sandboxed preload: only `electron` may be required here; everything else goes over IPC.
// The main process checks the sender of every call (hub origin; adminToken: settings window only).

interface Toast {
  level: 'info' | 'warn' | 'error';
  message: string;
  ttlMs: number;
}

interface HubEntry {
  hubId: string;
  roomName: string;
  address: string;
  port: number;
  hubEpoch: number;
  keyEpoch: number;
  protocolVersion: number;
  version: string;
  lastSeen: number;
  verified: boolean;
}

interface ReplicaInfo {
  snapshotAt: number;
  hubEpoch: number;
  bytes: number;
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
  /** This build's `ReleaseNotes` (version, date, changes, checklist) or null. */
  releaseNotes: (): Promise<unknown> => ipcRenderer.invoke('jukebox:releaseNotes'),
  /** Quits the app after the owner password. */
  quit: (): Promise<boolean> => ipcRenderer.invoke('jukebox:quit'),
  /** The setup page calls this after `POST /api/setup` succeeded; the TV window moves to /tv. */
  setupComplete: (reply?: {
    token?: string;
    playerToken?: string;
    playerId?: string;
  }): Promise<boolean> => ipcRenderer.invoke('jukebox:setupComplete', reply),

  // ---- M2 (docs/contract-m2.md). All origin-checked in main; player-only calls resolve to
  // null/false in hub mode and vice versa.

  /** `'hub' | 'player'`: the role of this run. */
  mode: (): Promise<'hub' | 'player'> => ipcRenderer.invoke('jukebox:mode'),
  /** Player first run / re-pair: POST <hub>/api/pair, verify the proof, store, switch to player
   * mode and reload the TV window. `{ ok: false, code, message }` on failure. */
  pair: (input: {
    hubAddress?: string;
    password: string;
    deviceName?: string;
  }): Promise<
    | { ok: true; roomName: string; hubAddress: string; protocolMismatch: boolean }
    | { ok: false; code?: string; message: string }
  > => ipcRenderer.invoke('jukebox:pair', input),
  /** Hubs heard via beacons (verified with our key; unverified while unpaired), newest first. */
  hubs: (): Promise<HubEntry[]> => ipcRenderer.invoke('jukebox:hubs'),
  /** Pushed on every accepted beacon and when a hub expires (30 s). Returns an unsubscribe. */
  onHubs: (cb: (hubs: HubEntry[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, hubs: HubEntry[]): void => cb(hubs);
    ipcRenderer.on('jukebox:hubs', listener);
    return () => ipcRenderer.removeListener('jukebox:hubs', listener);
  },
  /** Player: the `auth` message's `{ deviceId, proof }` for the saved hub address, or null. */
  playerAuth: (nonceP: string): Promise<{ deviceId: string; proof: string } | null> =>
    ipcRenderer.invoke('jukebox:playerAuth', nonceP),
  /** Player: checks `authOk.proof`; true also lets this laptop's `/hub.json` answer. */
  verifyAuthOk: (nonceP: string, nonceH: string, proof: string): Promise<boolean> =>
    ipcRenderer.invoke('jukebox:verifyAuthOk', nonceP, nonceH, proof),
  /** Remembered join-popup state (default `linked`). */
  linkState: (): Promise<'linked' | 'independent'> => ipcRenderer.invoke('jukebox:linkState'),
  setLinkState: (s: 'linked' | 'independent'): Promise<boolean> =>
    ipcRenderer.invoke('jukebox:setLinkState', s),
  /** Manual hub address (`192.168.1.5:8080` or a URL); persisted. */
  setHubAddress: (
    url: string,
  ): Promise<{ ok: true; hubAddress: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('jukebox:setHubAddress', url),
  /** Player: store the key from a `rekey` message. */
  storeKey: (k: { householdKey: string; keyEpoch: number }): Promise<boolean> =>
    ipcRenderer.invoke('jukebox:storeKey', k),
  /** Player: persist a `replica` snapshot (sealed). Resolves to `replicaInfo()` or null. */
  storeReplica: (snapshot: unknown): Promise<ReplicaInfo | null> =>
    ipcRenderer.invoke('jukebox:storeReplica', snapshot),
  replicaInfo: (): Promise<ReplicaInfo | null> => ipcRenderer.invoke('jukebox:replicaInfo'),
  /** Hub: the hub's own TV window's `auth` proof (device id/token issued at setup), or null. */
  localPlayerAuth: (nonceP: string): Promise<{ deviceId: string; proof: string } | null> =>
    ipcRenderer.invoke('jukebox:localPlayerAuth', nonceP),
  /** The hub speaks a newer protocol: install the update now (the page shows "Update required"). */
  updateRequired: (): Promise<boolean> => ipcRenderer.invoke('jukebox:updateRequired'),

  /** Subscribes to `jukebox:toast`; returns an unsubscribe function. */
  onToast: (cb: (toast: Toast) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, toast: Toast): void => cb(toast);
    ipcRenderer.on('jukebox:toast', listener);
    return () => ipcRenderer.removeListener('jukebox:toast', listener);
  },
});
