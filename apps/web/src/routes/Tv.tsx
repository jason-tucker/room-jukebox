import { decideSeek, expectedPosition } from '@room-jukebox/core';
import { describeYouTubeError, type SpikePlayerStatus } from '@room-jukebox/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HubConnection, resolveHub, type ConnectionStatus } from '../spike/hub.ts';
import { fmtDrift, fmtSec, numParam, stablePlayerId } from '../spike/format.ts';
import { loadYouTubeApi, YTState, type YTPlayer } from '../spike/youtube.ts';

/*
 * M0 spike TV page (plan §3.6 layout, §3.4 sync math). Throwaway: replaced by the real /tv in M1.
 * Query: ?player=<name>  ?hub=<origin>  and tuning knobs ?deadband=1.25 ?minseek=2500 ?lead=0.
 */

declare global {
  interface Window {
    jukebox?: {
      selfcheck?: () => unknown;
      lastBeacon?: () => unknown;
    };
  }
}

const SYNC_INTERVAL_MS = 300;
const REPORT_INTERVAL_MS = 1000;
const AUTOPLAY_CHECK_MS = 3000;
const ERROR_SHOW_MS = 5000;
const LOCAL_DELAYED_SEC = 3;

type Pill = 'Online' | 'Delayed' | 'Reconnecting' | 'Press Start Music' | 'Looking for hub';

interface View {
  connection: ConnectionStatus;
  serverStatus: SpikePlayerStatus | null;
  videoId: string | null;
  title: string | null;
  revision: number | null;
  loadedRevision: number;
  paused: boolean;
  actual: number | null;
  expected: number | null;
  drift: number | null;
  playerState: number | null;
  offsetMs: number;
  seeks: number;
  lastSeek: string | null;
  needsStart: boolean;
  flashError: string | null;
  lastError: string | null;
  apiError: string | null;
}

const INITIAL_VIEW: View = {
  connection: 'looking',
  serverStatus: null,
  videoId: null,
  title: null,
  revision: null,
  loadedRevision: -1,
  paused: false,
  actual: null,
  expected: null,
  drift: null,
  playerState: null,
  offsetMs: 0,
  seeks: 0,
  lastSeek: null,
  needsStart: false,
  flashError: null,
  lastError: null,
  apiError: null,
};

const STATE_NAMES: Record<number, string> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

function pillFor(v: View): Pill {
  if (v.connection === 'looking') return 'Looking for hub';
  if (v.connection === 'reconnecting') return 'Reconnecting';
  if (v.needsStart || v.serverStatus === 'blocked') return 'Press Start Music';
  if (v.serverStatus === 'delayed') return 'Delayed';
  if (v.drift !== null && !v.paused && Math.abs(v.drift) > LOCAL_DELAYED_SEC) return 'Delayed';
  return 'Online';
}

const PILL_CLASS: Record<Pill, string> = {
  Online: 'bg-emerald-600',
  Delayed: 'bg-amber-500 text-black',
  Reconnecting: 'bg-orange-600',
  'Press Start Music': 'bg-sky-500 text-black',
  'Looking for hub': 'bg-neutral-600',
};

export function Tv() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const name = params.get('player') || 'tv';
  const hub = useMemo(() => resolveHub(window.location.search), []);
  const tuning = useMemo(
    () => ({
      deadBandSec: numParam(params, 'deadband', 1.25),
      minSeekIntervalMs: numParam(params, 'minseek', 2500),
      leadSec: numParam(params, 'lead', 0),
    }),
    [params],
  );
  const playerId = useMemo(() => stablePlayerId(name), [name]);
  const containerRef = useRef<HTMLDivElement>(null);
  const startMusicRef = useRef<() => void>(() => undefined);
  const [view, setView] = useState<View>(INITIAL_VIEW);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let player: YTPlayer | null = null;
    let ready = false;
    let loadedRevision = -1;
    let mirroredPaused = false;
    let lastSeekAt: number | null = null;
    let lastActual: number | null = null;
    let seeks = 0;
    let lastSeek: string | null = null;
    let needsStart = false;
    let autoplayTimer: ReturnType<typeof setTimeout> | undefined;
    let flash: { text: string; until: number } | null = null;
    let lastError: string | null = null;
    let apiError: string | null = null;
    let sentPlayingRev = -1;
    let sentEndedRev = -1;
    let sentBlockedRev = -1;
    let sentErrorRev = -1;
    let sample = {
      actual: null as number | null,
      expected: null as number | null,
      ps: null as number | null,
    };

    const conn = new HubConnection(hub, (c) =>
      c.send({ type: 'hello', playerId, name, origin: window.location.origin }),
    );

    const sendEvent = (kind: 'ended' | 'error' | 'autoplayBlocked' | 'playing', code?: number) =>
      conn.send({
        type: 'event',
        playerId,
        kind,
        revision: loadedRevision,
        ...(code !== undefined ? { code } : {}),
      });

    const markBlocked = () => {
      needsStart = true;
      if (sentBlockedRev !== loadedRevision) {
        sentBlockedRev = loadedRevision;
        sendEvent('autoplayBlocked');
      }
    };

    // "Blocked" heuristic: still unstarted/cued 3 s after asking to play.
    const armAutoplayCheck = () => {
      clearTimeout(autoplayTimer);
      autoplayTimer = setTimeout(() => {
        if (!player || mirroredPaused) return;
        const ps = player.getPlayerState();
        if (ps === YTState.UNSTARTED || ps === YTState.CUED) markBlocked();
      }, AUTOPLAY_CHECK_MS);
    };

    const startMusic = () => {
      if (!player) return;
      needsStart = false;
      player.playVideo();
      armAutoplayCheck();
    };
    startMusicRef.current = startMusic;

    const applyState = () => {
      const state = conn.state;
      if (!player || !ready || !state) return;
      const np = state.nowPlaying;
      if (!np) {
        if (loadedRevision !== state.revision) {
          loadedRevision = state.revision;
          player.stopVideo();
        }
        return;
      }
      if (state.revision !== loadedRevision) {
        loadedRevision = state.revision;
        const startSeconds = expectedPosition(np, conn.serverNow());
        mirroredPaused = np.pausedAt !== null;
        lastSeekAt = Date.now();
        lastActual = null;
        if (mirroredPaused) {
          player.cueVideoById({ videoId: np.videoId, startSeconds });
        } else {
          player.loadVideoById({ videoId: np.videoId, startSeconds });
          armAutoplayCheck();
        }
        return;
      }
      const paused = np.pausedAt !== null;
      if (paused !== mirroredPaused) {
        mirroredPaused = paused;
        if (paused) {
          player.pauseVideo();
        } else {
          player.playVideo();
          armAutoplayCheck();
        }
      }
    };

    const unsubscribe = conn.subscribe(applyState);
    conn.start();

    void loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        const host = document.createElement('div');
        container.appendChild(host);
        player = new YT.Player(host, {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            controls: 1,
            rel: 0,
            playsinline: 1,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              ready = true;
              applyState();
            },
            onStateChange: (e) => {
              if (e.data === YTState.PLAYING) {
                needsStart = false;
                clearTimeout(autoplayTimer);
                if (sentPlayingRev !== loadedRevision) {
                  sentPlayingRev = loadedRevision;
                  sendEvent('playing');
                }
              } else if (e.data === YTState.ENDED) {
                // Never advance locally: the hub decides (single transition rule).
                if (sentEndedRev !== loadedRevision) {
                  sentEndedRev = loadedRevision;
                  sendEvent('ended');
                }
              }
            },
            onError: (e) => {
              const code = Number(e.data);
              const text = describeYouTubeError(code);
              flash = { text, until: Date.now() + ERROR_SHOW_MS };
              lastError = `${new Date().toLocaleTimeString()} ${conn.state?.nowPlaying?.videoId ?? ''}: ${text}`;
              clearTimeout(autoplayTimer);
              if (sentErrorRev !== loadedRevision) {
                sentErrorRev = loadedRevision;
                sendEvent('error', code);
              }
            },
            onAutoplayBlocked: () => markBlocked(),
          },
        });
      })
      .catch((err: unknown) => {
        apiError = err instanceof Error ? err.message : String(err);
      });

    const syncTimer = setInterval(() => {
      const state = conn.state;
      const np = state?.nowPlaying;
      if (!player || !ready || !state || !np || loadedRevision !== state.revision) {
        sample = {
          actual: null,
          expected: null,
          ps: player && ready ? player.getPlayerState() : null,
        };
        return;
      }
      const now = Date.now();
      const expected = expectedPosition(np, conn.serverNow());
      const actual = player.getCurrentTime();
      const ps = player.getPlayerState();
      // Only correct a player whose clock is visibly moving: a stalled player (ad, buffering, hand
      // pause) is left alone and shows Delayed until it plays again (plan §3.4).
      const advancing = ps === YTState.PLAYING && lastActual !== null && actual - lastActual > 0.05;
      lastActual = actual;
      sample = { actual, expected, ps };

      if (np.pausedAt !== null) {
        if (ps === YTState.PLAYING) player.pauseVideo();
        return;
      }
      if (!advancing) return;
      const decision = decideSeek({
        expected: expected + tuning.leadSec,
        actual,
        lastSeekAt,
        now,
        deadBandSec: tuning.deadBandSec,
        minSeekIntervalMs: tuning.minSeekIntervalMs,
      });
      if (decision.seek && decision.to !== undefined) {
        player.seekTo(decision.to, true);
        lastSeekAt = now;
        lastActual = null;
        seeks += 1;
        lastSeek = `${new Date().toLocaleTimeString()} ${decision.reason} by ${Math.abs(actual - expected).toFixed(2)} s`;
      }
    }, SYNC_INTERVAL_MS);

    const reportTimer = setInterval(() => {
      if (!player || !ready || sample.actual === null || sample.ps === null) return;
      conn.send({
        type: 'position',
        playerId,
        position: sample.actual,
        playerState: sample.ps,
        revision: loadedRevision,
      });
    }, REPORT_INTERVAL_MS);

    const renderTimer = setInterval(() => {
      const state = conn.state;
      const me = state?.players.find((p) => p.id === playerId);
      const np = state?.nowPlaying ?? null;
      if (flash && Date.now() > flash.until) flash = null;
      setView({
        connection: conn.status,
        serverStatus: me?.status ?? null,
        videoId: np?.videoId ?? null,
        title: np?.title ?? player?.getVideoData?.()?.title ?? null,
        revision: state?.revision ?? null,
        loadedRevision,
        paused: np?.pausedAt != null,
        actual: sample.actual,
        expected: sample.expected,
        drift:
          sample.actual !== null && sample.expected !== null
            ? sample.actual - sample.expected
            : null,
        playerState: sample.ps,
        offsetMs: conn.offsetMs(),
        seeks,
        lastSeek,
        needsStart,
        flashError: flash?.text ?? null,
        lastError,
        apiError,
      });
    }, 250);

    const onVisible = () => {
      if (document.visibilityState === 'visible') lastSeekAt = null; // resync now
    };
    // While Start Music is showing, any key or click anywhere counts as pressing it.
    const onGesture = () => {
      if (needsStart) startMusic();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('keydown', onGesture);
    window.addEventListener('pointerdown', onGesture);

    return () => {
      disposed = true;
      unsubscribe();
      conn.stop();
      clearInterval(syncTimer);
      clearInterval(reportTimer);
      clearInterval(renderTimer);
      clearTimeout(autoplayTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('keydown', onGesture);
      window.removeEventListener('pointerdown', onGesture);
      try {
        player?.destroy();
      } catch {
        // already gone
      }
      container.replaceChildren();
    };
  }, [hub, name, playerId, tuning]);

  const pill = pillFor(view);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-black text-neutral-100">
      {/* Nothing is ever drawn over this box (YouTube player rules, plan §3.6). */}
      <div
        ref={containerRef}
        className="h-full shrink-0"
        style={{ width: '75%', minWidth: 480, minHeight: 270 }}
        aria-label="YouTube player"
      />
      <aside className="flex h-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto bg-neutral-900 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className={`rounded-full px-3 py-1 text-base font-semibold ${PILL_CLASS[pill]}`}>
            {pill}
          </span>
          <span className="truncate text-neutral-400" title={playerId}>
            {name}
          </span>
        </div>

        {(view.needsStart || view.serverStatus === 'blocked') && (
          <button
            type="button"
            onClick={() => startMusicRef.current()}
            className="rounded-xl bg-sky-500 px-4 py-6 text-2xl font-bold text-black hover:bg-sky-400"
          >
            Start Music
            <span className="block text-sm font-normal">(or press any key)</span>
          </button>
        )}

        {view.flashError && (
          <div className="rounded-lg bg-red-700 p-3 text-base font-medium">{view.flashError}</div>
        )}

        <section>
          <div className="text-lg font-semibold leading-tight">
            {view.title ?? 'Nothing playing'}
          </div>
          <div className="font-mono text-neutral-400">{view.videoId ?? '-'}</div>
        </section>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
          <dt className="text-neutral-400">position</dt>
          <dd>{fmtSec(view.actual, 2)}</dd>
          <dt className="text-neutral-400">expected</dt>
          <dd>{fmtSec(view.expected, 2)}</dd>
          <dt className="text-neutral-400">drift</dt>
          <dd className={view.drift !== null && Math.abs(view.drift) > 1 ? 'text-amber-400' : ''}>
            {fmtDrift(view.drift)}
          </dd>
          <dt className="text-neutral-400">player</dt>
          <dd>
            {view.playerState === null ? '-' : (STATE_NAMES[view.playerState] ?? view.playerState)}
          </dd>
          <dt className="text-neutral-400">hub state</dt>
          <dd>{view.paused ? 'paused' : 'playing'}</dd>
          <dt className="text-neutral-400">revision</dt>
          <dd>
            {view.revision ?? '-'} (loaded {view.loadedRevision})
          </dd>
          <dt className="text-neutral-400">clock offset</dt>
          <dd>{view.offsetMs.toFixed(0)} ms</dd>
          <dt className="text-neutral-400">seeks</dt>
          <dd>{view.seeks}</dd>
          <dt className="text-neutral-400">last seek</dt>
          <dd className="break-words">{view.lastSeek ?? '-'}</dd>
          <dt className="text-neutral-400">last error</dt>
          <dd className="break-words">{view.lastError ?? '-'}</dd>
          <dt className="text-neutral-400">hub</dt>
          <dd className="break-all">{hub}</dd>
          <dt className="text-neutral-400">page</dt>
          <dd className="break-all">{window.location.origin}</dd>
          <dt className="text-neutral-400">tuning</dt>
          <dd>
            ±{tuning.deadBandSec} s / {tuning.minSeekIntervalMs} ms / lead {tuning.leadSec} s
          </dd>
        </dl>

        {view.apiError && <div className="rounded bg-red-800 p-2">{view.apiError}</div>}

        <SelfCheckPanel />
      </aside>
    </div>
  );
}

async function runSelfCheck(): Promise<string> {
  const jb = window.jukebox;
  const out: Record<string, unknown> = {};
  for (const key of ['selfcheck', 'lastBeacon'] as const) {
    const fn = jb?.[key];
    if (typeof fn !== 'function') {
      out[key] = 'not available (not running in the desktop app?)';
      continue;
    }
    try {
      out[key] = await Promise.resolve(fn());
    } catch (err) {
      out[key] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return JSON.stringify(out, null, 2);
}

function SelfCheckPanel() {
  const [result, setResult] = useState<string>('running...');

  useEffect(() => {
    let live = true;
    void runSelfCheck().then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <details className="mt-auto rounded bg-neutral-800 p-2">
      <summary className="cursor-pointer select-none">Desktop self-check</summary>
      <button
        type="button"
        onClick={() => void runSelfCheck().then(setResult)}
        className="my-2 rounded bg-neutral-700 px-2 py-1 hover:bg-neutral-600"
      >
        Run again
      </button>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{result}</pre>
    </details>
  );
}
