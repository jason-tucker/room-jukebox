import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_COUNTRY, DEFAULT_LIMITS, INITIAL_HUB_EPOCH } from '@room-jukebox/core';
import type { PlaylistInfo, SettingsPatch, SettingsPublic } from '@room-jukebox/shared';
import type { PlaylistRow, Repos, SettingsData, SettingsRow } from './db/repo.ts';

/** At-rest encryption for secrets (the desktop passes Electron safeStorage; standalone = identity). */
export interface Secrets {
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

export const identitySecrets: Secrets = { encrypt: (s) => s, decrypt: (s) => s };

export function defaultSettingsData(): SettingsData {
  return {
    roomName: 'Room Jukebox',
    lanPort: 8080,
    country: DEFAULT_COUNTRY,
    limits: structuredClone({ ...DEFAULT_LIMITS, search: { ...DEFAULT_LIMITS.search } }),
    wifi: null,
    tvDisplayId: null,
    autoStart: true,
    autoFullscreen: true,
    kiosk: false,
    publicMode: false,
    hubId: randomUUID(),
    hubEpoch: INITIAL_HUB_EPOCH,
    lanChosen: null,
  };
}

export function toPlaylistInfo(p: PlaylistRow): PlaylistInfo {
  return {
    id: p.id,
    playlistId: p.playlistId,
    title: p.title,
    url: p.url,
    videoCount: p.videoCount,
    importedAt: p.importedAt,
    ...(p.lastError !== null ? { lastError: p.lastError } : {}),
  };
}

/** Settings row access, the public projection and PATCH handling. Secrets never leave here. */
export class SettingsService {
  #repos: Repos;
  #secrets: Secrets;
  #now: () => number;

  constructor(repos: Repos, secrets: Secrets, now: () => number) {
    this.#repos = repos;
    this.#secrets = secrets;
    this.#now = now;
    if (repos.settings.get() === null) {
      repos.settings.create(defaultSettingsData(), randomBytes(32).toString('base64url'), now());
    }
  }

  row(): SettingsRow {
    return this.#repos.settings.get() as SettingsRow;
  }

  data(): SettingsData {
    return this.row().data;
  }

  needsSetup(): boolean {
    return this.row().passwordVerifier === null;
  }

  apiKey(): string | null {
    const enc = this.row().apiKeyEnc;
    if (enc === null) return null;
    try {
      return this.#secrets.decrypt(enc) || null;
    } catch {
      return null;
    }
  }

  wifiPassword(): string | null {
    const enc = this.row().wifiPasswordEnc;
    if (enc === null) return null;
    try {
      return this.#secrets.decrypt(enc);
    } catch {
      return null;
    }
  }

  setData(data: SettingsData): void {
    this.#repos.settings.setData(data, this.#now());
  }

  setApiKey(key: string | null): void {
    const trimmed = key?.trim() ?? '';
    if (trimmed === '') this.#repos.settings.setApiKey(null, null, this.#now());
    else
      this.#repos.settings.setApiKey(
        this.#secrets.encrypt(trimmed),
        trimmed.slice(-4),
        this.#now(),
      );
  }

  setWifiPassword(password: string | null): void {
    this.#repos.settings.setWifiPassword(
      password === null || password === '' ? null : this.#secrets.encrypt(password),
      this.#now(),
    );
  }

  toPublic(): SettingsPublic {
    const row = this.row();
    const d = row.data;
    const usableKey = (this.apiKey() ?? '') !== '';
    return {
      roomName: d.roomName,
      lanPort: d.lanPort,
      country: d.country,
      limits: structuredClone(d.limits),
      fallbackPlaylists: this.#repos.playlists.list().map(toPlaylistInfo),
      wifi: d.wifi ? { ...d.wifi } : null,
      hasWifiPassword: row.wifiPasswordEnc !== null,
      hasApiKey: usableKey,
      apiKeyLast4: usableKey ? row.apiKeyLast4 : null,
      tvDisplayId: d.tvDisplayId,
      autoStart: d.autoStart,
      autoFullscreen: d.autoFullscreen,
      kiosk: d.kiosk,
      publicMode: d.publicMode,
      hubId: d.hubId,
      hubEpoch: d.hubEpoch,
    };
  }

  /**
   * Applies a PATCH. Read-only fields (`hubId`, `hubEpoch`, `fallbackPlaylists`, the `has*` flags
   * and `apiKeyLast4`) are ignored; secrets are encrypted and never echoed.
   */
  patch(p: SettingsPatch): SettingsPublic {
    const d = { ...this.data() };
    if (p.roomName !== undefined) d.roomName = p.roomName;
    if (p.lanPort !== undefined) d.lanPort = p.lanPort;
    if (p.country !== undefined) d.country = p.country.toUpperCase();
    if (p.limits !== undefined) d.limits = structuredClone(p.limits);
    if (p.wifi !== undefined) d.wifi = p.wifi === null ? null : { ...p.wifi };
    if (p.tvDisplayId !== undefined) d.tvDisplayId = p.tvDisplayId;
    if (p.autoStart !== undefined) d.autoStart = p.autoStart;
    if (p.autoFullscreen !== undefined) d.autoFullscreen = p.autoFullscreen;
    if (p.kiosk !== undefined) d.kiosk = p.kiosk;
    if (p.publicMode !== undefined) d.publicMode = p.publicMode;
    this.setData(d);
    if (p.youtubeApiKey !== undefined) this.setApiKey(p.youtubeApiKey);
    if (p.wifiPassword !== undefined) this.setWifiPassword(p.wifiPassword);
    if (p.wifi === null) this.setWifiPassword(null);
    return this.toPublic();
  }
}
