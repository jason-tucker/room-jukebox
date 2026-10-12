import type { EntryPublic, GuestState, PlayerState } from '@room-jukebox/shared';

export function entry(over: Partial<EntryPublic> = {}): EntryPublic {
  return {
    id: 'e1',
    videoId: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    durationSec: 213,
    requesterName: 'Sam',
    source: 'request',
    status: 'queued',
    enqueuedAt: 1,
    ...over,
  };
}

export function guestState(over: Partial<GuestState> = {}): GuestState {
  return {
    revision: 1,
    changeSeq: 1,
    serverTime: Date.now(),
    protocolVersion: 1,
    roomName: 'Basement',
    playback: { state: 'idle', nowPlaying: null },
    queue: [],
    recentHistory: [],
    search: { enabled: false, remaining: null, low: false },
    limits: { maxPendingPerGuest: 5, cooldownSec: 5, maxDurationSec: 480, allowDuplicates: true },
    flags: { hasApiKey: false, publicMode: false },
    ...over,
  };
}

export function playerState(over: Partial<PlayerState> = {}): PlayerState {
  return {
    revision: 2,
    changeSeq: 1,
    serverTime: Date.now(),
    protocolVersion: 1,
    roomName: 'Basement',
    playback: {
      state: 'playing',
      nowPlaying: {
        ...entry({ status: 'playing' }),
        startedAt: Date.now(),
        pausedAt: null,
        accumulatedPauseMs: 0,
      },
    },
    upcoming: [{ title: 'Uptown Funk', requesterName: 'Alex' }],
    qr: {
      lanUrl: 'http://192.168.1.20:8080/',
      publicUrl: null,
      wifi: 'WIFI:T:WPA;S:PartyNet;P:pw;;',
      wifiSsid: 'PartyNet',
    },
    partyCode: null,
    me: { playerId: 'tv', role: 'leader' },
    status: 'online',
    lastError: null,
    selfTest: { autoplayBlocked: false },
    ...over,
  };
}
