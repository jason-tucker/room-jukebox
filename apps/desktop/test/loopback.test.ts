import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startBroadcaster, startListener } from '../src/beacon';
import { startStaticServer } from '../src/static-server';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe('player loopback static server', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>spa</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  let close: (() => Promise<void>) | undefined;
  afterAll(() => close?.());

  it('serves files, falls back to index.html for routes and 404s missing assets', async () => {
    const server = await startStaticServer(root);
    close = server.close;
    const base = `http://127.0.0.1:${server.port}`;

    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');

    const tv = await fetch(`${base}/tv?player=x&hub=http%3A%2F%2F10.0.0.2%3A8080`);
    expect(tv.status).toBe(200);
    expect(await tv.text()).toContain('<title>spa</title>');

    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    // Dot segments are normalised before lookup, so traversal only ever reaches the SPA shell.
    const traversal = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    expect(await traversal.text()).not.toContain('root:');
  });
});

describe('beacon', () => {
  it('broadcasts per interface and the listener records the last beacon', async () => {
    const beaconPort = 40000 + Math.floor(Math.random() * 5000);
    const listener = startListener({ log: quiet, beaconPort });
    const broadcaster = startBroadcaster({
      hubId: 'hub-1',
      bootId: 'boot-1',
      roomName: 'Basement',
      port: 8080,
      version: '0.0.1',
      protocolVersion: 1,
      log: quiet,
      beaconPort,
      listInterfaces: () => [
        { name: 'lo', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.0.0.1' },
      ],
    });
    try {
      await expect.poll(() => listener.last(), { timeout: 5000, interval: 100 }).not.toBeNull();
      const got = listener.last()!;
      expect(got.from).toBe('127.0.0.1');
      expect(got.beacon).toMatchObject({
        type: 'beacon',
        hubId: 'hub-1',
        bootId: 'boot-1',
        roomName: 'Basement',
        address: '127.0.0.1',
        port: 8080,
        protocolVersion: 1,
      });
      expect(got.beacon.counter).toBeGreaterThanOrEqual(1);
    } finally {
      broadcaster.stop();
      listener.stop();
    }
  });
});
