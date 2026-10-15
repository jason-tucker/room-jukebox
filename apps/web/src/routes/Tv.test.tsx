import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as YouTubeModule from '../lib/youtube.ts';
import type { PlayerHandlers, YTPlayer } from '../lib/youtube.ts';
import { S } from '../strings.ts';
import { FakeWebSocket } from '../test/fakeWs.ts';
import { playerState } from '../test/fixtures.ts';
import { Tv } from './Tv.tsx';

const yt = vi.hoisted(() => ({
  handlers: null as PlayerHandlers | null,
  player: null as YTPlayer | null,
}));

vi.mock('../lib/youtube.ts', async (importOriginal) => {
  const real = await importOriginal<typeof YouTubeModule>();
  return {
    ...real,
    createYouTubePlayer: (_el: HTMLElement, h: PlayerHandlers) => {
      yt.handlers = h;
      yt.player = {
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
      };
      setTimeout(() => h.onReady?.(), 0);
      return Promise.resolve(yt.player);
    },
  };
});

describe('/tv Start Music', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState(null, '', '/tv?player=tv1&token=t0k');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows Start Music beside the player when autoplay is blocked; any key plays', async () => {
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    expect(ws.url).toContain('role=player');
    expect(ws.url).toContain('player=tv1');
    expect(ws.url).toContain('token=t0k');
    act(() => {
      ws.open();
      ws.receive({ type: 'state', state: playerState() });
    });
    await waitFor(() =>
      expect(yt.player?.loadVideoById).toHaveBeenCalledWith(
        expect.objectContaining({ videoId: 'dQw4w9WgXcQ' }),
      ),
    );
    expect(screen.getByText(S.tv.requestSong)).toBeInTheDocument();
    expect(screen.getByText(S.tv.joinWifi)).toBeInTheDocument();
    expect(screen.getByText('Wi-Fi: PartyNet')).toBeInTheDocument();
    expect(screen.queryByTestId('start-music')).toBeNull();

    act(() => yt.handlers?.onAutoplayBlocked?.());
    const button = await screen.findByTestId('start-music');
    expect(screen.getByTestId('tv-pill')).toHaveTextContent(S.tv.pill.start);
    // Never over the player.
    expect(screen.getByTestId('tv-player')).not.toContainElement(button);
    expect(ws.sent).toContainEqual({ type: 'event', kind: 'autoplayBlocked', revision: 2 });

    fireEvent.keyDown(window, { key: 'a' });
    expect(yt.player?.playVideo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('start-music')).toBeNull());
  });

  it('a click anywhere also starts the music', async () => {
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    act(() => {
      ws.open();
      ws.receive({ type: 'state', state: playerState() });
    });
    await waitFor(() => expect(yt.player?.loadVideoById).toHaveBeenCalled());
    act(() => yt.handlers?.onAutoplayBlocked?.());
    await screen.findByTestId('start-music');
    fireEvent.pointerDown(document.body);
    expect(yt.player?.playVideo).toHaveBeenCalled();
  });

  it('shows the stopped message with Start Music when the fallback gave up', async () => {
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    act(() => {
      ws.open();
      ws.receive({
        type: 'state',
        state: playerState({
          playback: { state: 'idle', nowPlaying: null },
          lastError: {
            code: 'stopped',
            message: 'Fallback music stopped after 5 failures',
            at: Date.now(),
          },
        }),
      });
    });
    expect(await screen.findByTestId('tv-stopped')).toHaveTextContent(
      'Fallback music stopped after 5 failures',
    );
    expect(screen.getByTestId('start-music')).toBeInTheDocument();
  });
});

describe('/tv notices and version', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState(null, '', '/tv?player=tv1&token=t0k');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.jukebox;
  });

  it('shows info toasts bottom-right, outside the player, and the hub version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/version'
            ? new Response(JSON.stringify({ version: '0.0.8', protocolVersion: 1 }))
            : new Response('{}', { status: 404 }),
        ),
      ),
    );
    let desktopToast: ((t: string) => void) | null = null;
    window.jukebox = {
      onToast: (cb) => {
        desktopToast = cb;
        return () => undefined;
      },
    };
    render(<Tv />);
    expect(await screen.findByTestId('tv-version')).toHaveTextContent(S.tv.version('0.0.8'));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    act(() => {
      ws.open();
      ws.receive({ type: 'state', state: playerState() });
      ws.receive({ type: 'toast', level: 'info', message: 'Updated to 0.0.8', ttlMs: 8000 });
      ws.receive({ type: 'toast', level: 'warn', message: 'Not for the TV', ttlMs: 8000 });
    });
    const toasts = screen.getByTestId('tv-toasts');
    expect(await within(toasts).findByText('Updated to 0.0.8')).toBeInTheDocument();
    expect(screen.queryByText('Not for the TV')).toBeNull();
    expect(screen.getByTestId('tv-player')).not.toContainElement(toasts);

    act(() => desktopToast?.('Updating in 15 s'));
    expect(await within(toasts).findByText('Updating in 15 s')).toBeInTheDocument();
  });
});

describe('/tv join address', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState(null, '', '/tv?player=tv1&token=t0k');
  });
  afterEach(() => vi.unstubAllGlobals());

  const show = async (qr: Partial<ReturnType<typeof playerState>['qr']>) => {
    render(<Tv />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    const ws = FakeWebSocket.last();
    const base = playerState();
    act(() => {
      ws.open();
      ws.receive({ type: 'state', state: { ...base, qr: { ...base.qr, ...qr } } });
    });
  };

  it('prints joinUrl big and keeps the IP URL small underneath when they differ', async () => {
    await show({ joinUrl: 'http://jukebox.home:8080/' });
    expect(await screen.findByTestId('tv-join')).toHaveTextContent('jukebox.home:8080');
    expect(screen.getByTestId('tv-lan')).toHaveTextContent('192.168.1.20:8080');
  });

  it('shows only the IP address when joinUrl is the IP URL', async () => {
    await show({});
    expect(await screen.findByTestId('tv-join')).toHaveTextContent('192.168.1.20:8080');
    expect(screen.queryByTestId('tv-lan')).toBeNull();
  });
});
