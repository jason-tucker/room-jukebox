import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
