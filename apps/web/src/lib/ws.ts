import {
  M2ServerMessageSchema,
  type AdminState,
  type ClientMessage,
  type M2ClientMessage,
  type M2ServerMessage,
  type GuestState,
  type PlayerState,
  type Role,
  type ServerMessage,
} from '@room-jukebox/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type ApiResult } from './api.ts';
import { desktopAdminToken, type PlayerProof } from './jukebox.ts';

/**
 * Role-aware WebSocket client for `GET /ws` (contract-m1 "WebSocket messages").
 *
 * - reconnects with exponential backoff 1 s → 30 s;
 * - pings every 2 s and keeps an NTP-style clock offset (median of the last 5 samples);
 * - keeps the latest projection for its role and resyncs when it notices a missed broadcast
 *   (a heartbeat whose `changeSeq` is ahead of the last state it saw): guests and admins fetch
 *   `GET /api/session` / `GET /api/admin/session`; the player has no HTTP snapshot route in M1,
 *   so it reconnects and takes the state the server sends on connect. Those reconnects are
 *   coalesced and rate-limited (`PLAYER_RESYNC_MIN_INTERVAL_MS`), and skipped when a `state`
 *   catches up first, so a lagging `changeSeq` can never turn into a reconnect storm.
 */

export type StateFor<R extends Role> = R extends 'admin'
  ? AdminState
  : R extends 'player'
    ? PlayerState
    : GuestState;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';
export type Toast = Extract<ServerMessage, { type: 'toast' }>;
/** M2 messages the session client does not handle itself (`rekey`, `replica`, `replicaDelta`). */
export type ExtraMessage = Extract<M2ServerMessage, { type: 'rekey' | 'replica' | 'replicaDelta' }>;

/**
 * Player join handshake (contract-m2 §1): on open the client sends `auth` before anything else and
 * accepts nothing from the hub until its `authOk` proof verifies.
 */
export interface Handshake {
  auth: (nonceP: string) => Promise<PlayerProof>;
  verify: (nonceP: string, nonceH: string, proof: string) => Promise<boolean>;
}

/** Why the last handshake failed: our proof was refused (`bye bad-proof`) or the hub's was bad. */
export type AuthProblem = 'hub-unverified' | 'player-rejected' | null;

/** 16 random bytes, base64url. */
export function makeNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const PING_INTERVAL_MS = 2000;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** Heartbeats arrive every 5 s; a socket silent for this long is treated as dead. */
export const SILENCE_LIMIT_MS = 15_000;
const OFFSET_SAMPLE_WINDOW = 5;
/** At most one resync-by-reconnect per this window for the player role. */
export const PLAYER_RESYNC_MIN_INTERVAL_MS = 10_000;

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
  /** M2 player handshake; without it the socket behaves as in M1. */
  handshake?: Handshake | null;
  /** `rekey` / `replica` / `replicaDelta` from a verified hub. */
  onExtra?: (msg: ExtraMessage, client: SessionClient<R>) => void;
}

function defaultSnapshot<R extends Role>(
  role: R,
  group?: string,
): (() => Promise<StateFor<R> | null>) | null {
  const unwrap = <T>(r: ApiResult<T>): T | null => (r.ok ? r.data : null);
  if (role === 'guest') {
    return async () => unwrap(await api.guest.session(group)) as StateFor<R> | null;
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
  /** With a handshake: whether the current socket's hub proved itself. */
  verified = false;
  /** Last time a verified socket was open (ms); null before the first one. */
  lastVerifiedAt: number | null = null;
  authProblem: AuthProblem = null;

  #samples: OffsetSample[] = [];
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #lastSeq: number | null = null;
  #acceptAny = true;
  #resyncing = false;
  /** Newest `changeSeq` a heartbeat announced (player reconnect resync). */
  #heardSeq: number | null = null;
  #lastReconnectResyncAt: number | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<() => void>();
  #toastListeners = new Set<(t: Toast) => void>();
  #opts: SessionClientOptions<R>;
  #WS: typeof WebSocket;
  #snapshot: (() => Promise<StateFor<R> | null>) | null;
  /** Handshake in progress: the nonce sent and messages held until `authOk` verifies. */
  #nonceP: string | null = null;
  #held: M2ServerMessage[] | null = null;

  constructor(opts: SessionClientOptions<R>) {
    this.role = opts.role;
    this.#opts = opts;
    this.#WS = opts.WebSocketImpl ?? WebSocket;
    this.#snapshot =
      opts.fetchSnapshot === undefined
        ? defaultSnapshot(opts.role, opts.query?.group)
        : opts.fetchSnapshot;
  }

  get #handshake(): Handshake | null {
    return this.#opts.handshake ?? null;
  }

  /** Socket open and, with a handshake, verified. */
  get #ready(): boolean {
    return this.#ws?.readyState === this.#WS.OPEN && (!this.#handshake || this.verified);
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

  send(msg: ClientMessage | { type: 'replicaAck'; snapshotAt: number }): boolean {
    if (!this.#ready) return false;
    this.#ws!.send(JSON.stringify(msg));
    return true;
  }

  #sendRaw(msg: M2ClientMessage): void {
    if (this.#ws?.readyState === this.#WS.OPEN) this.#ws.send(JSON.stringify(msg));
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
      if (this.verified) this.lastVerifiedAt = Date.now();
      this.send({ type: 'ping', t0: Date.now() });
    }, PING_INTERVAL_MS);
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#pingTimer);
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  /** Fetches a fresh snapshot (or, for the player, reconnects). */
  async resync(countAsGap = true): Promise<void> {
    if (!this.#snapshot) {
      this.#reconnectResync();
      return;
    }
    if (countAsGap) this.resyncs += 1;
    if (this.#resyncing) return;
    this.#resyncing = true;
    try {
      const snap = await this.#snapshot();
      if (snap && !this.#stopped) this.#applyState(snap);
    } finally {
      this.#resyncing = false;
    }
  }

  /** Reconnect now, or once when the rate-limit window ends if a `state` has not caught up. */
  #reconnectResync(): void {
    if (this.#reconnectTimer !== undefined) return; // already scheduled: coalesce
    const last = this.#lastReconnectResyncAt;
    const wait = last === null ? 0 : last + PLAYER_RESYNC_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.#lastReconnectResyncAt = Date.now();
      this.resyncs += 1;
      this.#ws?.close();
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (!this.#stopped && this.#behind()) this.#reconnectResync();
    }, wait);
  }

  #behind(): boolean {
    return this.#lastSeq === null || (this.#heardSeq !== null && this.#heardSeq > this.#lastSeq);
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
      this.verified = false;
      if (this.#handshake) {
        void this.#startHandshake(ws);
      } else {
        this.send({ type: 'ping', t0: Date.now() });
      }
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
      const parsed = M2ServerMessageSchema.safeParse(data);
      if (!parsed.success) return;
      this.#receive(parsed.data);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.verified) this.lastVerifiedAt = Date.now();
      this.verified = false;
      this.#nonceP = null;
      this.#held = null;
      if (this.#stopped) return;
      this.status = this.status === 'connecting' ? 'connecting' : 'reconnecting';
      this.#emit();
      this.#scheduleRetry();
    };
  }

  async #startHandshake(ws: WebSocket): Promise<void> {
    const hs = this.#handshake!;
    const nonceP = makeNonce();
    this.#nonceP = nonceP;
    this.#held = [];
    let p: PlayerProof;
    try {
      p = await hs.auth(nonceP);
    } catch {
      ws.close();
      return;
    }
    if (this.#ws !== ws || this.#nonceP !== nonceP) return;
    this.#sendRaw({ type: 'auth', deviceId: p.deviceId, nonceP, proof: p.proof });
  }

  async #verifyAuthOk(nonceH: string, proof: string): Promise<void> {
    const ws = this.#ws;
    const nonceP = this.#nonceP;
    if (!ws || !nonceP || this.verified) return;
    let ok: boolean;
    try {
      ok = await this.#handshake!.verify(nonceP, nonceH, proof);
    } catch {
      ok = false;
    }
    if (this.#ws !== ws) return;
    if (!ok) {
      this.authProblem = 'hub-unverified';
      this.#held = null;
      this.#emit();
      ws.close();
      return;
    }
    this.verified = true;
    this.authProblem = null;
    this.lastVerifiedAt = Date.now();
    const held = this.#held ?? [];
    this.#held = null;
    this.send({ type: 'ping', t0: Date.now() });
    for (const m of held) this.#handle(m);
    this.#emit();
  }

  #receive(msg: M2ServerMessage): void {
    if (!this.#handshake) {
      this.#handle(msg);
      return;
    }
    if (msg.type === 'authOk') {
      void this.#verifyAuthOk(msg.nonceH, msg.proof);
      return;
    }
    if (msg.type === 'bye' && !this.verified) {
      this.lastBye = msg.reason;
      if (msg.reason === 'bad-proof') this.authProblem = 'player-rejected';
      this.#emit();
      return;
    }
    if (!this.verified) {
      // Hold everything until the hub's proof checks out (verification is async).
      this.#held?.push(msg);
      return;
    }
    this.#handle(msg);
  }

  #handle(msg: M2ServerMessage): void {
    switch (msg.type) {
      case 'authOk':
        return;
      case 'rekey':
      case 'replica':
      case 'replicaDelta':
        this.#opts.onExtra?.(msg, this);
        return;
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
        this.#heardSeq = msg.changeSeq;
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
  /** With a handshake: the hub proved itself on the current socket. */
  verified: boolean;
  authProblem: AuthProblem;
  lastVerifiedAt: number | null;
}

const viewOf = <R extends Role>(client: SessionClient<R>): SessionView<R> => ({
  state: client.state,
  status: client.status,
  client,
  verified: client.verified,
  authProblem: client.authProblem,
  lastVerifiedAt: client.lastVerifiedAt,
});

/**
 * Live projection for a role. `enabled: false` holds off connecting (the guest page first needs the
 * cookie from `POST /api/guest/hello`; the admin page needs a login). `origin` points the socket
 * at another host (a Player's TV talks to the hub); `handshake` and `onExtra` are read when the
 * client is created, so pass `handshakeKey` to say when they change.
 */
export function useSessionState<R extends Role>(
  role: R,
  opts: {
    enabled?: boolean;
    query?: Record<string, string>;
    origin?: string;
    handshake?: Handshake | null;
    handshakeKey?: string;
    onExtra?: SessionClientOptions<R>['onExtra'];
  } = {},
): SessionView<R> {
  const enabled = opts.enabled ?? true;
  const queryKey = JSON.stringify(opts.query ?? {});
  const origin = opts.origin;
  const handshakeKey = opts.handshakeKey ?? '';
  const live = useRef({ handshake: opts.handshake, onExtra: opts.onExtra });
  useEffect(() => {
    live.current = { handshake: opts.handshake, onExtra: opts.onExtra };
  });
  const [view, setView] = useState<SessionView<R>>({
    state: null,
    status: 'connecting',
    client: null,
    verified: false,
    authProblem: null,
    lastVerifiedAt: null,
  });

  useEffect(() => {
    if (!enabled) return;
    const query = JSON.parse(queryKey) as Record<string, string>;
    const client = new SessionClient<R>({
      role,
      query,
      ...(origin ? { origin } : {}),
      handshake: live.current.handshake ?? null,
      onExtra: (msg, c) => live.current.onExtra?.(msg, c),
    });
    const update = () => setView(viewOf(client));
    const unsubscribe = client.subscribe(update);
    update();
    client.start();
    return () => {
      unsubscribe();
      client.stop();
    };
  }, [role, enabled, queryKey, origin, handshakeKey]);

  return view;
}
