import { createHmac, hkdfSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeaconUnsigned, PairReply, ReplicaSnapshot } from '@room-jukebox/shared';
import { loadState, openSecret, saveState, sealSecret } from '../src/desktop-state';
import type { SecretCodec } from '../src/desktop-state';
import {
  canonicalJson,
  hmacProof,
  hubEndpoint,
  joinAckProof,
  pairProof,
  signBeacon,
  subkey,
  verifyBeacon,
} from '../src/household';
import type { BeaconLastSeen } from '../src/household';
import {
  deriveKeys,
  joinAckProof as serverJoinAckProof,
  joinProof as serverJoinProof,
  pairProof as serverPairProof,
} from 'server/src/household.ts';
import { HUB_EXPIRY_MS, HubDirectory } from '../src/hubs';
import {
  localPlayerAuthProof,
  normalizeHubAddress,
  pairWithHub,
  playerAuthProof,
  verifyAuthOk,
} from '../src/pairing';
import type { FetchFn } from '../src/pairing';
import { hubJson, redirectTarget, startPlayerLan, startStubLan } from '../src/player-lan';
import type { PlayerHubView } from '../src/player-lan';
import { readReplica, replicaInfo, writeReplica } from '../src/replica-store';
import { buildApp } from 'server/src/app.ts';

// Fixed household key: 32 bytes of 0x01.
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');

const fakeDpapi: SecretCodec = {
  available: true,
  encrypt: (p) => Buffer.from(`enc:${p}`).toString('base64'),
  decrypt: (c) => {
    const text = Buffer.from(c, 'base64').toString();
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  },
};

const unsigned: BeaconUnsigned = {
  v: 2,
  hubId: 'hub-1',
  hubEpoch: 1,
  keyEpoch: 0,
  roomName: 'Basement',
  address: '192.168.1.5',
  port: 8080,
  version: '0.1.0',
  protocolVersion: 2,
  bootId: 'boot-1',
  counter: 1,
};

describe('household crypto (contract formulas, fixed-key fixtures)', () => {
  it('derives the four HKDF-SHA256 subkeys (empty salt, info = label)', () => {
    expect(subkey(KEY, 'rj/beacon').toString('hex')).toBe(
      'dadb368c671143fb4f141575e917cf8930aa4806a2c3768c3e951c3a6adbae28',
    );
    expect(subkey(KEY, 'rj/player-proof').toString('hex')).toBe(
      '91d4e271f6168503e5174aaea3586d9ed94b89d216493b393d7d70acfdc48992',
    );
    expect(subkey(KEY, 'rj/hub-proof').toString('hex')).toBe(
      '51bcb2be05ef7b4949ce8e7c25728f0b5ac423e0601f11c278809462036ba8a3',
    );
    expect(subkey(KEY, 'rj/wrap').toString('hex')).toBe(
      'b96b00199bcf52310184856c923df51a8d8daf821832c1cf1a637b94d01c7b89',
    );
    // Independent recomputation with node:crypto directly.
    const raw = Buffer.from(
      hkdfSync('sha256', Buffer.from(KEY, 'base64'), Buffer.alloc(0), 'rj/beacon', 32),
    );
    expect(subkey(KEY, 'rj/beacon').equals(raw)).toBe(true);
  });

  it('hmacProof is base64url HMAC-SHA256 over the parts joined with "|"', () => {
    const sub = subkey(KEY, 'rj/player-proof');
    const proof = hmacProof(sub, ['join', 'dev-1', 'hub-1', 'np', '192.168.1.5', 8080]);
    expect(proof).toBe('9KG44LbsfwW-OKh7hVMBcC-v6Uuf6SARwHOz6iz3Lj0');
    expect(proof).toBe(
      createHmac('sha256', sub).update('join|dev-1|hub-1|np|192.168.1.5|8080').digest('base64url'),
    );
  });

  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('signs beacons over the canonical JSON of the other fields', () => {
    const key = subkey(KEY, 'rj/beacon');
    const beacon = signBeacon(unsigned, key);
    expect(beacon.sig).toBe('Jl41B4muKVTK-QaFoK-9xRruIz_sCp406ovO5WnYzjc');
    // Field order does not matter.
    const reordered = Object.fromEntries(Object.entries(unsigned).reverse()) as BeaconUnsigned;
    expect(signBeacon(reordered, key).sig).toBe(beacon.sig);
  });

  it('verifies beacons: signature, tamper, wrong key, source address, (bootId, counter) replay', () => {
    const key = subkey(KEY, 'rj/beacon');
    const b1 = signBeacon(unsigned, key);
    const src = '192.168.1.5';
    const seen = (bootId?: string, counter = 0): BeaconLastSeen =>
      new Map(bootId === undefined ? [] : [['hub-1', { bootId, counter }]]);
    expect(verifyBeacon(b1, key, seen(), src)).toMatchObject({ ok: true });
    expect(verifyBeacon({ ...b1, roomName: 'Attic' }, key, seen(), src)).toEqual({
      ok: false,
      reason: 'bad-sig',
    });
    expect(verifyBeacon(b1, subkey(OTHER_KEY, 'rj/beacon'), seen(), src)).toEqual({
      ok: false,
      reason: 'bad-sig',
    });
    expect(verifyBeacon(b1, key, seen(), '192.168.1.66')).toEqual({
      ok: false,
      reason: 'address-mismatch',
    });
    expect(verifyBeacon(b1, key, seen('boot-1', 1), src)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyBeacon(b1, key, seen('boot-1', 0), src)).toMatchObject({ ok: true });
    // A restarted hub (new bootId) counts from 1 again and is accepted.
    expect(verifyBeacon(b1, key, seen('boot-0', 999), src)).toMatchObject({ ok: true });
    // Accepting records the pair.
    const last = seen();
    verifyBeacon(b1, key, last, src);
    expect(last.get('hub-1')).toEqual({ bootId: 'boot-1', counter: 1 });
  });
});

describe('hub directory', () => {
  const beaconKey = subkey(KEY, 'rj/beacon');
  const beacon = (patch: Partial<BeaconUnsigned> = {}, key = beaconKey) =>
    signBeacon({ ...unsigned, ...patch }, key);

  it('lists a hub once it is verified, dedupes by hubId and drops replays', () => {
    let t = 1000;
    const dir = new HubDirectory(
      () => beaconKey,
      () => t,
    );
    expect(dir.accept(beacon(), '192.168.1.5')).toMatchObject({ ok: true });
    expect(dir.accept(beacon(), '192.168.1.5')).toEqual({ ok: false, reason: 'replay' });
    t = 3000;
    expect(dir.accept(beacon({ counter: 2 }), '192.168.1.5')).toMatchObject({ ok: true });
    const list = dir.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      hubId: 'hub-1',
      roomName: 'Basement',
      address: '192.168.1.5',
      port: 8080,
      hubEpoch: 1,
      lastSeen: 3000,
      verified: true,
    });
  });

  it('ignores unsigned, badly signed, foreign-household and address-spoofed beacons', () => {
    const dir = new HubDirectory(() => beaconKey);
    expect(dir.accept({ ...unsigned }, '192.168.1.5')).toEqual({ ok: false, reason: 'malformed' });
    expect(dir.accept({ ...beacon(), sig: 'x' }, '192.168.1.5')).toEqual({
      ok: false,
      reason: 'bad-sig',
    });
    expect(dir.accept(beacon({}, subkey(OTHER_KEY, 'rj/beacon')), '192.168.1.5')).toEqual({
      ok: false,
      reason: 'bad-sig',
    });
    expect(dir.accept(beacon(), '192.168.1.66')).toEqual({ ok: false, reason: 'address' });
    expect(dir.accept({ type: 'beacon', hubId: 'm0' }, '192.168.1.5')).toMatchObject({
      ok: false,
    });
    expect(dir.list()).toEqual([]);
  });

  it('expires hubs 30 s after the last beacon', () => {
    let t = 0;
    const dir = new HubDirectory(
      () => beaconKey,
      () => t,
    );
    dir.accept(beacon(), '192.168.1.5');
    dir.accept(beacon({ hubId: 'hub-2', address: '192.168.1.6' }), '192.168.1.6');
    t = 20_000;
    dir.accept(beacon({ hubId: 'hub-2', address: '192.168.1.6', counter: 2 }), '192.168.1.6');
    t = HUB_EXPIRY_MS;
    expect(dir.list().map((h) => h.hubId)).toEqual(['hub-2', 'hub-1']);
    t = HUB_EXPIRY_MS + 1;
    expect(dir.sweep()).toBe(true);
    expect(dir.list().map((h) => h.hubId)).toEqual(['hub-2']);
    expect(dir.sweep()).toBe(false);
  });

  it('unpaired: lists well-formed beacons as unverified, hides them once keyed', () => {
    let key: Buffer | null = null;
    const dir = new HubDirectory(() => key);
    expect(dir.accept(beacon(), '192.168.1.5')).toMatchObject({ ok: true });
    expect(dir.list()[0]).toMatchObject({ hubId: 'hub-1', verified: false });
    expect(dir.accept(beacon(), '192.168.1.5')).toEqual({ ok: false, reason: 'replay' });
    key = beaconKey;
    expect(dir.list()).toEqual([]);
    expect(dir.accept(beacon({ counter: 2 }), '192.168.1.5')).toMatchObject({ ok: true });
    expect(dir.list()[0]).toMatchObject({ verified: true });
  });
});

describe('pairing', () => {
  const nonceP = 'nonce-p';
  const reply = (patch: Partial<PairReply> = {}, address = '192.168.1.5', port = 8080) => {
    const base: PairReply = {
      ok: true,
      playerId: 'player-1',
      deviceToken: 'device-token',
      householdKey: KEY,
      hubId: 'hub-1',
      hubEpoch: 1,
      roomName: 'Basement',
      protocolVersion: 2,
      nonceH: 'nonce-h',
      proof: '',
      ...patch,
    };
    base.proof =
      patch.proof ??
      pairProof(base.householdKey, {
        hubId: base.hubId,
        deviceId: 'dev-1',
        nonceP,
        nonceH: base.nonceH,
        hub: { host: address, port },
      });
    return base;
  };
  const respond =
    (status: number, body: unknown, seen?: { url?: string; body?: unknown }): FetchFn =>
    (url, init) => {
      if (seen) {
        seen.url = url;
        seen.body = JSON.parse(String(init.body));
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
  const pair = (fetch: FetchFn, hubAddress = '192.168.1.5:8080') =>
    pairWithHub({
      hubAddress,
      password: 'pw',
      deviceName: 'Den laptop',
      deviceId: 'dev-1',
      nonceP,
      fetch,
    });

  it('normalises hub addresses', () => {
    expect(normalizeHubAddress('192.168.1.5')).toBe('http://192.168.1.5:8080');
    expect(normalizeHubAddress(' 192.168.1.5:8081 ')).toBe('http://192.168.1.5:8081');
    expect(normalizeHubAddress('http://jukebox.local:9000/')).toBe('http://jukebox.local:9000');
    expect(() => normalizeHubAddress('')).toThrow();
    expect(() => normalizeHubAddress('https://x')).toThrow();
    expect(() => normalizeHubAddress('http://x/admin')).toThrow();
  });

  it('accepts a reply whose proof verifies with the received key for the dialled address', async () => {
    const seen: { url?: string; body?: unknown } = {};
    const out = await pair(respond(200, reply(), seen));
    expect(out).toMatchObject({ ok: true, hubAddress: 'http://192.168.1.5:8080' });
    expect(seen.url).toBe('http://192.168.1.5:8080/api/pair');
    expect(seen.body).toEqual({
      password: 'pw',
      deviceName: 'Den laptop',
      deviceId: 'dev-1',
      nonceP,
    });
    if (out.ok) expect(out.protocolMismatch).toBe(false);
  });

  it('rejects a bad proof, a proof for another address or port, and another key', async () => {
    expect(await pair(respond(200, reply({ proof: 'forged' })))).toMatchObject({
      ok: false,
      code: 'bad-proof',
    });
    // The hub (or a relay) proved for a different address than the one we dialled.
    expect(await pair(respond(200, reply({}, '192.168.1.66')))).toMatchObject({
      ok: false,
      code: 'bad-proof',
    });
    expect(await pair(respond(200, reply({}, '192.168.1.5', 8081)))).toMatchObject({
      ok: false,
      code: 'bad-proof',
    });
    // Proof made with one key but a different key delivered.
    const good = reply();
    expect(await pair(respond(200, { ...good, householdKey: OTHER_KEY }))).toMatchObject({
      ok: false,
      code: 'bad-proof',
    });
  });

  it('maps errors to the web wizard codes: bad-password, login-throttled, bad-proof, unreachable', async () => {
    expect(await pair(respond(401, { error: { code: 'unauthorized' } }))).toMatchObject({
      ok: false,
      code: 'bad-password',
    });
    expect(await pair(respond(429, { error: { retryAfterSec: 42 } }))).toMatchObject({
      ok: false,
      code: 'login-throttled',
      retryAfterSec: 42,
      message: expect.stringContaining('42') as unknown,
    });
    expect(await pair(respond(200, { ok: true }))).toMatchObject({ ok: false, code: 'bad-proof' });
    expect(
      await pair(respond(403, { error: { code: 'not-household', message: 'Not on this Wi-Fi' } })),
    ).toMatchObject({ ok: false, code: 'bad-proof', message: 'Not on this Wi-Fi' });
    expect(await pair(() => Promise.reject(new Error('ECONNREFUSED')))).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
    expect(await pair(respond(200, reply()), 'ftp://x')).toMatchObject({
      ok: false,
      code: 'unreachable',
    });
  });

  it('flags a protocol mismatch without failing the pairing', async () => {
    const out = await pair(respond(200, reply({ protocolVersion: 3 })));
    expect(out).toMatchObject({ ok: true, protocolMismatch: true });
  });
});

describe('join proofs', () => {
  it('computes the player proof bound to the hub address and port', () => {
    const proof = playerAuthProof({
      householdKey: KEY,
      deviceId: 'dev-1',
      hubId: 'hub-1',
      hubAddress: 'http://192.168.1.5:8080',
      nonceP: 'np',
    });
    expect(proof).toBe('9KG44LbsfwW-OKh7hVMBcC-v6Uuf6SARwHOz6iz3Lj0');
    expect(
      playerAuthProof({
        householdKey: KEY,
        deviceId: 'dev-1',
        hubId: 'hub-1',
        hubAddress: 'http://192.168.1.5:8081',
        nonceP: 'np',
      }),
    ).not.toBe(proof);
    expect(hubEndpoint('http://localhost:8080')).toEqual({ host: 'localhost', port: 8080 });
  });

  it("the hub's own TV proves for its page origin, matching the server's joinProof", () => {
    const nonceP = 'np-local';
    const desktop = localPlayerAuthProof({
      householdKey: KEY,
      deviceId: 'tv-1',
      hubId: 'hub-1',
      pageOrigin: 'http://localhost:8080',
      nonceP,
    });
    const server = serverJoinProof(deriveKeys(KEY).playerProof, {
      deviceId: 'tv-1',
      hubId: 'hub-1',
      nonceP,
      hubAddress: 'localhost',
      hubPort: 8080,
    });
    expect(desktop).toBe(server);
    // The server's own helper (`app.jukebox.localPlayerAuth` formula) agrees for 127.0.0.1 too.
    expect(
      localPlayerAuthProof({
        householdKey: KEY,
        deviceId: 'tv-1',
        hubId: 'hub-1',
        pageOrigin: 'http://127.0.0.1:8080',
        nonceP,
      }),
    ).toBe(
      serverJoinProof(deriveKeys(KEY).playerProof, {
        deviceId: 'tv-1',
        hubId: 'hub-1',
        nonceP,
        hubAddress: '127.0.0.1',
        hubPort: 8080,
      }),
    );
  });

  it('pair and join-ack proofs match the server implementation', () => {
    const keys = deriveKeys(KEY);
    expect(
      pairProof(KEY, {
        hubId: 'hub-1',
        deviceId: 'dev-1',
        nonceP: 'np',
        nonceH: 'nh',
        hub: { host: '192.168.1.5', port: 8080 },
      }),
    ).toBe(
      serverPairProof(keys.hubProof, {
        hubId: 'hub-1',
        deviceId: 'dev-1',
        nonceP: 'np',
        nonceH: 'nh',
        hubAddress: '192.168.1.5',
        hubPort: 8080,
      }),
    );
    const ack = { hubId: 'hub-1', deviceId: 'dev-1', nonceP: 'np', nonceH: 'nh' };
    expect(joinAckProof(KEY, ack)).toBe(serverJoinAckProof(keys.hubProof, ack));
  });

  it('verifies authOk with the hub-proof subkey', () => {
    const p = { hubId: 'hub-1', deviceId: 'dev-1', nonceP: 'np', nonceH: 'nh' };
    const proof = joinAckProof(KEY, p);
    expect(proof).toBe(
      createHmac('sha256', subkey(KEY, 'rj/hub-proof'))
        .update('join-ack|hub-1|dev-1|np|nh')
        .digest('base64url'),
    );
    expect(verifyAuthOk({ householdKey: KEY, ...p, proof })).toBe(true);
    expect(verifyAuthOk({ householdKey: KEY, ...p, nonceH: 'other', proof })).toBe(false);
    expect(verifyAuthOk({ householdKey: OTHER_KEY, ...p, proof })).toBe(false);
    expect(verifyAuthOk({ householdKey: KEY, ...p, proof: 'x' })).toBe(false);
  });
});

describe('desktop-state M2 keys', () => {
  it('existing installs default to hub mode; player state round-trips sealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rj-m2-'));
    const legacy = join(dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ playerId: 'tv', updateMode: 'quiet' }));
    expect(loadState(legacy)).toMatchObject({ mode: 'hub', playerId: 'tv', updateMode: 'quiet' });
    writeFileSync(legacy, JSON.stringify({ mode: 'tv', linkState: 'split' }));
    const junk = loadState(legacy);
    expect(junk.mode).toBe('hub');
    expect('linkState' in junk).toBe(false);

    const file = join(dir, 'desktop-state.json');
    const before = loadState(file);
    saveState(file, {
      ...before,
      mode: 'player',
      deviceId: 'dev-1',
      hubAddress: 'http://192.168.1.5:8080',
      hubId: 'hub-1',
      hubEpoch: 1,
      roomName: 'Basement',
      deviceToken: sealSecret(fakeDpapi, 'device-secret'),
      householdKey: sealSecret(fakeDpapi, KEY),
      keyEpoch: 2,
      linkState: 'independent',
    });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('device-secret');
    expect(text).not.toContain(KEY);
    const back = loadState(file);
    expect(back).toMatchObject({
      mode: 'player',
      deviceId: 'dev-1',
      hubAddress: 'http://192.168.1.5:8080',
      keyEpoch: 2,
      linkState: 'independent',
    });
    expect(openSecret(fakeDpapi, back.deviceToken)).toBe('device-secret');
    expect(openSecret(fakeDpapi, back.householdKey)).toBe(KEY);
  });
});

const snapshot: ReplicaSnapshot = {
  settings: { roomName: 'Basement' },
  passwordVerifier: 'verifier-secret',
  householdKeyEpoch: 0,
  fallbackPlaylists: [],
  fallbackVideos: [],
  videos: [{ id: 'v1', title: 'Song' }],
  history: [],
  rooms: [],
  groups: [],
  players: [],
  quotaLog: [],
  searchUsage: [],
  queueEntries: [{ id: 'q1' }],
  tombstones: [{ table: 'history', id: 'h', deletedAt: 5 }],
  snapshotAt: 1_700_000_000_000,
  hubEpoch: 3,
};

describe('replica store', () => {
  it('round-trips a sealed snapshot atomically and reports its info', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rj-replica-')), 'sub', 'replica.json');
    expect(replicaInfo(file)).toBeNull();
    expect(readReplica(file, fakeDpapi)).toBeNull();
    const info = writeReplica(file, fakeDpapi, snapshot);
    expect(info).toMatchObject({ snapshotAt: snapshot.snapshotAt, hubEpoch: 3 });
    expect(replicaInfo(file)).toEqual(info);
    expect(readFileSync(file, 'utf8')).not.toContain('verifier-secret');
    expect(readReplica(file, fakeDpapi)).toEqual(snapshot);
    // Another Windows user cannot open it; a corrupt file reads as none.
    expect(
      readReplica(file, {
        ...fakeDpapi,
        decrypt: () => {
          throw new Error('x');
        },
      }),
    ).toBeNull();
    writeFileSync(file, '{oops');
    expect(replicaInfo(file)).toBeNull();
  });

  it('refuses snapshots that do not match the schema', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rj-replica-')), 'replica.json');
    expect(() => writeReplica(file, fakeDpapi, { ...snapshot, hubEpoch: -1 })).toThrow();
    expect(replicaInfo(file)).toBeNull();
  });
});

describe('player LAN listener (stub)', () => {
  const hub = {
    address: 'http://192.168.1.5:8080',
    epoch: 3,
    roomName: 'Basement',
    verified: true,
  };
  let close: (() => Promise<void>) | undefined;
  afterEach(() => close?.());

  it('serves /hub.json with open CORS once verified and redirects party paths', async () => {
    const view: { -readonly [K in keyof PlayerHubView]: PlayerHubView[K] } = {
      ...hub,
      verified: false,
    };
    const lan = startStubLan(view);
    close = lan.close;
    const port = 41000 + Math.floor(Math.random() * 2000);
    await lan.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/hub.json`)).status).toBe(503);
    view.verified = true;
    const res = await fetch(`${base}/hub.json`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({
      hubAddress: 'http://192.168.1.5:8080',
      hubEpoch: 3,
      protocolVersion: 2,
      roomName: 'Basement',
    });
    const r = await fetch(`${base}/r/g1?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://192.168.1.5:8080/r/g1?x=1');
    expect((await fetch(`${base}/tv`, { redirect: 'manual' })).status).toBe(404);
  });

  it('redirect targets and hub.json shape', () => {
    expect(redirectTarget(hub, '/')).toBe('http://192.168.1.5:8080/');
    expect(redirectTarget(hub, '/admin')).toBe('http://192.168.1.5:8080/admin');
    expect(redirectTarget(hub, '/administrator')).toBeNull();
    expect(redirectTarget(hub, '/api/state')).toBeNull();
    expect(hubJson(hub).protocolVersion).toBe(2);
  });

  it('uses buildApp player mode when it serves /hub.json, else falls back to the stub', async () => {
    const closed: string[] = [];
    const fake =
      (status: number, type = 'application/json; charset=utf-8') =>
      () =>
        Promise.resolve({
          inject: () => Promise.resolve({ statusCode: status, headers: { 'content-type': type } }),
          listen: () => Promise.resolve(),
          close: () => {
            closed.push(String(status));
            return Promise.resolve();
          },
        });
    const warn = () => undefined;
    expect((await startPlayerLan({ hub, build: fake(200), warn })).kind).toBe('server');
    expect((await startPlayerLan({ hub, build: fake(503), warn })).kind).toBe('server');
    expect((await startPlayerLan({ hub, build: fake(404), warn })).kind).toBe('stub');
    // A full hub's SPA fallback answers 200 text/html: not player mode.
    expect((await startPlayerLan({ hub, build: fake(200, 'text/html'), warn })).kind).toBe('stub');
    expect(closed).toEqual(['404', '200']);
    const failing = () => Promise.reject(new Error('boom'));
    expect((await startPlayerLan({ hub, build: failing, warn })).kind).toBe('stub');
  });
  it("the server's player mode is used and its /hub.json follows the view's verified flag", async () => {
    const view: { -readonly [K in keyof PlayerHubView]: PlayerHubView[K] } = {
      ...hub,
      verified: false,
    };
    const warnings: string[] = [];
    const lan = await startPlayerLan({
      hub: view,
      build: (o) => buildApp(o),
      warn: (m) => warnings.push(m),
    });
    expect(lan.kind).toBe('server');
    expect(warnings).toEqual([]);
    close = lan.close;
    const port = 43000 + Math.floor(Math.random() * 2000);
    await lan.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const before = await fetch(`${base}/hub.json`);
    expect(before.status).toBe(503);
    expect(before.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${base}/`, { redirect: 'manual' })).status).toBe(503);
    view.verified = true;
    view.roomName = 'Den';
    const after = await fetch(`${base}/hub.json`);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      hubAddress: 'http://192.168.1.5:8080',
      hubEpoch: 3,
      protocolVersion: 2,
      roomName: 'Den',
    });
    const r = await fetch(`${base}/r/g1?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://192.168.1.5:8080/r/g1?x=1');
  });
});
