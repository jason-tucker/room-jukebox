/**
 * Sync math (plan §3.4): NTP-style clock offset, expected position and the dead-band seek rule.
 * Pure functions, no clocks or timers: callers pass `now` in.
 */

/** One ping round trip: client send time, server time in the reply, client receive time (ms). */
export interface OffsetSample {
  t0: number;
  t1: number;
  t2: number;
}

/** Number of most recent samples the offset estimate uses. */
export const OFFSET_SAMPLE_WINDOW = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Estimated `serverClock − clientClock` in ms: the median over the last 5 samples of
 * `t1 − (t0 + t2) / 2` (assumes a symmetric path). Returns 0 with no samples.
 */
export function estimateOffset(samples: readonly OffsetSample[]): number {
  const recent = samples.slice(-OFFSET_SAMPLE_WINDOW);
  if (recent.length === 0) return 0;
  return median(recent.map((s) => s.t1 - (s.t0 + s.t2) / 2));
}

/** The timing fields of a now-playing record (structurally matches the spike/session schemas). */
export interface PlaybackClock {
  startedAt: number;
  pausedAt: number | null;
  accumulatedPauseMs: number;
}

/**
 * Where the group should be, in seconds: `(serverNow − startedAt − pausedTotal) / 1000`, frozen at
 * `pausedAt` while paused, never negative.
 */
export function expectedPosition(state: PlaybackClock, serverNow: number): number {
  const until = state.pausedAt ?? serverNow;
  return Math.max(0, (until - state.startedAt - state.accumulatedPauseMs) / 1000);
}

export interface SeekInput {
  /** Expected position in seconds. */
  expected: number;
  /** `getCurrentTime()` in seconds. */
  actual: number;
  /** Local ms timestamp of the last seek this player made, or null if none. */
  lastSeekAt: number | null;
  /** Local ms timestamp now. */
  now: number;
  deadBandSec?: number;
  minSeekIntervalMs?: number;
}

export interface SeekDecision {
  seek: boolean;
  to?: number;
  reason: 'within-dead-band' | 'rate-limited' | 'behind' | 'ahead';
}

export const DEFAULT_DEAD_BAND_SEC = 1.25;
export const DEFAULT_MIN_SEEK_INTERVAL_MS = 2500;

/**
 * Seek only when |drift| exceeds the dead band, and at most once per `minSeekIntervalMs`
 * (`seekTo` snaps to a keyframe, so micro-seeks make drift worse).
 */
export function decideSeek(input: SeekInput): SeekDecision {
  const deadBand = input.deadBandSec ?? DEFAULT_DEAD_BAND_SEC;
  const minInterval = input.minSeekIntervalMs ?? DEFAULT_MIN_SEEK_INTERVAL_MS;
  const drift = input.actual - input.expected;
  if (Math.abs(drift) <= deadBand) return { seek: false, reason: 'within-dead-band' };
  if (input.lastSeekAt !== null && input.now - input.lastSeekAt < minInterval) {
    return { seek: false, reason: 'rate-limited' };
  }
  return { seek: true, to: input.expected, reason: drift < 0 ? 'behind' : 'ahead' };
}
