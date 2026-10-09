import { expectedPosition } from '@room-jukebox/core';
import {
  SPIKE_MATRIX,
  type SpikePlayer,
  type SpikeResult,
  type SpikeState,
} from '@room-jukebox/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, HubConnection, resolveHub, type ConnectionStatus } from '../spike/hub.ts';
import { fmtDrift, fmtSec } from '../spike/format.ts';

/*
 * M0 spike control page: drives the hub (/api/spike/*), runs the 20-video matrix and shows players,
 * drift and results. Throwaway: replaced by /admin in M1. Query: ?hub=<origin> (optional).
 */

const MATRIX_STEP_MS = 25_000;
const MATRIX_ERROR_GRACE_MS = 2_000;

interface DriftStats {
  name: string;
  samples: number;
  maxAbs: number;
  sumAbs: number;
  since: number;
}

interface MatrixProgress {
  index: number;
  title: string;
  endsAt: number;
}

const titleOf = (videoId: string) => SPIKE_MATRIX.find((e) => e.videoId === videoId);

function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (cancelled() || Date.now() - started >= ms) resolve();
      else setTimeout(tick, 200);
    };
    tick();
  });
}

function toMarkdown(
  results: SpikeResult[],
  players: SpikePlayer[],
  drift: Record<string, DriftStats>,
  hub: string,
): string {
  const lines: string[] = [];
  lines.push(`## Room Jukebox M0 spike results (${new Date().toISOString()}, hub ${hub})`, '');
  lines.push(
    '### Players',
    '',
    '| name | origin | status | drift now | max abs drift | mean abs drift | samples | window |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of players) {
    const d = drift[p.id];
    lines.push(
      `| ${p.name} | ${p.origin} | ${p.status} | ${fmtDrift(p.drift)} | ${d ? d.maxAbs.toFixed(2) : '-'} | ${
        d && d.samples ? (d.sumAbs / d.samples).toFixed(2) : '-'
      } | ${d?.samples ?? 0} | ${d ? Math.round((Date.now() - d.since) / 1000) : 0} s |`,
    );
  }
  lines.push(
    '',
    '### Results',
    '',
    '| time | player | origin | videoId | title | expect | event | code | note |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const m = titleOf(r.videoId);
    lines.push(
      `| ${new Date(r.ts).toLocaleTimeString()} | ${r.playerName ?? r.playerId} | ${r.origin ?? ''} | ${
        r.videoId
      } | ${m?.title ?? ''} | ${m?.expect ?? ''} | ${r.event} | ${r.code ?? ''} | ${(r.note ?? '').replace(/\|/g, '/')} |`,
    );
  }
  return lines.join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http://<lan-ip> is not a secure context: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function Spike() {
  const hub = useMemo(() => resolveHub(window.location.search), []);
  const connRef = useRef<HubConnection | null>(null);
  const [state, setState] = useState<SpikeState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('looking');
  const [results, setResults] = useState<SpikeResult[]>([]);
  const [videoId, setVideoId] = useState(SPIKE_MATRIX[0]?.videoId ?? '');
  const [freeId, setFreeId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<MatrixProgress | null>(null);
  const [drift, setDrift] = useState<Record<string, DriftStats>>({});
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [expectedNow, setExpectedNow] = useState<number | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    const conn = new HubConnection(hub);
    connRef.current = conn;
    const unsubscribe = conn.subscribe(() => {
      setConnection(conn.status);
      if (conn.state) setState(conn.state);
    });
    conn.start();
    const tick = setInterval(() => {
      setNow(Date.now());
      const np = conn.state?.nowPlaying;
      setExpectedNow(np ? expectedPosition(np, conn.serverNow()) : null);
    }, 500);
    return () => {
      unsubscribe();
      conn.stop();
      clearInterval(tick);
      connRef.current = null;
    };
  }, [hub]);

  // Drift statistics per player, sampled once per second from the live state.
  useEffect(() => {
    const timer = setInterval(() => {
      const players = connRef.current?.state?.players ?? [];
      setDrift((prev) => {
        const next = { ...prev };
        for (const p of players) {
          if (p.drift === null || p.status === 'reconnecting') continue;
          const d = next[p.id] ?? {
            name: p.name,
            samples: 0,
            maxAbs: 0,
            sumAbs: 0,
            since: Date.now(),
          };
          const abs = Math.abs(p.drift);
          next[p.id] = {
            ...d,
            samples: d.samples + 1,
            maxAbs: Math.max(d.maxAbs, abs),
            sumAbs: d.sumAbs + abs,
          };
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshResults = useCallback(async () => {
    try {
      setResults(await api<SpikeResult[]>(hub, '/api/spike/results'));
    } catch (err) {
      setMessage(String(err));
    }
  }, [hub]);

  useEffect(() => {
    const first = setTimeout(() => void refreshResults(), 0);
    const timer = setInterval(() => void refreshResults(), 3000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refreshResults]);

  const command = async (path: string, body?: unknown) => {
    try {
      setMessage(null);
      return await api<SpikeState>(hub, `/api/spike/${path}`, 'POST', body);
    } catch (err) {
      setMessage(String(err));
      return null;
    }
  };

  const currentPosition = (): number => {
    const conn = connRef.current;
    const np = conn?.state?.nowPlaying;
    return np && conn ? expectedPosition(np, conn.serverNow()) : 0;
  };

  const runMatrix = async () => {
    const conn = connRef.current;
    if (!conn) return;
    cancelRef.current = false;
    // Evaluate every video on every player: one laptop's error must not skip it for the other.
    const wasAutoAdvance = conn.state?.autoAdvance ?? true;
    await command('auto-advance', { enabled: false });
    try {
      await runMatrixSteps(conn);
    } finally {
      await command('auto-advance', { enabled: wasAutoAdvance });
      setProgress(null);
    }
  };

  const runMatrixSteps = async (conn: HubConnection) => {
    for (let i = 0; i < SPIKE_MATRIX.length && !cancelRef.current; i++) {
      const entry = SPIKE_MATRIX[i]!;
      const played = await command('play', { videoId: entry.videoId });
      if (!played) break;
      const rev = played.revision;
      const outcome = new Map<string, { playing: boolean; code?: number }>();
      const observe = () => {
        for (const p of conn.state?.players ?? []) {
          if (p.status === 'reconnecting' && !outcome.has(p.id)) continue;
          const o = outcome.get(p.id) ?? { playing: false };
          if (p.playingRevision === rev) o.playing = true;
          if (p.lastError?.revision === rev) o.code = p.lastError.code;
          outcome.set(p.id, o);
        }
      };
      const unsubscribe = conn.subscribe(observe);
      observe();
      const endsAt = Date.now() + MATRIX_STEP_MS;
      setProgress({ index: i, title: entry.title, endsAt });
      let allErroredAt: number | null = null;
      await sleep(MATRIX_STEP_MS, () => {
        if (cancelRef.current) return true;
        const vals = [...outcome.values()];
        if (vals.length > 0 && vals.every((o) => o.code !== undefined)) {
          allErroredAt ??= Date.now();
          return Date.now() - allErroredAt > MATRIX_ERROR_GRACE_MS;
        }
        return false;
      });
      unsubscribe();
      observe();
      for (const [playerId, o] of outcome) {
        await api(hub, '/api/spike/report', 'POST', {
          playerId,
          videoId: entry.videoId,
          event: o.playing
            ? 'matrix-playing'
            : o.code !== undefined
              ? 'matrix-error'
              : 'matrix-no-playing',
          ...(o.code !== undefined ? { code: o.code } : {}),
          note: `expect ${entry.expect}; revision ${rev}${cancelRef.current ? '; cancelled' : ''}`,
        }).catch((err: unknown) => setMessage(String(err)));
      }
      if (outcome.size === 0) setMessage('No players connected: nothing recorded for this video.');
      void refreshResults();
    }
  };

  const players = state?.players ?? [];
  const np = state?.nowPlaying ?? null;
  const spread = (() => {
    const ds = players
      .filter((p) => p.drift !== null && p.status !== 'reconnecting')
      .map((p) => p.drift as number);
    return ds.length >= 2 ? Math.max(...ds) - Math.min(...ds) : null;
  })();

  const btn =
    'rounded bg-neutral-200 px-3 py-1.5 font-medium hover:bg-neutral-300 disabled:opacity-50 dark:bg-neutral-700 dark:hover:bg-neutral-600';

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Spike control</h1>
        <span>
          hub <code>{hub}</code> · socket <b>{connection}</b> · revision {state?.revision ?? '-'} ·
          auto-advance <b>{state ? (state.autoAdvance ? 'on' : 'off') : '-'}</b>
          {state && state.errorStreak >= 5 && (
            <b className="text-red-600">
              {' '}
              · {state.errorStreak} failures in a row: errors no longer skip
            </b>
          )}
        </span>
      </header>

      <section className="rounded border border-neutral-300 p-3 dark:border-neutral-700">
        <div className="mb-2">
          Now playing: <b>{np?.title ?? np?.videoId ?? 'nothing'}</b>{' '}
          {np && (
            <>
              <code>{np.videoId}</code> · {np.pausedAt !== null ? 'paused' : 'playing'} · expected{' '}
              {fmtSec(expectedNow)}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={videoId}
            onChange={(e) => setVideoId(e.target.value)}
            className="max-w-md rounded border px-2 py-1 dark:bg-neutral-800"
          >
            {SPIKE_MATRIX.map((e, i) => (
              <option key={e.videoId} value={e.videoId}>
                {i + 1}. {e.title} ({e.expect})
              </option>
            ))}
          </select>
          <button type="button" className={btn} onClick={() => void command('play', { videoId })}>
            Play
          </button>
          <input
            value={freeId}
            onChange={(e) => setFreeId(e.target.value)}
            placeholder="any videoId"
            className="w-36 rounded border px-2 py-1 font-mono dark:bg-neutral-800"
          />
          <button
            type="button"
            className={btn}
            disabled={!freeId.trim()}
            onClick={() => void command('play', { videoId: freeId.trim() })}
          >
            Play ID
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => void command('pause')}>
            Pause
          </button>
          <button type="button" className={btn} onClick={() => void command('resume')}>
            Resume
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => void command('seek', { position: Math.max(0, currentPosition() - 10) })}
          >
            Seek −10 s
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => void command('seek', { position: currentPosition() + 10 })}
          >
            Seek +10 s
          </button>
          <button type="button" className={btn} onClick={() => void command('next')}>
            Next
          </button>
          <button
            type="button"
            className={btn}
            disabled={!state || progress !== null}
            onClick={() => void command('auto-advance', { enabled: !state?.autoAdvance })}
          >
            Auto-advance {state?.autoAdvance ? 'off' : 'on'}
          </button>
          {progress ? (
            <button
              type="button"
              className={`${btn} !bg-red-600 text-white`}
              onClick={() => (cancelRef.current = true)}
            >
              Stop matrix ({progress.index + 1}/{SPIKE_MATRIX.length}: {progress.title},{' '}
              {Math.max(0, Math.ceil((progress.endsAt - now) / 1000))} s)
            </button>
          ) : (
            <button
              type="button"
              className={`${btn} !bg-sky-600 text-white`}
              onClick={() => void runMatrix()}
            >
              Run matrix (20 × 25 s)
            </button>
          )}
        </div>
        {message && (
          <p
            className={`mt-2 ${/^(Error|No players|Copy failed)/.test(message) ? 'text-red-600' : 'text-emerald-700'}`}
          >
            {message}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-1 flex items-center gap-3 text-lg font-semibold">
          Players
          <span className="text-sm font-normal">
            spread between players: <b>{fmtDrift(spread)}</b>
          </span>
          <button type="button" className={btn} onClick={() => setDrift({})}>
            Reset drift stats
          </button>
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b">
                {[
                  'name',
                  'origin',
                  'position',
                  'drift',
                  'max |drift|',
                  'mean |drift|',
                  'status',
                  'last seen',
                ].map((h) => (
                  <th key={h} className="px-2 py-1">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const d = drift[p.id];
                return (
                  <tr
                    key={p.id}
                    className="border-b border-neutral-200 font-mono dark:border-neutral-800"
                  >
                    <td className="px-2 py-1 font-sans">{p.name}</td>
                    <td className="px-2 py-1">{p.origin}</td>
                    <td className="px-2 py-1">{fmtSec(p.position, 2)}</td>
                    <td className="px-2 py-1">{fmtDrift(p.drift)}</td>
                    <td className="px-2 py-1">{d ? `${d.maxAbs.toFixed(2)} s` : '-'}</td>
                    <td className="px-2 py-1">
                      {d && d.samples ? `${(d.sumAbs / d.samples).toFixed(2)} s` : '-'}
                    </td>
                    <td className="px-2 py-1">{p.status}</td>
                    <td className="px-2 py-1">{Math.round((now - p.lastSeen) / 1000)} s ago</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {players.length === 0 && (
            <p className="p-2 text-neutral-500">
              No players yet. Open /tv?player=NAME on each laptop.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-1 flex flex-wrap items-center gap-2 text-lg font-semibold">
          Results ({results.length})
          <button type="button" className={btn} onClick={() => void refreshResults()}>
            Refresh
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => {
              if (!window.confirm('Delete all recorded results?')) return;
              void api(hub, '/api/spike/results', 'DELETE').then(refreshResults);
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => {
              const md = toMarkdown(results, players, drift, hub);
              setMarkdown(md);
              void copyText(md).then((ok) =>
                setMessage(
                  ok ? 'Copied results as Markdown.' : 'Copy failed: select the text below.',
                ),
              );
            }}
          >
            Copy results as Markdown
          </button>
        </h2>
        {markdown && (
          <textarea
            readOnly
            value={markdown}
            className="mb-2 h-40 w-full rounded border p-2 font-mono text-xs dark:bg-neutral-900"
          />
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b">
                {['time', 'player', 'origin', 'video', 'expect', 'event', 'code', 'note'].map(
                  (h) => (
                    <th key={h} className="px-2 py-1">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const m = titleOf(r.videoId);
                const bad = r.event !== 'matrix-playing' && m?.expect === 'play';
                return (
                  <tr
                    key={`${r.ts}-${i}`}
                    className={`border-b border-neutral-200 dark:border-neutral-800 ${bad ? 'bg-red-100 dark:bg-red-950' : ''}`}
                  >
                    <td className="px-2 py-1">{new Date(r.ts).toLocaleTimeString()}</td>
                    <td className="px-2 py-1">{r.playerName ?? r.playerId}</td>
                    <td className="px-2 py-1 font-mono">{r.origin ?? ''}</td>
                    <td className="px-2 py-1">
                      <code>{r.videoId}</code> {m?.title ?? ''}
                    </td>
                    <td className="px-2 py-1">{m?.expect ?? ''}</td>
                    <td className="px-2 py-1">{r.event}</td>
                    <td className="px-2 py-1">{r.code ?? ''}</td>
                    <td className="px-2 py-1">{r.note ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
