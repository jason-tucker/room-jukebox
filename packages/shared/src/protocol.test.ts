import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SessionStateSchema } from './index.ts';

describe('SessionStateSchema', () => {
  it('parses a sample session state', () => {
    const sample = {
      revision: 3,
      serverTime: 1_760_000_000_000,
      protocolVersion: PROTOCOL_VERSION,
      nowPlaying: {
        videoId: 'dQw4w9WgXcQ',
        title: 'Sample track',
        startedAt: 1_760_000_000_000,
        pausedAt: null,
      },
      queue: [
        {
          id: 'q1',
          videoId: 'abc123def45',
          title: 'Next up',
          requester: 'Guest',
          source: 'request',
          status: 'queued',
        },
        {
          id: 'q2',
          videoId: 'zyx987wvu65',
          title: 'Fallback',
          requester: null,
          source: 'auto',
          status: 'queued',
        },
      ],
      players: [{ id: 'p1', name: 'Living room', lanAddress: '192.168.1.20', status: 'playing' }],
    };

    const parsed = SessionStateSchema.parse(sample);
    expect(parsed).toEqual(sample);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('rejects an unknown queue source', () => {
    const result = SessionStateSchema.safeParse({
      revision: 0,
      serverTime: 0,
      protocolVersion: 1,
      nowPlaying: null,
      queue: [
        { id: 'x', videoId: 'v', title: 't', requester: null, source: 'bogus', status: 'queued' },
      ],
      players: [],
    });
    expect(result.success).toBe(false);
  });
});
