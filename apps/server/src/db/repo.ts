/**
 * Thin typed repositories over the M1 schema. Every method is synchronous (node:sqlite).
 */
import type {
  Entry,
  FallbackVideo,
  HistoryEntry,
  Limits,
  SearchUsage,
  SkipReason,
} from '@room-jukebox/core';
import { emptySearchUsage } from '@room-jukebox/core';
import type { SearchProvider, SearchSource, VideoCard } from '@room-jukebox/shared';
import type { SQLOutputValue } from 'node:sqlite';
import type { Db } from './index.ts';
import { transaction } from './index.ts';

type Row = Record<string, SQLOutputValue>;

const str = (v: SQLOutputValue | undefined): string => (v == null ? '' : String(v));
const optStr = (v: SQLOutputValue | undefined): string | undefined =>
  v == null ? undefined : String(v);
const nullStr = (v: SQLOutputValue | undefined): string | null => (v == null ? null : String(v));
const num = (v: SQLOutputValue | undefined): number => Number(v ?? 0);
const optNum = (v: SQLOutputValue | undefined): number | undefined =>
  v == null ? undefined : Number(v);
const nullNum = (v: SQLOutputValue | undefined): number | null => (v == null ? null : Number(v));
const optBool = (v: SQLOutputValue | undefined): boolean | undefined =>
  v == null ? undefined : Number(v) !== 0;
const bit = (b: boolean | undefined): number | null => (b === undefined ? null : b ? 1 : 0);
const und = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

// ---------------------------------------------------------------------------------------------
// Settings

export type WifiSecurity = 'WPA' | 'WEP' | 'nopass';

/** Non-secret settings, stored as JSON in `settings.data`. */
export interface SettingsData {
  roomName: string;
  lanPort: number;
  country: string;
  limits: Limits;
  wifi: { ssid: string; security: WifiSecurity; hidden: boolean } | null;
  tvDisplayId: number | null;
  autoStart: boolean;
  autoFullscreen: boolean;
  kiosk: boolean;
  publicMode: boolean;
  hubId: string;
  hubEpoch: number;
  /** Owner's QR address override (`PATCH /api/admin/lan`). */
  lanChosen: string | null;
  /**
   * Absent in rows written before 0.0.5; `unofficialFallback` only in 0.0.5 rows (migrated to
   * `source` when the settings service starts).
   */
  search?: { source?: SearchSource; unofficialFallback?: boolean };
}

export interface SettingsRow {
  data: SettingsData;
  passwordVerifier: string | null;
  apiKeyEnc: string | null;
  apiKeyLast4: string | null;
  wifiPasswordEnc: string | null;
  guestSecret: string;
  noticeAcceptedAt: number | null;
}

export class SettingsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(): SettingsRow | null {
    const r = this.#db.prepare('SELECT * FROM settings WHERE id = 1').get();
    if (r === undefined) return null;
    return {
      data: JSON.parse(str(r.data)) as SettingsData,
      passwordVerifier: nullStr(r.password_verifier),
      apiKeyEnc: nullStr(r.youtube_api_key_enc),
      apiKeyLast4: nullStr(r.youtube_api_key_last4),
      wifiPasswordEnc: nullStr(r.wifi_password_enc),
      guestSecret: str(r.guest_secret),
      noticeAcceptedAt: nullNum(r.notice_accepted_at),
    };
  }

  create(data: SettingsData, guestSecret: string, now: number): void {
    this.#db
      .prepare(
        'INSERT INTO settings (id, data, guest_secret, created_at, updated_at) VALUES (1, ?, ?, ?, ?)',
      )
      .run(JSON.stringify(data), guestSecret, now, now);
  }

  setData(data: SettingsData, now: number): void {
    this.#db
      .prepare('UPDATE settings SET data = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(data), now);
  }

  setPasswordVerifier(verifier: string, now: number): void {
    this.#db
      .prepare('UPDATE settings SET password_verifier = ?, updated_at = ? WHERE id = 1')
      .run(verifier, now);
  }

  setApiKey(enc: string | null, last4: string | null, now: number): void {
    this.#db
      .prepare(
        'UPDATE settings SET youtube_api_key_enc = ?, youtube_api_key_last4 = ?, updated_at = ? WHERE id = 1',
      )
      .run(enc, last4, now);
  }

  setWifiPassword(enc: string | null, now: number): void {
    this.#db
      .prepare('UPDATE settings SET wifi_password_enc = ?, updated_at = ? WHERE id = 1')
      .run(enc, now);
  }

  setNoticeAccepted(at: number): void {
    this.#db
      .prepare('UPDATE settings SET notice_accepted_at = ?, updated_at = ? WHERE id = 1')
      .run(at, at);
  }
}

// ---------------------------------------------------------------------------------------------
// Session metadata

export interface SessionMeta {
  revision: number;
  changeSeq: number;
  data: SessionData;
}

export interface LastError {
  at: number;
  videoId: string;
  code?: string;
  message: string;
}

/** JSON in `session.data`. */
export interface SessionData {
  /** Pause clock of the current revision. */
  pausedAt: number | null;
  accumulatedPauseMs: number;
  /** The revision `pausedAt`/`accumulatedPauseMs` belong to. */
  clockRevision: number;
  /** Last position (s) a player reported for `positionRevision`. */
  lastPositionSec: number;
  positionRevision: number;
  consecutiveFailures: number;
  /** True after too many consecutive failures: idle until Start Music / the owner presses play. */
  stopped: boolean;
  lastErrors: LastError[];
}

export const emptySessionData = (): SessionData => ({
  pausedAt: null,
  accumulatedPauseMs: 0,
  clockRevision: 0,
  lastPositionSec: 0,
  positionRevision: 0,
  consecutiveFailures: 0,
  stopped: false,
  lastErrors: [],
});

export class SessionRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  load(): SessionMeta | null {
    const r = this.#db.prepare('SELECT * FROM session WHERE id = 1').get();
    if (r === undefined) return null;
    return {
      revision: num(r.revision),
      changeSeq: num(r.change_seq),
      data: { ...emptySessionData(), ...(JSON.parse(str(r.data)) as Partial<SessionData>) },
    };
  }

  save(meta: SessionMeta, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO session (id, revision, change_seq, data, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, change_seq = excluded.change_seq,
           data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(meta.revision, meta.changeSeq, JSON.stringify(meta.data), now);
  }
}

// ---------------------------------------------------------------------------------------------
// Queue and history

function entryFromRow(r: Row): Entry {
  const e: Entry = {
    id: str(r.id),
    videoId: str(r.video_id),
    title: str(r.title),
    requester:
      r.requester_guest_id == null
        ? null
        : {
            guestId: str(r.requester_guest_id),
            ...(r.requester_name != null ? { name: str(r.requester_name) } : {}),
          },
    source: str(r.source) === 'auto' ? 'auto' : 'request',
    status: str(r.status) as Entry['status'],
    enqueuedAt: num(r.enqueued_at),
  };
  const channelTitle = optStr(r.channel_title);
  if (channelTitle !== undefined) e.channelTitle = channelTitle;
  const thumbnail = optStr(r.thumbnail);
  if (thumbnail !== undefined) e.thumbnail = thumbnail;
  const durationSec = optNum(r.duration_sec);
  if (durationSec !== undefined) e.durationSec = durationSec;
  const key = optStr(r.idempotency_key);
  if (key !== undefined) e.idempotencyKey = key;
  const startedAt = optNum(r.started_at);
  if (startedAt !== undefined) e.startedAt = startedAt;
  if (num(r.restarted) === 1) e.restarted = true;
  return e;
}

function entryParams(e: Entry | HistoryEntry) {
  return [
    e.id,
    e.status,
    e.videoId,
    e.title,
    und(e.channelTitle),
    und(e.thumbnail),
    und(e.durationSec),
    e.source,
    e.requester?.guestId ?? null,
    e.requester?.name ?? null,
    und(e.idempotencyKey),
    e.enqueuedAt,
    und(e.startedAt),
    e.restarted === true ? 1 : 0,
  ] as const;
}

export interface StoredQueue {
  nowPlaying: Entry | null;
  queue: Entry[];
  /** Source IP per entry id (per-IP limits; survives Forget me). */
  ips: Map<string, string>;
}

export class QueueRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  load(): StoredQueue {
    const rows = this.#db.prepare('SELECT * FROM queue_entries ORDER BY position').all();
    const ips = new Map<string, string>();
    let nowPlaying: Entry | null = null;
    const queue: Entry[] = [];
    for (const r of rows) {
      const e = entryFromRow(r);
      if (r.requester_ip != null) ips.set(e.id, str(r.requester_ip));
      if (num(r.position) < 0) nowPlaying = e;
      else queue.push(e);
    }
    return { nowPlaying, queue, ips };
  }

  replace(nowPlaying: Entry | null, queue: readonly Entry[], ips: ReadonlyMap<string, string>) {
    transaction(this.#db, () => {
      this.#db.exec('DELETE FROM queue_entries');
      const insert = this.#db.prepare(
        `INSERT INTO queue_entries (id, status, video_id, title, channel_title, thumbnail, duration_sec,
           source, requester_guest_id, requester_name, idempotency_key, enqueued_at, started_at, restarted,
           position, requester_ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const all: [Entry, number][] = [
        ...(nowPlaying ? [[nowPlaying, -1] as [Entry, number]] : []),
        ...queue.map((e, i) => [e, i] as [Entry, number]),
      ];
      for (const [e, position] of all) {
        insert.run(...entryParams(e), position, ips.get(e.id) ?? null);
      }
    });
  }
}

export class HistoryRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  loadAll(): HistoryEntry[] {
    return this.#db
      .prepare('SELECT * FROM history ORDER BY seq')
      .all()
      .map((r) => {
        const base = entryFromRow({ ...r, status: 'queued' });
        const h: HistoryEntry = {
          ...base,
          status: str(r.status) as HistoryEntry['status'],
          endedAt: num(r.ended_at),
        };
        const failReason = optStr(r.fail_reason);
        if (failReason !== undefined) h.failReason = failReason;
        const skipReason = optStr(r.skip_reason);
        if (skipReason !== undefined) h.skipReason = skipReason as SkipReason;
        return h;
      });
  }

  append(entries: readonly HistoryEntry[]): void {
    const insert = this.#db.prepare(
      `INSERT OR REPLACE INTO history (id, status, video_id, title, channel_title, thumbnail, duration_sec,
         source, requester_guest_id, requester_name, idempotency_key, enqueued_at, started_at, restarted,
         fail_reason, skip_reason, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const h of entries) {
      insert.run(...entryParams(h), und(h.failReason), und(h.skipReason), h.endedAt);
    }
  }

  /** Forget me: drops the guest's attribution, keeps the anonymised rows. */
  anonymise(guestId: string): void {
    this.#db
      .prepare(
        'UPDATE history SET requester_guest_id = NULL, requester_name = NULL WHERE requester_guest_id = ?',
      )
      .run(guestId);
  }
}

// ---------------------------------------------------------------------------------------------
// Guests

export interface GuestRow {
  guestId: string;
  name: string | null;
  ip: string | null;
  createdAt: number;
  noticeAcceptedAt: number | null;
  forgottenAt: number | null;
}

export class GuestsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(guestId: string): GuestRow | null {
    const r = this.#db.prepare('SELECT * FROM guests WHERE guest_id = ?').get(guestId);
    if (r === undefined) return null;
    return {
      guestId: str(r.guest_id),
      name: nullStr(r.name),
      ip: nullStr(r.ip),
      createdAt: num(r.created_at),
      noticeAcceptedAt: nullNum(r.notice_accepted_at),
      forgottenAt: nullNum(r.forgotten_at),
    };
  }

  create(guestId: string, ip: string, now: number): void {
    this.#db
      .prepare('INSERT INTO guests (guest_id, ip, created_at) VALUES (?, ?, ?)')
      .run(guestId, ip, now);
  }

  setName(guestId: string, name: string | null): void {
    this.#db.prepare('UPDATE guests SET name = ? WHERE guest_id = ?').run(name, guestId);
  }

  setIp(guestId: string, ip: string): void {
    this.#db.prepare('UPDATE guests SET ip = ? WHERE guest_id = ?').run(ip, guestId);
  }

  acceptNotice(guestId: string, now: number): void {
    this.#db
      .prepare('UPDATE guests SET notice_accepted_at = ? WHERE guest_id = ?')
      .run(now, guestId);
  }

  /** Keeps a tombstone (ID + time) so the old cookie is never revived; drops every personal field. */
  forget(guestId: string, now: number): void {
    this.#db
      .prepare(
        'UPDATE guests SET name = NULL, ip = NULL, notice_accepted_at = NULL, forgotten_at = ? WHERE guest_id = ?',
      )
      .run(now, guestId);
  }
}

// ---------------------------------------------------------------------------------------------
// Videos

export interface VideoRow {
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnail?: string;
  durationSec?: number | null;
  embeddable?: boolean;
  ytRating?: string;
  madeForKids?: boolean;
  liveBroadcastContent?: string;
  regionRestriction?: { allowed?: string[]; blocked?: string[] };
  privacyStatus?: string;
  missing: boolean;
  refreshedAt: number;
}

function videoFromRow(r: Row): VideoRow {
  const v: VideoRow = {
    videoId: str(r.video_id),
    title: str(r.title),
    missing: num(r.missing) === 1,
    refreshedAt: num(r.refreshed_at),
  };
  const channelTitle = optStr(r.channel_title);
  if (channelTitle !== undefined) v.channelTitle = channelTitle;
  const thumbnail = optStr(r.thumbnail);
  if (thumbnail !== undefined) v.thumbnail = thumbnail;
  if (r.duration_sec !== undefined) v.durationSec = nullNum(r.duration_sec);
  const embeddable = optBool(r.embeddable);
  if (embeddable !== undefined) v.embeddable = embeddable;
  const ytRating = optStr(r.yt_rating);
  if (ytRating !== undefined) v.ytRating = ytRating;
  const mfk = optBool(r.made_for_kids);
  if (mfk !== undefined) v.madeForKids = mfk;
  const live = optStr(r.live_broadcast_content);
  if (live !== undefined) v.liveBroadcastContent = live;
  const region = optStr(r.region_restriction);
  if (region !== undefined)
    v.regionRestriction = JSON.parse(region) as VideoRow['regionRestriction'];
  const privacy = optStr(r.privacy_status);
  if (privacy !== undefined) v.privacyStatus = privacy;
  return v;
}

export class VideosRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(videoId: string): VideoRow | null {
    const r = this.#db.prepare('SELECT * FROM videos WHERE video_id = ?').get(videoId);
    return r === undefined ? null : videoFromRow(r);
  }

  getMany(ids: readonly string[]): Map<string, VideoRow> {
    const out = new Map<string, VideoRow>();
    const stmt = this.#db.prepare('SELECT * FROM videos WHERE video_id = ?');
    for (const id of ids) {
      const r = stmt.get(id);
      if (r !== undefined) out.set(id, videoFromRow(r));
    }
    return out;
  }

  upsert(v: VideoRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO videos (video_id, title, channel_title, thumbnail, duration_sec, embeddable,
           yt_rating, made_for_kids, live_broadcast_content, region_restriction, privacy_status, missing,
           refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.videoId,
        v.title,
        und(v.channelTitle),
        und(v.thumbnail),
        v.durationSec ?? null,
        bit(v.embeddable),
        und(v.ytRating),
        bit(v.madeForKids),
        und(v.liveBroadcastContent),
        v.regionRestriction === undefined ? null : JSON.stringify(v.regionRestriction),
        und(v.privacyStatus),
        v.missing ? 1 : 0,
        v.refreshedAt,
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Fallback playlists

export interface PlaylistRow {
  id: string;
  playlistId: string;
  title: string;
  url: string;
  videoCount: number;
  importedAt: number;
  lastError: string | null;
}

export class PlaylistsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  #fromRow(r: Row): PlaylistRow {
    return {
      id: str(r.id),
      playlistId: str(r.playlist_id),
      title: str(r.title),
      url: str(r.url),
      videoCount: num(r.video_count),
      importedAt: num(r.imported_at),
      lastError: nullStr(r.last_error),
    };
  }

  list(): PlaylistRow[] {
    return this.#db
      .prepare('SELECT * FROM fallback_playlists ORDER BY imported_at, id')
      .all()
      .map((r) => this.#fromRow(r));
  }

  get(id: string): PlaylistRow | null {
    const r = this.#db.prepare('SELECT * FROM fallback_playlists WHERE id = ?').get(id);
    return r === undefined ? null : this.#fromRow(r);
  }

  upsert(p: PlaylistRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO fallback_playlists (id, playlist_id, title, url, video_count, imported_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.playlistId, p.title, p.url, p.videoCount, p.importedAt, p.lastError);
  }

  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM fallback_playlists WHERE id = ?').run(id).changes > 0;
  }

  setVideos(id: string, videoIds: readonly string[]): void {
    transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM fallback_videos WHERE playlist_row_id = ?').run(id);
      const insert = this.#db.prepare(
        'INSERT INTO fallback_videos (playlist_row_id, position, video_id) VALUES (?, ?, ?)',
      );
      videoIds.forEach((v, i) => insert.run(id, i, v));
    });
  }

  /** Every playlist video joined with its metadata, in playlist order, with its `videos` row. */
  allVideos(): { video: FallbackVideo; row: VideoRow | null }[] {
    return this.#db
      .prepare(
        `SELECT fv.video_id AS fv_video_id, v.* FROM fallback_videos fv
         JOIN fallback_playlists p ON p.id = fv.playlist_row_id
         LEFT JOIN videos v ON v.video_id = fv.video_id
         ORDER BY p.imported_at, p.id, fv.position`,
      )
      .all()
      .map((r) => {
        const row = r.video_id == null ? null : videoFromRow(r);
        const video: FallbackVideo = { videoId: str(r.fv_video_id), title: row?.title ?? '' };
        if (row?.channelTitle !== undefined) video.channelTitle = row.channelTitle;
        if (row?.thumbnail !== undefined) video.thumbnail = row.thumbnail;
        if (row?.durationSec != null) video.durationSec = row.durationSec;
        return { video, row };
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Search cache and usage

export interface SearchCacheRow {
  videoIds: string[];
  fetchedAt: number;
  provider: SearchProvider;
  /** Results-page snapshot (unofficial rows only). */
  cards?: VideoCard[];
}

export class SearchCacheRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(query: string): SearchCacheRow | null {
    const r = this.#db.prepare('SELECT * FROM search_cache WHERE query = ?').get(query);
    if (r === undefined) return null;
    const row: SearchCacheRow = {
      videoIds: JSON.parse(str(r.video_ids)) as string[],
      fetchedAt: num(r.fetched_at),
      provider: r.provider === 'unofficial' ? 'unofficial' : 'youtube-api',
    };
    if (typeof r.cards === 'string') row.cards = JSON.parse(r.cards) as VideoCard[];
    return row;
  }

  put(
    query: string,
    videoIds: readonly string[],
    at: number,
    provider: SearchProvider = 'youtube-api',
    cards?: readonly VideoCard[],
  ): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO search_cache (query, video_ids, fetched_at, provider, cards) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        query,
        JSON.stringify(videoIds),
        at,
        provider,
        cards === undefined ? null : JSON.stringify(cards),
      );
  }
}

export class SearchUsageRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(day: string): SearchUsage {
    const r = this.#db.prepare('SELECT data FROM search_usage WHERE day = ?').get(day);
    return r === undefined ? emptySearchUsage() : (JSON.parse(str(r.data)) as SearchUsage);
  }

  put(day: string, usage: SearchUsage, now: number): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO search_usage (day, data, updated_at) VALUES (?, ?, ?)')
      .run(day, JSON.stringify(usage), now);
  }
}

// ---------------------------------------------------------------------------------------------
// Players, admin sessions, login attempts

export interface PlayerRow {
  deviceId: string;
  name: string;
  createdAt: number;
  revokedAt: number | null;
}

export class PlayersRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  #fromRow(r: Row): PlayerRow {
    return {
      deviceId: str(r.device_id),
      name: str(r.name),
      createdAt: num(r.created_at),
      revokedAt: nullNum(r.revoked_at),
    };
  }

  list(): PlayerRow[] {
    return this.#db
      .prepare('SELECT * FROM players WHERE revoked_at IS NULL ORDER BY created_at')
      .all()
      .map((r) => this.#fromRow(r));
  }

  findByTokenHash(tokenHash: string): PlayerRow | null {
    const r = this.#db
      .prepare('SELECT * FROM players WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash);
    return r === undefined ? null : this.#fromRow(r);
  }

  upsert(deviceId: string, name: string, tokenHash: string, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO players (device_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = NULL`,
      )
      .run(deviceId, name, tokenHash, now);
  }
}

export class AdminSessionsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  create(tokenHash: string, client: string, now: number, expiresAt: number | null): void {
    this.#db
      .prepare(
        'INSERT INTO admin_sessions (token_hash, created_at, expires_at, client) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, now, expiresAt, client);
  }

  isValid(tokenHash: string, now: number): boolean {
    const r = this.#db
      .prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(tokenHash);
    return r !== undefined && (r.expires_at == null || num(r.expires_at) > now);
  }

  delete(tokenHash: string): void {
    this.#db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteAll(): void {
    this.#db.exec('DELETE FROM admin_sessions');
  }

  purgeExpired(now: number): void {
    this.#db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now);
  }
}

export class LoginAttemptsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(key: string): { failures: number; lastAt: number } {
    const r = this.#db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key);
    return r === undefined
      ? { failures: 0, lastAt: 0 }
      : { failures: num(r.failures), lastAt: num(r.last_at) };
  }

  fail(key: string, now: number): number {
    const failures = this.get(key).failures + 1;
    this.#db
      .prepare('INSERT OR REPLACE INTO login_attempts (key, failures, last_at) VALUES (?, ?, ?)')
      .run(key, failures, now);
    return failures;
  }

  reset(key: string): void {
    this.#db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
  }
}

// ---------------------------------------------------------------------------------------------
// Audit and quota logs

export class EventsRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  append(kind: string, data: Record<string, unknown>, at: number): void {
    this.#db
      .prepare('INSERT INTO events (at, kind, data) VALUES (?, ?, ?)')
      .run(at, kind, JSON.stringify(data));
  }

  recent(limit: number): { at: number; kind: string; data: Record<string, unknown> }[] {
    return this.#db
      .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
      .all(limit)
      .map((r) => ({
        at: num(r.at),
        kind: str(r.kind),
        data: JSON.parse(str(r.data)) as Record<string, unknown>,
      }));
  }
}

export class QuotaLogRepo {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  append(at: number, day: string, endpoint: string, units: number, status: number): void {
    this.#db
      .prepare('INSERT INTO quota_log (at, day, endpoint, units, status) VALUES (?, ?, ?, ?, ?)')
      .run(at, day, endpoint, units, status);
  }

  unitsForDay(day: string): number {
    const r = this.#db.prepare('SELECT SUM(units) AS u FROM quota_log WHERE day = ?').get(day);
    return num(r?.u);
  }
}

/** Every repository over one database. */
export class Repos {
  readonly db: Db;
  readonly settings: SettingsRepo;
  readonly session: SessionRepo;
  readonly queue: QueueRepo;
  readonly history: HistoryRepo;
  readonly guests: GuestsRepo;
  readonly videos: VideosRepo;
  readonly playlists: PlaylistsRepo;
  readonly searchCache: SearchCacheRepo;
  readonly searchUsage: SearchUsageRepo;
  readonly players: PlayersRepo;
  readonly adminSessions: AdminSessionsRepo;
  readonly loginAttempts: LoginAttemptsRepo;
  readonly events: EventsRepo;
  readonly quotaLog: QuotaLogRepo;

  constructor(db: Db) {
    this.db = db;
    this.settings = new SettingsRepo(db);
    this.session = new SessionRepo(db);
    this.queue = new QueueRepo(db);
    this.history = new HistoryRepo(db);
    this.guests = new GuestsRepo(db);
    this.videos = new VideosRepo(db);
    this.playlists = new PlaylistsRepo(db);
    this.searchCache = new SearchCacheRepo(db);
    this.searchUsage = new SearchUsageRepo(db);
    this.players = new PlayersRepo(db);
    this.adminSessions = new AdminSessionsRepo(db);
    this.loginAttempts = new LoginAttemptsRepo(db);
    this.events = new EventsRepo(db);
    this.quotaLog = new QuotaLogRepo(db);
  }
}
