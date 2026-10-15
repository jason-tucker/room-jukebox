/**
 * Replication to authenticated players (contract-m2 §4): a full **ReplicaSnapshot** every 10 s
 * and shortly after each change. Secrets travel wrapped with AES-256-GCM under the `rj/wrap`
 * subkey; the household key itself never does. Tombstones are per receiver: those written since
 * the snapshot it last acknowledged (`replicaAck`), within the 30-day retention.
 */
import type { ReplicaSnapshot, Tombstone } from '@room-jukebox/shared';
import type { Repos } from './db/repo.ts';
import type { Household } from './household.ts';
import { wrapSecret } from './household.ts';
import type { Groups } from './session/groups.ts';
import { isLocalPlayer } from './session/groups.ts';
import type { SettingsService } from './settings.ts';

export const REPLICA_INTERVAL_MS = 10_000;
/** Changes are batched this long before an extra snapshot goes out. */
export const REPLICA_DEBOUNCE_MS = 1_000;
export const REPLICA_HISTORY_ROWS = 500;
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const QUOTA_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReplicaDeps {
  repos: Repos;
  settings: SettingsService;
  household: Household;
  groups: Groups;
  now: () => number;
}

export interface ReplicaStatus {
  lastSentAt: number | null;
  bytes: number;
  players: { deviceId: string; lastAckAt: number | null }[];
}

type Rows = Record<string, unknown>[];

/** The snapshot's `settings`: the settings JSON plus wrapped secrets (never plaintext). */
export interface ReplicaSettings {
  data: Record<string, unknown>;
  apiKeyWrapped: string | null;
  apiKeyLast4: string | null;
  wifiPasswordWrapped: string | null;
  guestSecretWrapped: string;
  noticeAcceptedAt: number | null;
}

export class ReplicaService {
  #d: ReplicaDeps;
  #acks = new Map<string, { snapshotAt: number; at: number }>();
  #lastSentAt: number | null = null;
  #bytes = 0;

  constructor(deps: ReplicaDeps) {
    this.#d = deps;
  }

  #rows(sql: string, ...params: (string | number)[]): Rows {
    return this.#d.repos.db.prepare(sql).all(...params) as Rows;
  }

  /** The snapshot without tombstones (`forPlayer` adds the receiver's). */
  build(): Omit<ReplicaSnapshot, 'tombstones'> {
    const { settings, household, groups, now } = this.#d;
    const at = now();
    const row = settings.row();
    const wrap = household.keys().wrap;
    const apiKey = settings.apiKey();
    const wifi = settings.wifiPassword();
    const replicaSettings: ReplicaSettings = {
      data: { ...row.data },
      apiKeyWrapped: apiKey ? wrapSecret(wrap, apiKey) : null,
      apiKeyLast4: row.apiKeyLast4,
      wifiPasswordWrapped: wifi ? wrapSecret(wrap, wifi) : null,
      guestSecretWrapped: wrapSecret(wrap, row.guestSecret),
      noticeAcceptedAt: row.noticeAcceptedAt,
    };
    groups.saveLeaders();
    return {
      settings: replicaSettings as unknown as Record<string, unknown>,
      passwordVerifier: row.passwordVerifier ?? '',
      householdKeyEpoch: household.keyEpoch(),
      fallbackPlaylists: this.#rows('SELECT * FROM fallback_playlists ORDER BY imported_at'),
      fallbackVideos: this.#rows(
        'SELECT * FROM fallback_videos ORDER BY playlist_row_id, position',
      ),
      videos: this.#rows('SELECT * FROM videos ORDER BY video_id'),
      history: this.#rows(
        'SELECT * FROM history ORDER BY seq DESC LIMIT ?',
        REPLICA_HISTORY_ROWS,
      ).reverse(),
      rooms: this.#rows('SELECT * FROM rooms ORDER BY created_at, device_id'),
      groups: this.#rows(
        "SELECT * FROM groups ORDER BY group_id = 'main' DESC, created_at, group_id",
      ),
      players: this.#rows(
        'SELECT device_id, name, token_hash, created_at, paired_at, revoked_at FROM players ORDER BY created_at',
      ),
      quotaLog: this.#rows(
        'SELECT * FROM quota_log WHERE at >= ? ORDER BY seq',
        at - QUOTA_DAYS_MS,
      ),
      searchUsage: this.#rows('SELECT * FROM search_usage ORDER BY day'),
      queueEntries: this.#rows('SELECT * FROM queue_entries ORDER BY group_id, position'),
      snapshotAt: at,
      hubEpoch: row.data.hubEpoch,
    };
  }

  /** Tombstones the player has not acknowledged yet. */
  tombstonesFor(deviceId: string): Tombstone[] {
    const { repos, now } = this.#d;
    repos.tombstones.purgeBefore(now() - TOMBSTONE_RETENTION_MS);
    const since = this.#acks.get(deviceId)?.snapshotAt ?? 0;
    return repos.tombstones.since(since);
  }

  /** The `replica` message text for one player. */
  messageFor(base: Omit<ReplicaSnapshot, 'tombstones'>, deviceId: string): string {
    const snapshot: ReplicaSnapshot = { ...base, tombstones: this.tombstonesFor(deviceId) };
    return JSON.stringify({ type: 'replica', snapshot });
  }

  sent(bytes: number): void {
    this.#lastSentAt = this.#d.now();
    this.#bytes = bytes;
  }

  ack(deviceId: string, snapshotAt: number): void {
    const prev = this.#acks.get(deviceId);
    if (prev && prev.snapshotAt > snapshotAt) return;
    this.#acks.set(deviceId, { snapshotAt, at: this.#d.now() });
  }

  forget(deviceId: string): void {
    this.#acks.delete(deviceId);
  }

  status(): ReplicaStatus {
    return {
      lastSentAt: this.#lastSentAt,
      bytes: this.#bytes,
      players: this.#d.repos.players
        .list()
        .filter((p) => !isLocalPlayer(p.deviceId))
        .map((p) => ({ deviceId: p.deviceId, lastAckAt: this.#acks.get(p.deviceId)?.at ?? null })),
    };
  }
}
