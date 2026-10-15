import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startBroadcaster, startListener } from '../src/beacon';
import type { BeaconIdentity } from '../src/beacon';
import { subkey } from '../src/household';
import { HubDirectory } from '../src/hubs';
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
  it('broadcasts signed v2 beacons per interface and the listener hands them over', async () => {
    const beaconPort = 40000 + Math.floor(Math.random() * 5000);
    const beaconKey = subkey(Buffer.alloc(32, 7), 'rj/beacon');
    const directory = new HubDirectory(() => beaconKey);
    const listener = startListener({
      log: quiet,
      beaconPort,
      onBeacon: (b, from) => directory.accept(b, from),
    });
    let identity: BeaconIdentity | null = null;
    const broadcaster = startBroadcaster({
      identity: () => identity,
      bootId: 'boot-1',
      port: 8080,
      version: '0.0.1',
      protocolVersion: 2,
      log: quiet,
      beaconPort,
      listInterfaces: () => [
        { name: 'lo', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.0.0.1' },
      ],
    });
    try {
      // No household key yet: nothing is sent.
      await new Promise((r) => setTimeout(r, 300));
      expect(listener.last()).toBeNull();
      identity = { hubId: 'hub-1', hubEpoch: 3, keyEpoch: 1, roomName: 'Basement', beaconKey };
      await expect.poll(() => directory.list().length, { timeout: 6000, interval: 100 }).toBe(1);
      const got = listener.last()!;
      expect(got.from).toBe('127.0.0.1');
      expect(got.beacon).toMatchObject({
        v: 2,
        hubId: 'hub-1',
        hubEpoch: 3,
        keyEpoch: 1,
        bootId: 'boot-1',
        roomName: 'Basement',
        address: '127.0.0.1',
        port: 8080,
        protocolVersion: 2,
      });
      expect(directory.list()[0]).toMatchObject({ hubId: 'hub-1', verified: true, port: 8080 });
    } finally {
      broadcaster.stop();
      listener.stop();
    }
  });
});
