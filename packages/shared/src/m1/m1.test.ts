import { describe, expect, it } from 'vitest';
import {
  AdminStateSchema,
  ClientMessageSchema,
  EntryAdminSchema,
  EntryPublicSchema,
  GuestStateSchema,
  HelloBodySchema,
  M1_PROTOCOL_VERSION,
  PlayerStateSchema,
  RequestReplySchema,
  SearchBodySchema,
  ServerMessageSchema,
  SettingsPatchSchema,
  SetupBodySchema,
} from './index.ts';

const entry = {
  id: 'e1',
  videoId: 'dQw4w9WgXcQ',
  title: 'Song',
  requesterName: null,
  source: 'request' as const,
  status: 'queued' as const,
  enqueuedAt: 1000,
};
const playback = { state: 'idle' as const, nowPlaying: null };
const guestState = {
  revision: 1,
  changeSeq: 2,
  serverTime: 3,
  protocolVersion: M1_PROTOCOL_VERSION,
  roomName: 'Room',
  playback,
  queue: [entry],
  recentHistory: [],
  search: { enabled: true, remaining: 5, low: false },
  limits: { maxPendingPerGuest: 5, cooldownSec: 5, maxDurationSec: 480, allowDuplicates: true },
  flags: { hasApiKey: true, publicMode: false },
};
const settings = {
  roomName: 'Room',
  lanPort: 8080,
  country: 'US',
  limits: {
    maxPendingPerGuest: 5,
    cooldownSec: 5,
    allowDuplicates: true,
    maxDurationSec: 480,
    search: {
      perGuestPerDay: 10,
      perGuestIntervalSec: 15,
      perIpPerDay: 10,
      publicPerDay: 20,
      ownerReserve: 20,
      dailyTotal: 100,
    },
  },
  fallbackPlaylists: [],
  wifi: null,
  hasWifiPassword: false,
  hasApiKey: false,
  apiKeyLast4: null,
  tvDisplayId: null,
  autoStart: true,
  autoFullscreen: true,
  kiosk: false,
  publicMode: false,
  hubId: 'hub',
  hubEpoch: 1,
  friendlyHost: null,
};

describe('entries', () => {
  it('parses EntryPublic with mine optional', () => {
    expect(EntryPublicSchema.safeParse(entry).success).toBe(true);
    expect(EntryPublicSchema.safeParse({ ...entry, mine: true }).success).toBe(true);
  });
  it('rejects a bad status', () => {
    expect(EntryPublicSchema.safeParse({ ...entry, status: 'bogus' }).success).toBe(false);
  });
  it('EntryAdmin requires nullable requesterGuestId', () => {
    expect(EntryAdminSchema.safeParse({ ...entry, requesterGuestId: null }).success).toBe(true);
    expect(EntryAdminSchema.safeParse(entry).success).toBe(false);
  });
});

describe('state', () => {
  it('parses guest, admin and player states', () => {
    expect(GuestStateSchema.safeParse(guestState).success).toBe(true);
    const admin = {
      ...guestState,
      queue: [{ ...entry, requesterGuestId: 'g' }],
      players: [],
      fallback: { playlists: [], poolSize: 0, consecutiveFailures: 0 },
      searchUsage: { guests: 1, owner: 2, resetsAt: 3 },
      settings,
      lastErrors: [],
    };
    expect(AdminStateSchema.safeParse(admin).success).toBe(true);
    const player = {
      revision: 1,
      changeSeq: 1,
      serverTime: 1,
      protocolVersion: 1,
      roomName: 'R',
      playback,
      upcoming: [],
      qr: { lanUrl: 'http://x', joinUrl: 'http://x', publicUrl: null, wifi: null, wifiSsid: null },
      partyCode: null,
      me: { playerId: 'p', role: 'leader' },
      status: 'online',
      lastError: null,
      selfTest: { autoplayBlocked: false },
    };
    expect(PlayerStateSchema.safeParse(player).success).toBe(true);
  });
  it('rejects an invalid guest state', () => {
    expect(GuestStateSchema.safeParse({ ...guestState, revision: -1 }).success).toBe(false);
  });
  it('SettingsPatch accepts a null API key', () => {
    expect(SettingsPatchSchema.safeParse({ youtubeApiKey: null }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ lanPort: 'x' }).success).toBe(false);
  });
  it('SettingsPatch search accepts a source or the legacy boolean', () => {
    expect(SettingsPatchSchema.parse({ search: { source: 'page' } }).search).toEqual({
      source: 'page',
    });
    expect(SettingsPatchSchema.parse({ search: { unofficialFallback: false } }).search).toEqual({
      unofficialFallback: false,
    });
    expect(SettingsPatchSchema.safeParse({ search: { source: 'web' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ search: {} }).success).toBe(false);
  });
  it('SettingsPublic search carries the source', () => {
    expect(
      AdminStateSchema.shape.settings.safeParse({ ...settings, search: { source: 'api-first' } })
        .success,
    ).toBe(true);
  });
});

describe('ws', () => {
  it('parses server and client messages', () => {
    expect(ServerMessageSchema.safeParse({ type: 'state', state: guestState }).success).toBe(true);
    expect(ServerMessageSchema.safeParse({ type: 'bye', reason: 'x' }).success).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ type: 'event', kind: 'ended', revision: 1 }).success,
    ).toBe(true);
  });
  it('rejects an unknown type', () => {
    expect(ServerMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
});

describe('api', () => {
  it('SetupBody validates password and notice', () => {
    const ok = { password: '12345678', roomName: 'R', noticeAccepted: true };
    expect(SetupBodySchema.safeParse(ok).success).toBe(true);
    expect(SetupBodySchema.safeParse({ ...ok, noticeAccepted: false }).success).toBe(false);
    expect(SetupBodySchema.safeParse({ ...ok, password: '1234567' }).success).toBe(false);
  });
  it('SearchBody trims and rejects empty', () => {
    expect(SearchBodySchema.parse({ q: '  hi  ' }).q).toBe('hi');
    expect(SearchBodySchema.safeParse({ q: '   ' }).success).toBe(false);
  });
  it('RequestReply and HelloBody', () => {
    expect(RequestReplySchema.safeParse({ entry, duplicate: false }).success).toBe(true);
    expect(RequestReplySchema.safeParse({ entry }).success).toBe(false);
    expect(HelloBodySchema.safeParse({}).success).toBe(true);
  });
});
