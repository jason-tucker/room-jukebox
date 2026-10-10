/** Small display formatters shared by the pages. */

/** 245 → "4:05", 3725 → "1:02:05"; null/undefined → "". */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Local clock time, e.g. "4:00 AM". */
export function fmtClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Seconds of the current track that have played, from the hub's timing fields. */
export function elapsedSec(
  np: { startedAt: number; pausedAt: number | null; accumulatedPauseMs: number },
  serverNow: number,
): number {
  const until = np.pausedAt ?? serverNow;
  return Math.max(0, (until - np.startedAt - np.accumulatedPauseMs) / 1000);
}

/** 0..1 progress, or null when the duration is unknown. */
export function progressFraction(
  elapsed: number,
  durationSec: number | null | undefined,
): number | null {
  if (!durationSec || durationSec <= 0) return null;
  return Math.min(1, Math.max(0, elapsed / durationSec));
}
