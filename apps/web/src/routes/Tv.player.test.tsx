import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JukeboxBridge } from '../lib/jukebox.ts';
import type * as YouTubeModule from '../lib/youtube.ts';
import type { PlayerHandlers } from '../lib/youtube.ts';
import { S } from '../strings.ts';
import { FakeWebSocket } from '../test/fakeWs.ts';
import { playerState } from '../test/fixtures.ts';
import { bodyOf, callsTo, stubFetch } from '../test/stubFetch.ts';
import { HUB_LOST_MS, Tv } from './Tv.tsx';

vi.mock('../lib/youtube.ts', async (importOriginal) => {
  const real = await importOriginal<typeof YouTubeModule>();
  return {
    ...real,
    createYouTubePlayer: (_el: HTMLElement, h: PlayerHandlers) => {
      setTimeout(() => h.onReady?.(), 0);
      return Promise.resolve({
        loadVideoById: vi.fn(),
        cueVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        stopVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: () => 0,
        getPlayerState: () => -1,
        getDuration: () => 213,
        destroy: vi.fn(),
      });
    },
  };
});

const HUB = 'http://192.168.1.20:8080';
const KEY = 'A'.repeat(43) + '=';
const m2State = (over: Parameters<typeof playerState>[0] = {}) =>
  playerState({ protocolVersion: 2, ...over });

function installBridge(over: Partial<JukeboxBridge> = {}) {
  const b = {
    playerAuth: vi.fn((nonceP: string) =>
      Promise.resolve({ deviceId: 'den', proof: `p:${nonceP}` }),
    ),
    localPlayerAuth: vi.fn((nonceP: string) =>
      Promise.resolve({ deviceId: 'hubtv', proof: `l:${nonceP}` }),
    ),
    verifyAuthOk: vi.fn((nonceP: string, nonceH: string, proof: string) =>
      Promise.resolve(proof === `h:${nonceP}:${nonceH}`),
    ),
    storeKey: vi.fn(),
    storeReplica: vi.fn(() => Promise.resolve()),
    setLinkState: vi.fn(),
    setHubAddress: vi.fn(),
    mode: vi.fn(() => ({ mode: 'player' as const })),
    ...over,
  };
  window.jukebox = b;
  return b;
}

function stubHub() {
  return stubFetch({
    [`GET ${HUB}/hub.json`]: () => ({
      body: { hubAddress: HUB, hubEpoch: 1, protocolVersion: 2, roomName: 'Basement' },
    }),
    [`POST ${HUB}/api/rooms/me`]: () => ({ body: { ok: true } }),
    'GET /api/version': () => ({ body: { version: '0.1.0', protocolVersion: 2 } }),
  });
}

/** Opens the socket and returns the `auth` message the page sent. */
async function openAndAuth(ws: FakeWebSocket) {
  act(() => ws.open());
  await waitFor(() =>
    expect(ws.sent.some((m) => (m as { type: string }).type === 'auth')).toBe(true),
  );
  return ws.sent.find((m) => (m as { type: string }).type === 'auth') as {
    type: 'auth';
    deviceId: string;
    nonceP: string;
    proof: string;
  };
}

/** Completes a good handshake and delivers `state`. */
async function joinHub(state = m2State()) {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  const ws = FakeWebSocket.last();
  const auth = await openAndAuth(ws);
  act(() => {
    ws.receive({ type: 'authOk', nonceH: 'nh1', proof: `h:${auth.nonceP}:nh1` });
    ws.receive({ type: 'state', state });
  });
  return { ws, auth };
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.history.replaceState(null, '', `/tv?mode=player&hub=${HUB}&player=den&token=tok`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.jukebox;
});

describe('/tv player mode handshake', () => {
  it('connects to the hub, sends auth first, and accepts state only after authOk verifies', async () => {
    const b = installBridge();
    stubHub();
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    expect(ws.url.startsWith('ws://192.168.1.20:8080/ws?')).toBe(true);
    expect(ws.url).toContain('role=player');
    expect(ws.url).toContain('player=den');
    const auth = await openAndAuth(ws);
    expect(ws.sent[0]).toEqual({
      type: 'auth',
      deviceId: 'den',
      nonceP: auth.nonceP,
      proof: `p:${auth.nonceP}`,
    });
    expect(b.playerAuth).toHaveBeenCalledWith(auth.nonceP);
    expect(b.localPlayerAuth).not.toHaveBeenCalled();

    // A state that arrives while authOk is being verified is held, not shown early.
    act(() => {
      ws.receive({ type: 'authOk', nonceH: 'nh1', proof: `h:${auth.nonceP}:nh1` });
      ws.receive({ type: 'state', state: m2State() });
    });
    expect(screen.getByText(S.tv.nothingPlaying)).toBeInTheDocument();
    expect(await screen.findByText('Never Gonna Give You Up')).toBeInTheDocument();
    expect(b.verifyAuthOk).toHaveBeenCalledWith(auth.nonceP, 'nh1', `h:${auth.nonceP}:nh1`);
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.pill.online);

    // rekey → storeKey; replica → storeReplica, then replicaAck.
    const snapshot = {
      settings: {},
      passwordVerifier: 'x',
      householdKeyEpoch: 1,
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
      tombstones: [],
      snapshotAt: 1234,
      hubEpoch: 1,
    };
    act(() => {
      ws.receive({ type: 'rekey', householdKey: KEY, keyEpoch: 3 });
      ws.receive({ type: 'replica', snapshot });
    });
    expect(b.storeKey).toHaveBeenCalledWith({ householdKey: KEY, keyEpoch: 3 });
    await waitFor(() => expect(ws.sent).toContainEqual({ type: 'replicaAck', snapshotAt: 1234 }));
    expect(b.storeReplica).toHaveBeenCalledWith(snapshot);
  });

  it('closes and says so when the hub fails verification', async () => {
    installBridge();
    stubHub();
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    const auth = await openAndAuth(ws);
    act(() => {
      ws.receive({ type: 'authOk', nonceH: 'nh1', proof: 'forged' });
      ws.receive({ type: 'state', state: m2State() });
    });
    expect(await screen.findByTestId('tv-auth-problem')).toHaveTextContent(S.tv.hubUnverified);
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.pill.unverified);
    expect(screen.queryByText('Never Gonna Give You Up')).toBeNull();
    expect(screen.queryByTestId('join-popup')).toBeNull();
    expect(auth.deviceId).toBe('den');
  });

  it('hub mode uses localPlayerAuth and goes to this origin', async () => {
    window.history.replaceState(null, '', '/tv?player=hubtv&token=t');
    const b = installBridge();
    stubHub();
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    expect(ws.url.startsWith(`ws://${window.location.host}/ws?`)).toBe(true);
    const auth = await openAndAuth(ws);
    expect(auth.deviceId).toBe('hubtv');
    expect(b.playerAuth).not.toHaveBeenCalled();
    act(() => {
      ws.receive({ type: 'authOk', nonceH: 'n', proof: `h:${auth.nonceP}:n` });
      ws.receive({ type: 'state', state: playerState() });
    });
    expect(await screen.findByText('Never Gonna Give You Up')).toBeInTheDocument();
    // No player-mode UI on the hub's own TV.
    expect(screen.queryByTestId('join-popup')).toBeNull();
    expect(screen.queryByTestId('tv-link-caption')).toBeNull();
  });

  it('shows Update required when the hub speaks another protocol', async () => {
    installBridge();
    stubHub();
    render(<Tv />);
    await joinHub(m2State({ protocolVersion: 3 }));
    await waitFor(() => expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.pill.update));
  });
});

describe('/tv join popup', () => {
  it('counts down to linked; Stay separate flips it on the hub and in the desktop', async () => {
    const b = installBridge();
    const fetchMock = stubHub();
    render(<Tv />);
    await joinHub();
    const countdown = await screen.findByTestId('join-countdown');
    await waitFor(() => expect(countdown).toHaveTextContent(S.tv.joining('Basement', 10)));
    fireEvent.click(screen.getByRole('button', { name: S.tv.staySeparate }));
    expect(b.setLinkState).toHaveBeenCalledWith('independent');
    await waitFor(() => expect(callsTo(fetchMock, `POST ${HUB}/api/rooms/me`)).toHaveLength(1));
    const call = callsTo(fetchMock, `POST ${HUB}/api/rooms/me`)[0]!;
    expect(bodyOf(call)).toEqual({ linkState: 'independent' });
    expect((call[1]?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(screen.getByTestId('join-countdown')).toHaveTextContent(/^Staying separate in \d+…$/);
    expect(screen.getByRole('button', { name: S.tv.join('Basement') })).toBeInTheDocument();
    expect(screen.getByTestId('tv-link-caption')).toHaveTextContent(S.tv.ownQueue);
  });

  it('auto-joins when the countdown ends, without posting anything', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installBridge();
    const fetchMock = stubHub();
    render(<Tv />);
    await joinHub();
    await screen.findByTestId('join-popup');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(screen.queryByTestId('join-popup')).toBeNull();
    expect(screen.getByTestId('tv-link-caption')).toHaveTextContent(S.tv.linkedTo('Basement'));
    expect(callsTo(fetchMock, `POST ${HUB}/api/rooms/me`)).toHaveLength(0);
  });

  it('counts down to the remembered independent state with a Join button', async () => {
    const b = installBridge({
      mode: vi.fn(() => ({ mode: 'player' as const, linkState: 'independent' as const })),
    });
    const fetchMock = stubHub();
    render(<Tv />);
    await joinHub();
    await waitFor(() =>
      expect(screen.getByTestId('join-countdown')).toHaveTextContent(S.tv.staying(10)),
    );
    fireEvent.click(screen.getByRole('button', { name: S.tv.join('Basement') }));
    expect(b.setLinkState).toHaveBeenCalledWith('linked');
    await waitFor(() => expect(callsTo(fetchMock, `POST ${HUB}/api/rooms/me`)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, `POST ${HUB}/api/rooms/me`)[0]!)).toEqual({
      linkState: 'linked',
    });
  });
});

describe('/tv looking for the hub', () => {
  it('after 20 s without a verified hub: names the room, shows the address and takes a new one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const b = installBridge();
    stubHub();
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HUB_LOST_MS - 2000);
    });
    expect(screen.queryByTestId('tv-lost')).toBeNull();
    expect(screen.getByTestId('tv-pill')).not.toHaveTextContent(S.tv.lookingFor('Basement'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.lookingFor('Basement'));
    expect(screen.getByTestId('tv-lost')).toHaveTextContent(S.tv.lastAddress('192.168.1.20:8080'));

    const before = FakeWebSocket.instances.length;
    fireEvent.change(screen.getByLabelText(S.tv.enterHub), { target: { value: '192.168.1.77' } });
    fireEvent.click(screen.getByRole('button', { name: S.tv.connect }));
    expect(b.setHubAddress).toHaveBeenCalledWith('http://192.168.1.77:8080');
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(before));
    expect(FakeWebSocket.last().url.startsWith('ws://192.168.1.77:8080/ws?')).toBe(true);
  });

  it('a verified hub that drops is Reconnecting first, then Looking after 20 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installBridge();
    stubHub();
    render(<Tv />);
    const { ws } = await joinHub();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByTestId('tv-pill')).not.toHaveTextContent(S.tv.lookingFor('Basement'));
    act(() => ws.close());
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.pill.reconnecting);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HUB_LOST_MS + 500);
    });
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.lookingFor('Basement'));
  });
});
