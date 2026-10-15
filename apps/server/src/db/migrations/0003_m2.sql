-- M2 (docs/contract-m2.md): household key, rooms and groups, one session per group, tombstones.

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
