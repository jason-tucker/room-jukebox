import type { ReleaseNotes, UpdateStatus } from '@room-jukebox/shared';
import {
  ChecklistStateSchema,
  ReleaseNotesReplySchema,
  UpdateStatusSchema,
} from '@room-jukebox/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/app.ts';
import type { UpdaterApi } from '../src/app.ts';
import { makeHub, setup } from './helpers.ts';
import type { TestHub } from './helpers.ts';

let hub: TestHub;
afterEach(async () => hub.close());

const NOTES: ReleaseNotes = {
  version: VERSION,
  date: '2026-10-14',
  changes: ['Auto-updater', "What's new tab"],
  checklist: [
    { id: 'tv-toast', text: 'The TV showed the update notice.' },
    { id: 'ticks', text: 'Ticks survive a reload.' },
    { id: 'mode', text: 'Settings shows the update mode.' },
  ],
};

class FakeUpdater implements UpdaterApi {
  calls: string[] = [];
  fail: string | null = null;
  s: UpdateStatus = {
    mode: 'immediate',
    feed: 'tango',
    feedUrl: 'https://tango.example/updates/',
    state: 'idle',
    current: VERSION,
    available: null,
    message: null,
    lastCheckAt: null,
  };
  status() {
    return structuredClone(this.s);
  }
  async checkNow() {
    this.calls.push('check');
    if (this.fail) throw new Error(this.fail);
    this.s = { ...this.s, state: 'available', available: '9.9.9', lastCheckAt: 1000 };
  }
  async installNow() {
    this.calls.push('install');
    this.s = { ...this.s, state: 'installing' };
  }
  setMode(mode: UpdateStatus['mode']) {
    this.calls.push(`mode:${mode}`);
    this.s = { ...this.s, mode };
  }
  setFeed(feed: UpdateStatus['feed'], url?: string) {
    this.calls.push(`feed:${feed}:${url ?? ''}`);
    this.s = { ...this.s, feed, feedUrl: url ?? `https://${feed}.example/` };
  }
}

async function signedIn(extra: Parameters<typeof makeHub>[0] = {}) {
  hub = await makeHub(extra);
  const { token } = await setup(hub.app);
  const as = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    hub.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  return as;
}

describe('GET /api/version', () => {
  it('is public and reports the version and protocol', async () => {
    hub = await makeHub();
    const res = await hub.app.inject({
      method: 'GET',
      url: '/api/version',
      remoteAddress: '8.8.8.8',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: VERSION, protocolVersion: 1 });
  });
});

describe('release notes and checklist', () => {
  it('needs an admin session and the household gate', async () => {
    const as = await signedIn({ releaseNotes: NOTES });
    const anon = await hub.app.inject({ method: 'GET', url: '/api/admin/release-notes' });
    expect(anon.statusCode).toBe(401);
    const outside = await hub.app.inject({
      method: 'GET',
      url: '/api/admin/release-notes',
      remoteAddress: '8.8.8.8',
    });
    expect(outside.statusCode).toBe(403);
    expect((await as('GET', '/api/admin/release-notes')).statusCode).toBe(200);
  });

  it('returns the notes with an empty checklist, and null notes on a standalone server', async () => {
    let as = await signedIn({ releaseNotes: NOTES });
    let reply = ReleaseNotesReplySchema.parse((await as('GET', '/api/admin/release-notes')).json());
    expect(reply).toEqual({
      notes: NOTES,
      checklist: { version: VERSION, done: {}, updatedAt: null },
      installedVersion: VERSION,
    });
    await hub.close();

    as = await signedIn();
    reply = ReleaseNotesReplySchema.parse((await as('GET', '/api/admin/release-notes')).json());
    expect(reply.notes).toBeNull();
    expect(reply.checklist).toEqual({ version: VERSION, done: {}, updatedAt: null });
  });

  it('merges ticks, stamps updatedAt and keeps them across a restart', async () => {
    const as = await signedIn({ releaseNotes: NOTES });
    let res = await as('PATCH', '/api/admin/checklist', {
      version: VERSION,
      done: { 'tv-toast': true, ticks: true },
    });
    expect(res.statusCode).toBe(200);
    hub.clock.advance(5000);
    res = await as('PATCH', '/api/admin/checklist', { version: VERSION, done: { ticks: false } });
    const state = ChecklistStateSchema.parse(res.json());
    expect(state).toEqual({
      version: VERSION,
      done: { 'tv-toast': true, ticks: false },
      updatedAt: hub.clock.now,
    });

    await hub.restart({ releaseNotes: NOTES });
    const reply = ReleaseNotesReplySchema.parse(
      (await as('GET', '/api/admin/release-notes')).json(),
    );
    expect(reply.checklist).toEqual(state);
  });

  it('starts empty when the stored checklist belongs to another version', async () => {
    const as = await signedIn({ releaseNotes: NOTES });
    const settingsRes = await as('PATCH', '/api/admin/checklist', {
      version: VERSION,
      done: { ticks: true },
    });
    expect(settingsRes.statusCode).toBe(200);
    // Simulate an update: the stored ticks now belong to an older version.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${hub.dataDir}/data.db`);
    const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string };
    const stored = JSON.parse(row.data) as { checklist: { version: string } };
    stored.checklist.version = '0.0.1';
    db.prepare('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(stored));
    db.close();

    const reply = ReleaseNotesReplySchema.parse(
      (await as('GET', '/api/admin/release-notes')).json(),
    );
    expect(reply.checklist).toEqual({ version: VERSION, done: {}, updatedAt: null });
    const res = await as('PATCH', '/api/admin/checklist', {
      version: VERSION,
      done: { mode: true },
    });
    expect(ChecklistStateSchema.parse(res.json()).done).toEqual({ mode: true });
  });

  it('rejects ticks for a version that is not installed and bad bodies', async () => {
    const as = await signedIn({ releaseNotes: NOTES });
    const stale = await as('PATCH', '/api/admin/checklist', {
      version: '0.0.1',
      done: { a: true },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version-mismatch');
    const bad = await as('PATCH', '/api/admin/checklist', { version: VERSION, done: { a: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('update endpoints', () => {
  it('report the standalone status and 503 for actions without the updater', async () => {
    const as = await signedIn();
    const res = await as('GET', '/api/admin/update-status');
    expect(res.statusCode).toBe(200);
    expect(UpdateStatusSchema.parse(res.json())).toEqual({
      mode: 'off',
      feed: 'tango',
      feedUrl: '',
      state: 'idle',
      current: VERSION,
      available: null,
      message: 'Updater not available (standalone server)',
      lastCheckAt: null,
    });
    for (const [url, body] of [
      ['/api/admin/update/check', {}],
      ['/api/admin/update/install', {}],
      ['/api/admin/update/mode', { mode: 'quiet' }],
      ['/api/admin/update/feed', { feed: 'github' }],
    ] as const) {
      const r = await as('POST', url, body);
      expect(r.statusCode, url).toBe(503);
      expect(r.json().error.code).toBe('updater-unavailable');
    }
  });

  it('need an admin session', async () => {
    const updater = new FakeUpdater();
    await signedIn({ updater });
    for (const [method, url] of [
      ['GET', '/api/admin/update-status'],
      ['POST', '/api/admin/update/check'],
      ['POST', '/api/admin/update/install'],
    ] as const) {
      const r = await hub.app.inject({ method, url, payload: {} });
      expect(r.statusCode, url).toBe(401);
    }
    expect(updater.calls).toEqual([]);
  });

  it('drive the updater and answer with its new status', async () => {
    const updater = new FakeUpdater();
    const as = await signedIn({ updater });
    expect((await as('GET', '/api/admin/update-status')).json()).toEqual(updater.s);

    let res = await as('POST', '/api/admin/update/check', {});
    expect(res.statusCode).toBe(200);
    expect(UpdateStatusSchema.parse(res.json())).toMatchObject({
      state: 'available',
      available: '9.9.9',
    });

    res = await as('POST', '/api/admin/update/mode', { mode: 'quiet' });
    expect(res.json().mode).toBe('quiet');

    res = await as('POST', '/api/admin/update/feed', { feed: 'github' });
    expect(res.json()).toMatchObject({ feed: 'github', feedUrl: 'https://github.example/' });
    res = await as('POST', '/api/admin/update/feed', {
      feed: 'tango',
      url: 'https://tango.lan/rj/',
    });
    expect(res.json()).toMatchObject({ feed: 'tango', feedUrl: 'https://tango.lan/rj/' });

    res = await as('POST', '/api/admin/update/install', {});
    expect(res.json().state).toBe('installing');

    expect(updater.calls).toEqual([
      'check',
      'mode:quiet',
      'feed:github:',
      'feed:tango:https://tango.lan/rj/',
      'install',
    ]);
  });

  it('validate bodies and turn updater failures into 502', async () => {
    const updater = new FakeUpdater();
    const as = await signedIn({ updater });
    expect((await as('POST', '/api/admin/update/mode', { mode: 'sometimes' })).statusCode).toBe(
      400,
    );
    expect(
      (await as('POST', '/api/admin/update/feed', { feed: 'tango', url: 'not a url' })).statusCode,
    ).toBe(400);
    updater.fail = 'feed signature invalid';
    const res = await as('POST', '/api/admin/update/check', {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({ code: 'update-failed', message: 'feed signature invalid' });
  });
});
