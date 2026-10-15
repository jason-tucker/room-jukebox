import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, openSecret, saveState, sealSecret } from '../src/desktop-state';
import type { SecretCodec } from '../src/desktop-state';
import { tvConnected } from '../src/display';
import { lanAddresses } from '../src/net';
import { errorPageUrl, escapeHtml, passwordPageUrl } from '../src/pages';
import { IdleTokenCache } from '../src/token-cache';
import { resolveWindowMode } from '../src/window-mode';

const fakeDpapi: SecretCodec = {
  available: true,
  encrypt: (p) => Buffer.from(`enc:${p}`).toString('base64'),
  decrypt: (c) => {
    const text = Buffer.from(c, 'base64').toString();
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  },
};

describe('desktop-state.json', () => {
  const DEFAULTS = {
    mode: 'hub',
    updateMode: 'immediate',
    updateFeed: 'tango',
    updateFeedUrl: 'http://192.168.1.5:8766/',
  } as const;

  it('defaults when missing or corrupt: immediate updates from the Tango feed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rj-state-'));
    expect(loadState(join(dir, 'missing.json'))).toEqual(DEFAULTS);
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(loadState(join(dir, 'bad.json'))).toEqual(DEFAULTS);
    writeFileSync(join(dir, 'arr.json'), '[]');
    expect(loadState(join(dir, 'arr.json'))).toEqual(DEFAULTS);
  });

  it('migrates the legacy autoUpdate toggle and rejects bad update settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rj-state-'));
    writeFileSync(join(dir, 'off.json'), JSON.stringify({ autoUpdate: false }));
    expect(loadState(join(dir, 'off.json'))).toEqual({ ...DEFAULTS, updateMode: 'off' });
    writeFileSync(join(dir, 'on.json'), JSON.stringify({ autoUpdate: true }));
    expect(loadState(join(dir, 'on.json'))).toEqual(DEFAULTS);
    writeFileSync(
      join(dir, 'set.json'),
      JSON.stringify({
        autoUpdate: false,
        updateMode: 'quiet',
        updateFeed: 'github',
        updateFeedUrl: 'http://10.0.0.2:9000/feed',
      }),
    );
    expect(loadState(join(dir, 'set.json'))).toEqual({
      mode: 'hub',
      updateMode: 'quiet',
      updateFeed: 'github',
      updateFeedUrl: 'http://10.0.0.2:9000/feed/',
    });
    writeFileSync(
      join(dir, 'junk.json'),
      JSON.stringify({ updateMode: 'yolo', updateFeed: 'ftp', updateFeedUrl: 'file:///etc' }),
    );
    expect(loadState(join(dir, 'junk.json'))).toEqual(DEFAULTS);
  });

  it('round-trips with sealed secrets and never stores the token in clear', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rj-state-')), 'sub', 'desktop-state.json');
    saveState(file, {
      ...DEFAULTS,
      updateMode: 'off',
      lastRunVersion: '0.0.7',
      playerId: 'tv-1',
      playerToken: sealSecret(fakeDpapi, 'player-secret'),
      lanPort: 8081,
    });
    expect(readFileSync(file, 'utf8')).not.toContain('player-secret');
    const back = loadState(file);
    expect(back.updateMode).toBe('off');
    expect(back.lastRunVersion).toBe('0.0.7');
    expect(back.lanPort).toBe(8081);
    expect(openSecret(fakeDpapi, back.playerToken)).toBe('player-secret');
  });

  it('falls back to plaintext without DPAPI and survives undecryptable values', () => {
    const plain: SecretCodec = { ...fakeDpapi, available: false };
    const sealed = sealSecret(plain, 'x');
    expect(sealed).toEqual({ enc: 'plain', value: 'x' });
    expect(openSecret(plain, sealed)).toBe('x');
    expect(openSecret(plain, sealSecret(fakeDpapi, 'y'))).toBeUndefined();
    expect(openSecret(fakeDpapi, { enc: 'safeStorage', value: 'garbage' })).toBeUndefined();
    expect(openSecret(fakeDpapi, undefined)).toBeUndefined();
  });
});

describe('owner token cache', () => {
  it('expires after 10 min idle, and use or input keeps it alive', () => {
    let t = 0;
    const cache = new IdleTokenCache(600_000, () => t);
    expect(cache.get()).toBeUndefined();
    cache.set('tok');
    t = 599_999;
    expect(cache.get()).toBe('tok');
    t += 599_999;
    cache.touch();
    t += 599_999;
    expect(cache.has()).toBe(true);
    t += 1;
    expect(cache.expired()).toBe(true);
    expect(cache.get()).toBeUndefined();
    expect(cache.expired()).toBe(false);
  });

  it('clear returns the token for logout', () => {
    const cache = new IdleTokenCache(1000, () => 0);
    cache.set('abc');
    expect(cache.clear()).toBe('abc');
    expect(cache.has()).toBe(false);
  });
});

describe('TV window mode', () => {
  const cli = { fullscreen: true, kiosk: false, display: undefined };
  it('defaults to fullscreen, no kiosk', () => {
    expect(resolveWindowMode(cli, {}, false)).toEqual({
      fullscreen: true,
      kiosk: false,
      displayId: undefined,
    });
  });
  it('follows the hub settings', () => {
    expect(
      resolveWindowMode(cli, { kiosk: true, autoFullscreen: false, tvDisplayId: 7 }, false),
    ).toEqual({
      fullscreen: true,
      kiosk: true,
      displayId: 7,
    });
    expect(resolveWindowMode(cli, { autoFullscreen: false }, false).fullscreen).toBe(false);
  });
  it('command-line flags win', () => {
    expect(resolveWindowMode({ ...cli, kiosk: true }, { kiosk: false }, false).kiosk).toBe(true);
    expect(resolveWindowMode({ ...cli, display: 3 }, { tvDisplayId: 7 }, false).displayId).toBe(3);
    expect(resolveWindowMode({ ...cli, fullscreen: false }, { kiosk: true }, false)).toMatchObject({
      fullscreen: false,
      kiosk: false,
    });
  });
  it('stays windowed during setup', () => {
    expect(resolveWindowMode(cli, { kiosk: true }, true)).toMatchObject({
      fullscreen: false,
      kiosk: false,
    });
  });
});

describe('TV display connected', () => {
  const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, internal: true };
  const tv = { id: 2, bounds: { x: 1920, y: 0, width: 3840, height: 2160 }, internal: false };
  it('uses the configured display id when set', () => {
    expect(tvConnected([laptop, tv], 2)).toBe(true);
    expect(tvConnected([laptop], 2)).toBe(false);
  });
  it('otherwise needs an external display', () => {
    expect(tvConnected([laptop, tv], null)).toBe(true);
    expect(tvConnected([laptop], null)).toBe(false);
    expect(tvConnected([tv], undefined)).toBe(true);
  });
});

describe('lan addresses', () => {
  it('lists non-internal IPv4 with CIDR', () => {
    expect(
      lanAddresses({
        lo: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
        eth0: [
          {
            address: '192.168.1.20',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '',
            internal: false,
            cidr: '192.168.1.20/24',
          },
          {
            address: 'fe80::1',
            netmask: 'ffff::',
            family: 'IPv6',
            mac: '',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      }),
    ).toEqual([{ interface: 'eth0', address: '192.168.1.20', cidr: '192.168.1.20/24' }]);
  });
});

describe('local pages', () => {
  it('escapes the error text', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&#60;script&#62;&#34;&#38;&#39;');
    const html = decodeURIComponent(
      errorPageUrl('Port 8080 is in use', ['<b>x</b>']).split(',')[1]!,
    );
    expect(html).toContain('Port 8080 is in use');
    expect(html).toContain('&#60;b&#62;x');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain("default-src 'none'");
  });
  it('builds the password prompt', () => {
    const url = passwordPageUrl('Quit <now>');
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    const html = decodeURIComponent(url.split(',')[1]!);
    expect(html).toContain('type="password"');
    expect(html).toContain('Quit &#60;now&#62;');
  });
});
