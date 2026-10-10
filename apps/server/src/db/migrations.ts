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
];
