import { describe, expect, it } from 'vitest';
import {
  BeaconSchema,
  HubChallengeBodySchema,
  HubJsonSchema,
  HouseholdSubkeysSchema,
  LinkReplySchema,
  LinkStateSchema,
  M2_PROTOCOL_VERSION,
  M2ClientMessageSchema,
  M2ServerMessageSchema,
  PairBodySchema,
  PairReplySchema,
  ReplicaSnapshotSchema,
  RoomsReplySchema,
} from './index.ts';

const key = 'A'.repeat(43) + '=';
const beacon = {
  v: 2,
  hubId: 'h1',
  hubEpoch: 1,
  keyEpoch: 0,
  roomName: 'Den',
  address: '192.168.1.5',
  port: 8765,
  version: '0.1.0',
  protocolVersion: 2,
  bootId: 'b1',
  counter: 1,
  sig: 'abc',
};
const snapshot = {
  settings: {},
  passwordVerifier: 'x',
  householdKeyEpoch: 0,
  fallbackPlaylists: [],
  fallbackVideos: [],
  videos: [],
  history: [],
  rooms: [],
  groups: [],
  players: [],
  quotaLog: [],
  searchUsage: [],
  queueEntries: [],
  tombstones: [{ table: 'history', id: 'h', deletedAt: 5 }],
  snapshotAt: 10,
  hubEpoch: 1,
};

describe('m2 schemas', () => {
  it('protocol version', () => expect(M2_PROTOCOL_VERSION).toBe(2));

  it('pairing', () => {
    expect(
      PairBodySchema.safeParse({ password: 'p', deviceName: 'n', deviceId: 'd', nonceP: 'x' })
        .success,
    ).toBe(true);
    expect(PairBodySchema.safeParse({ password: 'p' }).success).toBe(false);
    const reply = {
      ok: true,
      playerId: 'p',
      deviceToken: 't',
      householdKey: key,
      hubId: 'h',
      hubEpoch: 1,
      roomName: 'r',
      protocolVersion: 2,
      nonceH: 'n',
      proof: 'x',
    };
    expect(PairReplySchema.safeParse(reply).success).toBe(true);
    expect(PairReplySchema.safeParse({ ...reply, householdKey: 'short' }).success).toBe(false);
    expect(PairReplySchema.safeParse({ ...reply, keyEpoch: 3 }).success).toBe(true);
    expect(PairReplySchema.safeParse({ ...reply, keyEpoch: -1 }).success).toBe(false);
    expect(HouseholdSubkeysSchema.safeParse('rj/wrap').success).toBe(true);
    expect(HouseholdSubkeysSchema.safeParse('rj/other').success).toBe(false);
  });

  it('beacon', () => {
    expect(BeaconSchema.safeParse(beacon).success).toBe(true);
    expect(BeaconSchema.safeParse({ ...beacon, v: 1 }).success).toBe(false);
  });

  it('ws', () => {
    expect(
      M2ClientMessageSchema.safeParse({ type: 'auth', deviceId: 'd', nonceP: 'n', proof: 'p' })
        .success,
    ).toBe(true);
    expect(M2ClientMessageSchema.safeParse({ type: 'ping', t0: 1 }).success).toBe(true);
    expect(M2ClientMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(
      M2ServerMessageSchema.safeParse({ type: 'rekey', householdKey: key, keyEpoch: 1 }).success,
    ).toBe(true);
    expect(M2ServerMessageSchema.safeParse({ type: 'bye', reason: 'x' }).success).toBe(true);
    expect(M2ServerMessageSchema.safeParse({ type: 'replica', snapshot }).success).toBe(true);
    expect(M2ServerMessageSchema.safeParse({ type: 'replicaDelta', changes: [] }).success).toBe(
      true,
    );
    expect(M2ServerMessageSchema.safeParse({ type: 'authOk', nonceH: 'n' }).success).toBe(false);
    expect(M2ServerMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('rooms', () => {
    expect(LinkStateSchema.safeParse('linked').success).toBe(true);
    expect(LinkStateSchema.safeParse('split').success).toBe(false);
    const room = {
      deviceId: 'd',
      name: 'n',
      groupId: 'g',
      linkState: 'independent',
      lanAddress: null,
      lastSeen: 1,
    };
    expect(
      RoomsReplySchema.safeParse({
        rooms: [room],
        groups: [{ groupId: 'g', name: 'Main', leaderDeviceId: null }],
      }).success,
    ).toBe(true);
    expect(
      RoomsReplySchema.safeParse({ rooms: [{ ...room, linkState: 'x' }], groups: [] }).success,
    ).toBe(false);
    expect(LinkReplySchema.safeParse({ room, orphaned: [] }).success).toBe(true);
    expect(LinkReplySchema.safeParse({ orphaned: [] }).success).toBe(false);
  });

  it('replica', () => {
    expect(ReplicaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      ReplicaSnapshotSchema.safeParse({ ...snapshot, tombstones: [{ table: 't' }] }).success,
    ).toBe(false);
  });

  it('replicaAck is a client message', () => {
    expect(M2ClientMessageSchema.safeParse({ type: 'replicaAck', snapshotAt: 10 }).success).toBe(
      true,
    );
    expect(M2ClientMessageSchema.safeParse({ type: 'replicaAck' }).success).toBe(false);
  });

  it('hub', () => {
    expect(HubChallengeBodySchema.safeParse({ hubId: 'h', nonce: 'n' }).success).toBe(true);
    expect(HubChallengeBodySchema.safeParse({ hubId: 'h' }).success).toBe(false);
    expect(
      HubJsonSchema.safeParse({ hubAddress: 'a', hubEpoch: 1, protocolVersion: 2, roomName: 'r' })
        .success,
    ).toBe(true);
    expect(HubJsonSchema.safeParse({ hubAddress: 'a' }).success).toBe(false);
  });
});
