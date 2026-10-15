import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '@room-jukebox/shared';
import type { UpdateInfo } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/feed-signature';
import type { FeedConfig } from '../src/update-policy';
import { Updater } from '../src/updater';
import type { AutoUpdaterLike, UpdateSettings } from '../src/updater';

// A throwaway Ed25519 key made and used exactly like scripts/build-win.sh does (host openssl,
// `pkeyutl -sign -rawin | base64 -w0`), so these tests prove the app accepts that format.
const DIR = mkdtempSync(join(tmpdir(), 'rj-updater-'));
const KEY = join(DIR, 'key.pem');
execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', KEY]);
const PUBLIC_PEM = execFileSync('openssl', ['pkey', '-in', KEY, '-pubout']).toString();

function opensslSign(yml: string): string {
  const file = join(DIR, `latest-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(file, yml);
  return execFileSync('bash', [
    '-c',
    `openssl pkeyutl -sign -inkey "${KEY}" -rawin -in "${file}" | base64 -w0`,
  ]).toString();
}

const SHA = 'c2hhNTEyLW9mLXRoZS1pbnN0YWxsZXI=';
const ymlFor = (version: string): string => `version: ${version}
files:
  - url: RoomJukebox-Setup-${version}.exe
    sha512: ${SHA}
    size: 90123456
path: RoomJukebox-Setup-${version}.exe
sha512: ${SHA}
releaseDate: '2026-10-14T08:00:00.000Z'
releaseNotes: |-
  - Auto-updater.
  - What's new tab.
`;
const infoFor = (version: string): UpdateInfo =>
  ({
    version,
    files: [{ url: `RoomJukebox-Setup-${version}.exe`, sha512: SHA, size: 90123456 }],
    path: `RoomJukebox-Setup-${version}.exe`,
    sha512: SHA,
    releaseDate: '2026-10-14T08:00:00.000Z',
  }) as UpdateInfo;

class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = true;
  allowDowngrade = true;
  allowPrerelease = true;
  autoInstallOnAppQuit = true;
  feed: FeedConfig | undefined;
  offer: UpdateInfo | null = null;
  checkError: Error | undefined;
  downloadError: Error | undefined;
  checks = 0;
  downloads = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  private onDownloaded: ((info: UpdateInfo) => void) | undefined;

  setFeedURL(options: FeedConfig): void {
    this.feed = options;
  }
  async checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfo }> {
    this.checks++;
    if (this.checkError) throw this.checkError;
    return this.offer
      ? { isUpdateAvailable: true, updateInfo: this.offer }
      : { isUpdateAvailable: false, updateInfo: infoFor('0.0.7') };
  }
  async downloadUpdate(): Promise<string[]> {
    this.downloads++;
    if (this.downloadError) throw this.downloadError;
    if (this.offer) this.onDownloaded?.(this.offer);
    return [];
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
  on(
    event: 'error' | 'update-downloaded',
    listener: ((err: Error) => void) | ((info: UpdateInfo) => void),
  ): this {
    if (event === 'update-downloaded') this.onDownloaded = listener as (info: UpdateInfo) => void;
    return this;
  }
}

function feedServer(files: Record<string, string>): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      headers: { get: () => null },
      arrayBuffer: async () => {
        const b = Buffer.from(body ?? 'Not Found');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  return { fetch, urls };
}

const TANGO = 'http://192.168.1.5:8766/';
const MIN = 60_000;

function setup(opts: { mode?: UpdateSettings['mode']; files?: Record<string, string> } = {}) {
  const au = new FakeAutoUpdater();
  au.offer = infoFor('0.0.8');
  const yml = ymlFor('0.0.8');
  const server = feedServer(
    opts.files ?? {
      [`${TANGO}latest.yml`]: yml,
      [`${TANGO}latest.yml.sig`]: opensslSign(yml),
    },
  );
  let settings: UpdateSettings = { mode: opts.mode ?? 'immediate', feed: 'tango', feedUrl: TANGO };
  const env = {
    au,
    server,
    now: Date.UTC(2026, 9, 14, 20, 0, 0),
    setupOpen: false,
    sessionEnding: false,
    quiet: { quiet: false, tvConnected: true },
    toasts: [] as { level: string; message: string; ttlMs: number | undefined }[],
    statuses: [] as UpdateStatus[],
    beforeInstall: vi.fn(),
    settings: () => settings,
  };
  const updater = new Updater({
    autoUpdater: au,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    fetch: server.fetch,
    publicKeyPem: PUBLIC_PEM,
    currentVersion: '0.0.7',
    toast: (level, message, ttlMs) => env.toasts.push({ level, message, ttlMs }),
    settings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch };
    },
    quietStatus: () => env.quiet,
    sessionEnding: () => env.sessionEnding,
    setupOpen: () => env.setupOpen,
    setPending: () => undefined,
    beforeInstall: env.beforeInstall,
    now: () => env.now,
  });
  updater.subscribe((s) => env.statuses.push(s));
  return { updater, env };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('updater: immediate mode', () => {
  it('verifies, downloads, shows a 15 s notice everywhere, then installs', async () => {
    const { updater, env } = setup();
    expect(env.au.feed).toEqual({ provider: 'generic', url: TANGO });
    expect(env.au.autoDownload).toBe(false);
    expect(env.au.autoInstallOnAppQuit).toBe(false);

    await updater.tick();
    expect(env.server.urls).toEqual([`${TANGO}latest.yml`, `${TANGO}latest.yml.sig`]);
    expect(env.au.downloads).toBe(1);
    expect(env.toasts).toEqual([
      { level: 'info', message: 'Updating to 0.0.8 in 15 s', ttlMs: 15_000 },
    ]);
    expect(updater.status()).toMatchObject({
      mode: 'immediate',
      feed: 'tango',
      feedUrl: TANGO,
      state: 'installing',
      current: '0.0.7',
      available: '0.0.8',
      message: 'Updating to 0.0.8 in 15 s',
      lastCheckAt: env.now,
    });
    // Subscribers (the server, for phones) saw the same notice.
    expect(env.statuses.map((s) => s.state)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloaded',
      'installing',
    ]);
    expect(env.statuses.at(-1)?.message).toBe('Updating to 0.0.8 in 15 s');

    // Ticks during the notice change nothing.
    await updater.tick();
    expect(env.au.checks).toBe(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(env.au.installs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.au.installs).toEqual([[true, true]]);
    expect(env.beforeInstall).toHaveBeenCalledOnce();
    expect(updater.status().message).toBe('Installing 0.0.8…');
  });

  it('checks at launch and then every 10 minutes', async () => {
    const { updater, env } = setup();
    env.au.offer = null;
    await updater.tick();
    expect(env.au.checks).toBe(1);
    expect(updater.status().state).toBe('up-to-date');
    env.now += 9 * MIN;
    await updater.tick();
    expect(env.au.checks).toBe(1);
    env.now += MIN;
    await updater.tick();
    expect(env.au.checks).toBe(2);
  });

  it('waits while the setup wizard is open and calls the install off if it opens', async () => {
    const { updater, env } = setup();
    env.setupOpen = true;
    await updater.tick();
    expect(env.au.downloads).toBe(0);
    expect(env.toasts).toEqual([]);
    env.setupOpen = false;
    await updater.tick();
    expect(updater.countdownActive()).toBe(true);
    env.setupOpen = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.au.installs).toEqual([]);
    expect(updater.status().state).toBe('downloaded');
    env.setupOpen = false;
    await updater.tick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.au.installs).toHaveLength(1);
  });

  it('never installs while Windows is shutting down', async () => {
    const { updater, env } = setup();
    await updater.tick();
    env.sessionEnding = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.au.installs).toEqual([]);
  });
});

describe('updater: mode transitions', () => {
  it('leaving immediate during the notice cancels it; off does nothing; quiet waits', async () => {
    const { updater, env } = setup();
    await updater.tick();
    expect(updater.countdownActive()).toBe(true);
    updater.setMode('quiet');
    expect(updater.countdownActive()).toBe(false);
    expect(updater.status()).toMatchObject({ mode: 'quiet', state: 'downloaded' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.au.installs).toEqual([]);

    // Quiet: not quiet -> no install; TV unplugged -> installs without a notice.
    await updater.tick();
    expect(env.au.installs).toEqual([]);
    env.quiet = { quiet: true, tvConnected: false };
    await updater.tick();
    expect(env.au.installs).toEqual([[true, true]]);
  });

  it('off: no checks at all, but Update now still forces the install', async () => {
    const { updater, env } = setup({ mode: 'off' });
    await updater.tick();
    env.now += 24 * 60 * MIN;
    await updater.tick();
    expect(env.au.checks).toBe(0);
    const r = await updater.updateNow();
    expect(r).toEqual({ ok: true, message: 'Installing 0.0.8…' });
    expect(env.au.installs).toEqual([[true, true]]);
  });

  it('quiet does not download until the room is quiet and checks every 6 h', async () => {
    const { updater, env } = setup({ mode: 'quiet' });
    await updater.tick();
    expect(env.au.checks).toBe(1);
    expect(env.au.downloads).toBe(0);
    env.now += 5 * 60 * MIN;
    await updater.tick();
    expect(env.au.checks).toBe(1);
    env.now += 60 * MIN;
    await updater.tick();
    expect(env.au.checks).toBe(2);
  });

  it('switching to immediate picks up a pending offer right away', async () => {
    const { updater, env } = setup({ mode: 'quiet' });
    await updater.tick();
    updater.setMode('immediate');
    await vi.advanceTimersByTimeAsync(0);
    expect(env.settings().mode).toBe('immediate');
    expect(updater.countdownActive()).toBe(true);
  });

  it('setFeed(github) switches the provider and the signature location', async () => {
    const gh = 'https://github.com/jason-tucker/room-jukebox/releases/download/v0.0.8';
    const yml = ymlFor('0.0.8');
    const { updater, env } = setup({
      mode: 'off',
      files: { [`${gh}/latest.yml`]: yml, [`${gh}/latest.yml.sig`]: opensslSign(yml) },
    });
    updater.setFeed('github');
    expect(env.au.feed).toEqual({
      provider: 'github',
      owner: 'jason-tucker',
      repo: 'room-jukebox',
    });
    expect(updater.status().feedUrl).toBe('https://github.com/jason-tucker/room-jukebox/releases');
    expect((await updater.check()).ok).toBe(true);
    expect(env.server.urls).toEqual([`${gh}/latest.yml`, `${gh}/latest.yml.sig`]);

    updater.setFeed('tango', 'http://10.1.1.1:9000/rj');
    expect(env.settings()).toMatchObject({ feed: 'tango', feedUrl: 'http://10.1.1.1:9000/rj/' });
    expect(env.au.feed).toEqual({ provider: 'generic', url: 'http://10.1.1.1:9000/rj/' });
    expect(() => updater.setFeed('tango', 'file:///C:/evil')).toThrow();
    expect(() => updater.setMode('later' as never)).toThrow();
  });
});

describe('updater: failures never crash', () => {
  it('a bad signature refuses the update: status error, one toast, no download', async () => {
    const yml = ymlFor('0.0.8');
    const { updater, env } = setup({
      files: {
        [`${TANGO}latest.yml`]: yml.replace('90123456', '90123457'),
        [`${TANGO}latest.yml.sig`]: opensslSign(yml),
      },
    });
    await updater.tick();
    env.now += 10 * MIN;
    await updater.tick();
    expect(env.au.checks).toBe(2);
    expect(env.au.downloads).toBe(0);
    expect(updater.status()).toMatchObject({
      state: 'error',
      message: 'Update 0.0.8 refused: latest.yml signature is invalid.',
    });
    expect(env.toasts).toEqual([
      {
        level: 'error',
        message: 'Update 0.0.8 refused: latest.yml signature is invalid.',
        ttlMs: undefined,
      },
    ]);
  });

  it('a missing signature file refuses the update', async () => {
    const { updater, env } = setup({ files: { [`${TANGO}latest.yml`]: ymlFor('0.0.8') } });
    await updater.tick();
    expect(updater.status().state).toBe('error');
    expect(env.au.downloads).toBe(0);
  });

  it('a failed download: status error, a toast, retried at the next check only', async () => {
    const { updater, env } = setup();
    env.au.downloadError = new Error('ECONNRESET');
    await updater.tick();
    expect(updater.status()).toMatchObject({
      state: 'error',
      message: 'Update 0.0.8 could not be downloaded.',
    });
    expect(env.toasts.map((t) => t.level)).toEqual(['error']);
    await updater.tick();
    expect(env.au.downloads).toBe(1);
    env.au.downloadError = undefined;
    env.now += 10 * MIN;
    await updater.tick();
    expect(env.au.downloads).toBe(2);
    expect(updater.countdownActive()).toBe(true);
  });

  it('an offline check sets error without a toast', async () => {
    const { updater, env } = setup();
    env.au.checkError = new Error('ENOTFOUND');
    await expect(updater.tick()).resolves.toBeUndefined();
    expect(updater.status()).toMatchObject({ state: 'error' });
    expect(env.toasts).toEqual([]);
  });

  it('a throwing quitAndInstall is reported, not thrown', async () => {
    const { updater, env } = setup();
    env.au.quitAndInstall = () => {
      throw new Error('spawn EACCES');
    };
    await updater.tick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updater.status()).toMatchObject({
      state: 'error',
      message: 'Update 0.0.8 could not be installed.',
    });
  });
});
