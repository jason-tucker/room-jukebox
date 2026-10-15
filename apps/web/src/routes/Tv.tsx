import {
  M2_PROTOCOL_VERSION,
  type HubJson,
  type LinkState,
  type PlayerState,
} from '@room-jukebox/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useToasts } from '../components/Toasts.tsx';
import { YouTubeAttribution } from '../components/YouTubeAttribution.tsx';
import { displayHubAddress, normalizeHubAddress } from '../lib/hub.ts';
import { bridge, callBridge, desktopMemory, onDesktopToast } from '../lib/jukebox.ts';
import { api } from '../lib/api.ts';
import { readLocal, writeLocal } from '../lib/storage.ts';
import { QrCode } from '../lib/qr.tsx';
import {
  DEFAULT_TUNING,
  LOCAL_DELAYED_SEC,
  TvPlayback,
  type TvSnapshot,
} from '../lib/tvPlayback.ts';
import {
  useSessionState,
  type ConnectionStatus,
  type Handshake,
  type SessionClientOptions,
} from '../lib/ws.ts';
import { S } from '../strings.ts';

/*
 * /tv: the TV window (plan §3.6). The desktop injects `?player=<deviceId>&token=<deviceToken>`.
 * Hub mode (default): the socket goes to this origin. Player mode (`?mode=player&hub=<url>`,
 * contract-m2): the socket goes to the hub, the join popup counts down on every start, and the
 * pill says when the hub has been missing for 20 s. In both modes, when the desktop bridge offers
 * the proof functions, the socket runs the auth/authOk handshake before accepting any state.
 * Layout rule: the player box is never covered by anything (YouTube player policy); everything
 * else, including the Start Music prompt, lives in the right column.
 * Diagnostics knobs as on the spike page: ?deadband=1.25 ?minseek=2500 ?lead=0.
 */

type Pill = keyof typeof S.tv.pill;
type TvPill = Pill | 'lost';

/** No verified hub for this long → "Looking for the <room> laptop…" (plan §3.5). */
export const HUB_LOST_MS = 20_000;
/** Join popup countdown (plan §0). */
export const JOIN_COUNTDOWN_MS = 10_000;
const HUB_ROOM_KEY = 'rj.hubRoom';

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

const PILL_CLASS: Record<TvPill, string> = {
  online: 'bg-emerald-600 text-white',
  delayed: 'bg-amber-400 text-black',
  reconnecting: 'bg-orange-600 text-white',
  start: 'bg-teal-400 text-black',
  looking: 'bg-neutral-600 text-white',
  lost: 'bg-neutral-600 text-white',
  update: 'bg-red-600 text-white',
  unverified: 'bg-red-600 text-white',
};

/** The player-mode states layered over `pillFor` (most important first). */
export function playerPill(
  base: Pill,
  p: { updateRequired: boolean; unverified: boolean; lost: boolean },
): TvPill {
  if (p.updateRequired) return 'update';
  if (p.unverified) return 'unverified';
  if (p.lost) return 'lost';
  return base;
}

/** The handshake the bridge supports for this mode, or null (M1 behaviour). */
function bridgeHandshake(playerMode: boolean): Handshake | null {
  const b = bridge();
  const auth = playerMode ? b?.playerAuth : b?.localPlayerAuth;
  const verify = b?.verifyAuthOk;
  if (typeof auth !== 'function' || typeof verify !== 'function') return null;
  return { auth: (n) => auth(n), verify: (n, h, p) => verify(n, h, p) };
}

const onExtra: NonNullable<SessionClientOptions<'player'>['onExtra']> = (msg, client) => {
  if (msg.type === 'rekey') {
    void callBridge('storeKey', { householdKey: msg.householdKey, keyEpoch: msg.keyEpoch });
  } else if (msg.type === 'replica') {
    const store = bridge()?.storeReplica;
    if (typeof store !== 'function') return;
    void (async () => {
      try {
        await store(msg.snapshot);
      } catch {
        return; // not stored: no ack, the hub sends the next snapshot anyway
      }
      client.send({ type: 'replicaAck', snapshotAt: msg.snapshot.snapshotAt });
    })();
  }
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
  const playerMode = params.get('mode') === 'player';
  const deviceToken = params.get('token');
  const [hubAddress, setHubAddress] = useState<string | null>(() => {
    const raw = params.get('hub');
    return playerMode && raw ? normalizeHubAddress(raw) : null;
  });
  const [handshake] = useState(() => bridgeHandshake(playerMode));
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

  const { state, status, client, verified, authProblem, lastVerifiedAt } = useSessionState(
    'player',
    {
      query,
      ...(hubAddress ? { origin: hubAddress } : {}),
      handshake,
      onExtra,
    },
  );
  const [startedAt] = useState(() => Date.now());

  // ---- Player mode: hub info, link state, join popup, hub-lost timer ----
  const [hubInfo, setHubInfo] = useState<HubJson | null>(null);
  useEffect(() => {
    if (!playerMode || !hubAddress) return;
    let live = true;
    void api.hub.info(hubAddress).then((r) => {
      if (!live || !r.ok) return;
      setHubInfo(r.data);
      writeLocal(HUB_ROOM_KEY, r.data.roomName);
    });
    return () => {
      live = false;
    };
  }, [playerMode, hubAddress]);
  const [cachedRoom] = useState(() => readLocal(HUB_ROOM_KEY));
  const hubRoom = hubInfo?.roomName || cachedRoom || state?.roomName || null;

  const [linkState, setLinkState] = useState<LinkState>(() =>
    params.get('link') === 'independent' ? 'independent' : 'linked',
  );
  const linkTouched = useRef(false);
  useEffect(() => {
    if (!playerMode) return;
    let live = true;
    void desktopMemory().then((m) => {
      if (live && m.linkState && !linkTouched.current) setLinkState(m.linkState);
    });
    return () => {
      live = false;
    };
  }, [playerMode]);

  // The popup starts with the first verified state after this page started (every start).
  const [popupEnd, setPopupEnd] = useState<number | null>(null);
  const popupStarted = useRef(false);
  useEffect(() => {
    if (!client || !playerMode) return;
    const check = () => {
      if (popupStarted.current || !client.state) return;
      if (handshake && !client.verified) return;
      popupStarted.current = true;
      setPopupEnd(Date.now() + JOIN_COUNTDOWN_MS);
    };
    return client.subscribe(check);
  }, [client, playerMode, handshake]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playerMode) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [playerMode]);

  const popupLeft = popupEnd === null ? 0 : Math.ceil((popupEnd - now) / 1000);
  const popupOpen = playerMode && popupEnd !== null && popupLeft > 0;

  const flipLink = useCallback(async () => {
    const prev = linkState;
    const next: LinkState = prev === 'linked' ? 'independent' : 'linked';
    linkTouched.current = true;
    setLinkState(next);
    void callBridge('setLinkState', next);
    if (!hubAddress) return;
    const r = await api.hub.setRoomState(hubAddress, deviceToken, next);
    if (!r.ok) {
      setLinkState(prev);
      void callBridge('setLinkState', prev);
    }
  }, [linkState, hubAddress, deviceToken]);

  const connectedNow = handshake ? verified && status === 'open' : status === 'open';
  const lost = playerMode && !connectedNow && now - (lastVerifiedAt ?? startedAt) >= HUB_LOST_MS;
  const updateRequired =
    playerMode &&
    ((!!state && state.protocolVersion !== M2_PROTOCOL_VERSION) ||
      (!!hubInfo && hubInfo.protocolVersion !== M2_PROTOCOL_VERSION));

  const [addressDraft, setAddressDraft] = useState('');
  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeHubAddress(addressDraft);
    if (!url) return;
    void callBridge('setHubAddress', url);
    setAddressDraft('');
    setHubAddress(url);
  };
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

  // Info notices ("Updated to x.y.z", "Updating in 15 s") from the hub socket or the desktop shell.
  const { toasts, push } = useToasts();
  useEffect(() => {
    if (!client) return;
    return client.onToast((t) => {
      if (t.level === 'info') push(t.message, 'info', t.ttlMs);
    });
  }, [client, push]);
  useEffect(
    () =>
      onDesktopToast((message, level, ttlMs) => {
        if (level === 'info') push(message, 'info', ttlMs);
      }),
    [push],
  );

  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.version().then((r) => {
      if (live && r.ok) setVersion(r.data.version);
    });
    return () => {
      live = false;
    };
  }, []);

  const basePill = pillFor(status, state, tv);
  const pill: TvPill = playerMode
    ? playerPill(basePill, {
        updateRequired,
        unverified: authProblem === 'hub-unverified' && !verified,
        lost,
      })
    : authProblem === 'hub-unverified' && !verified
      ? 'unverified'
      : basePill;
  const pillText = pill === 'lost' ? S.tv.lookingFor(hubRoom) : S.tv.pill[pill];
  const np = state?.playback.nowPlaying ?? null;
  const requestUrl = state ? (state.qr.publicUrl ?? state.qr.joinUrl) : null;
  const lanUrlSmall = state && state.qr.joinUrl !== state.qr.lanUrl ? state.qr.lanUrl : null;

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
            {pillText}
          </span>
        </div>

        {playerMode && (
          <p data-testid="tv-link-caption" className="-mt-2 text-base text-neutral-400">
            {linkState === 'linked' ? S.tv.linkedTo(hubRoom ?? S.app.name) : S.tv.ownQueue}
          </p>
        )}

        {authProblem && !verified && (
          <div
            role="alert"
            data-testid="tv-auth-problem"
            className="flex items-center gap-2 rounded-xl bg-neutral-800 p-3 text-lg"
          >
            <span aria-hidden className="size-3 shrink-0 rounded-full bg-red-500" />
            {authProblem === 'hub-unverified' ? S.tv.hubUnverified : S.tv.playerRejected}
          </div>
        )}

        {updateRequired && (
          <div role="status" className="rounded-xl bg-neutral-800 p-3 text-lg">
            {S.tv.updateRequired}
          </div>
        )}

        {popupOpen && (
          <div
            role="dialog"
            aria-label={S.tv.join(hubRoom ?? S.app.name)}
            data-testid="join-popup"
            className="relative z-20 flex flex-col gap-3 rounded-2xl bg-neutral-800 p-4"
          >
            <p data-testid="join-countdown" className="text-2xl font-bold">
              {linkState === 'linked'
                ? S.tv.joining(hubRoom ?? S.app.name, popupLeft)
                : S.tv.staying(popupLeft)}
            </p>
            <button
              type="button"
              onClick={() => void flipLink()}
              className="self-start rounded-full bg-neutral-100 px-5 py-2 text-lg font-semibold text-black hover:bg-white"
            >
              {linkState === 'linked' ? S.tv.staySeparate : S.tv.join(hubRoom ?? S.app.name)}
            </button>
          </div>
        )}

        {lost && (
          <div data-testid="tv-lost" className="flex flex-col gap-2 rounded-xl bg-neutral-800 p-3">
            {hubAddress && (
              <p className="text-base text-neutral-300">
                {S.tv.lastAddress(displayHubAddress(hubAddress))}
              </p>
            )}
            <label htmlFor="hub-address" className="text-sm text-neutral-400">
              {S.tv.enterHub}
            </label>
            <form onSubmit={submitAddress} className="flex gap-2">
              <input
                id="hub-address"
                placeholder={S.tv.hubAddressPlaceholder}
                value={addressDraft}
                onChange={(e) => setAddressDraft(e.target.value)}
                className="min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-base text-neutral-100"
              />
              <button
                type="submit"
                disabled={!normalizeHubAddress(addressDraft)}
                className="rounded-lg bg-neutral-600 px-3 py-1.5 text-base font-semibold disabled:opacity-50"
              >
                {S.tv.connect}
              </button>
            </form>
          </div>
        )}

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
          {state && state.qr.wifi && state.qr.wifiSsid && (
            <p className="text-center text-[min(2.6vw,4.5vh)] font-semibold">
              {S.tv.wifiName(state.qr.wifiSsid)}
            </p>
          )}
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
          {lanUrlSmall && (
            <div data-testid="tv-lan" className="text-center text-base text-neutral-400 break-all">
              {displayAddress(lanUrlSmall)}
            </div>
          )}
          <YouTubeAttribution link={false} className="self-center text-neutral-100" />
        </div>

        {state?.partyCode && (
          <div className="absolute right-2 bottom-1 text-base text-neutral-500">
            {S.tv.partyCode(state.partyCode)}
          </div>
        )}

        {/* Bottom-right of the right column, above the party code; never over the player. */}
        <div
          aria-live="polite"
          data-testid="tv-toasts"
          className="absolute right-2 bottom-8 z-20 flex max-w-full flex-col items-end gap-1 pl-2"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-lg text-neutral-100 shadow"
            >
              {t.message}
            </div>
          ))}
        </div>

        {version && (
          <div
            data-testid="tv-version"
            className="absolute bottom-1 left-2 text-base text-neutral-500"
          >
            {S.tv.version(version)}
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
