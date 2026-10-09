import { estimateOffset, type OffsetSample } from '@room-jukebox/core';
import {
  SpikeServerMessageSchema,
  type SpikeClientMessage,
  type SpikeState,
} from '@room-jukebox/shared';

/**
 * Hub origin for API and WebSocket calls: `?hub=<origin>` (scheme optional, e.g.
 * `?hub=192.168.1.20:8080`) or, without it, the page's own origin.
 */
export function resolveHub(search: string): string {
  const raw = new URLSearchParams(search).get('hub');
  if (!raw) return window.location.origin;
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).origin;
  } catch {
    return window.location.origin;
  }
}

export async function api<T = unknown>(
  hub: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${hub}${path}`, init);
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export type ConnectionStatus = 'looking' | 'open' | 'reconnecting';

const PING_INTERVAL_MS = 2000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** Heartbeats arrive every 5 s; a socket silent for this long is treated as dead. */
const SILENCE_LIMIT_MS = 15_000;

/**
 * The spike WebSocket client: reconnects with exponential backoff (1 s → 30 s), pings every 2 s for
 * the NTP-style clock offset, and keeps the latest `SpikeState`.
 */
export class HubConnection {
  state: SpikeState | null = null;
  status: ConnectionStatus = 'looking';
  samples: OffsetSample[] = [];
  lastMessageAt = 0;
  readonly wsUrl: string;
  #ws: WebSocket | null = null;
  #attempt = 0;
  #stopped = true;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #listeners = new Set<() => void>();
  #onOpen: ((conn: HubConnection) => void) | undefined;

  constructor(hub: string, onOpen?: (conn: HubConnection) => void) {
    this.wsUrl = `${hub.replace(/^http/, 'ws')}/ws`;
    this.#onOpen = onOpen;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }

  /** Current server clock estimate in ms. */
  serverNow(): number {
    return Date.now() + this.offsetMs();
  }

  offsetMs(): number {
    return estimateOffset(this.samples);
  }

  send(msg: SpikeClientMessage): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
    this.#pingTimer = setInterval(() => {
      if (this.#ws?.readyState !== WebSocket.OPEN) return;
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
    this.#ws?.close();
    this.#ws = null;
  }

  #connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.status = 'open';
      this.lastMessageAt = Date.now();
      this.send({ type: 'ping', t0: Date.now() });
      this.#onOpen?.(this);
      this.#emit();
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = SpikeServerMessageSchema.safeParse(data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === 'pong') {
        this.samples = [...this.samples, { t0: msg.t0, t1: msg.serverTime, t2: Date.now() }].slice(
          -5,
        );
      } else if (msg.type === 'state') {
        this.state = msg.state;
      }
      this.#emit();
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#stopped) return;
      if (this.status === 'open') this.status = 'reconnecting';
      this.#emit();
      this.#scheduleRetry();
    };
  }

  #scheduleRetry(): void {
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      if (!this.#stopped) this.#connect();
    }, delay);
  }
}
