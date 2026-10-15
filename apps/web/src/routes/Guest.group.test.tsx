import type { GuestState } from '@room-jukebox/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../lib/api.ts';
import type * as WsModule from '../lib/ws.ts';
import { SessionClient } from '../lib/ws.ts';
import { FakeWebSocket } from '../test/fakeWs.ts';
import { guestState } from '../test/fixtures.ts';
import { callsTo, stubFetch } from '../test/stubFetch.ts';
import { Guest } from './Guest.tsx';

const h = vi.hoisted(() => ({
  state: null as GuestState | null,
  opts: [] as unknown[],
  request: vi.fn(),
}));

vi.mock('../lib/ws.ts', async (importOriginal) => {
  const real = await importOriginal<typeof WsModule>();
  return {
    ...real,
    useSessionState: (_role: string, opts: unknown) => {
      h.opts.push(opts);
      return { state: h.state, status: 'online', client: null };
    },
  };
});

vi.mock('../lib/api.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>();
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, status: 200, data });
  return {
    ...real,
    api: {
      ...real.api,
      guest: {
        ...real.api.guest,
        hello: () => ok({ guestId: 'g1', name: null, noticeAccepted: true }),
        notice: () => ok({ ok: true }),
        request: h.request,
      },
    },
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Guest />} />
        <Route path="/r/:groupId" element={<Guest />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/r/:groupId guest page', () => {
  beforeEach(() => {
    h.opts = [];
    h.state = guestState({ roomName: 'Den' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('binds the socket to the group and shows its room name', async () => {
    renderAt('/r/g-den');
    expect(await screen.findByRole('heading', { level: 1, name: 'Den' })).toBeInTheDocument();
    await waitFor(() =>
      expect(h.opts.at(-1)).toMatchObject({ enabled: true, query: { group: 'g-den' } }),
    );
  });

  it('/ stays on the main group (no group query)', async () => {
    h.state = guestState();
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Basement' })).toBeInTheDocument();
    await waitFor(() => expect(h.opts.at(-1)).toMatchObject({ enabled: true }));
    expect((h.opts.at(-1) as { query?: unknown }).query).toBeUndefined();
  });
});

describe('group-bound API calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('session and requests carry ?group=', async () => {
    const real = await vi.importActual<typeof ApiModule>('../lib/api.ts');
    const fetchMock = stubFetch({
      'GET /api/session?group=g-den': () => ({ body: guestState({ roomName: 'Den' }) }),
      'POST /api/requests?group=g-den': () => ({
        status: 409,
        body: { error: { code: 'duplicate', message: 'dup' } },
      }),
    });
    const s = await real.api.guest.session('g-den');
    expect(s.ok && s.data.roomName).toBe('Den');
    await real.api.guest.request({ videoId: 'v', idempotencyKey: 'k' }, 'g-den');
    expect(callsTo(fetchMock, 'POST /api/requests?group=g-den')).toHaveLength(1);
  });

  it('the guest socket asks for the group and resyncs from that group', async () => {
    FakeWebSocket.reset();
    const fetchMock = stubFetch({
      'GET /api/session?group=g-den': () => ({ body: guestState({ roomName: 'Den' }) }),
    });
    const client = new SessionClient({
      role: 'guest',
      query: { group: 'g-den' },
      origin: 'http://hub.test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });
    client.start();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.last().url).toBe('ws://hub.test/ws?role=guest&group=g-den');
    await waitFor(() => expect(callsTo(fetchMock, 'GET /api/session?group=g-den')).toHaveLength(1));
    await waitFor(() => expect(client.state?.roomName).toBe('Den'));
    act(() => client.stop());
  });
});
