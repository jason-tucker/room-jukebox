import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A secret at rest: `safeStorage` ciphertext (base64) or, when DPAPI is unavailable, plaintext. */
export interface StoredSecret {
  enc: 'safeStorage' | 'plain';
  value: string;
}

/**
 * `userData/desktop-state.json`: what the desktop shell keeps across restarts. The server owns
 * the real settings; the display/port fields are the last values it reported, so the TV window
 * can open correctly before the server is asked again.
 */
export interface DesktopState {
  /** Desktop admin bearer issued by `POST /api/setup` (used for the updater's activity poll). */
  adminToken?: StoredSecret;
  /** Device token of the hub's own TV window. */
  playerToken?: StoredSecret;
  playerId?: string;
  /** Auto-update toggle (default on). */
  autoUpdate: boolean;
  /** Hub port; takes effect at the next start. `LAN_PORT` in the environment overrides it. */
  lanPort?: number;
  autoStart?: boolean;
  autoFullscreen?: boolean;
  kiosk?: boolean;
  tvDisplayId?: number | null;
  /** Set when electron-updater finished a download; installed at the next launch. */
  pendingUpdate?: { version: string; downloadedAt: number };
  /** `app.relaunch()` timestamps for the crash-loop breaker. */
  relaunches?: number[];
}

export interface SecretCodec {
  available: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export const DEFAULT_STATE: DesktopState = { autoUpdate: true };

export function loadState(file: string): DesktopState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopState> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...parsed, autoUpdate: parsed.autoUpdate !== false };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Write-then-rename so a crash mid-write never leaves a truncated file. */
export function saveState(file: string, state: DesktopState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function sealSecret(codec: SecretCodec, plain: string): StoredSecret {
  return codec.available
    ? { enc: 'safeStorage', value: codec.encrypt(plain) }
    : { enc: 'plain', value: plain };
}

/** `undefined` when absent or when the ciphertext cannot be decrypted (another Windows user). */
export function openSecret(
  codec: SecretCodec,
  secret: StoredSecret | undefined,
): string | undefined {
  if (!secret) return undefined;
  if (secret.enc === 'plain') return secret.value;
  if (!codec.available) return undefined;
  try {
    return codec.decrypt(secret.value);
  } catch {
    return undefined;
  }
}
