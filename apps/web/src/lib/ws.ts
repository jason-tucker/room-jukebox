import {
  ServerMessageSchema,
  type AdminState,
  type ClientMessage,
  type GuestState,
  type PlayerState,
  type Role,
  type ServerMessage,
} from '@room-jukebox/shared';
import { useEffect, useState } from 'react';
import { api, type ApiResult } from './api.ts';
import { desktopAdminToken } from './jukebox.ts';

/**
 * Role-aware WebSocket client for `GET /ws` (contract-m1 "WebSocket messages").
 *
 * - reconnects with exponential backoff 1 s → 30 s;
 * - pings every 2 s and keeps an NTP-style clock offset (median of the last 5 samples);
 * - keeps the latest projection for its role and resyncs when it notices a missed broadcast
 *   (a heartbeat whose `changeSeq` is ahead of the last state it saw): guests and admins fetch
 *   `GET /api/session` / `GET /api/admin/session`; the player has no HTTP snapshot route in M1,
 *   so it reconnects and takes the state the server sends on connect.
 */

export type StateFor<R extends Role> = R extends 'admin'
  ? AdminState
  : R extends 'player'
    ? PlayerState
    : GuestState;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';
export type Toast = Extract<ServerMessage, { type: 'toast' }>;

export const PING_INTERVAL_MS = 2000;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** Heartbeats arrive every 5 s; a socket silent for this long is treated as dead. */
export const SILENCE_LIMIT_MS = 15_000;
const OFFSET_SAMPLE_WINDOW = 5;

interface OffsetSample {
  t0: number;
  t1: number;
  t2: number;
}

/** Same rule as `estimateOffset` in @room-jukebox/core (copied so the client stays standalone). */
export function estimateOffset(samples: readonly OffsetSample[]): number {
  const recent = samples.slice(-OFFSET_SAMPLE_WINDOW).map((s) => s.t1 - (s.t0 + s.t2) / 2);
  if (recent.length === 0) return 0;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
}

export interface SessionClientOptions<R extends Role> {
  role: R;
  /** Extra query parameters (the player's `player` and `token`). */
  query?: Record<string, string>;
  /** Page origin; defaults to `window.location.origin`. */
  origin?: string;
  WebSocketImpl?: typeof WebSocket;
  /** HTTP snapshot for resync; defaults by role (none for the player). */
  fetchSnapshot?: (() => Promise<StateFor<R> | null>) | null;
  /** Admin bearer for `&token=`; defaults to the desktop bridge. */
  tokenProvider?: () => Promise<string | null>;
}

function defaultSnapshot<R extends Role>(role: R): (() => Promise<StateFor<R> | null>) | null {
  const unwrap = <T>(r: ApiResult<T>): T | null => (r.ok ? r.data : null);
  if (role === 'guest') {
    return async () => unwrap(await api.guest.session()) as StateFor<R> | null;
  }
  if (role === 'admin') {
    return async () => unwrap(await api.admin.session()) as StateFor<R> | null;
  }
  return null;
}

export class SessionClient<R extends Role = Role> {
  readonly role: R;
  state: StateFor<R> | null = null;
  status: ConnectionStatus = 'connecting';
  lastMessageAt = 0;
  lastBye: string | null = null;
  /** Number of HTTP/reconnect resyncs triggered by a changeSeq gap (diagnostics and tests). */
  resyncs = 0;

  #samples: OffsetSample[] = [];
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #lastSeq: number | null = null;
  #acceptAny = true;
  #resyncing = false;
  #listeners = new Set<() => void>();
  #toastListeners = new Set<(t: Toast) => void>();
  #opts: SessionClientOptions<R>;
  #WS: typeof WebSocket;
  #snapshot: (() => Promise<StateFor<R> | null>) | null;

  constructor(opts: SessionClientOptions<R>) {
    this.role = opts.role;
    this.#opts = opts;
    this.#WS = opts.WebSocketImpl ?? WebSocket;
    this.#snapshot =
      opts.fetchSnapshot === undefined ? defaultSnapshot(opts.role) : opts.fetchSnapshot;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  onToast(fn: (t: Toast) => void): () => void {
    this.#toastListeners.add(fn);
    return () => {
      this.#toastListeners.delete(fn);
    };
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  offsetMs(): number {
    return estimateOffset(this.#samples);
  }

  /** Current server clock estimate in ms. */
  serverNow(): number {
    return Date.now() + this.offsetMs();
  }

  send(msg: ClientMessage): boolean {
    if (this.#ws?.readyState !== this.#WS.OPEN) return false;
    this.#ws.send(JSON.stringify(msg));
    return true;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
    // First paint does not wait for the socket.
    if (this.#snapshot) void this.resync(false);
    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState !== this.#WS.OPEN) return;
      if (Date.now() - this.lastMessageAt > SILENCE_LIMIT_MS) {
        this.#ws.close();
        return;
      }
      this.send({ type: 'ping', t0: Date.now() });
    }, PING_INTERVAL_MS);
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#pingTimer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  /** Fetches a fresh snapshot (or, for the player, reconnects). */
  async resync(countAsGap = true): Promise<void> {
    if (countAsGap) this.resyncs += 1;
    if (!this.#snapshot) {
      this.#ws?.close();
      return;
    }
    if (this.#resyncing) return;
    this.#resyncing = true;
    try {
      const snap = await this.#snapshot();
      if (snap && !this.#stopped) this.#applyState(snap);
    } finally {
      this.#resyncing = false;
    }
  }

  async #url(): Promise<string> {
    const origin = this.#opts.origin ?? window.location.origin;
    const q = new URLSearchParams({ role: this.role, ...this.#opts.query });
    if (this.role === 'admin' && !q.has('token')) {
      const token = await (this.#opts.tokenProvider ?? desktopAdminToken)();
      if (token) q.set('token', token);
    }
    return `${origin.replace(/^http/, 'ws')}/ws?${q.toString()}`;
  }

  async #connect(): Promise<void> {
    let ws: WebSocket;
    try {
      const url = await this.#url();
      if (this.#stopped) return;
      ws = new this.#WS(url);
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.status = 'open';
      this.lastMessageAt = Date.now();
      this.#acceptAny = true;
      this.send({ type: 'ping', t0: Date.now() });
      this.#emit();
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastMessageAt = Date.now();
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = ServerMessageSchema.safeParse(data);
      if (!parsed.success) return;
      this.#handle(parsed.data);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#stopped) return;
      this.status = this.status === 'connecting' ? 'connecting' : 'reconnecting';
      this.#emit();
      this.#scheduleRetry();
    };
  }

  #handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'pong':
        this.#samples = [
          ...this.#samples,
          { t0: msg.t0, t1: msg.serverTime, t2: Date.now() },
        ].slice(-OFFSET_SAMPLE_WINDOW);
        this.#emit();
        return;
      case 'state':
        // A state message is a full projection, so a gap before it needs no extra fetch.
        this.#applyState(msg.state as StateFor<R>);
        return;
      case 'heartbeat':
        if (this.#lastSeq === null || msg.changeSeq > this.#lastSeq) void this.resync();
        return;
      case 'toast':
        for (const fn of this.#toastListeners) fn(msg);
        return;
      case 'bye':
        this.lastBye = msg.reason;
        this.#emit();
        return;
    }
  }

  #applyState(state: StateFor<R>): void {
    if (!this.#acceptAny && this.#lastSeq !== null && state.changeSeq < this.#lastSeq) return;
    this.#acceptAny = false;
    this.#lastSeq = state.changeSeq;
    this.state = state;
    this.#emit();
  }

  #scheduleRetry(): void {
    const delay = backoffDelay(this.#attempt);
    this.#attempt += 1;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      if (!this.#stopped) void this.#connect();
    }, delay);
  }
}

export interface SessionView<R extends Role> {
  state: StateFor<R> | null;
  status: ConnectionStatus;
  client: SessionClient<R> | null;
}

/**
 * Live projection for a role. `enabled: false` holds off connecting (the guest page first needs the
 * cookie from `POST /api/guest/hello`; the admin page needs a login).
 */
export function useSessionState<R extends Role>(
  role: R,
  opts: { enabled?: boolean; query?: Record<string, string> } = {},
): SessionView<R> {
  const enabled = opts.enabled ?? true;
  const queryKey = JSON.stringify(opts.query ?? {});
  const [view, setView] = useState<SessionView<R>>({
    state: null,
    status: 'connecting',
    client: null,
  });

  useEffect(() => {
    if (!enabled) return;
    const query = JSON.parse(queryKey) as Record<string, string>;
    const client = new SessionClient<R>({ role, query });
    const update = () => setView({ state: client.state, status: client.status, client });
    const unsubscribe = client.subscribe(update);
    update();
    client.start();
    return () => {
      unsubscribe();
      client.stop();
    };
  }, [role, enabled, queryKey]);

  return view;
}
