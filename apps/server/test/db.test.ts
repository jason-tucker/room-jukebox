import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { BackupScheduler, listBackups, nextLocalTime, pruneBackups } from '../src/db/backup.ts';
import { closeDb, openDb } from '../src/db/index.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { LAN, makeHub, setup, vid } from './helpers.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'rj-db-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('migrations', () => {
  it('embedded SQL matches the .sql files', () => {
    for (const m of MIGRATIONS) {
      const file = readFileSync(new URL(`../src/db/migrations/${m.name}`, import.meta.url), 'utf8');
      expect(m.sql).toBe(file);
    }
  });

  it('applies once, records schema_migrations, uses WAL', async () => {
    const path = join(tmp(), 'data.db');
    const first = await openDb(path);
    expect(first.applied).toEqual([1]);
    expect(first.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    closeDb(first.db);
    const second = await openDb(path);
    expect(second.applied).toEqual([]);
    expect(second.db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: '0001_init.sql' },
    ]);
    closeDb(second.db);
  });
});

describe('backups', () => {
  it('nextLocalTime is the next 04:00 local', () => {
    const at = new Date(2026, 9, 24, 3, 59).getTime();
    expect(nextLocalTime(at)).toBe(new Date(2026, 9, 24, 4, 0).getTime());
    const after = new Date(2026, 9, 24, 4, 0).getTime();
    expect(nextLocalTime(after)).toBe(new Date(2026, 9, 25, 4, 0).getTime());
  });

  it('the scheduler runs at 04:00 and re-arms', async () => {
    let now = new Date(2026, 9, 24, 22, 0).getTime();
    const pending: { fn: () => void; ms: number }[] = [];
    let runs = 0;
    const s = new BackupScheduler({
      run: async () => void runs++,
      now: () => now,
      timers: { setTimeout: (fn, ms) => pending.push({ fn, ms }), clearTimeout: () => {} },
    });
    s.start();
    expect(pending[0]?.ms).toBe(6 * 60 * 60 * 1000);
    now += pending[0]!.ms;
    pending.shift()!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1);
    expect(pending[0]?.ms).toBe(24 * 60 * 60 * 1000);
    s.stop();
  });

  it('keeps 7', () => {
    const dir = tmp();
    for (let i = 0; i < 10; i++) {
      const p = join(dir, `data-2026101${i}-040000-nightly.db`);
      writeFileSync(p, 'x');
    }
    pruneBackups(dir);
    expect(listBackups(dir)).toHaveLength(7);
  });

  it('backup → restore round trip reproduces settings, queue and the API key', async () => {
    const hub = await makeHub();
    try {
      hub.yt.add({ id: vid(1), title: 'One' }, { id: vid(2), title: 'Two' });
      const { token } = await setup(hub.app, { youtubeApiKey: 'AIzaROUNDTRIP42', roomName: 'Den' });
      const auth = { authorization: `Bearer ${token}` };
      for (const i of [1, 2]) {
        await hub.app.inject({
          method: 'POST',
          url: '/api/admin/requests',
          headers: auth,
          payload: { videoId: vid(i), idempotencyKey: `k${i}` },
        });
      }
      const res = await hub.app.inject({ method: 'POST', url: '/api/admin/backup', headers: auth });
      expect(res.statusCode).toBe(200);
      const info = res.json() as { path: string; bytes: number; at: number };
      expect(info.bytes).toBeGreaterThan(0);
      const list = await hub.app.inject({ url: '/api/admin/backups', headers: auth });
      expect(list.json().backups.map((b: { path: string }) => b.path)).toContain(info.path);

      // Manual restore: copy the backup into a clean data dir as data.db.
      const fresh = tmp();
      mkdirSync(fresh, { recursive: true });
      copyFileSync(info.path, join(fresh, 'data.db'));
      const restored = await buildApp({
        webRoot: '/nonexistent',
        dataDir: fresh,
        lan: { addresses: () => LAN },
        fetch: hub.yt.fetch,
        restartGraceMs: -1,
        nightlyBackup: false,
      });
      try {
        expect(restored.jukebox.needsSetup()).toBe(false);
        const settings = restored.jukebox.settings();
        expect(settings).toMatchObject({ roomName: 'Den', hasApiKey: true, apiKeyLast4: 'IP42' });
        const s = restored.jukebox.session.state;
        expect(s.nowPlaying?.videoId).toBe(vid(1));
        expect(s.queue.map((e) => e.videoId)).toEqual([vid(2)]);
        const login = await restored.inject({
          method: 'POST',
          url: '/api/admin/login',
          payload: { password: 'correct horse' },
        });
        expect(login.statusCode).toBe(200);
        // the key works: a search reaches YouTube
        const search = await restored.inject({
          method: 'POST',
          url: '/api/search',
          payload: { q: 'x' },
        });
        expect(search.statusCode).toBe(200);
        expect(hub.yt.calls.at(-2)?.params.get('key')).toBe('AIzaROUNDTRIP42');
      } finally {
        await restored.close();
      }
    } finally {
      await hub.close();
    }
  });

  it('graceful close checkpoints the WAL', async () => {
    const dir = tmp();
    const app = await buildApp({ webRoot: '/nonexistent', dataDir: dir, nightlyBackup: false });
    await app.ready();
    await app.close();
    const wal = join(dir, 'data.db-wal');
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
  });

  it('encrypts secrets through the secrets option', async () => {
    const dir = tmp();
    const secrets = {
      encrypt: (s: string) => `enc:${Buffer.from(s).toString('base64')}`,
      decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString(),
    };
    const app = await buildApp({
      webRoot: '/nonexistent',
      dataDir: dir,
      nightlyBackup: false,
      secrets,
    });
    try {
      await app.ready();
      await setup(app, { youtubeApiKey: 'AIzaPLAINTEXT99' });
      const raw = readFileSync(join(dir, 'data.db-wal'));
      expect(raw.includes('AIzaPLAINTEXT99')).toBe(false);
      expect(app.jukebox.settings().apiKeyLast4).toBe('XT99');
    } finally {
      await app.close();
    }
  });
});
