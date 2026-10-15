import { describe, expect, it, vi } from 'vitest';
import { buildAnswers, mdnsNames, startMdns } from '../src/mdns';
import type { MdnsSocket } from '../src/mdns';

describe('mdnsNames', () => {
  it('always has jukebox.local and adds the friendly host only when it ends in .local', () => {
    expect(mdnsNames(null)).toEqual(['jukebox.local']);
    expect(mdnsNames('jukebox.home')).toEqual(['jukebox.local']);
    expect(mdnsNames('party.local')).toEqual(['jukebox.local', 'party.local']);
    expect(mdnsNames('jukebox.local')).toEqual(['jukebox.local']);
  });
});

describe('buildAnswers', () => {
  const names = ['jukebox.local', 'party.local'];
  it('answers A and ANY questions for our names, case-insensitively', () => {
    const answers = buildAnswers(
      [
        { name: 'Jukebox.LOCAL', type: 'A' },
        { name: 'party.local', type: 'ANY' },
      ],
      names,
      '192.168.1.20',
    );
    expect(answers).toEqual([
      { name: 'Jukebox.LOCAL', type: 'A', ttl: 120, data: '192.168.1.20', flush: true },
      { name: 'party.local', type: 'A', ttl: 120, data: '192.168.1.20', flush: true },
    ]);
  });
  it('ignores other names, other record types and duplicates', () => {
    expect(buildAnswers([{ name: 'printer.local', type: 'A' }], names, '1.2.3.4')).toEqual([]);
    expect(buildAnswers([{ name: 'jukebox.local', type: 'AAAA' }], names, '1.2.3.4')).toEqual([]);
    expect(
      buildAnswers(
        [
          { name: 'jukebox.local', type: 'A' },
          { name: 'jukebox.local', type: 'ANY' },
        ],
        names,
        '1.2.3.4',
      ),
    ).toHaveLength(1);
  });
});

describe('startMdns', () => {
  function fakeSocket() {
    let onQuery: ((q: { questions: { name: string; type: string }[] }) => void) | null = null;
    const socket = {
      on: vi.fn((event: string, cb: unknown) => {
        if (event === 'query') onQuery = cb as typeof onQuery;
      }),
      respond: vi.fn(),
      destroy: vi.fn(),
    };
    return {
      socket: socket as unknown as MdnsSocket,
      raw: socket,
      query: (q: never) => onQuery?.(q),
    };
  }

  it('responds to matching queries, logs once, and destroys the socket on stop', () => {
    const f = fakeSocket();
    const log = { info: vi.fn(), warn: vi.fn() };
    let friendly: string | null = null;
    const m = startMdns({
      socket: f.socket,
      address: () => '192.168.1.20',
      friendlyHost: () => friendly,
      log,
    });
    expect(log.info).toHaveBeenCalledTimes(1);
    f.query({ questions: [{ name: 'jukebox.local', type: 'A' }] } as never);
    expect(f.raw.respond).toHaveBeenCalledWith({
      answers: [{ name: 'jukebox.local', type: 'A', ttl: 120, data: '192.168.1.20', flush: true }],
    });
    f.query({ questions: [{ name: 'party.local', type: 'A' }] } as never);
    expect(f.raw.respond).toHaveBeenCalledTimes(1);
    friendly = 'party.local';
    f.query({ questions: [{ name: 'party.local', type: 'A' }] } as never);
    expect(f.raw.respond).toHaveBeenCalledTimes(2);
    m.stop();
    expect(f.raw.destroy).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
