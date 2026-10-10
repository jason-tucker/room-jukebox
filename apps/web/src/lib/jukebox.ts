import type { SetupReply } from '@room-jukebox/shared';

/** A toast from the desktop shell: a plain string or the WS toast shape. */
export type DesktopToast =
  string | { message: string; level?: 'info' | 'warn' | 'error'; ttlMs?: number };

/**
 * The desktop preload bridge (`window.jukebox`, contract-m1 "Desktop ↔ server and IPC"). Every
 * member is optional: the same pages run in a phone browser where the bridge does not exist.
 */
export interface JukeboxBridge {
  selfcheck?: () => unknown;
  lastBeacon?: () => unknown;
  /** App version for the owner page footer (may be async over IPC). */
  version?: () => string | null | undefined | Promise<string | null | undefined>;
  openSettings?: () => unknown;
  /**
   * Settings window only: the desktop admin bearer token (undefined elsewhere; may be async over
   * IPC). When it returns a token, /admin skips its login form and sends the bearer everywhere.
   */
  adminToken?: () => string | null | undefined | Promise<string | null | undefined>;
  quit?: () => unknown;
  installUpdate?: () => unknown;
  /** Called by /setup with the SetupReply after a successful POST /api/setup. */
  setupComplete?: (reply: SetupReply) => unknown;
  /** Desktop-originated toasts; returns an unsubscribe function. */
  onToast?: (cb: (toast: DesktopToast) => void) => (() => void) | undefined;
}

declare global {
  interface Window {
    jukebox?: JukeboxBridge;
  }
}

export function bridge(): JukeboxBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.jukebox;
}

export async function desktopAdminToken(): Promise<string | null> {
  const fn = bridge()?.adminToken;
  if (typeof fn !== 'function') return null;
  try {
    const token = await fn();
    return token || null;
  } catch {
    return null;
  }
}

export async function desktopVersion(): Promise<string | null> {
  const fn = bridge()?.version;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

/** Subscribes to desktop toasts when the bridge offers them; returns an unsubscribe function. */
export function onDesktopToast(
  cb: (message: string, level: 'info' | 'warn' | 'error', ttlMs?: number) => void,
): () => void {
  const fn = bridge()?.onToast;
  if (typeof fn !== 'function') return () => undefined;
  try {
    const off = fn((t) => {
      if (typeof t === 'string') cb(t, 'info');
      else if (t && typeof t.message === 'string') cb(t.message, t.level ?? 'info', t.ttlMs);
    });
    return typeof off === 'function' ? off : () => undefined;
  } catch {
    return () => undefined;
  }
}
