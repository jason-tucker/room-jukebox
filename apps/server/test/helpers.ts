import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from '@fastify/websocket';
import type { ServerMessage, SetupReply } from '@room-jukebox/shared';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { BuildAppOptions, LanAddress } from '../src/app.ts';

export type App = Awaited<ReturnType<typeof buildApp>>;

export const LAN: LanAddress[] = [
  { interface: 'Wi-Fi', address: '192.168.1.20', cidr: '192.168.1.20/24' },
  { interface: 'vEthernet (WSL)', address: '172.20.0.1', cidr: '172.20.0.1/20' },
];

export interface FakeVideo {
  id: string;
  title: string;
  channel?: string;
  duration?: string;
  embeddable?: boolean;
  privacy?: string;
  ytRating?: string;
  live?: string;
  /** Absent from videos.list and 404 on oEmbed. */
  missing?: boolean;
}

/** 11-character IDs. */
export const vid = (n: number | string): string => `vid${String(n).padStart(8, '0')}`;

/** A programmable fake for the YouTube Data API and oEmbed. */
export class FakeYouTube {
  videos = new Map<string, FakeVideo>();
  playlists = new Map<string, { status?: number; items: { id: string; privacy?: string }[] }>();
  searchResults = new Map<string, string[]>();
  calls: { endpoint: string; params: URLSearchParams }[] = [];
  quotaExceeded = false;
  down = false;

  add(...videos: FakeVideo[]): this {
    for (const v of videos) this.videos.set(v.id, v);
    return this;
  }

  count(endpoint: string): number {
    return this.calls.filter((c) => c.endpoint === endpoint).length;
  }

  fetch = async (input: string): Promise<Response> => {
    const url = new URL(input);
    const endpoint = url.pathname.split('/').pop() ?? '';
    this.calls.push({ endpoint, params: url.searchParams });
    if (this.down) throw new Error('offline');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const apiError = (status: number, reason: string) =>
      json(status, { error: { code: status, message: reason, errors: [{ reason }] } });

    if (endpoint === 'search') {
      if (this.quotaExceeded) return apiError(403, 'quotaExceeded');
      const q = url.searchParams.get('q') ?? '';
      const ids = this.searchResults.get(q) ?? [...this.videos.keys()];
      return json(200, {
        items: ids.map((id) => ({
          id: { kind: 'youtube#video', videoId: id },
          snippet: { title: this.videos.get(id)?.title ?? id, channelTitle: 'Ch' },
        })),
      });
    }
    if (endpoint === 'videos') {
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const items = ids
        .map((id) => this.videos.get(id))
        .filter((v): v is FakeVideo => v !== undefined && !v.missing)
        .map((v) => ({
          id: v.id,
          snippet: {
            title: v.title,
            channelTitle: v.channel ?? 'Channel',
            liveBroadcastContent: v.live ?? 'none',
            thumbnails: { medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` } },
          },
          contentDetails: {
            duration: v.duration ?? 'PT3M30S',
            ...(v.ytRating ? { contentRating: { ytRating: v.ytRating } } : {}),
          },
          status: { embeddable: v.embeddable ?? true, privacyStatus: v.privacy ?? 'public' },
        }));
      return json(200, { items });
    }
    if (endpoint === 'playlistItems') {
      const pl = this.playlists.get(url.searchParams.get('playlistId') ?? '');
      if (!pl) return apiError(404, 'playlistNotFound');
      if (pl.status) return apiError(pl.status, 'playlistItemsNotAccessible');
      return json(200, {
        items: pl.items.map((i) => ({
          snippet: { title: this.videos.get(i.id)?.title ?? 'Private video' },
          contentDetails: { videoId: i.id },
          status: { privacyStatus: i.privacy ?? 'public' },
        })),
      });
    }
    if (endpoint === 'oembed') {
      const target = new URL(url.searchParams.get('url') ?? '');
      const list = target.searchParams.get('list');
      if (list) return json(200, { title: `Playlist ${list}` });
      const v = this.videos.get(target.searchParams.get('v') ?? '');
      if (!v || v.missing) return new Response('Not Found', { status: 404 });
      if (v.embeddable === false || v.privacy === 'private')
        return new Response('Unauthorized', { status: 401 });
      return json(200, { title: v.title, author_name: v.channel ?? 'Channel' });
    }
    return new Response('nope', { status: 500 });
  };
}

export interface TestHub {
  app: App;
  dataDir: string;
  yt: FakeYouTube;
  clock: { now: number; advance(ms: number): void };
  close(): Promise<void>;
  /** Rebuilds the app on the same data directory (restart). */
  restart(extra?: Partial<BuildAppOptions>): Promise<App>;
}

export async function makeHub(extra: Partial<BuildAppOptions> = {}): Promise<TestHub> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rj-server-'));
  const yt = new FakeYouTube();
  const clock = {
    now: Date.UTC(2026, 9, 24, 23, 0, 0),
    advance(ms: number) {
      clock.now += ms;
    },
  };
  const opts = (more: Partial<BuildAppOptions>): BuildAppOptions => ({
    webRoot: '/nonexistent',
    dataDir,
    lan: { addresses: () => LAN },
    fetch: yt.fetch,
    now: () => clock.now,
    rng: () => 0,
    restartGraceMs: -1,
    nightlyBackup: false,
    ...extra,
    ...more,
  });
  const hub: TestHub = {
    app: await buildApp(opts({})),
    dataDir,
    yt,
    clock,
    async close() {
      await hub.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
    async restart(more = {}) {
      await hub.app.close();
      hub.app = await buildApp(opts(more));
      await hub.app.ready();
      return hub.app;
    },
  };
  await hub.app.ready();
  return hub;
}

export const LOOPBACK = '127.0.0.1';

export async function setup(
  app: App,
  body: Record<string, unknown> = {},
): Promise<SetupReply & { playerId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/setup',
    remoteAddress: LOOPBACK,
    payload: { password: 'correct horse', roomName: 'Basement', noticeAccepted: true, ...body },
  });
  if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  const reply = res.json() as SetupReply;
  const playerId = app.jukebox.session.players()[0]?.id ?? '';
  return { ...reply, playerId };
}

/** A guest client: keeps its cookie across calls. */
export class Guest {
  cookie = '';
  readonly app: App;
  readonly ip: string;
  constructor(app: App, ip = '192.168.1.50') {
    this.app = app;
    this.ip = ip;
  }

  async req(opts: InjectOptions & { url: string }) {
    const res = await this.app.inject({
      ...opts,
      remoteAddress: this.ip,
      headers: { ...(opts.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    const set = res.cookies.find((c) => c.name === 'rj_guest');
    if (set) this.cookie = set.value ? `rj_guest=${set.value}` : '';
    return res;
  }

  async hello(name?: string) {
    return (
      await this.req({ method: 'POST', url: '/api/guest/hello', payload: name ? { name } : {} })
    ).json() as { guestId: string };
  }

  request(videoId: string, idempotencyKey: string = crypto.randomUUID()) {
    return this.req({ method: 'POST', url: '/api/requests', payload: { videoId, idempotencyKey } });
  }
}

export interface WsClient {
  ws: WebSocket;
  messages: ServerMessage[];
  next<T extends ServerMessage['type']>(
    type: T,
    predicate?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  send(msg: unknown): void;
}

export async function connectWs(
  app: App,
  path: string,
  opts: { ip?: string; headers?: Record<string, string> } = {},
): Promise<WsClient> {
  const messages: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  const ws: WebSocket = await app.injectWS(
    path,
    {
      headers: opts.headers ?? {},
      socket: { remoteAddress: opts.ip ?? LOOPBACK },
    } as never,
    {
      onInit(socket) {
        socket.on('message', (raw: Buffer) => {
          messages.push(JSON.parse(String(raw)) as ServerMessage);
          for (const w of waiters.splice(0)) w();
        });
      },
    },
  );
  const next: WsClient['next'] = async (type, predicate = () => true) => {
    for (;;) {
      const i = messages.findIndex(
        (m) => m.type === type && predicate(m as Extract<ServerMessage, { type: typeof type }>),
      );
      if (i >= 0) return messages.splice(0, i + 1).pop() as never;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  return { ws, messages, next, send: (msg) => ws.send(JSON.stringify(msg)) };
}

/** Round-trips a ping so every earlier message on `c` has been processed. */
export async function flush(c: WsClient): Promise<void> {
  const t0 = Math.random();
  c.send({ type: 'ping', t0 });
  await c.next('pong', (m) => m.t0 === t0);
}
