/*
 * In-browser mock hub for `VITE_MOCK=1 pnpm --filter web dev`. Replaces `fetch` for /api/* and
 * /healthz and `WebSocket` for /ws with an in-memory server that follows docs/contract-m1.md, so
 * the pages can be developed without apps/server. Never bundled into a normal build (main.tsx
 * imports it only when VITE_MOCK is "1").
 *
 * Handy inputs: owner password "jukebox1"; open /setup?mocksetup=1 to see the wizard; resolve
 * "blockedvid1" for a not-embeddable verdict and "toolongvid1" for an over-limit one; search
 * "quota" to switch to the unofficial provider (as when the API quota runs out), "budget" for the
 * per-guest budget error, "down" for YouTube not answering, "off" to turn guest search off (reload
 * to undo), "low" to flip the low banner, "zero" to exhaust guest search.
 */
import type {
  AdminState,
  EntryAdmin,
  GuestState,
  M1NowPlaying,
  PlayerInfo,
  PlayerState,
  PlaylistInfo,
  ResolveReply,
  SearchProvider,
  ServerMessage,
  SettingsPublic,
  VideoCard,
} from '@room-jukebox/shared';

interface Video {
  videoId: string;
  title: string;
  channelTitle: string;
  durationSec: number;
}

const CATALOG: Video[] = [
  {
    videoId: 'M7lc1UVf-VE',
    title: 'YouTube Developers Live: Embedded Web Player Customization',
    channelTitle: 'Google for Developers',
    durationSec: 1384,
  },
  {
    videoId: 'dQw4w9WgXcQ',
    title: 'Rick Astley - Never Gonna Give You Up',
    channelTitle: 'Rick Astley',
    durationSec: 213,
  },
  {
    videoId: '9bZkp7q19f0',
    title: 'PSY - GANGNAM STYLE',
    channelTitle: 'officialpsy',
    durationSec: 252,
  },
  {
    videoId: 'OPf0YbXqDm0',
    title: 'Mark Ronson - Uptown Funk ft. Bruno Mars',
    channelTitle: 'Mark Ronson',
    durationSec: 270,
  },
  {
    videoId: 'fJ9rUzIMcZQ',
    title: 'Queen – Bohemian Rhapsody',
    channelTitle: 'Queen Official',
    durationSec: 360,
  },
  {
    videoId: 'JGwWNGJdvx8',
    title: 'Ed Sheeran - Shape of You',
    channelTitle: 'Ed Sheeran',
    durationSec: 263,
  },
];

type NowAdmin = EntryAdmin & Pick<M1NowPlaying, 'startedAt' | 'pausedAt' | 'accumulatedPauseMs'>;

const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const PASSWORD = 'jukebox1';
const GUEST_ID = 'mock-guest-1';

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const err = (status: number, code: string, message: string, retryAfterSec?: number) =>
  json(status, {
    error: { code, message, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) },
  });

class MockHub {
  revision = 1;
  changeSeq = 1;
  playbackState: 'playing' | 'paused' | 'idle' | 'blocked' = 'playing';
  nowPlaying: NowAdmin | null = null;
  queue: EntryAdmin[] = [];
  history: EntryAdmin[] = [];
  nextId = 1;
  guestName: string | null = null;
  noticeAccepted = false;
  loggedIn = sessionStorage.getItem('rjmock.admin') === '1';
  failedLogins = 0;
  needsSetup = new URLSearchParams(location.search).has('mocksetup');
  searchLow = false;
  searchOff = false;
  searchProvider: SearchProvider = 'youtube-api';
  guestSearchesLeft: number | null = 5;
  searchUsage = { guests: 3, owner: 1, resetsAt: Date.now() + 6 * 3600_000 };
  lastErrors: AdminState['lastErrors'] = [];
  lastError: PlayerState['lastError'] = null;
  backups: { path: string; bytes: number; at: number }[] = [
    {
      path: 'C:\\Users\\owner\\AppData\\Roaming\\Room Jukebox\\backups\\jukebox-2026-10-09.db',
      bytes: 182_272,
      at: Date.now() - 20 * 3600_000,
    },
  ];
  lan = {
    addresses: [
      { interface: 'Wi-Fi', address: '192.168.1.20', cidr: '192.168.1.0/24' },
      { interface: 'Ethernet', address: '10.0.0.5', cidr: '10.0.0.0/24' },
    ],
    chosen: '192.168.1.20',
  };
  settings: SettingsPublic = {
    roomName: 'Basement',
    lanPort: 8080,
    country: 'US',
    limits: {
      maxPendingPerGuest: 5,
      cooldownSec: 5,
      allowDuplicates: true,
      maxDurationSec: 480,
      search: {
        perGuestPerDay: 5,
        perGuestIntervalSec: 20,
        perIpPerDay: 8,
        publicPerDay: 20,
        ownerReserve: 15,
        dailyTotal: 95,
      },
    },
    fallbackPlaylists: [],
    wifi: { ssid: 'PartyNet', security: 'WPA', hidden: false },
    hasWifiPassword: true,
    hasApiKey: true,
    apiKeyLast4: 'x9Qa',
    tvDisplayId: null,
    autoStart: true,
    autoFullscreen: true,
    kiosk: false,
    publicMode: false,
    hubId: 'mock-hub',
    hubEpoch: 1,
    search: { unofficialFallback: true },
  };
  playlists: PlaylistInfo[] = [
    {
      id: 'pl1',
      playlistId: 'PLmock1',
      title: 'Party classics',
      url: 'https://www.youtube.com/playlist?list=PLmock1',
      videoCount: 42,
      importedAt: Date.now() - 86_400_000,
    },
  ];
  players: PlayerInfo[] = [
    {
      id: 'tv-hub',
      name: 'Basement TV',
      lanAddress: '127.0.0.1',
      status: 'online',
      role: 'leader',
      lastSeen: Date.now(),
      drift: 0.2,
    },
  ];
  sockets = new Set<MockSocket>();

  constructor() {
    this.#play(this.#entry(CATALOG[1]!, 'Sam', 'auto'));
    this.queue.push(this.#entry(CATALOG[2]!, 'Alex', 'request', 'guest-2'));
    this.queue.push(this.#entry(CATALOG[3]!, null, 'request', GUEST_ID));
    setInterval(() => this.#tick(), 1000);
    setInterval(() => this.#heartbeat(), 5000);
  }

  #entry(
    v: Video,
    requesterName: string | null,
    source: 'request' | 'auto',
    guestId: string | null = null,
  ): EntryAdmin {
    return {
      id: `e${this.nextId++}`,
      videoId: v.videoId,
      title: v.title,
      thumbnail: thumb(v.videoId),
      durationSec: v.durationSec,
      requesterName,
      source,
      status: 'queued',
      enqueuedAt: Date.now(),
      requesterGuestId: guestId,
    };
  }

  #play(e: EntryAdmin | undefined) {
    if (this.nowPlaying) {
      const done: EntryAdmin & Partial<NowAdmin> = { ...this.nowPlaying, status: 'done' };
      delete done.pausedAt;
      delete done.accumulatedPauseMs;
      this.history = [done, ...this.history].slice(0, 10);
    }
    this.revision += 1;
    if (!e) {
      const v = CATALOG[Math.floor(Math.random() * CATALOG.length)]!;
      e = this.#entry(v, null, 'auto');
    }
    this.nowPlaying = {
      ...e,
      status: 'playing',
      startedAt: Date.now(),
      pausedAt: null,
      accumulatedPauseMs: 0,
    };
    this.playbackState = 'playing';
  }

  advance() {
    this.#play(this.queue.shift());
    this.broadcast();
  }

  #tick() {
    const np = this.nowPlaying;
    if (!np || np.pausedAt !== null || !np.durationSec) return;
    // No real player reports `ended` in pure mock mode, so time out on duration (+2 s grace).
    if (Date.now() - np.startedAt - np.accumulatedPauseMs > (np.durationSec + 2) * 1000)
      this.advance();
  }

  #heartbeat() {
    for (const s of this.sockets) {
      s.deliver({
        type: 'heartbeat',
        serverTime: Date.now(),
        changeSeq: this.changeSeq,
        revision: this.revision,
      });
    }
  }

  #pub(e: EntryAdmin) {
    const { requesterGuestId, ...rest } = e;
    delete rest.idempotencyKey;
    return { ...rest, ...(requesterGuestId === GUEST_ID ? { mine: true } : {}) };
  }

  guestState(): GuestState {
    const np = this.nowPlaying;
    return {
      revision: this.revision,
      changeSeq: this.changeSeq,
      serverTime: Date.now(),
      protocolVersion: 1,
      roomName: this.settings.roomName,
      playback: {
        state: this.playbackState,
        nowPlaying: np
          ? {
              ...this.#pub(np),
              startedAt: np.startedAt,
              pausedAt: np.pausedAt,
              accumulatedPauseMs: np.accumulatedPauseMs,
            }
          : null,
      },
      queue: this.queue.map((e) => this.#pub(e)),
      recentHistory: this.history.map((e) => this.#pub(e)),
      search: {
        enabled: !this.searchOff && this.guestSearchesLeft !== null,
        remaining: this.guestSearchesLeft,
        low: this.searchLow,
        provider: this.searchProvider,
      },
      limits: {
        maxPendingPerGuest: this.settings.limits.maxPendingPerGuest,
        cooldownSec: this.settings.limits.cooldownSec,
        maxDurationSec: this.settings.limits.maxDurationSec,
        allowDuplicates: this.settings.limits.allowDuplicates,
      },
      flags: { hasApiKey: this.settings.hasApiKey, publicMode: false },
    };
  }

  adminState(): AdminState {
    return {
      ...this.guestState(),
      queue: this.queue,
      recentHistory: this.history,
      players: this.players.map((p) => ({ ...p, lastSeen: Date.now() })),
      fallback: { playlists: this.playlists, poolSize: 57, consecutiveFailures: 0 },
      searchUsage: this.searchUsage,
      settings: { ...this.settings, fallbackPlaylists: this.playlists },
      lastErrors: this.lastErrors,
    };
  }

  playerState(): PlayerState {
    const g = this.guestState();
    const w = this.settings.wifi;
    return {
      revision: g.revision,
      changeSeq: g.changeSeq,
      serverTime: g.serverTime,
      protocolVersion: 1,
      roomName: g.roomName,
      playback: g.playback,
      upcoming: this.queue
        .slice(0, 5)
        .map((e) => ({ title: e.title, requesterName: e.requesterName })),
      qr: {
        lanUrl: `http://${this.lan.chosen}:${this.settings.lanPort}/`,
        publicUrl: null,
        wifi: w
          ? `WIFI:T:${w.security};S:${w.ssid};P:secret123;${w.hidden ? 'H:true;' : ''};`
          : null,
      },
      partyCode: null,
      me: { playerId: 'tv-hub', role: 'leader' },
      status: this.playbackState === 'blocked' ? 'blocked' : 'online',
      lastError: this.lastError,
      selfTest: { autoplayBlocked: false },
    };
  }

  broadcast() {
    this.changeSeq += 1;
    for (const s of this.sockets) s.sendState();
  }

  toastGuests(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    for (const s of this.sockets)
      if (s.role === 'guest') s.deliver({ type: 'toast', level, message, ttlMs: 4000 });
  }

  resolve(input: string): ResolveReply | null {
    const id = input.trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    if (id === 'blockedvid1') {
      return {
        videoId: id,
        title: 'A video that refuses embedding',
        thumbnail: thumb(id),
        channelTitle: 'Somebody',
        durationSec: 200,
        playable: false,
        reason: 'not-embeddable',
        source: 'youtube',
      };
    }
    if (id === 'toolongvid1') {
      return {
        videoId: id,
        title: 'Ten-hour mix',
        thumbnail: thumb(id),
        channelTitle: 'Mixes',
        durationSec: 36_000,
        playable: false,
        reason: 'too-long',
        source: 'owner',
      };
    }
    const v = CATALOG.find((c) => c.videoId === id) ?? {
      videoId: id,
      title: `Video ${id}`,
      channelTitle: 'Unknown channel',
      durationSec: 240,
    };
    return { ...v, thumbnail: thumb(id), playable: true, source: 'youtube' };
  }

  search(q: string): VideoCard[] {
    const words = q.toLowerCase();
    const hits = CATALOG.filter((c) => c.title.toLowerCase().includes(words));
    const rows: VideoCard[] = (hits.length ? hits : CATALOG).map((v) => ({
      ...v,
      thumbnail: thumb(v.videoId),
      playable: true,
      source: 'youtube',
    }));
    rows.splice(1, 0, {
      videoId: 'blockedvid1',
      title: `${q} (live performance)`,
      channelTitle: 'Somebody',
      thumbnail: thumb('blockedvid1'),
      durationSec: 200,
      playable: false,
      reason: 'age-restricted',
      source: 'youtube',
    });
    return rows;
  }

  addRequest(
    videoId: string,
    name: string | null,
    guestId: string | null,
    owner: boolean,
  ): Response {
    const r = this.resolve(videoId);
    if (!r) return err(422, 'not-found', 'Video not found');
    if (!r.playable) return err(422, r.reason ?? 'not-found', 'Not playable');
    if (
      !owner &&
      this.queue.filter((e) => e.requesterGuestId === guestId).length >=
        this.settings.limits.maxPendingPerGuest
    ) {
      return err(429, 'too-many-pending', 'Too many pending');
    }
    const dup = this.queue.find((e) => e.videoId === videoId);
    if (dup && !this.settings.limits.allowDuplicates) return err(409, 'duplicate', 'Duplicate');
    const v: Video = {
      videoId: r.videoId,
      title: r.title,
      channelTitle: r.channelTitle ?? '',
      durationSec: r.durationSec ?? 240,
    };
    const e = this.#entry(v, owner ? 'Owner' : name, 'request', guestId);
    this.queue.push(e);
    this.broadcast();
    if (!owner) this.toastGuests(`${e.title} is in the queue (#${this.queue.length})`);
    return json(201, { entry: this.#pub(e), duplicate: false });
  }

  transport(action: string) {
    const np = this.nowPlaying;
    if (action === 'skip') return this.advance();
    if (!np) return;
    if (action === 'pause' && np.pausedAt === null) {
      np.pausedAt = Date.now();
      this.playbackState = 'paused';
    } else if (action === 'play' && np.pausedAt !== null) {
      np.accumulatedPauseMs += Date.now() - np.pausedAt;
      np.pausedAt = null;
      this.playbackState = 'playing';
    }
    this.broadcast();
  }

  onClient(s: MockSocket, msg: { type: string; [k: string]: unknown }) {
    if (msg.type === 'ping') {
      s.deliver({ type: 'pong', t0: Number(msg.t0), serverTime: Date.now() });
    } else if (msg.type === 'event' && msg.revision === this.revision) {
      if (msg.kind === 'ended') this.advance();
      else if (msg.kind === 'error') {
        const at = Date.now();
        this.lastError = {
          code: String(msg.code ?? ''),
          message: `YouTube error ${String(msg.code)}`,
          at,
        };
        this.lastErrors = [
          {
            at,
            videoId: this.nowPlaying?.videoId ?? '',
            code: String(msg.code ?? ''),
            message: 'Player error',
          },
          ...this.lastErrors,
        ].slice(0, 5);
        this.toastGuests(`Couldn't play ${this.nowPlaying?.title ?? 'a song'}, skipped`, 'warn');
        this.advance();
      } else if (msg.kind === 'autoplayBlocked') {
        this.playbackState = 'blocked';
        this.broadcast();
      } else if (msg.kind === 'playing' && this.playbackState === 'blocked') {
        this.playbackState = 'playing';
        this.broadcast();
      }
    }
  }

  async handle(method: string, url: URL, body: unknown): Promise<Response> {
    const p = url.pathname;
    const b = (body ?? {}) as Record<string, unknown>;
    const adminOnly = p.startsWith('/api/admin/') && p !== '/api/admin/login';
    if (adminOnly && !this.loggedIn) return err(401, 'unauthorized', 'Log in first');

    switch (`${method} ${p}`) {
      case 'GET /healthz':
        return json(200, {
          ok: true,
          version: '0.0.0-mock',
          protocolVersion: 1,
          needsSetup: this.needsSetup,
        });
      case 'POST /api/guest/hello':
        if (typeof b.name === 'string') this.guestName = b.name;
        return json(200, {
          guestId: GUEST_ID,
          name: this.guestName,
          noticeAccepted: this.noticeAccepted,
        });
      case 'POST /api/guest/notice':
        this.noticeAccepted = true;
        return json(200, { ok: true });
      case 'POST /api/guest/name':
        this.guestName = (b.name as string | null) ?? null;
        return json(200, { ok: true });
      case 'POST /api/guest/forget':
        this.guestName = null;
        this.noticeAccepted = false;
        for (const e of this.queue)
          if (e.requesterGuestId === GUEST_ID)
            Object.assign(e, { requesterGuestId: null, requesterName: null });
        this.broadcast();
        return json(200, { ok: true });
      case 'GET /api/session':
        return json(200, this.guestState());
      case 'GET /api/videos/resolve': {
        const r = this.resolve(url.searchParams.get('input') ?? '');
        return r ? json(200, r) : err(404, 'not-found', 'No such video');
      }
      case 'POST /api/requests':
        return this.addRequest(
          String(b.videoId),
          (b.name as string) ?? this.guestName,
          GUEST_ID,
          false,
        );
      case 'POST /api/search':
      case 'POST /api/admin/search': {
        const q = String(b.q ?? '');
        const owner = p.startsWith('/api/admin');
        if (q === 'budget') return err(429, 'search-budget', 'Guest search budget used');
        if (q === 'down') return err(502, 'youtube-unavailable', 'YouTube did not answer');
        if (!owner && q === 'off') {
          this.searchOff = true;
          this.broadcast();
          return err(503, 'search-disabled', 'Search is disabled');
        }
        if (q === 'quota') this.searchProvider = 'unofficial';
        if (!owner && q === 'low') this.searchLow = !this.searchLow;
        if (!owner && q === 'zero') this.guestSearchesLeft = 0;
        else if (!owner && this.guestSearchesLeft !== null)
          this.guestSearchesLeft = Math.max(0, this.guestSearchesLeft - 1);
        if (owner) this.searchUsage.owner += 1;
        else this.searchUsage.guests += 1;
        this.broadcast();
        return json(200, {
          results: this.search(q),
          remaining: owner ? null : this.guestSearchesLeft,
          cached: false,
          provider: this.searchProvider,
        });
      }
      case 'GET /api/privacy.json':
        return err(404, 'not-found', 'Mock has no privacy document (the page shows its fallback)');
      case 'POST /api/admin/login':
        if (this.failedLogins >= 5) return err(429, 'login-throttled', 'Too many attempts', 30);
        if (b.password !== PASSWORD) {
          this.failedLogins += 1;
          return err(401, 'bad-password', 'Wrong password');
        }
        this.failedLogins = 0;
        this.loggedIn = true;
        sessionStorage.setItem('rjmock.admin', '1');
        return json(200, { ok: true });
      case 'POST /api/admin/logout':
        this.loggedIn = false;
        sessionStorage.removeItem('rjmock.admin');
        return json(200, { ok: true });
      case 'GET /api/admin/session':
        return json(200, this.adminState());
      case 'POST /api/admin/transport':
        this.transport(String(b.action));
        return json(200, { ok: true });
      case 'POST /api/admin/queue/reorder': {
        const from = this.queue.findIndex((e) => e.id === b.id);
        if (from < 0) return err(404, 'not-found', 'No such entry');
        const [e] = this.queue.splice(from, 1);
        this.queue.splice(Math.min(Number(b.toIndex), this.queue.length), 0, e!);
        this.broadcast();
        return json(200, { ok: true });
      }
      case 'POST /api/admin/requests':
        return this.addRequest(String(b.videoId), 'Owner', null, true);
      case 'GET /api/admin/settings':
        return json(200, this.adminState().settings);
      case 'PATCH /api/admin/settings': {
        const { youtubeApiKey, wifiPassword, ...rest } = b as Record<string, unknown>;
        Object.assign(this.settings, rest);
        if (youtubeApiKey !== undefined) {
          this.settings.hasApiKey = youtubeApiKey !== null;
          this.settings.apiKeyLast4 =
            typeof youtubeApiKey === 'string' ? youtubeApiKey.slice(-4) : null;
        }
        if (wifiPassword !== undefined) this.settings.hasWifiPassword = !!wifiPassword;
        if (rest.wifi === null) this.settings.hasWifiPassword = false;
        this.broadcast();
        return json(200, this.adminState().settings);
      }
      case 'POST /api/admin/password':
        if (b.current !== PASSWORD) return err(401, 'bad-password', 'Wrong password');
        this.loggedIn = false;
        sessionStorage.removeItem('rjmock.admin');
        return json(200, { ok: true });
      case 'POST /api/admin/playlists': {
        const u = String(b.url ?? '');
        if (u.includes('private')) return err(422, 'playlist-private', 'Private playlist');
        const m = u.match(/list=([\w-]+)/);
        if (!m) return err(422, 'playlist-not-found', 'Not a playlist');
        const pl: PlaylistInfo = {
          id: `pl${this.nextId++}`,
          playlistId: m[1]!,
          title: `Playlist ${m[1]}`,
          url: u,
          videoCount: 25,
          importedAt: Date.now(),
        };
        this.playlists.push(pl);
        this.broadcast();
        return json(200, pl);
      }
      case 'GET /api/admin/searches':
        return json(200, {
          ...this.searchUsage,
          dailyTotal: this.settings.limits.search.dailyTotal,
        });
      case 'POST /api/admin/backup': {
        const bk = {
          path: `C:\\backups\\jukebox-${Date.now()}.db`,
          bytes: 190_000,
          at: Date.now(),
        };
        this.backups.unshift(bk);
        return json(200, bk);
      }
      case 'GET /api/admin/backups':
        return json(200, { backups: this.backups });
      case 'GET /api/admin/players':
        return json(200, { players: this.adminState().players });
      case 'GET /api/admin/lan':
        return json(200, {
          ...this.lan,
          lanUrl: `http://${this.lan.chosen}:${this.settings.lanPort}/`,
        });
      case 'PATCH /api/admin/lan':
        this.lan.chosen = String(b.chosen);
        this.broadcast();
        return json(200, { ok: true });
      case 'GET /api/admin/logs/tail':
        return json(200, { lines: ['[mock] no server log'] });
      case 'GET /api/setup/status':
        if (!this.needsSetup) return err(409, 'setup-done', 'Setup is finished');
        return json(200, {
          needsSetup: true,
          lan: {
            addresses: [
              { interface: 'Loopback', address: '127.0.0.1', cidr: '127.0.0.0/8' },
              ...this.lan.addresses,
            ],
            chosen: this.lan.chosen,
            lanUrl: `http://${this.lan.chosen}:8080/`,
          },
        });
      case 'POST /api/setup':
        if (!this.needsSetup) return err(409, 'setup-done', 'Setup is finished');
        this.needsSetup = false;
        this.settings.roomName = String(b.roomName);
        this.broadcast();
        return json(200, {
          ok: true,
          token: 'mock-desktop-token',
          playerToken: 'mock-player-token',
        });
    }

    // Parameterised routes.
    let m = p.match(/^\/api\/admin\/queue\/(.+)$/);
    if (m && method === 'DELETE') {
      this.queue = this.queue.filter((e) => e.id !== decodeURIComponent(m![1]!));
      this.broadcast();
      return json(200, { ok: true });
    }
    m = p.match(/^\/api\/admin\/playlists\/([^/]+)(\/refresh)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      if (method === 'DELETE') this.playlists = this.playlists.filter((x) => x.id !== id);
      else if (m[2])
        this.playlists = this.playlists.map((x) =>
          x.id === id ? { ...x, importedAt: Date.now() } : x,
        );
      this.broadcast();
      return json(200, { ok: true });
    }
    m = p.match(/^\/api\/admin\/guests\/(.+)$/);
    if (m && method === 'DELETE') {
      const gid = decodeURIComponent(m[1]!);
      for (const e of [...this.queue, ...this.history]) {
        if (e.requesterGuestId === gid)
          Object.assign(e, { requesterGuestId: null, requesterName: null });
      }
      this.broadcast();
      return json(200, { ok: true });
    }
    return err(404, 'not-found', `Mock has no route ${method} ${p}`);
  }
}

let hub: MockHub;

class MockSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  role: string;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    this.role = new URL(url).searchParams.get('role') ?? 'guest';
    setTimeout(() => {
      if (this.readyState !== 0) return;
      if (this.role === 'admin' && !hub.loggedIn) {
        this.readyState = 3;
        this.onclose?.(new CloseEvent('close', { code: 4401 }));
        return;
      }
      this.readyState = 1;
      hub.sockets.add(this);
      this.onopen?.(new Event('open'));
      this.sendState();
    }, 50);
  }

  sendState() {
    const state =
      this.role === 'admin'
        ? hub.adminState()
        : this.role === 'player'
          ? hub.playerState()
          : hub.guestState();
    this.deliver({ type: 'state', state });
  }

  deliver(msg: ServerMessage) {
    if (this.readyState !== 1) return;
    setTimeout(
      () => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) })),
      5,
    );
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    hub.onClient(this, JSON.parse(data) as { type: string });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    hub.sockets.delete(this);
    setTimeout(() => this.onclose?.(new CloseEvent('close', { code: 1000 })), 0);
  }
}

export function installMock(): void {
  hub = new MockHub();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.origin,
    );
    if (
      url.origin !== location.origin ||
      !(url.pathname.startsWith('/api/') || url.pathname === '/healthz')
    ) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    await new Promise((r) => setTimeout(r, 120)); // feel like a network
    return hub.handle(method, url, body);
  };
  const RealWS = window.WebSocket;
  window.WebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const u = new URL(String(url));
    if (u.pathname === '/ws') return new MockSocket(u.href);
    return new RealWS(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  console.info(
    '[room-jukebox] VITE_MOCK=1: using the in-browser mock hub (owner password "jukebox1").',
  );
}
