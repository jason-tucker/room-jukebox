import {
  PairReplySchema,
  ReplicaSnapshotSchema,
  RoomsReplySchema,
  type BeaconUnsigned,
  type GuestState,
  type PlayerState,
  type ReplicaSnapshot,
} from '@room-jukebox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import {
  canonicalJson,
  deriveKeys,
  hmacProof,
  hubChallengeProof,
  joinAckProof,
  joinProof,
  newNonce,
  pairProof,
  signBeacon,
  subkey,
  unwrapSecret,
  verifyBeacon,
  verifyProof,
  wrapSecret,
  type BeaconLastSeen,
} from '../src/household.ts';
import type { ReplicaSettings } from '../src/replica.ts';
import { connectPlayer, connectWs, Guest, makeHub, setup, vid } from './helpers.ts';
import type { App, TestHub, WsClient } from './helpers.ts';

// Fixed household key: 32 bytes of 0x01 (same fixtures as apps/desktop/test/m2.test.ts).
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');

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

describe('household crypto (fixed-key fixtures shared with the desktop)', () => {
  it('derives the four HKDF-SHA256 subkeys', () => {
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
  });

  it('reproduces the desktop join proof and beacon signature', () => {
    const keys = deriveKeys(KEY);
    expect(hmacProof(keys.playerProof, ['join', 'dev-1', 'hub-1', 'np', '192.168.1.5', 8080])).toBe(
      '9KG44LbsfwW-OKh7hVMBcC-v6Uuf6SARwHOz6iz3Lj0',
    );
    expect(
      joinProof(keys.playerProof, {
        deviceId: 'dev-1',
        hubId: 'hub-1',
        nonceP: 'np',
        hubAddress: '192.168.1.5',
        hubPort: 8080,
      }),
    ).toBe('9KG44LbsfwW-OKh7hVMBcC-v6Uuf6SARwHOz6iz3Lj0');
    const b = signBeacon(unsigned, keys.beacon);
    expect(b.sig).toBe('Jl41B4muKVTK-QaFoK-9xRruIz_sCp406ovO5WnYzjc');
    const reordered = Object.fromEntries(Object.entries(unsigned).reverse()) as BeaconUnsigned;
    expect(signBeacon(reordered, keys.beacon).sig).toBe(b.sig);
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}',
    );
  });

  it('labels keep proofs apart; "|" in a part is refused', () => {
    const k = deriveKeys(KEY).hubProof;
    const ack = joinAckProof(k, { hubId: 'h', deviceId: 'd', nonceP: 'n', nonceH: 'm' });
    expect(verifyProof(k, ['join-ack', 'h', 'd', 'n', 'm'], ack)).toBe(true);
    expect(verifyProof(k, ['join', 'h', 'd', 'n', 'm'], ack)).toBe(false);
    expect(() => hmacProof(k, ['a|b'])).toThrow();
    expect(verifyProof(k, ['a|b'], 'x')).toBe(false);
  });

  it('wraps secrets with AES-256-GCM under the wrap subkey', () => {
    const wrap = deriveKeys(KEY).wrap;
    const w = wrapSecret(wrap, 'AIza-secret');
    expect(w).not.toContain('AIza');
    expect(wrapSecret(wrap, 'AIza-secret')).not.toBe(w);
    expect(unwrapSecret(wrap, w)).toBe('AIza-secret');
    expect(() => unwrapSecret(deriveKeys(OTHER_KEY).wrap, w)).toThrow();
    const tampered = Buffer.from(w, 'base64');
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
    expect(() => unwrapSecret(wrap, tampered.toString('base64'))).toThrow();
  });

  it('verifies beacons: sig, tamper, wrong key, address, replay, restart', () => {
    const key = deriveKeys(KEY).beacon;
    const seen: BeaconLastSeen = new Map();
    const b1 = signBeacon(unsigned, key);
    expect(verifyBeacon({ ...unsigned }, key, seen, '192.168.1.5')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyBeacon({ ...b1, roomName: 'Attic' }, key, seen, '192.168.1.5')).toMatchObject({
      reason: 'bad-sig',
    });
    expect(verifyBeacon(b1, deriveKeys(OTHER_KEY).beacon, seen, '192.168.1.5')).toMatchObject({
      reason: 'bad-sig',
    });
    expect(verifyBeacon(b1, key, seen, '192.168.1.66')).toMatchObject({
      reason: 'address-mismatch',
    });
    expect(verifyBeacon(b1, key, seen, '192.168.1.5')).toMatchObject({ ok: true });
    // replay of the same (bootId, counter) and an older counter
    expect(verifyBeacon(b1, key, seen, '192.168.1.5')).toMatchObject({ reason: 'replay' });
    const b2 = signBeacon({ ...unsigned, counter: 2 }, key);
    expect(verifyBeacon(b2, key, seen, '192.168.1.5')).toMatchObject({ ok: true });
    expect(verifyBeacon(b1, key, seen, '192.168.1.5')).toMatchObject({ reason: 'replay' });
    // a restarted hub (new bootId) counts from 1 again
    const r1 = signBeacon({ ...unsigned, bootId: 'boot-2', counter: 1 }, key);
    expect(verifyBeacon(r1, key, seen, '192.168.1.5')).toMatchObject({ ok: true });
    expect(seen.get('hub-1')).toEqual({ bootId: 'boot-2', counter: 1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Integration

const HUB_HOST = '192.168.1.20:8080';
const REMOTE_IP = '192.168.1.60';

let hub: TestHub;
let creds: Awaited<ReturnType<typeof setup>>;

const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  hub.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${creds.token}` },
    ...(payload ? { payload } : {}),
  });

interface Paired {
  deviceId: string;
  deviceToken: string;
  householdKey: string;
  hubId: string;
  keyEpoch: number;
}

async function pair(
  app: App,
  deviceId: string,
  opts: { password?: string; ip?: string; host?: string; nonceP?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/pair',
    remoteAddress: opts.ip ?? REMOTE_IP,
    headers: { host: opts.host ?? HUB_HOST },
    payload: {
      password: opts.password ?? 'correct horse',
      deviceName: `Room ${deviceId}`,
      deviceId,
      nonceP: opts.nonceP ?? 'np-1',
    },
  });
}

async function paired(deviceId: string): Promise<Paired> {
  const res = await pair(hub.app, deviceId);
  expect(res.statusCode).toBe(200);
  const body = res.json() as Omit<Paired, 'deviceId'> & { playerId: string };
  return { ...body, deviceId: body.playerId };
}

type AnyMsg = { type: string } & Record<string, unknown>;

async function waitFor(c: WsClient, type: string, ms = 3000): Promise<AnyMsg> {
  const deadline = Date.now() + ms;
  for (;;) {
    const msgs = c.messages as unknown as AnyMsg[];
    const i = msgs.findIndex((m) => m.type === type);
    if (i >= 0) return msgs.splice(0, i + 1).pop() as AnyMsg;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${type}: ${JSON.stringify(msgs.map((m) => m.type))}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Opens a remote player socket and sends `auth` (a proof for `host`, under `key`). */
async function remote(
  p: Paired,
  opts: { key?: string; host?: string; proofHost?: string; nonceP?: string; proof?: string } = {},
): Promise<{ c: WsClient; nonceP: string }> {
  const host = opts.host ?? HUB_HOST;
  const c = await connectWs(
    hub.app,
    `/ws?role=player&player=${p.deviceId}&token=${p.deviceToken}`,
    { ip: REMOTE_IP, headers: { host } },
  );
  const nonceP = opts.nonceP ?? newNonce();
  const [hubAddress, port] = (opts.proofHost ?? host).split(':');
  const proof =
    opts.proof ??
    joinProof(deriveKeys(opts.key ?? p.householdKey).playerProof, {
      deviceId: p.deviceId,
      hubId: p.hubId,
      nonceP,
      hubAddress: hubAddress as string,
      hubPort: Number(port ?? 8080),
    });
  c.send({ type: 'auth', deviceId: p.deviceId, nonceP, proof });
  return { c, nonceP };
}

/** The newest `state` after every earlier message was processed. */
async function lastState(c: WsClient): Promise<PlayerState> {
  const t0 = Math.random();
  c.send({ type: 'ping', t0 });
  const all = c.messages as unknown as AnyMsg[];
  const deadline = Date.now() + 3000;
  while (!all.some((m) => m.type === 'pong' && m.t0 === t0)) {
    if (Date.now() > deadline) throw new Error('no pong');
    await new Promise((r) => setTimeout(r, 10));
  }
  const states = all.filter((m) => m.type === 'state');
  c.messages.length = 0;
  const last = states.at(-1);
  if (!last) throw new Error('no state');
  return last.state as PlayerState;
}

async function joined(p: Paired, key?: string): Promise<WsClient> {
  const { c } = await remote(p, key ? { key } : {});
  await waitFor(c, 'authOk');
  await waitFor(c, 'state');
  return c;
}

beforeEach(async () => {
  hub = await makeHub();
  for (let i = 1; i <= 9; i++) hub.yt.add({ id: vid(i), title: `Song ${i}` });
  creds = await setup(hub.app);
});
afterEach(async () => hub.close());

describe('pairing', () => {
  it('correct password → PairReply whose proof binds the key to the dialled address', async () => {
    const res = await pair(hub.app, 'laptop-1', { nonceP: 'np-x' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const reply = PairReplySchema.parse(body);
    expect(body.keyEpoch).toBe(0);
    expect(reply.householdKey).toBe(hub.app.jukebox.household()?.householdKey);
    expect(reply.playerId).toBe('laptop-1');
    expect(reply.protocolVersion).toBe(2);
    const hubKey = deriveKeys(reply.householdKey).hubProof;
    const input = {
      hubId: reply.hubId,
      deviceId: 'laptop-1',
      nonceP: 'np-x',
      nonceH: reply.nonceH,
      hubAddress: '192.168.1.20',
      hubPort: 8080,
    };
    expect(reply.proof).toBe(pairProof(hubKey, input));
    expect(reply.proof).not.toBe(pairProof(hubKey, { ...input, hubAddress: '192.168.1.21' }));
    expect(reply.proof).not.toBe(pairProof(hubKey, { ...input, hubPort: 8081 }));
    expect(reply.proof).not.toBe(pairProof(deriveKeys(OTHER_KEY).hubProof, input));
    // a different dialled host gives a different proof
    const other = (await pair(hub.app, 'laptop-1', { host: 'jukebox.local:9000' })).json();
    expect(other.proof).toBe(
      pairProof(deriveKeys(other.householdKey).hubProof, {
        ...input,
        nonceP: 'np-1',
        nonceH: other.nonceH,
        hubAddress: 'jukebox.local',
        hubPort: 9000,
      }),
    );
    // the device is a linked room of the main group
    const rooms = RoomsReplySchema.parse((await admin('GET', '/api/admin/rooms')).json());
    expect(rooms.rooms.find((r) => r.deviceId === 'laptop-1')).toMatchObject({
      groupId: 'main',
      linkState: 'linked',
    });
  });

  it('wrong password → 401, then throttled; outside the household → 403', async () => {
    const bad = await pair(hub.app, 'laptop-1', { password: 'wrong horse' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('bad-password');
    expect(JSON.stringify(bad.json())).not.toContain('householdKey');
    for (let i = 0; i < 5; i++) await pair(hub.app, 'laptop-1', { password: 'nope nope' });
    const throttled = await pair(hub.app, 'laptop-1');
    expect(throttled.statusCode).toBe(429);
    const outside = await pair(hub.app, 'laptop-2', { ip: '192.168.5.10' });
    expect(outside.statusCode).toBe(403);
    expect(hub.app.jukebox.groups.rooms().some((r) => r.deviceId === 'laptop-1')).toBe(false);
  });

  it('refuses the reserved local TV device ID', async () => {
    expect((await pair(hub.app, 'tv-evil')).statusCode).toBe(400);
  });
});

describe('player WebSocket auth', () => {
  it('happy path: authOk with a verifiable proof, then state', async () => {
    const p = await paired('laptop-1');
    const { c, nonceP } = await remote(p);
    const ok = await waitFor(c, 'authOk');
    expect(ok.proof).toBe(
      joinAckProof(deriveKeys(p.householdKey).hubProof, {
        hubId: p.hubId,
        deviceId: p.deviceId,
        nonceP,
        nonceH: ok.nonceH as string,
      }),
    );
    const st = (await waitFor(c, 'state')).state as PlayerState;
    expect(st.me.playerId).toBe('laptop-1');
    expect(st.protocolVersion).toBe(2);
    c.ws.terminate();
  });

  it('sends nothing before auth; a bad proof gets bye bad-proof', async () => {
    const p = await paired('laptop-1');
    const { c } = await remote(p, { proof: 'forged' });
    const bye = await waitFor(c, 'bye');
    expect(bye.reason).toBe('bad-proof');
    expect((c.messages as unknown as AnyMsg[]).some((m) => m.type === 'state')).toBe(false);
  });

  it('rejects proofs for another address/port, another key, reflected and replayed proofs', async () => {
    const p = await paired('laptop-1');
    const reasons: unknown[] = [];
    // proof for an address/port the player did not dial
    for (const proofHost of ['192.168.1.21:8080', '192.168.1.20:8081']) {
      const { c } = await remote(p, { proofHost });
      reasons.push((await waitFor(c, 'bye')).reason);
    }
    // another household
    {
      const { c } = await remote(p, { key: OTHER_KEY });
      reasons.push((await waitFor(c, 'bye')).reason);
    }
    // reflected: the hub's own join-ack / pair proofs presented as the player's proof
    const hubKey = deriveKeys(p.householdKey).hubProof;
    {
      const nonceP = 'n-reflect';
      const proof = joinAckProof(hubKey, {
        hubId: p.hubId,
        deviceId: p.deviceId,
        nonceP,
        nonceH: 'x',
      });
      const { c } = await remote(p, { nonceP, proof });
      reasons.push((await waitFor(c, 'bye')).reason);
    }
    {
      const proof = pairProof(hubKey, {
        hubId: p.hubId,
        deviceId: p.deviceId,
        nonceP: 'np-1',
        nonceH: 'x',
        hubAddress: '192.168.1.20',
        hubPort: 8080,
      });
      const { c } = await remote(p, { nonceP: 'np-1', proof });
      reasons.push((await waitFor(c, 'bye')).reason);
    }
    expect(reasons).toEqual(['bad-proof', 'bad-proof', 'bad-proof', 'bad-proof', 'bad-proof']);
    // a captured auth message works once only (after the failure backoff has passed)
    hub.clock.advance(60_000);
    const first = await remote(p, { nonceP: 'once' });
    await waitFor(first.c, 'authOk');
    const again = await remote(p, { nonceP: 'once' });
    expect((await waitFor(again.c, 'bye')).reason).toBe('bad-proof');
    first.c.ws.terminate();
  });

  it('throttles auth failures per source', async () => {
    const p = await paired('laptop-1');
    for (let i = 0; i < 5; i++) {
      const { c } = await remote(p, { proof: 'forged' });
      await waitFor(c, 'bye');
    }
    await expect(
      connectWs(hub.app, `/ws?role=player&player=${p.deviceId}&token=${p.deviceToken}`, {
        ip: REMOTE_IP,
        headers: { host: HUB_HOST },
      }),
    ).rejects.toThrow(/429/);
  });

  it("the hub's own TV proves for localhost on LAN_PORT", async () => {
    const tv = await connectPlayer(hub.app, creds.playerId, creds.playerToken, {
      host: 'localhost:8080',
    });
    const st = await tv.next('state');
    expect(st.state).toMatchObject({ me: { playerId: creds.playerId, role: 'leader' } });
    tv.ws.terminate();
  });
});

describe('revoke and rotation', () => {
  it('revoke: the device cannot re-auth and the other player gets rekey', async () => {
    const a = await paired('laptop-a');
    const b = await paired('laptop-b');
    const ca = await joined(a);
    const cb = await joined(b);
    const res = await admin('POST', '/api/admin/players/laptop-a/revoke');
    expect(res.json()).toEqual({ ok: true, keyEpoch: 1 });
    expect((await waitFor(ca, 'bye')).reason).toBe('revoked');
    expect((ca.messages as unknown as AnyMsg[]).some((m) => m.type === 'rekey')).toBe(false);
    const rekey = await waitFor(cb, 'rekey');
    const info = hub.app.jukebox.household();
    expect(rekey).toEqual({ type: 'rekey', householdKey: info?.householdKey, keyEpoch: 1 });
    expect(rekey.householdKey).not.toBe(b.householdKey);
    expect((await waitFor(cb, 'bye')).reason).toBe('rekey');
    // the revoked token is dead
    await expect(
      connectWs(hub.app, `/ws?role=player&player=${a.deviceId}&token=${a.deviceToken}`, {
        ip: REMOTE_IP,
        headers: { host: HUB_HOST },
      }),
    ).rejects.toThrow(/401/);
    // b: the old key no longer proves, the new one does
    const old = await remote(b);
    expect((await waitFor(old.c, 'bye')).reason).toBe('bad-proof');
    const fresh = await joined(b, rekey.householdKey as string);
    fresh.ws.terminate();
    expect(hub.app.jukebox.groups.rooms().some((r) => r.deviceId === 'laptop-a')).toBe(false);
    expect((await admin('POST', '/api/admin/players/laptop-a/revoke')).statusCode).toBe(404);
    expect((await admin('POST', `/api/admin/players/${creds.playerId}/revoke`)).statusCode).toBe(
      409,
    );
  });

  it('password change rotates the key and pushes rekey before invalidating sessions', async () => {
    const b = await paired('laptop-b');
    const cb = await joined(b);
    const res = await admin('POST', '/api/admin/password', {
      current: 'correct horse',
      next: 'battery staple',
    });
    expect(res.statusCode).toBe(200);
    const rekey = await waitFor(cb, 'rekey');
    expect(rekey.keyEpoch).toBe(1);
    expect(rekey.householdKey).toBe(hub.app.jukebox.household()?.householdKey);
    expect((await admin('GET', '/api/admin/session')).statusCode).toBe(401);
  });
});

describe('rooms and groups', () => {
  it('split gives the room its own session; link merges back and lists orphaned entries', async () => {
    const a = await paired('laptop-a');
    const ca = await joined(a);
    const split = await admin('POST', '/api/admin/rooms/laptop-a/split');
    expect(split.statusCode).toBe(200);
    const { room } = split.json();
    expect(room).toMatchObject({ linkState: 'independent' });
    const groupId = room.groupId as string;
    expect(groupId).not.toBe('main');

    // the room's player now follows its own group (QR to /r/<groupId>)
    const st = await lastState(ca);
    expect(st.qr.joinUrl).toBe(`http://192.168.1.20:8080/r/${groupId}`);
    expect(st.qr.lanUrl).toBe(`http://192.168.1.20:8080/r/${groupId}`);

    // per-group requests do not interfere
    const g = new Guest(hub.app);
    await g.hello('Ann');
    const r1 = await g.req({
      method: 'POST',
      url: '/api/requests',
      payload: { videoId: vid(1), idempotencyKey: 'k1', groupId },
    });
    expect(r1.statusCode).toBe(201);
    hub.clock.advance(6000);
    await g.req({
      method: 'POST',
      url: '/api/requests',
      payload: { videoId: vid(2), idempotencyKey: 'k2', groupId },
    });
    const own = hub.app.jukebox.groups.get(groupId);
    const main = hub.app.jukebox.session;
    expect(own?.liveEntries().map((e) => e.videoId)).toEqual([vid(1), vid(2)]);
    expect(main.liveEntries().some((e) => e.source === 'request')).toBe(false);
    const gs = (await g.req({ method: 'GET', url: `/api/session?group=${groupId}` })).json();
    expect((gs as GuestState).playback.nowPlaying?.videoId).toBe(vid(1));
    const ms = (await g.req({ method: 'GET', url: '/api/session' })).json() as GuestState;
    expect(ms.playback.nowPlaying?.videoId).not.toBe(vid(1));

    const rooms = RoomsReplySchema.parse((await admin('GET', '/api/admin/rooms')).json());
    expect(rooms.groups.map((x) => x.groupId)).toEqual(['main', groupId]);
    expect(rooms.groups[1]?.leaderDeviceId).toBe('laptop-a');

    // the player itself links back (device token)
    const link = await hub.app.inject({
      method: 'POST',
      url: '/api/rooms/me',
      remoteAddress: REMOTE_IP,
      headers: { authorization: `Bearer ${a.deviceToken}` },
      payload: { linkState: 'linked' },
    });
    expect(link.statusCode).toBe(200);
    const body = link.json();
    expect(body.room).toMatchObject({ groupId: 'main', linkState: 'linked' });
    expect(body.orphaned.map((e: { videoId: string }) => e.videoId)).toEqual([vid(1), vid(2)]);
    expect(body.orphaned[0].requesterGuestId).toBeTruthy();
    expect(hub.app.jukebox.groups.get(groupId)).toBeUndefined();
    // entries were not moved into the main group
    expect(main.liveEntries().some((e) => e.videoId === vid(1) && e.source === 'request')).toBe(
      false,
    );
    // the merged group's guests fall back to main
    const after = (await g.req({ method: 'GET', url: `/api/session?group=${groupId}` })).json();
    expect((after as GuestState).changeSeq).toBe(main.changeSeq);
    const st2 = await lastState(ca);
    expect(st2.qr.joinUrl).toBe('http://192.168.1.20:8080/');
    ca.ws.terminate();
  });

  it('remembers the link state across a re-pair; rooms/me needs a device token', async () => {
    await paired('laptop-a');
    await admin('POST', '/api/admin/rooms/laptop-a/split');
    const again = await paired('laptop-a');
    const room = hub.app.jukebox.groups.room(again.deviceId);
    expect(room?.linkState).toBe('independent');
    expect(room?.groupId).not.toBe('main');
    const bad = await hub.app.inject({
      method: 'POST',
      url: '/api/rooms/me',
      remoteAddress: REMOTE_IP,
      headers: { authorization: 'Bearer nope' },
      payload: { linkState: 'linked' },
    });
    expect(bad.statusCode).toBe(401);
    expect((await admin('POST', `/api/admin/rooms/${creds.playerId}/split`)).statusCode).toBe(409);
    expect((await admin('POST', '/api/admin/rooms/nobody/split')).statusCode).toBe(404);
  });

  it('survives a restart with per-group queues intact', async () => {
    await paired('laptop-a');
    const groupId = (await admin('POST', '/api/admin/rooms/laptop-a/split')).json().room.groupId;
    await admin('POST', `/api/admin/requests?group=${groupId}`, {
      videoId: vid(3),
      idempotencyKey: 'o3',
    });
    await admin('POST', '/api/admin/requests', { videoId: vid(4), idempotencyKey: 'o4' });
    const app = await hub.restart();
    expect(
      app.jukebox.groups
        .get(groupId)
        ?.liveEntries()
        .map((e) => e.videoId),
    ).toEqual([vid(3)]);
    expect(app.jukebox.session.liveEntries().map((e) => e.videoId)).toEqual([vid(4)]);
  });
});

describe('leader', () => {
  it('only the leader moves the queue; failover after 5 s of silence', async () => {
    const tv = await connectPlayer(hub.app, creds.playerId, creds.playerToken);
    await tv.next('state');
    hub.clock.advance(1000);
    const a = await paired('laptop-a');
    const ca = await joined(a);
    for (let i = 1; i <= 3; i++) {
      await admin('POST', '/api/admin/requests', { videoId: vid(i), idempotencyKey: `o${i}` });
    }
    const s = hub.app.jukebox.session;
    expect(s.leaderId()).toBe(creds.playerId);
    const rev = s.revision;
    // a follower's ended is ignored
    ca.send({ type: 'event', kind: 'ended', revision: rev });
    ca.send({ type: 'ping', t0: 1 });
    await waitFor(ca, 'pong');
    expect(s.revision).toBe(rev);

    // the TV goes silent; 6 s later laptop-a (still pinging) takes over
    hub.clock.advance(6000);
    ca.send({ type: 'ping', t0: 2 });
    await waitFor(ca, 'pong');
    hub.app.jukebox.groups.sweep();
    expect(s.leaderId()).toBe('laptop-a');
    const st = await lastState(ca);
    expect(st.me.role).toBe('leader');
    // a stale revision does nothing; the matching one advances once
    ca.send({ type: 'event', kind: 'ended', revision: rev - 1 });
    ca.send({ type: 'event', kind: 'ended', revision: rev });
    ca.send({ type: 'event', kind: 'ended', revision: rev });
    ca.send({ type: 'ping', t0: 3 });
    await waitFor(ca, 'pong');
    expect(s.revision).toBe(rev + 1);
    expect(s.state.nowPlaying?.videoId).toBe(vid(2));
    // the old leader's late report for the finished track cannot advance again
    tv.send({ type: 'event', kind: 'ended', revision: rev });
    tv.send({ type: 'ping', t0: 4 });
    await tv.next('pong');
    expect(s.revision).toBe(rev + 1);
    tv.ws.terminate();
    ca.ws.terminate();
  });
});

describe('replication', () => {
  it('sends wrapped snapshots to authenticated remote players; acks and tombstones', async () => {
    await admin('PATCH', '/api/admin/settings', { youtubeApiKey: 'AIzaSecretKey123' });
    const g = new Guest(hub.app);
    const { guestId } = await g.hello('Ann');
    await g.request(vid(1));
    const a = await paired('laptop-a');
    const ca = await joined(a);
    const msg = await waitFor(ca, 'replica');
    const text = JSON.stringify(msg);
    const snap: ReplicaSnapshot = ReplicaSnapshotSchema.parse(msg.snapshot);
    const key = hub.app.jukebox.household()?.householdKey as string;
    expect(text).not.toContain(key);
    expect(text).not.toContain('AIzaSecretKey123');
    expect(text).not.toContain(a.deviceToken);
    const settings = snap.settings as unknown as ReplicaSettings;
    expect(unwrapSecret(deriveKeys(key).wrap, settings.apiKeyWrapped as string)).toBe(
      'AIzaSecretKey123',
    );
    expect(snap.passwordVerifier).toMatch(/^scrypt\$/);
    expect(snap.householdKeyEpoch).toBe(0);
    expect(snap.players.map((p) => p.device_id)).toContain('laptop-a');
    expect(snap.players.every((p) => typeof p.token_hash === 'string')).toBe(true);
    expect(snap.queueEntries.map((e) => e.video_id)).toContain(vid(1));
    expect(snap.rooms.map((r) => r.device_id)).toContain('laptop-a');
    expect(snap.groups.map((x) => x.group_id)).toEqual(['main']);
    expect(snap.tombstones).toEqual([]);

    // a forgotten guest becomes a tombstone (until acknowledged)
    await g.req({ method: 'POST', url: '/api/guest/forget' });
    const next = ReplicaSnapshotSchema.parse((await waitFor(ca, 'replica')).snapshot);
    expect(next.tombstones).toEqual([{ table: 'guests', id: guestId, deletedAt: hub.clock.now }]);
    ca.send({ type: 'replicaAck', snapshotAt: next.snapshotAt + 1 });
    ca.send({ type: 'ping', t0: 1 });
    await waitFor(ca, 'pong');
    const status = (await admin('GET', '/api/admin/replica/status')).json();
    expect(status.lastSentAt).toBe(hub.clock.now);
    expect(status.bytes).toBeGreaterThan(100);
    expect(status.players).toEqual([{ deviceId: 'laptop-a', lastAckAt: hub.clock.now }]);
    await admin('POST', '/api/admin/transport', { action: 'pause', idempotencyKey: 'p1' });
    const third = ReplicaSnapshotSchema.parse((await waitFor(ca, 'replica')).snapshot);
    expect(third.tombstones).toEqual([]);
    ca.ws.terminate();
  });

  it('never sends replicas to the hub TV or unauthenticated sockets', async () => {
    const tv = await connectPlayer(hub.app, creds.playerId, creds.playerToken);
    const a = await paired('laptop-a');
    const { c } = await remote(a, { proof: 'forged' });
    await admin('POST', '/api/admin/requests', { videoId: vid(1), idempotencyKey: 'o1' });
    await new Promise((r) => setTimeout(r, 1300));
    for (const m of [...tv.messages, ...c.messages] as unknown as AnyMsg[]) {
      expect(m.type).not.toBe('replica');
    }
    tv.ws.terminate();
  });
});

describe('hub challenge and hub.json', () => {
  it('answers the challenge with the hub proof; household gate and rate limit', async () => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/hub/challenge',
      remoteAddress: REMOTE_IP,
      payload: { hubId: 'other-hub', nonce: 'n1' },
    });
    const info = hub.app.jukebox.household();
    expect(res.json()).toEqual({
      proof: hubChallengeProof(deriveKeys(info?.householdKey as string).hubProof, {
        theirHubId: 'other-hub',
        myHubId: info?.hubId as string,
        nonce: 'n1',
        epoch: info?.hubEpoch as number,
      }),
    });
    const outside = await hub.app.inject({
      method: 'POST',
      url: '/api/hub/challenge',
      remoteAddress: '192.168.5.10',
      payload: { hubId: 'x', nonce: 'n' },
    });
    expect(outside.statusCode).toBe(403);
    let last = 200;
    for (let i = 0; i < 25; i++) {
      last = (
        await hub.app.inject({
          method: 'POST',
          url: '/api/hub/challenge',
          remoteAddress: REMOTE_IP,
          payload: { hubId: 'other-hub', nonce: `n${i}` },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it('serves /hub.json with open CORS in hub mode', async () => {
    const res = await hub.app.inject({
      url: '/hub.json',
      headers: { origin: 'http://192.168.1.77:8080' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json()).toEqual({
      hubAddress: 'http://192.168.1.20:8080',
      hubEpoch: 1,
      protocolVersion: 2,
      roomName: 'Basement',
    });
  });

  it('household() is null before setup', async () => {
    const fresh = await makeHub();
    try {
      expect(fresh.app.jukebox.household()).toBeNull();
    } finally {
      await fresh.close();
    }
  });
});

describe('player mode', () => {
  it('registers only hub.json, healthz and redirects to the hub', async () => {
    const app = await buildApp({
      mode: 'player',
      hub: { address: '192.168.1.20:8080', epoch: 3, roomName: 'Basement' },
    });
    try {
      const j = await app.inject({ url: '/hub.json' });
      expect(j.headers['access-control-allow-origin']).toBe('*');
      expect(j.json()).toEqual({
        hubAddress: 'http://192.168.1.20:8080',
        hubEpoch: 3,
        protocolVersion: 2,
        roomName: 'Basement',
      });
      expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({
        ok: true,
        needsSetup: false,
      });
      for (const [url, to] of [
        ['/', 'http://192.168.1.20:8080/'],
        ['/r/g-1?x=1', 'http://192.168.1.20:8080/r/g-1?x=1'],
        ['/admin', 'http://192.168.1.20:8080/admin'],
      ] as const) {
        const r = await app.inject({ url });
        expect(r.statusCode).toBe(302);
        expect(r.headers.location).toBe(to);
      }
      for (const url of ['/api/session', '/api/admin/session', '/tv', '/ws']) {
        expect((await app.inject({ url })).statusCode).toBe(404);
      }
      expect((await app.inject({ method: 'POST', url: '/api/pair', payload: {} })).statusCode).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  });
});
