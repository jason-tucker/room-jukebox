import type { PlayerState } from '@room-jukebox/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { YouTubeAttribution } from '../components/YouTubeAttribution.tsx';
import { QrCode } from '../lib/qr.tsx';
import {
  DEFAULT_TUNING,
  LOCAL_DELAYED_SEC,
  TvPlayback,
  type TvSnapshot,
} from '../lib/tvPlayback.ts';
import { useSessionState, type ConnectionStatus } from '../lib/ws.ts';
import { S } from '../strings.ts';

/*
 * /tv: the hub's TV window (plan §3.6). The desktop injects `?player=<deviceId>&token=<deviceToken>`.
 * Layout rule: the player box is never covered by anything (YouTube player policy); everything
 * else, including the Start Music prompt, lives in the right column.
 * Diagnostics knobs as on the spike page: ?deadband=1.25 ?minseek=2500 ?lead=0.
 */

type Pill = keyof typeof S.tv.pill;

export function pillFor(
  connection: ConnectionStatus,
  state: PlayerState | null,
  tv: Pick<TvSnapshot, 'needsStart' | 'drift'>,
): Pill {
  if (connection === 'reconnecting') return 'reconnecting';
  if (!state || connection === 'connecting') return 'looking';
  const np = state.playback.nowPlaying;
  if (tv.needsStart || state.status === 'blocked') return 'start';
  if (state.status === 'delayed') return 'delayed';
  if (tv.drift !== null && np && np.pausedAt === null && Math.abs(tv.drift) > LOCAL_DELAYED_SEC) {
    return 'delayed';
  }
  return 'online';
}

const PILL_CLASS: Record<Pill, string> = {
  online: 'bg-emerald-600 text-white',
  delayed: 'bg-amber-400 text-black',
  reconnecting: 'bg-orange-600 text-white',
  start: 'bg-teal-400 text-black',
  looking: 'bg-neutral-600 text-white',
};

function numParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** "http://192.168.1.20:8080/" → "192.168.1.20:8080". */
function displayAddress(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const EMPTY_TV: TvSnapshot = {
  needsStart: false,
  failure: null,
  drift: null,
  playerError: null,
  ready: false,
};

export function Tv() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    const player = params.get('player');
    const token = params.get('token');
    if (player) q.player = player;
    if (token) q.token = token;
    return q;
  }, [params]);
  const tuning = useMemo(
    () => ({
      deadBandSec: numParam(params, 'deadband', DEFAULT_TUNING.deadBandSec),
      minSeekIntervalMs: numParam(params, 'minseek', DEFAULT_TUNING.minSeekIntervalMs),
      leadSec: numParam(params, 'lead', DEFAULT_TUNING.leadSec),
    }),
    [params],
  );

  const { state, status, client } = useSessionState('player', { query });
  const containerRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef<TvPlayback | null>(null);
  const [tv, setTv] = useState<TvSnapshot>(EMPTY_TV);
  // `lastError.code === 'stopped'`: the fallback gave up after 5 failures; a Start Music press
  // (any key) is the owner's way to try again.
  const stopped = state?.lastError?.code === 'stopped' ? state.lastError : null;
  const showStart = !!state && (tv.needsStart || state.status === 'blocked' || !!stopped);
  const showStartRef = useRef(showStart);
  useEffect(() => {
    showStartRef.current = showStart;
  }, [showStart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!client || !container) return;
    const playback = new TvPlayback(client, container, tuning);
    playbackRef.current = playback;
    const refresh = () => setTv(playback.snapshot());
    const unsubscribe = playback.subscribe(refresh);
    playback.start();
    // The failure line expires on its own; poll the snapshot cheaply.
    const timer = setInterval(refresh, 500);

    const onVisible = () => {
      if (document.visibilityState === 'visible') playback.resyncNow();
    };
    // While Start Music is showing, any key or click anywhere counts as pressing it.
    const onGesture = () => {
      if (playback.needsStart || showStartRef.current) playback.startMusic();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('keydown', onGesture);
    window.addEventListener('pointerdown', onGesture);
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('keydown', onGesture);
      window.removeEventListener('pointerdown', onGesture);
      playback.stop();
      playbackRef.current = null;
    };
  }, [client, tuning]);

  const pill = pillFor(status, state, tv);
  const np = state?.playback.nowPlaying ?? null;
  const requestUrl = state ? (state.qr.publicUrl ?? state.qr.lanUrl) : null;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-black text-neutral-100">
      {/* Nothing is ever drawn over this box (YouTube player rules, plan §3.6). */}
      <div
        ref={containerRef}
        data-testid="tv-player"
        aria-label={S.tv.player}
        className="h-full shrink-0"
        style={{ width: '75%', minWidth: 480, minHeight: 270 }}
      />
      <aside className="relative flex h-full min-w-0 flex-1 flex-col gap-4 overflow-hidden bg-neutral-900 p-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-2xl font-bold">{state?.roomName ?? S.app.name}</h1>
          <span
            data-testid="tv-pill"
            className={`shrink-0 rounded-full px-3 py-1 text-base font-semibold ${PILL_CLASS[pill]}`}
          >
            {S.tv.pill[pill]}
          </span>
        </div>

        {tv.failure !== null && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl bg-neutral-800 p-3 text-lg"
          >
            <span aria-hidden className="size-3 shrink-0 rounded-full bg-red-500" />
            {S.tv.failed(tv.failure || '')}
          </div>
        )}
        {stopped && (
          <div
            role="alert"
            data-testid="tv-stopped"
            className="relative z-20 flex items-center gap-2 rounded-xl bg-neutral-800 p-3 text-lg"
          >
            <span aria-hidden className="size-3 shrink-0 rounded-full bg-red-500" />
            {stopped.message}
          </div>
        )}
        {tv.playerError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-xl bg-neutral-800 p-3 text-lg"
          >
            <span aria-hidden className="size-3 shrink-0 rounded-full bg-red-500" />
            {S.tv.noPlayer}
          </div>
        )}

        <section>
          <div className="line-clamp-3 text-2xl leading-tight font-semibold">
            {np?.title ?? S.tv.nothingPlaying}
          </div>
          {np && (
            <div className="mt-1 text-lg text-neutral-400">
              {np.source === 'auto' ? S.guest.autoPick : S.guest.requestedBy(np.requesterName)}
            </div>
          )}
        </section>

        {state && state.upcoming.length > 0 && (
          <section className="min-h-0">
            <h2 className="mb-1 text-lg font-semibold text-neutral-400">{S.tv.upNext}</h2>
            <ol className="flex flex-col gap-1">
              {state.upcoming.slice(0, 5).map((u, i) => (
                <li key={`${i}-${u.title}`} className="text-lg leading-snug">
                  <span className="line-clamp-1">
                    {i + 1}. {u.title}
                  </span>
                  {u.requesterName && (
                    <span className="block truncate text-base text-neutral-400">
                      {S.guest.requestedBy(u.requesterName)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        <div className="mt-auto flex flex-col gap-3">
          {state && (
            <div className="flex items-start justify-center gap-3">
              {state.qr.wifi && (
                <QrCode value={state.qr.wifi} label={S.tv.joinWifi} size="min(10vw, 24vh)" />
              )}
              {requestUrl && (
                <QrCode value={requestUrl} label={S.tv.requestSong} size="min(10vw, 24vh)" />
              )}
            </div>
          )}
          {requestUrl && (
            <div data-testid="tv-join" className="text-center text-3xl font-bold break-all">
              {displayAddress(requestUrl)}
            </div>
          )}
          <YouTubeAttribution link={false} className="self-center text-neutral-100" />
        </div>

        {state?.partyCode && (
          <div className="absolute right-2 bottom-1 text-base text-neutral-500">
            {S.tv.partyCode(state.partyCode)}
          </div>
        )}

        {showStart && (
          // Covers the right column only, never the player.
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-900/95 p-5">
            <button
              type="button"
              data-testid="start-music"
              // Also reached by the window-level gesture handler; a second playVideo() is harmless.
              onClick={() => playbackRef.current?.startMusic()}
              className="w-full rounded-3xl bg-teal-400 px-4 py-10 text-4xl font-bold text-black hover:bg-teal-300"
            >
              {S.tv.startMusic}
              <span className="mt-2 block text-lg font-normal">{S.tv.startMusicHint}</span>
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
