import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@room-jukebox/shared';
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen } from 'electron';
import { buildApp } from 'server/src/app.ts';
import type { BuildAppOptions } from 'server/src/app.ts';
import { parseArgs } from './args';
import type { CliOptions } from './args';
import { startBroadcaster, startListener } from './beacon';
import { pickTvDisplay } from './display';
import { setupLogging } from './logging';
import { runSelfCheck } from './selfcheck';
import type { SelfCheck } from './selfcheck';
import { startStaticServer } from './static-server';

// Paths first: %APPDATA%\RoomJukebox and %APPDATA%\RoomJukebox\logs regardless of package name.
app.setName('RoomJukebox');
app.setPath('userData', join(app.getPath('appData'), 'RoomJukebox'));
app.setAppLogsPath(join(app.getPath('userData'), 'logs'));

const log = setupLogging(app.getPath('logs'));

process.on('uncaughtException', (err) => log.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));

let opts: CliOptions;
try {
  opts = parseArgs(process.argv.slice(1));
} catch (err) {
  log.error(String(err));
  app.exit(2);
  throw err;
}

if (opts.occlusionFix)
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const LAN_PORT = Number.parseInt(process.env.LAN_PORT ?? '8080', 10);
const ROOM_NAME = 'Basement';
const DEVICE_NAME = hostname();
const RELOAD_LIMIT = 5;
const RELOAD_WINDOW_MS = 10 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let pageUrl = '';
let selfCheck: Promise<SelfCheck> | null = null;

/** Built SPA: shipped as extraResources/web when packaged, apps/web/dist in a checkout. */
function webRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web')
    : join(app.getAppPath(), '..', 'web', 'dist');
}

/** Stable per-install hub id (M2 replaces it with the household identity). */
function hubId(): string {
  const file = join(app.getPath('userData'), 'hub-id');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    const id = randomUUID();
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(file, id);
    return id;
  }
}

type FastifyLogger = NonNullable<BuildAppOptions['loggerInstance']>;

/** Fastify logger interface on top of electron-log (debug/trace are dropped). */
function fastifyLogger(): FastifyLogger {
  const noop = (): void => undefined;
  const logger = {
    level: 'info',
    fatal: (...a: unknown[]) => log.error('[server]', ...a),
    error: (...a: unknown[]) => log.error('[server]', ...a),
    warn: (...a: unknown[]) => log.warn('[server]', ...a),
    info: (...a: unknown[]) => log.info('[server]', ...a),
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => logger,
  };
  return logger as unknown as FastifyLogger;
}

function displaySummary(): unknown {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label,
    primary: d.id === primary,
    internal: d.internal,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    refreshRate: d.displayFrequency,
  }));
}

function placeWindow(win: BrowserWindow): void {
  const displays = screen.getAllDisplays();
  const tv = pickTvDisplay(displays, screen.getPrimaryDisplay().id, opts.display);
  if (!tv) return;
  log.info(`placing player window on display ${tv.id} (${tv.label})`, tv.bounds);
  if (win.isKiosk()) win.setKiosk(false);
  if (win.isFullScreen()) win.setFullScreen(false);
  if (opts.fullscreen || opts.kiosk) {
    win.setBounds(tv.bounds);
  } else {
    const { x, y, width, height } = tv.workArea;
    const w = Math.min(1280, width);
    const h = Math.min(720, height);
    win.setBounds({
      x: x + Math.round((width - w) / 2),
      y: y + Math.round((height - h) / 2),
      width: w,
      height: h,
    });
  }
  if (opts.kiosk) {
    win.setKiosk(true);
    win.setAlwaysOnTop(true, 'screen-saver');
  } else if (opts.fullscreen) {
    win.setFullScreen(true);
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Room Jukebox',
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  placeWindow(win);
  win.once('ready-to-show', () => win.show());

  const blocker = powerSaveBlocker.start('prevent-display-sleep');
  win.on('closed', () => {
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on('console-message', (details) => {
    log.info(
      `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`,
    );
  });

  if (opts.kiosk) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key;
      if (key === 'Escape' || key === 'F11' || (input.alt && key === 'F4')) {
        event.preventDefault();
        return;
      }
      // M0 escape hatch until the password-gated tray lands (M1): Ctrl+Shift+Q quits.
      if (input.control && input.shift && key.toLowerCase() === 'q') app.quit();
    });
  }

  const reloads: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now();
    while (reloads.length > 0 && now - reloads[0]! > RELOAD_WINDOW_MS) reloads.shift();
    log.error('render-process-gone', details, `recent reloads: ${reloads.length}`);
    if (reloads.length >= RELOAD_LIMIT) {
      log.error(
        `giving up after ${RELOAD_LIMIT} renderer crashes in 10 min; logs in ${app.getPath('logs')}`,
      );
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** reloads.length);
    reloads.push(now);
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, delay);
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    log.warn(`did-fail-load ${code} ${description} ${url}`);
  });

  log.info(`loading ${pageUrl}`);
  void win.loadURL(pageUrl);
  return win;
}

async function startHub(root: string): Promise<string> {
  const spikeDataDir = join(app.getPath('userData'), 'data');
  const server = await buildApp({ webRoot: root, loggerInstance: fastifyLogger(), spikeDataDir });
  try {
    // Dual-stack so `http://localhost` works whether Chromium picks ::1 or 127.0.0.1.
    await server.listen({ port: LAN_PORT, host: '::' });
    log.info(`hub server listening on [::]:${LAN_PORT} (dual-stack)`);
  } catch (err) {
    log.error(`hub server failed to listen on ${LAN_PORT}`, err);
  }
  app.once('before-quit', () => void server.close());
  startBroadcaster({
    hubId: hubId(),
    bootId: randomUUID(),
    roomName: ROOM_NAME,
    port: LAN_PORT,
    version: app.getVersion(),
    protocolVersion: PROTOCOL_VERSION,
    log,
  });
  const query = new URLSearchParams({ player: DEVICE_NAME });
  return `http://${opts.loopback}:${LAN_PORT}/tv?${query.toString()}`;
}

async function startPlayer(root: string): Promise<string> {
  const server = await startStaticServer(root);
  log.info(`player loopback server on 127.0.0.1:${server.port}, hub ${opts.hub}`);
  app.once('before-quit', () => void server.close());
  const query = new URLSearchParams({ player: DEVICE_NAME, hub: opts.hub ?? '' });
  return `http://${opts.loopback}:${server.port}/tv?${query.toString()}`;
}

async function main(): Promise<void> {
  await app.whenReady();
  log.info(
    `Room Jukebox ${app.getVersion()} starting: mode=${opts.mode} electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`,
    opts,
  );

  const root = webRoot();
  log.info(`web root ${root}`);

  const listener = startListener({ log });
  ipcMain.handle('jukebox:lastBeacon', () => listener.last());

  selfCheck = runSelfCheck({
    mode: opts.mode,
    appVersion: app.getVersion(),
    displays: displaySummary(),
  }).then((result) => {
    log.info('selfcheck', result);
    try {
      writeFileSync(join(app.getPath('logs'), 'selfcheck.json'), JSON.stringify(result, null, 2));
    } catch (err) {
      log.error('writing selfcheck.json failed', err);
    }
    return result;
  });
  ipcMain.handle('jukebox:selfcheck', () => selfCheck);

  pageUrl = opts.mode === 'hub' ? await startHub(root) : await startPlayer(root);
  mainWindow = createWindow();

  let placeTimer: NodeJS.Timeout | undefined;
  const replace = (reason: string) => () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      log.info(`display change (${reason})`, displaySummary());
      if (mainWindow && !mainWindow.isDestroyed()) placeWindow(mainWindow);
    }, 500);
  };
  screen.on('display-added', replace('display-added'));
  screen.on('display-removed', replace('display-removed'));
  screen.on('display-metrics-changed', replace('display-metrics-changed'));

  const reloadOn = (event: string) => () => {
    log.info(`powerMonitor ${event}: reloading`);
    mainWindow?.webContents.reload();
  };
  powerMonitor.on('resume', reloadOn('resume'));
  powerMonitor.on('unlock-screen', reloadOn('unlock-screen'));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  main().catch((err: unknown) => log.error('startup failed', err));
}
