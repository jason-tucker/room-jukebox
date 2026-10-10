import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backup } from './backup.ts';
import { MIGRATIONS } from './migrations.ts';

export type Db = DatabaseSync;

export interface OpenDbResult {
  db: Db;
  /** Versions applied by this open (empty when the schema was current). */
  applied: number[];
}

/**
 * Opens (creating when absent) the SQLite database at `path` in WAL mode and applies pending
 * migrations in order, each inside a transaction, recording them in `schema_migrations`. An
 * existing database with pending migrations is backed up to `backupDir` first.
 */
export async function openDb(path: string, backupDir?: string): Promise<OpenDbResult> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const existed = path !== ':memory:' && existsSync(path);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const done = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => Number(r.version)),
  );
  const pending = MIGRATIONS.filter((m) => !done.has(m.version));
  if (pending.length > 0 && existed && done.size > 0 && backupDir !== undefined) {
    await backup(db, backupDir, Date.now(), 'pre-migration');
  }
  const applied: number[] = [];
  for (const m of pending) {
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    applied.push(m.version);
  }
  return { db, applied };
}

/** Runs `fn` inside BEGIN IMMEDIATE / COMMIT (nested calls join the outer transaction). */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Checkpoints the WAL into the main file and closes the database (graceful shutdown). */
export function closeDb(db: Db): void {
  if (!db.isOpen) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
