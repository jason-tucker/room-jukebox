import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LinkState } from '@room-jukebox/shared';
import type { Mode } from './args';
import { DEFAULT_FEED_URL, isUpdateFeed, isUpdateMode, normalizeFeedUrl } from './update-policy';
import type { UpdateFeed, UpdateMode } from './update-policy';

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
  /** M2: `hub` (full server; also every pre-M2 install) or `player` (joined a hub by pairing).
   * `--mode` on the command line overrides it for one run. */
  mode: Mode;
  /** M2: this laptop's id as a player, generated once (`PairBody.deviceId`). */
  deviceId?: string;
  /** M2 player: base URL of the hub, `http://<host>:<port>` (pairing, manual entry). */
  hubAddress?: string;
  /** M2 player: the paired hub's identity from `PairReply`. */
  hubId?: string;
  hubEpoch?: number;
  roomName?: string;
  /** M2 player: device token issued by `POST /api/pair`. */
  deviceToken?: StoredSecret;
  /** M2 player: household key (base64, 32 bytes) and its epoch (`rekey` raises it). */
  householdKey?: StoredSecret;
  keyEpoch?: number;
  /** M2 player: remembered join-popup state (default `linked`). */
  linkState?: LinkState;
  /** Desktop admin bearer issued by `POST /api/setup` (used for the updater's activity poll). */
  adminToken?: StoredSecret;
  /** Device token of the hub's own TV window. */
  playerToken?: StoredSecret;
  playerId?: string;
  /** `immediate` (test phase default): install each new build after a 15 s notice;
   * `quiet`: the quiet rule; `off`: only "Update now". Legacy `autoUpdate: false` reads as `off`. */
  updateMode: UpdateMode;
  /** `tango` (generic feed at `updateFeedUrl`) until a GitHub release exists, or `github`. */
  updateFeed: UpdateFeed;
  updateFeedUrl: string;
  /** Version of the previous run; differs on the first launch after an update. */
  lastRunVersion?: string;
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

export const DEFAULT_STATE: DesktopState = {
  mode: 'hub',
  updateMode: 'immediate',
  updateFeed: 'tango',
  updateFeedUrl: DEFAULT_FEED_URL,
};

function feedUrlOrDefault(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_FEED_URL;
  try {
    return normalizeFeedUrl(v);
  } catch {
    return DEFAULT_FEED_URL;
  }
}

export function loadState(file: string): DesktopState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as
      (Partial<DesktopState> & { autoUpdate?: unknown }) | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_STATE };
    const { autoUpdate, ...rest } = parsed;
    const legacyMode: UpdateMode = autoUpdate === false ? 'off' : DEFAULT_STATE.updateMode;
    if (rest.linkState !== 'linked' && rest.linkState !== 'independent') delete rest.linkState;
    return {
      ...DEFAULT_STATE,
      ...rest,
      mode: rest.mode === 'player' ? 'player' : 'hub',
      updateMode: isUpdateMode(rest.updateMode) ? rest.updateMode : legacyMode,
      updateFeed: isUpdateFeed(rest.updateFeed) ? rest.updateFeed : DEFAULT_STATE.updateFeed,
      updateFeedUrl: feedUrlOrDefault(rest.updateFeedUrl),
    };
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
