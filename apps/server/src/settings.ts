import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_COUNTRY, DEFAULT_LIMITS, INITIAL_HUB_EPOCH } from '@room-jukebox/core';
import type {
  ChecklistPatch,
  ChecklistState,
  PlaylistInfo,
  SearchSource,
  SettingsPatch,
  SettingsPublic,
} from '@room-jukebox/shared';
import type { PlaylistRow, Repos, SettingsData, SettingsRow } from './db/repo.ts';

/** `SettingsPublic` as this server always sends it (`search` is optional in the contract). */
export type SettingsPublicExt = SettingsPublic & { search: { source: SearchSource } };

/** Search reads YouTube's results page unless the owner picks the Data API. */
export const DEFAULT_SEARCH_SOURCE: SearchSource = 'page';

/** The pre-0.0.6 PATCH boolean: on = API then page, off = API only. */
export const sourceFromLegacyFallback = (on: boolean): SearchSource =>
  on ? 'api-first' : 'api-only';

/**
 * The stored source. 0.0.5 rows carry only `unofficialFallback`: `false` was an explicit owner
 * choice (→ `api-only`); `true` was the default, so it takes the new default (`page`).
 */
export function storedSearchSource(data: SettingsData): SearchSource {
  const s = data.search;
  if (s?.source !== undefined) return s.source;
  if (s?.unofficialFallback === false) return 'api-only';
  return DEFAULT_SEARCH_SOURCE;
}

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
    search: { source: DEFAULT_SEARCH_SOURCE },
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
    const existing = repos.settings.get();
    if (existing === null) {
      repos.settings.create(defaultSettingsData(), randomBytes(32).toString('base64url'), now());
    } else if (existing.data.search?.source === undefined) {
      // Migrate pre-0.0.6 rows to `search.source`.
      repos.settings.setData(
        { ...existing.data, search: { source: storedSearchSource(existing.data) } },
        now(),
      );
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

  /** Where search goes (`page`, `api-first` or `api-only`). */
  searchSource(): SearchSource {
    return storedSearchSource(this.data());
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

  /** The stored checklist when it belongs to `version`, else an empty one for `version`. */
  checklist(version: string): ChecklistState {
    const c = this.data().checklist;
    if (c && c.version === version) return { version, done: { ...c.done }, updatedAt: c.updatedAt };
    return { version, done: {}, updatedAt: null };
  }

  /** Merges `patch.done` into `patch.version`'s checklist (a new version starts empty). */
  patchChecklist(patch: ChecklistPatch): ChecklistState {
    const prev = this.checklist(patch.version);
    const next: ChecklistState = {
      version: patch.version,
      done: { ...prev.done, ...patch.done },
      updatedAt: this.#now(),
    };
    this.setData({ ...this.data(), checklist: next });
    return structuredClone(next);
  }

  toPublic(): SettingsPublicExt {
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
      search: { source: this.searchSource() },
    };
  }

  /**
   * Applies a PATCH. Read-only fields (`hubId`, `hubEpoch`, `fallbackPlaylists`, the `has*` flags
   * and `apiKeyLast4`) are ignored; secrets are encrypted and never echoed. `search` takes
   * `{ source }` or the legacy `{ unofficialFallback }` boolean.
   */
  patch(p: SettingsPatch): SettingsPublicExt {
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
    if (p.search !== undefined) {
      d.search = {
        source:
          'source' in p.search
            ? p.search.source
            : sourceFromLegacyFallback(p.search.unofficialFallback),
      };
    }
    this.setData(d);
    if (p.youtubeApiKey !== undefined) this.setApiKey(p.youtubeApiKey);
    if (p.wifiPassword !== undefined) this.setWifiPassword(p.wifiPassword);
    if (p.wifi === null) this.setWifiPassword(null);
    return this.toPublic();
  }
}
