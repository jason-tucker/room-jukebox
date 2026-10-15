import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { HealthReply, LanReply, ReleaseNotes, SettingsPublic } from '@room-jukebox/shared';
import { M1_PROTOCOL_VERSION } from '@room-jukebox/shared';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import { AdminAuth } from './auth/admin.ts';
import type { AppContext, AppHooks, UpdaterApi } from './context.ts';
import { backup, BackupScheduler } from './db/backup.ts';
import type { BackupInfo } from './db/backup.ts';
import { closeDb, openDb } from './db/index.ts';
import { Repos } from './db/repo.ts';
import { installErrorHandler } from './errors.ts';
import { FriendlyCheck, dnsResolver } from './friendly.ts';
import type { HostResolver } from './friendly.ts';
import type { LanProvider } from './lan.ts';
import { lanReply, osLan } from './lan.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerGuestRoutes } from './routes/guest.ts';
import { issueLocalPlayerToken, registerSetupRoutes } from './routes/setup.ts';
import { registerUpdateRoutes } from './routes/updates.ts';
import { registerWs, WsHub } from './routes/ws.ts';
import { Session } from './session/session.ts';
import type { Secrets } from './settings.ts';
import { identitySecrets, SettingsService } from './settings.ts';
import { registerSpike } from './spike/plugin.ts';
import type { SpikeSession } from './spike/session.ts';
import type { FetchLike } from './youtube/client.ts';
import { createYouTubeApi } from './youtube/client.ts';
import { pacificDay, YouTubeService } from './youtube/service.ts';
import { registerMirror } from './youtube/mirror.ts';
import { SuggestService } from './youtube/suggest.ts';
import { searchUnofficial } from './youtube/unofficial.ts';

export const VERSION: string = pkg.version;

export type { AppHooks, SetupCompleteInfo, UpdateFeed, UpdateMode, UpdaterApi } from './context.ts';
export type { LanAddress, LanProvider } from './lan.ts';
export type { Secrets } from './settings.ts';
export type { FetchLike } from './youtube/client.ts';

/** Loopback origins used by Electron player windows (plan §3.2). */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

/** The default restart-rule window (plan §3.4). */
export const RESTART_GRACE_MS = 10_000;

export interface BuildAppOptions {
  loggerInstance?: FastifyBaseLogger;
  /** Directory of the built SPA. Static serving is skipped when it does not exist. */
  webRoot?: string;
  /** Skip Fastify's per-request info logs (the desktop log otherwise records every request). */
  disableRequestLogging?: boolean;
  /** Database at `<dataDir>/data.db`, backups in `<dataDir>/backups/`. Default `./data`. */
  dataDir?: string;
  /** At-rest encryption for the API key and Wi-Fi password (desktop: safeStorage). */
  secrets?: Secrets;
  /** This machine's IPv4 addresses (household gate subnets, QR address). Default: os. */
  lan?: LanProvider;
  hooks?: AppHooks;
  /** Server log file, for `GET /api/admin/logs/tail`. Without it the tail is empty. */
  logFile?: string;
  /** The installed version's bundled release notes (desktop). Standalone: none. */
  releaseNotes?: ReleaseNotes | null;
  /** The desktop auto-updater behind `/api/admin/update*`. Standalone: none (503). */
  updater?: UpdaterApi;

  /** M0 spike routes (`/api/spike/*`, role-less `/ws`). Default false. */
  spike?: boolean;
  /** M0 spike: directory for `spike-results.jsonl`. Defaults to `SPIKE_DATA_DIR` or `./data`. */
  spikeDataDir?: string;
  /** M0 spike: inject a session (tests). */
  spikeSession?: SpikeSession;
  /** M0 spike: start the first matrix video as soon as the server is up. */
  spikeAutoplay?: boolean;

  /** Tests: DNS lookup for the friendly address (default `dns.promises.lookup`). */
  resolveHost?: HostResolver;
  /** Tests: YouTube/oEmbed `fetch`. */
  fetch?: FetchLike;
  /** Tests: clock (ms). */
  now?: () => number;
  /** Tests: fallback picker randomness. */
  rng?: () => number;
  /** Restart-rule window; default 10 s. Negative disables the timer (tests call it directly). */
  restartGraceMs?: number;
  /** Nightly 04:00 backup (default true). */
  nightlyBackup?: boolean;
}

/** In-process API for the desktop shell (`app.jukebox`). */
export interface JukeboxApi {
  needsSetup(): boolean;
  settings(): SettingsPublic;
  lan(): LanReply;
  /** A fresh token for the hub's own TV window (`/tv?player=<playerId>&token=<token>`). */
  issueLocalPlayerToken(): { playerId: string; token: string };
  backupNow(): Promise<BackupInfo>;
  /** Live session (tests and diagnostics). */
  session: Session;
  /** Applies the restart rule now (tests). */
  applyRestartRule(): boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    jukebox: JukeboxApi;
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(options.loggerInstance ? { loggerInstance: options.loggerInstance } : { logger: false }),
    // Passed only when set: the top-level option is deprecated (a warning) in Fastify 5.
    ...(options.disableRequestLogging ? { disableRequestLogging: true } : {}),
    // The YouTube mirror's `/yt/*` wildcard carries YouTube's long static paths.
    routerOptions: { maxParamLength: 4096 },
  });
  installErrorHandler(app);

  // YouTube embeds fail (error 153) under `no-referrer`; never use helmet defaults here.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  await app.register(cors, {
    origin: [LOOPBACK_ORIGIN],
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  await app.register(websocket);

  const now = options.now ?? Date.now;
  const dataDir = options.dataDir ?? './data';
  const backupDir = join(dataDir, 'backups');
  const { db } = await openDb(join(dataDir, 'data.db'), backupDir);
  const repos = new Repos(db);
  const settings = new SettingsService(repos, options.secrets ?? identitySecrets, now);
  const lan = options.lan ?? osLan;
  const friendly = new FriendlyCheck({
    lan,
    settings: () => settings.data(),
    resolve: options.resolveHost ?? dnsResolver,
    now,
    onChange: () => session.touch(),
  });
  const fetchImpl = options.fetch ?? fetch;
  const api = createYouTubeApi(fetchImpl, (call) => {
    try {
      const at = now();
      repos.quotaLog.append(at, pacificDay(at), call.endpoint, call.units, call.status);
    } catch (err) {
      app.log.warn({ err }, 'quota log write failed');
    }
  });
  const youtube = new YouTubeService({
    repos,
    settings,
    api,
    unofficial: (q) => searchUnofficial(q, { fetch: fetchImpl }),
    now,
  });
  const session = new Session({
    repos,
    settings,
    youtube,
    lan,
    friendly,
    now,
    rng: options.rng ?? Math.random,
    onError: (err) => app.log.error({ err }, 'session persist failed'),
  });

  friendly.start();
  app.addHook('onClose', async () => friendly.stop());

  let hub: WsHub | null = null;
  const ctx: AppContext = {
    repos,
    settings,
    auth: new AdminAuth(repos, now),
    youtube,
    suggest: new SuggestService({ fetch: fetchImpl, now }),
    session,
    lan,
    friendly,
    hooks: options.hooks ?? {},
    now,
    backupDir,
    logFile: options.logFile,
    releaseNotes: options.releaseNotes ?? null,
    updater: options.updater ?? null,
    toastGuest: (guestId, level, message) => hub?.toastGuest(guestId, level, message),
  };
  const wsHub = new WsHub(ctx);
  hub = wsHub;
  // Relay the desktop updater's countdown and errors to every page (phones included).
  const unsubscribeUpdater = options.updater?.subscribe?.((s) => {
    if (s.message && (s.state === 'installing' || s.state === 'error')) {
      wsHub.toastAll(
        s.state === 'error' ? 'warn' : 'info',
        s.message,
        s.state === 'installing' ? 15000 : 8000,
      );
    }
  });
  if (unsubscribeUpdater) app.addHook('onClose', async () => unsubscribeUpdater());

  app.decorate('jukebox', {
    needsSetup: () => settings.needsSetup(),
    settings: () => settings.toPublic(),
    lan: () => lanReply(lan, settings.data(), friendly),
    issueLocalPlayerToken: () => issueLocalPlayerToken(ctx),
    backupNow: () => backup(db, backupDir, now(), 'manual'),
    session,
    applyRestartRule: () => session.applyRestartRule(),
  } satisfies JukeboxApi);

  app.get('/healthz', async (): Promise<HealthReply> => ({
    ok: true,
    version: VERSION,
    protocolVersion: M1_PROTOCOL_VERSION,
    needsSetup: settings.needsSetup(),
  }));

  app.get('/api/version', async () => ({
    version: VERSION,
    protocolVersion: M1_PROTOCOL_VERSION,
  }));

  await registerGuestRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerUpdateRoutes(app, ctx, VERSION);
  await registerSetupRoutes(app, ctx);
  await registerMirror(app, { fetch: fetchImpl, enabled: () => settings.mirrorEnabled(), now });

  const spikeHandler = options.spike
    ? await registerSpike(app, {
        dataDir: options.spikeDataDir ?? process.env.SPIKE_DATA_DIR ?? './data',
        ...(options.spikeSession ? { session: options.spikeSession } : {}),
        autoplay: options.spikeAutoplay ?? false,
        mountWs: false,
      })
    : undefined;
  await registerWs(app, ctx, wsHub, spikeHandler);
  wsHub.start();

  const timers: ReturnType<typeof setTimeout>[] = [];
  const grace = options.restartGraceMs ?? RESTART_GRACE_MS;
  if (grace >= 0) {
    const t = setTimeout(() => session.applyRestartRule(), grace);
    t.unref();
    timers.push(t);
  }
  const scheduler = new BackupScheduler({
    run: () => backup(db, backupDir, Date.now(), 'nightly'),
    onError: (err) => app.log.error({ err }, 'nightly backup failed'),
  });
  if (options.nightlyBackup ?? true) scheduler.start();

  app.addHook('onClose', async () => {
    for (const t of timers) clearTimeout(t);
    scheduler.stop();
    wsHub.stop();
    session.close();
    closeDb(db);
  });

  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const hasWeb = existsSync(webRoot);
  if (hasWeb) await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  // SPA history fallback: client-side routes such as /tv and /admin get index.html.
  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({
      error: { code: 'not-found', message: `No route for ${request.method} ${request.url}` },
    });
  });

  return app;
}
