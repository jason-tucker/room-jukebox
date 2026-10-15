/**
 * Migrations embedded as strings so the desktop's esbuild bundle needs no `.sql` files on disk.
 * The `.sql` files in `./migrations/` are the source of truth; `test/db.test.ts` fails when an
 * embedded copy drifts from its file. Append new migrations; never edit an applied one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_init.sql',
    sql: `-- Room Jukebox M1 schema (docs/contract-m1.md, "Storage"). Times are epoch milliseconds.

-- Single row. 'data' holds the non-secret settings as JSON; secrets live in their own columns,
-- encrypted by the desktop (safeStorage) or stored as given when the server runs standalone.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  password_verifier TEXT,
  youtube_api_key_enc TEXT,
  youtube_api_key_last4 TEXT,
  wifi_password_enc TEXT,
  guest_secret TEXT NOT NULL,
  notice_accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Single row: live session metadata beside the queue (revision, changeSeq, pause clock, failures).
CREATE TABLE session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  change_seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE guests (
  guest_id TEXT PRIMARY KEY,
  name TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  notice_accepted_at INTEGER,
  forgotten_at INTEGER
);

-- Now playing (status 'playing', position -1) and the upcoming queue (status 'queued', 0..n).
CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_title TEXT,
  thumbnail TEXT,
  duration_sec REAL,
  source TEXT NOT NULL,
  requester_guest_id TEXT,
  requester_name TEXT,
  requester_ip TEXT,
  idempotency_key TEXT,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  restarted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_title TEXT,
  thumbnail TEXT,
  duration_sec REAL,
  source TEXT NOT NULL,
  requester_guest_id TEXT,
  requester_name TEXT,
  idempotency_key TEXT,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  restarted INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT,
  skip_reason TEXT,
  ended_at INTEGER NOT NULL
);
CREATE INDEX history_guest ON history (requester_guest_id);

CREATE TABLE videos (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel_title TEXT,
  thumbnail TEXT,
  duration_sec REAL,
  embeddable INTEGER,
  yt_rating TEXT,
  made_for_kids INTEGER,
  live_broadcast_content TEXT,
  region_restriction TEXT,
  privacy_status TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER NOT NULL
);

CREATE TABLE fallback_playlists (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  video_count INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL,
  last_error TEXT
);

CREATE TABLE fallback_videos (
  playlist_row_id TEXT NOT NULL REFERENCES fallback_playlists (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  PRIMARY KEY (playlist_row_id, position)
);

CREATE TABLE search_cache (
  query TEXT PRIMARY KEY,
  video_ids TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- One row per Pacific day (YouTube's quota day); 'data' is the core SearchUsage JSON.
CREATE TABLE search_usage (
  day TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE players (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- expires_at NULL = the desktop's long-lived token from setup (revoked by a password change).
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  client TEXT NOT NULL
);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);

-- Append-only audit of transitions and admin actions (no guest IDs or names).
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE quota_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  units INTEGER NOT NULL,
  status INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: '0002_search_provider.sql',
    sql: `-- Which source filled a search_cache row: the Data API ('youtube-api') or the results-page
-- fallback ('unofficial'). Rows written before this migration came from the API. 'cards' keeps
-- the results-page snapshot (title, channel, thumbnail, length, live) of unofficial rows, so a
-- cache hit can show them without a network call; it is NULL for API rows.
ALTER TABLE search_cache ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube-api';
ALTER TABLE search_cache ADD COLUMN cards TEXT;
`,
  },
  {
    version: 3,
    name: '0003_m2.sql',
    sql: `-- M2 (docs/contract-m2.md): household key, rooms and groups, one session per group, tombstones.

-- The household key (32 random bytes, base64), encrypted like the other secrets.
ALTER TABLE settings ADD COLUMN household_key_enc TEXT;

-- When the device last paired (created_at stays the first pairing; leader order uses it).
ALTER TABLE players ADD COLUMN paired_at INTEGER;

-- One session (queue machine + fallback) per group. 'main' is the hub's group.
CREATE TABLE groups (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  leader_device_id TEXT,
  created_at INTEGER NOT NULL
);

-- One room per player device (the hub's own TV included).
CREATE TABLE rooms (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL,
  link_state TEXT NOT NULL DEFAULT 'linked',
  lan_address TEXT,
  last_seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Session metadata of the non-main groups (the main group keeps the single-row 'session').
CREATE TABLE group_sessions (
  group_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  change_seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE queue_entries ADD COLUMN group_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE history ADD COLUMN group_id TEXT NOT NULL DEFAULT 'main';

-- Deletions the replicas must apply (forgotten guests, deleted history rows).
CREATE TABLE tombstones (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX tombstones_at ON tombstones (deleted_at);
`,
  },
];
