import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';

/** Backups kept (retention ≤ 7 days so a guest deletion leaves every copy within 7 days). */
export const BACKUPS_KEPT = 7;
const PREFIX = 'data-';
const SUFFIX = '.db';

export interface BackupInfo {
  path: string;
  bytes: number;
  /** ms (file modification time). */
  at: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `data-20261009-040000-nightly.db` in local time. */
function fileName(at: number, label: string): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${PREFIX}${stamp}-${label}${SUFFIX}`;
}

/**
 * Copies the live database to `<dir>/data-<stamp>-<label>.db` with SQLite's online backup API,
 * then prunes to the newest {@link BACKUPS_KEPT}.
 */
export async function backup(
  db: DatabaseSync,
  dir: string,
  at: number = Date.now(),
  label = 'manual',
): Promise<BackupInfo> {
  mkdirSync(dir, { recursive: true });
  let path = join(dir, fileName(at, label));
  for (let i = 1; listNames(dir).includes(path.slice(dir.length + 1)); i++) {
    path = join(dir, fileName(at, `${label}-${i}`));
  }
  await sqliteBackup(db, path);
  const bytes = statSync(path).size;
  pruneBackups(dir);
  return { path, bytes, at };
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX));
  } catch {
    return [];
  }
}

/** Kept backups, newest first. */
export function listBackups(dir: string): BackupInfo[] {
  return listNames(dir)
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return { path, bytes: st.size, at: Math.round(st.mtimeMs) };
    })
    .sort((a, b) => b.at - a.at || (a.path < b.path ? 1 : -1));
}

/** Deletes all but the newest `keep` backups. */
export function pruneBackups(dir: string, keep: number = BACKUPS_KEPT): void {
  for (const old of listBackups(dir).slice(keep)) rmSync(old.path, { force: true });
}

/** ms of the next local `hour`:00 strictly after `now`. */
export function nextLocalTime(now: number, hour = 4): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(hour, 0, 0, 0);
  }
  return d.getTime();
}

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface BackupSchedulerOptions {
  run: () => Promise<unknown>;
  now?: () => number;
  timers?: SchedulerTimers;
  hour?: number;
  onError?: (err: unknown) => void;
}

/** Runs `run` every night at 04:00 local time (re-armed after each run, so DST shifts follow). */
export class BackupScheduler {
  #opts: Required<Omit<BackupSchedulerOptions, 'onError'>> &
    Pick<BackupSchedulerOptions, 'onError'>;
  #handle: unknown = null;
  #stopped = false;

  constructor(options: BackupSchedulerOptions) {
    this.#opts = {
      now: Date.now,
      timers: realTimers,
      hour: 4,
      ...options,
    };
  }

  /** ms of the next scheduled run. */
  next(): number {
    return nextLocalTime(this.#opts.now(), this.#opts.hour);
  }

  start(): void {
    this.#stopped = false;
    this.#arm();
  }

  #arm(): void {
    if (this.#stopped) return;
    const delay = Math.max(0, this.next() - this.#opts.now());
    this.#handle = this.#opts.timers.setTimeout(() => {
      void this.#opts
        .run()
        .catch((err: unknown) => this.#opts.onError?.(err))
        .finally(() => this.#arm());
    }, delay);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#handle !== null) this.#opts.timers.clearTimeout(this.#handle);
    this.#handle = null;
  }
}
