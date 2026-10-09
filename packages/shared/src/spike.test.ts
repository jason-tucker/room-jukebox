import { describe, expect, it } from 'vitest';
import {
  describeYouTubeError,
  PROTOCOL_VERSION,
  SPIKE_MATRIX,
  SpikeClientMessageSchema,
  SpikeServerMessageSchema,
} from './index.ts';

describe('spike protocol', () => {
  it('parses every client message type', () => {
    const msgs = [
      { type: 'hello', playerId: 'p1', name: 'Living room' },
      { type: 'position', playerId: 'p1', position: 12.3, playerState: 1, revision: 4 },
      { type: 'event', playerId: 'p1', kind: 'error', code: 150, revision: 4 },
      { type: 'event', playerId: 'p1', kind: 'ended', revision: 4 },
      { type: 'ping', t0: 123 },
    ];
    for (const m of msgs) expect(SpikeClientMessageSchema.parse(m)).toEqual(m);
  });

  it('rejects unknown event kinds and message types', () => {
    expect(
      SpikeClientMessageSchema.safeParse({
        type: 'event',
        playerId: 'p',
        kind: 'skip',
        revision: 1,
      }).success,
    ).toBe(false);
    expect(SpikeClientMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('parses a state message', () => {
    const msg = {
      type: 'state',
      state: {
        revision: 2,
        serverTime: 1000,
        protocolVersion: PROTOCOL_VERSION,
        nowPlaying: {
          videoId: 'dQw4w9WgXcQ',
          startedAt: 0,
          pausedAt: null,
          accumulatedPauseMs: 0,
        },
        players: [
          {
            id: 'p1',
            name: 'tv',
            origin: 'http://127.0.0.1:5000',
            lastSeen: 900,
            position: 1,
            drift: 0.1,
            status: 'online',
            playingRevision: 2,
            lastError: null,
          },
        ],
        autoAdvance: true,
        errorStreak: 0,
      },
    };
    expect(SpikeServerMessageSchema.parse(msg)).toEqual(msg);
  });

  it('has 20 matrix entries with unique IDs and both expectations', () => {
    expect(SPIKE_MATRIX).toHaveLength(20);
    expect(new Set(SPIKE_MATRIX.map((e) => e.videoId)).size).toBe(20);
    expect(SPIKE_MATRIX.some((e) => e.expect === 'error')).toBe(true);
  });

  it('describes every gate (3) error code with a distinct sentence', () => {
    for (const code of [2, 5, 100, 101, 150, 153]) {
      expect(describeYouTubeError(code)).toContain(String(code));
    }
  });
});
