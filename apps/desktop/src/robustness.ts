/** Pure helpers for startup retries, the relaunch breaker and the renderer heartbeat. */

export interface RetryOptions {
  intervalMs: number;
  timeoutMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, err: unknown) => void;
}

function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/** Retries `listen` every `intervalMs` while the port is taken, up to `timeoutMs`; other errors throw at once. */
export async function listenWithRetry(listen: () => Promise<void>, o: RetryOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + o.timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await listen();
      return;
    } catch (err) {
      if (!isAddrInUse(err) || now() + o.intervalMs > deadline) throw err;
      o.onRetry?.(attempt, err);
      await sleep(o.intervalMs);
    }
  }
}

export const RELAUNCH_LIMIT = 3;
export const RELAUNCH_WINDOW_MS = 5 * 60 * 1000;

/** Crash-loop breaker: relaunch unless 3 relaunches already happened in the last 5 min. */
export function relaunchDecision(
  history: readonly number[],
  now: number,
  limit = RELAUNCH_LIMIT,
  windowMs = RELAUNCH_WINDOW_MS,
): { relaunch: boolean; history: number[] } {
  const recent = history.filter((t) => now - t < windowMs && t <= now);
  if (recent.length >= limit) return { relaunch: false, history: recent };
  return { relaunch: true, history: [...recent, now] };
}

/** Renderer → main heartbeat: stale after `timeoutMs` without a beat (reset on every load). */
export class HeartbeatWatch {
  private last: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(timeoutMs: number, now: () => number = Date.now) {
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.last = now();
  }

  beat(): void {
    this.last = this.now();
  }

  stale(): boolean {
    return this.now() - this.last >= this.timeoutMs;
  }
}
