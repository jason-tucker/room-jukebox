import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@room-jukebox/shared';
import type { ReleaseNotes, SettingsPublic } from '@room-jukebox/shared';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  screen,
  Tray,
} from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import publicKeyPem from '../build/release-public.pem';
import { buildApp } from 'server/src/app.ts';
import type { BuildAppOptions } from 'server/src/app.ts';
import { parseArgs } from './args';
import type { CliOptions } from './args';
import { startBroadcaster, startListener } from './beacon';
import { loadState, openSecret, saveState, sealSecret } from './desktop-state';
import type { DesktopState, SecretCodec } from './desktop-state';
import { pickTvDisplay, tvConnected } from './display';
import { loadReleaseNotes } from './release-notes';
import { setupLogging } from './logging';
import { lanAddresses } from './net';
import type { LanAddress } from './net';
import { errorPageUrl, passwordPageUrl } from './pages';
import { HeartbeatWatch, listenWithRetry, relaunchDecision } from './robustness';
import { runSelfCheck } from './selfcheck';
import type { SelfCheck } from './selfcheck';
import { startStaticServer } from './static-server';
import { IdleTokenCache } from './token-cache';
import { ActivityTracker, isQuiet, updatedMessage } from './update-policy';
import type { ActivitySnapshot } from './update-policy';
import { inertUpdaterControl, Updater } from './updater';
import type { UpdaterControl, UpdateSettings } from './updater';
import { resolveWindowMode } from './window-mode';
import type { WindowMode } from './window-mode';

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

const STATE_FILE = join(app.getPath('userData'), 'desktop-state.json');
let state: DesktopState = loadState(STATE_FILE);

function persist(patch: Partial<DesktopState>): void {
  state = { ...state, ...patch };
  try {
    saveState(STATE_FILE, state);
  } catch (err) {
    log.error(`writing ${STATE_FILE} failed`, err);
  }
}

const envPort = Number.parseInt(process.env.LAN_PORT ?? '', 10);
const LAN_PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : (state.lanPort ?? 8080);
const ROOM_NAME = 'Basement';
const DEVICE_NAME = hostname();
const RELOAD_LIMIT = 5;
const RELOAD_WINDOW_MS = 10 * 60 * 1000;
const OWNER_IDLE_MS = 10 * 60 * 1000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const REASSERT_FULLSCREEN_MS = 5000;
/** Updater tick: checks when due (10 min immediate, 6 h quiet), downloads and installs. */
const UPDATE_TICK_MS = 60_000;
const ACTIVITY_POLL_MS = 60_000;

let tvWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let promptWindow: BrowserWindow | null = null;
let promptWaiters: ((ok: boolean) => void)[] = [];
let tray: Tray | null = null;
let updater: Updater | undefined;
let releaseNotes: ReleaseNotes | null = null;
let selfCheck: Promise<SelfCheck> | null = null;
let codec: SecretCodec = { available: false, encrypt: (p) => p, decrypt: (c) => c };

/** Page origin of the windows (loopback, `localhost` by default: M0 finding). */
let pageOrigin = '';
/** Where the main process talks to the hub API (always IPv4 loopback in Hub mode). */
let apiBase = '';
let setupMode = false;
let mode: WindowMode = { fullscreen: true, kiosk: false, displayId: undefined };
/** The owner left fullscreen through the tray: no re-assert until *Show TV*. */
let ownerLeftFullscreen = false;
let placing = false;
let quitting = false;
let sessionEnding = false;
let showingError = false;

const ownerTokens = new IdleTokenCache(OWNER_IDLE_MS);
const heartbeat = new HeartbeatWatch(HEARTBEAT_TIMEOUT_MS);
const activity = new ActivityTracker(Date.now());

/** Built SPA: shipped as extraResources/web when packaged, apps/web/dist in a checkout. */
function webRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web')
    : join(app.getAppPath(), '..', 'web', 'dist');
}

function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png');
}

/** Release notes of this build: extraResources when packaged, the generated file in a checkout. */
function releaseNotesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'release-notes.json')
    : join(app.getAppPath(), 'build', 'release-notes.json');
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

/** Keep server log lines short: pino passes request/reply objects whose default serialisation
 * (electron-log's) dumps function source; keep primitives, error messages and a trimmed JSON. */
function compactArg(a: unknown): unknown {
  if (a === null || typeof a !== 'object') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(a, (_k, v: unknown) => {
      if (typeof v === 'function' || typeof v === 'symbol') return undefined;
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    });
    return text && text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return '[unserialisable]';
  }
}

/** Fastify logger interface on top of electron-log (debug/trace are dropped). */
function fastifyLogger(): FastifyLogger {
  const noop = (): void => undefined;
  const c = (a: unknown[]): unknown[] => a.map(compactArg);
  const logger = {
    level: 'info',
    fatal: (...a: unknown[]) => log.error('[server]', ...c(a)),
    error: (...a: unknown[]) => log.error('[server]', ...c(a)),
    warn: (...a: unknown[]) => log.warn('[server]', ...c(a)),
    info: (...a: unknown[]) => log.info('[server]', ...c(a)),
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

function isTvConnected(): boolean {
  return tvConnected(screen.getAllDisplays(), mode.displayId ?? state.tvDisplayId);
}

// ---------------------------------------------------------------------------------------------
// Hub API (main process → embedded server on loopback)

async function api(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${apiBase}${path}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
}

async function needsSetup(): Promise<boolean> {
  if (opts.mode !== 'hub') return false;
  try {
    const res = await api('/healthz');
    const body = (await res.json()) as { needsSetup?: unknown };
    return body.needsSetup === true;
  } catch (err) {
    log.warn('GET /healthz failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Windows

function toast(level: 'info' | 'warn' | 'error', message: string, ttlMs = 8000): void {
  for (const win of [tvWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('jukebox:toast', { level, message, ttlMs });
  }
}

function tvUrl(): string {
  if (opts.mode === 'player') {
    const query = new URLSearchParams({ player: DEVICE_NAME, hub: opts.hub ?? '' });
    return `${pageOrigin}/tv?${query.toString()}`;
  }
  if (setupMode) return `${pageOrigin}/setup`;
  const query = new URLSearchParams({ player: state.playerId ?? DEVICE_NAME });
  const token = openSecret(codec, state.playerToken);
  if (token) query.set('token', token);
  else log.warn('no stored player token; the TV page will ask for pairing');
  return `${pageOrigin}/tv?${query.toString()}`;
}

function currentMode(): WindowMode {
  return resolveWindowMode(opts, state, setupMode);
}

function placeWindow(win: BrowserWindow): void {
  const displays = screen.getAllDisplays();
  const tv = pickTvDisplay(displays, screen.getPrimaryDisplay().id, mode.displayId);
  if (!tv) return;
  log.info(`placing TV window on display ${tv.id} (${tv.label})`, tv.bounds, mode);
  placing = true;
  try {
    if (win.isKiosk()) win.setKiosk(false);
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setAlwaysOnTop(false);
    const full = (mode.fullscreen || mode.kiosk) && !ownerLeftFullscreen;
    if (full) {
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
    if (full && mode.kiosk) {
      win.setKiosk(true);
      win.setAlwaysOnTop(true, 'screen-saver');
    } else if (full) {
      win.setFullScreen(true);
    }
  } finally {
    placing = false;
  }
}

/** Only pages from the hub origin (or the player loopback origin) may use `window.jukebox`. */
function fromPage(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = event.senderFrame?.url;
  if (!url) return false;
  try {
    const u = new URL(url);
    const o = new URL(pageOrigin);
    return (
      u.protocol === 'http:' &&
      u.port === o.port &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function lockNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${pageOrigin}/`)) {
      log.warn(`blocked navigation to ${url}`);
      event.preventDefault();
    }
  });
}

function createTvWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Room Jukebox',
    icon: iconPath(),
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  mode = currentMode();
  placeWindow(win);
  win.once('ready-to-show', () => win.show());
  lockNavigation(win);

  const blocker = powerSaveBlocker.start('prevent-display-sleep');
  win.on('closed', () => {
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
    if (tvWindow === win) tvWindow = null;
  });
  // Exits are password-gated (tray Quit); Windows logoff and installs set `quitting`.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    log.info('TV window close ignored (use the tray: Quit)');
  });
  win.on('session-end', () => {
    log.info('Windows session-end: quitting without installing updates');
    sessionEnding = true;
    quitting = true;
  });

  win.webContents.on('console-message', (details) => {
    log.info(
      `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`,
    );
  });

  // Kiosk: swallow the keys that leave fullscreen or close the window.
  win.webContents.on('before-input-event', (event, input) => {
    if (!mode.kiosk || ownerLeftFullscreen || input.type !== 'keyDown') return;
    const key = input.key;
    if (key === 'Escape' || key === 'F11' || (input.alt && key === 'F4')) event.preventDefault();
  });

  // Re-assert fullscreen 5 s after anything but the owner (tray) took it away.
  win.on('leave-full-screen', () => {
    if (placing || ownerLeftFullscreen || !(mode.fullscreen || mode.kiosk)) return;
    setTimeout(() => {
      if (win.isDestroyed() || ownerLeftFullscreen || win.isFullScreen() || win.isKiosk()) return;
      if (!(mode.fullscreen || mode.kiosk)) return;
      log.info('re-asserting fullscreen');
      placeWindow(win);
    }, REASSERT_FULLSCREEN_MS);
  });

  const reloads: number[] = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    const now = Date.now();
    while (reloads.length > 0 && now - reloads[0]! > RELOAD_WINDOW_MS) reloads.shift();
    log.error('render-process-gone', details, `recent reloads: ${reloads.length}`);
    if (reloads.length >= RELOAD_LIMIT) {
      showError('The TV page keeps crashing', [
        `It crashed ${RELOAD_LIMIT} times in 10 minutes, so it was not reloaded again.`,
        `Logs: ${app.getPath('logs')}`,
        'Quit from the tray icon and start Room Jukebox again.',
      ]);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** reloads.length);
    reloads.push(now);
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, delay);
  });
  win.webContents.on('did-start-loading', () => heartbeat.beat());
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    log.warn(`did-fail-load ${code} ${description} ${url}`);
  });

  log.info(`loading ${url.replace(/token=[^&]+/, 'token=…')}`);
  heartbeat.beat();
  void win.loadURL(url);
  return win;
}

/** Plain local error page in the TV window (or a window of its own before the TV exists). */
function showError(title: string, lines: string[]): void {
  log.error(`error page: ${title}`, lines);
  showingError = true;
  const url = errorPageUrl(title, lines);
  let win = tvWindow;
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 900,
      height: 600,
      backgroundColor: '#111111',
      autoHideMenuBar: true,
      title: 'Room Jukebox',
      icon: iconPath(),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    tvWindow = win;
    win.on('closed', () => {
      if (tvWindow === win) tvWindow = null;
    });
  } else {
    if (win.isKiosk()) win.setKiosk(false);
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setAlwaysOnTop(false);
    ownerLeftFullscreen = true;
  }
  void win.loadURL(url);
  win.show();
}

function showTv(): void {
  ownerLeftFullscreen = false;
  if (!tvWindow || tvWindow.isDestroyed()) return;
  mode = currentMode();
  placeWindow(tvWindow);
  if (tvWindow.isMinimized()) tvWindow.restore();
  tvWindow.show();
  tvWindow.focus();
}

function leaveFullscreen(): void {
  ownerLeftFullscreen = true;
  if (tvWindow && !tvWindow.isDestroyed()) placeWindow(tvWindow);
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Room Jukebox settings',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  // Above a kiosk TV window on the same display.
  if (mode.kiosk && !ownerLeftFullscreen) win.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow = win;
  lockNavigation(win);
  win.webContents.on('input-event', () => ownerTokens.touch());
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  void win.loadURL(`${pageOrigin}/admin`);
}

/** Drops the owner token after 10 min idle, logs it out and closes the settings window. */
function sweepOwnerToken(): void {
  if (!ownerTokens.expired()) return;
  const token = ownerTokens.clear();
  log.info('owner session idle for 10 min: closing settings');
  if (token) void api('/api/admin/logout', { method: 'POST' }, token).catch(() => undefined);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
}

// ---------------------------------------------------------------------------------------------
// Owner password gate (tray actions and privileged IPC)

async function login(password: string): Promise<{ ok: boolean; message?: string }> {
  let res: Response;
  try {
    res = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'desktop' },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    log.error('admin login request failed', err);
    return { ok: false, message: 'The hub server is not reachable.' };
  }
  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    error?: { code?: string; retryAfterSec?: number };
  };
  if (res.ok && typeof body.token === 'string') {
    ownerTokens.set(body.token);
    return { ok: true };
  }
  if (res.ok) return { ok: false, message: 'The server did not issue a desktop token.' };
  const wait = body.error?.retryAfterSec;
  if (res.status === 429 || wait) {
    return { ok: false, message: `Too many attempts. Try again in ${wait ?? 60} s.` };
  }
  if (res.status === 401) return { ok: false, message: 'Wrong password.' };
  return { ok: false, message: `Login failed (HTTP ${res.status}).` };
}

function finishPrompt(ok: boolean): void {
  const waiters = promptWaiters;
  promptWaiters = [];
  for (const w of waiters) w(ok);
  const win = promptWindow;
  promptWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

/**
 * Resolves true once the owner is authenticated (cached token, or the password prompt). Before
 * setup no password exists, so nothing is gated yet.
 */
async function ownerGate(reason: string): Promise<boolean> {
  if (ownerTokens.get()) return true;
  // No hub server (port error page): there is no password to check and nothing to protect.
  if (!apiBase) return true;
  if (await needsSetup()) return true;
  return new Promise<boolean>((resolve) => {
    promptWaiters.push(resolve);
    if (promptWindow && !promptWindow.isDestroyed()) {
      promptWindow.show();
      promptWindow.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 440,
      height: 230,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: 'Room Jukebox',
      icon: iconPath(),
      backgroundColor: '#111111',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, 'prompt-preload.cjs'),
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    promptWindow = win;
    win.on('closed', () => {
      if (promptWindow === win) finishPrompt(false);
    });
    void win.loadURL(passwordPageUrl(reason));
  });
}

ipcMain.handle('owner-prompt:submit', async (event, password: unknown) => {
  if (!promptWindow || event.sender !== promptWindow.webContents) return { ok: false };
  const result = await login(typeof password === 'string' ? password : '');
  if (result.ok) finishPrompt(true);
  return result;
});
ipcMain.on('owner-prompt:cancel', (event) => {
  if (promptWindow && event.sender === promptWindow.webContents) finishPrompt(false);
});

function quitApp(): void {
  log.info('quit requested by the owner');
  quitting = true;
  app.quit();
}

async function checkFromTray(): Promise<void> {
  if (!updater) {
    toast('info', 'Updates are only available in the installed app.');
    return;
  }
  const result = await updater.check();
  if (!result.ok || !result.version) {
    toast(result.ok ? 'info' : 'error', result.message);
    void dialog.showMessageBox({ type: result.ok ? 'info' : 'error', message: result.message });
    return;
  }
  const choice = await dialog.showMessageBox({
    type: 'info',
    message: `${result.message} ${
      state.updateMode === 'immediate'
        ? 'It installs on its own in a few minutes.'
        : state.updateMode === 'quiet'
          ? 'It installs on its own when the room is quiet.'
          : 'Automatic updates are off.'
    }`,
    buttons: ['Update now', 'Later'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice.response === 0) toastResult(await updater.updateNow());
}

function toastResult(r: { ok: boolean; message: string }): void {
  toast(r.ok ? 'info' : 'error', r.message);
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(
    image.isEmpty() ? image : image.resize({ width: 16, height: 16, quality: 'best' }),
  );
  tray.setToolTip(`Room Jukebox ${app.getVersion()}`);
  const gated = (reason: string, action: () => void | Promise<void>) => () => {
    void ownerGate(reason).then(async (ok) => {
      if (ok) await action();
    });
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show TV', click: () => showTv() },
      { label: 'Leave fullscreen', click: gated('Leave fullscreen', leaveFullscreen) },
      { label: 'Settings', click: gated('Settings', openSettings) },
      { label: 'Check for updates', click: gated('Check for updates', checkFromTray) },
      { type: 'separator' },
      { label: 'Quit', click: gated('Quit Room Jukebox', quitApp) },
    ]),
  );
  tray.on('double-click', () => showTv());
}

function openSettings(): void {
  if (setupMode) {
    showTv();
    return;
  }
  openSettingsWindow();
}

// ---------------------------------------------------------------------------------------------
// Server hooks: setup completion and settings changes

interface SetupTokens {
  token?: string;
  playerToken?: string;
  /** Device id the player token is bound to (falls back to the hostname). */
  playerId?: string;
}

function completeSetup(tokens: SetupTokens): void {
  const patch: Partial<DesktopState> = {};
  if (tokens.token) patch.adminToken = sealSecret(codec, tokens.token);
  if (tokens.playerToken) patch.playerToken = sealSecret(codec, tokens.playerToken);
  if (tokens.playerId) patch.playerId = tokens.playerId;
  if (!state.playerId && !tokens.playerId) patch.playerId = DEVICE_NAME;
  persist(patch);
  const wasSetup = setupMode;
  setupMode = false;
  log.info('setup complete: tokens stored, moving the TV window to /tv');
  const win = tvWindow;
  if (!win || win.isDestroyed()) return;
  const onSetupPage = new URL(win.webContents.getURL() || 'about:blank').pathname === '/setup';
  if (!wasSetup && !onSetupPage) return;
  mode = currentMode();
  placeWindow(win);
  void win.loadURL(tvUrl());
  void applyServerSettings();
}

type DesktopSettings = Partial<
  Pick<SettingsPublic, 'autoStart' | 'autoFullscreen' | 'kiosk' | 'tvDisplayId' | 'lanPort'>
>;

function applySettings(s: DesktopSettings): void {
  const patch: Partial<DesktopState> = {};
  if (typeof s.autoStart === 'boolean') {
    patch.autoStart = s.autoStart;
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.autoStart });
  }
  if (typeof s.autoFullscreen === 'boolean') patch.autoFullscreen = s.autoFullscreen;
  if (typeof s.kiosk === 'boolean') patch.kiosk = s.kiosk;
  if (s.tvDisplayId !== undefined) patch.tvDisplayId = s.tvDisplayId;
  if (typeof s.lanPort === 'number' && s.lanPort > 0 && s.lanPort !== LAN_PORT) {
    patch.lanPort = s.lanPort;
    log.info(`hub port changed to ${s.lanPort}; takes effect after a restart (now ${LAN_PORT})`);
  }
  persist(patch);
  const next = currentMode();
  const changed =
    next.fullscreen !== mode.fullscreen ||
    next.kiosk !== mode.kiosk ||
    next.displayId !== mode.displayId;
  mode = next;
  if (changed && tvWindow && !tvWindow.isDestroyed() && !showingError) placeWindow(tvWindow);
}

/** At start (and after setup) the server's settings are the truth for the window mode. */
async function applyServerSettings(): Promise<void> {
  const token = openSecret(codec, state.adminToken);
  if (!token || setupMode) return;
  try {
    const res = await api('/api/admin/settings', {}, token);
    if (!res.ok) {
      log.warn(`GET /api/admin/settings: HTTP ${res.status}`);
      return;
    }
    applySettings((await res.json()) as DesktopSettings);
  } catch (err) {
    log.warn('GET /api/admin/settings failed', err);
  }
}

/** Updater activity source: polls `GET /api/admin/session` with the stored desktop token. */
let lastPollStatus = '';
async function pollActivity(): Promise<void> {
  const token = openSecret(codec, state.adminToken);
  let status = 'ok';
  if (!token || setupMode) {
    activity.unknown();
    status = 'no-token';
  } else {
    try {
      const res = await api('/api/admin/session', {}, token);
      if (res.ok) activity.observe((await res.json()) as ActivitySnapshot);
      else {
        activity.unknown();
        status = `HTTP ${res.status}`;
      }
    } catch (err) {
      activity.unknown();
      status = err instanceof Error ? err.message : String(err);
    }
  }
  if (status !== lastPollStatus) log.info(`activity poll: ${status}`);
  lastPollStatus = status;
}

function quietStatus(): { quiet: boolean; tvConnected: boolean } {
  const connected = isTvConnected();
  return {
    tvConnected: connected,
    quiet: isQuiet({
      now: Date.now(),
      lastRequestAt: activity.lastRequestAt,
      nowPlayingSource: activity.nowPlayingSource,
      tvConnected: connected,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Startup

/** Fatal startup error: relaunch, unless that already happened 3 times in 5 minutes. */
function fatal(reason: string, err: unknown): void {
  log.error(`fatal: ${reason}`, err);
  const decision = relaunchDecision(state.relaunches ?? [], Date.now());
  persist({ relaunches: decision.history });
  if (decision.relaunch) {
    log.info(`relaunching (${decision.history.length} in the last 5 min)`);
    quitting = true;
    app.relaunch();
    app.exit(0);
    return;
  }
  showError('Room Jukebox could not start', [
    `${reason}: ${err instanceof Error ? err.message : String(err)}`,
    'It was restarted 3 times in 5 minutes and stopped trying.',
    `Logs: ${app.getPath('logs')}`,
  ]);
}

function secretsCodec(): SecretCodec {
  const available = safeStorage.isEncryptionAvailable();
  if (!available) {
    log.error(
      '!!! safeStorage (Windows DPAPI) is NOT available: the API key, Wi-Fi password and tokens ' +
        'are stored in PLAINTEXT in the data folder until it is !!!',
    );
  }
  return {
    available,
    encrypt: (plain) => (available ? safeStorage.encryptString(plain).toString('base64') : plain),
    decrypt: (b64) => (available ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : b64),
  };
}

/**
 * M1 `buildApp` options (contract "Desktop ↔ server"). Declared here as well so the desktop
 * builds against a server that does not have them yet; once the server lane lands they are
 * the same names and this intersection collapses to `BuildAppOptions`.
 */
type HubOptions = BuildAppOptions & {
  dataDir?: string;
  secrets?: { encrypt(plain: string): string; decrypt(cipher: string): string };
  lan?: { addresses(): LanAddress[] };
  hooks?: {
    onSetupComplete(reply: SetupTokens): void;
    onSettingsChanged(settings: DesktopSettings): void;
  };
  spike?: boolean;
  /** M0 server only: where the spike writes results (drop once the server reads `dataDir`). */
  spikeDataDir?: string;
  /** M1.5: this build's notes and checklist (`GET /api/admin/release-notes`). */
  releaseNotes?: ReleaseNotes | null;
  /** M1.5: `GET /api/admin/update-status`, `POST /api/admin/update/{check,install,mode,feed}`. */
  updater?: UpdaterControl;
};

function updateSettings(): UpdateSettings {
  return { mode: state.updateMode, feed: state.updateFeed, feedUrl: state.updateFeedUrl };
}

function saveUpdateSettings(patch: Partial<UpdateSettings>): void {
  const next: Partial<DesktopState> = {};
  if (patch.mode) next.updateMode = patch.mode;
  if (patch.feed) next.updateFeed = patch.feed;
  if (patch.feedUrl) next.updateFeedUrl = patch.feedUrl;
  persist(next);
}

function updaterControl(): UpdaterControl {
  return updater ?? inertUpdaterControl(app.getVersion(), updateSettings, saveUpdateSettings);
}

async function startHub(root: string): Promise<boolean> {
  const dataDir = join(app.getPath('userData'), 'data');
  const options: HubOptions = {
    webRoot: root,
    dataDir,
    loggerInstance: fastifyLogger(),
    disableRequestLogging: true,
    secrets: { encrypt: codec.encrypt, decrypt: codec.decrypt },
    lan: { addresses: () => lanAddresses(networkInterfaces()) },
    hooks: {
      onSetupComplete: (reply) => completeSetup(reply),
      onSettingsChanged: (settings) => applySettings(settings),
    },
    spike: true /* keep the M0 spike reachable until M0 closes */,
    spikeDataDir: dataDir,
    releaseNotes,
    updater: updaterControl(),
  };
  const server = await buildApp(options);
  try {
    // Dual-stack so `http://localhost` works whether Chromium picks ::1 or 127.0.0.1.
    await listenWithRetry(
      async () => {
        await server.listen({ port: LAN_PORT, host: '::' });
      },
      {
        intervalMs: 2000,
        timeoutMs: 30_000,
        onRetry: (attempt) =>
          log.warn(`port ${LAN_PORT} is in use (attempt ${attempt}); retrying in 2 s`),
      },
    );
  } catch (err) {
    if ((err as { code?: unknown }).code === 'EADDRINUSE') {
      showError(`Port ${LAN_PORT} is in use`, [
        `Another program is using port ${LAN_PORT}, so the hub server could not start (tried for 30 s).`,
        'Close the other program, or choose another port: quit Room Jukebox from the tray, set ' +
          `"lanPort" in ${STATE_FILE} (for example 8081) and start Room Jukebox again.`,
        `Logs: ${app.getPath('logs')}`,
      ]);
      return false;
    }
    throw err;
  }
  log.info(`hub server listening on [::]:${LAN_PORT} (dual-stack)`);
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
  pageOrigin = `http://${opts.loopback}:${LAN_PORT}`;
  apiBase = `http://127.0.0.1:${LAN_PORT}`;
  return true;
}

async function startPlayer(root: string): Promise<boolean> {
  const server = await startStaticServer(root);
  log.info(`player loopback server on 127.0.0.1:${server.port}, hub ${opts.hub}`);
  app.once('before-quit', () => void server.close());
  pageOrigin = `http://${opts.loopback}:${server.port}`;
  apiBase = opts.hub ?? '';
  return true;
}

function registerIpc(): void {
  ipcMain.handle('jukebox:version', (e) => (fromPage(e) ? app.getVersion() : undefined));
  ipcMain.handle('jukebox:adminToken', (e) =>
    fromPage(e) && settingsWindow && e.sender === settingsWindow.webContents
      ? ownerTokens.get()
      : undefined,
  );
  ipcMain.handle('jukebox:openSettings', async (e) => {
    if (!fromPage(e) || !(await ownerGate('Settings'))) return false;
    openSettings();
    return true;
  });
  ipcMain.handle('jukebox:quit', async (e) => {
    if (!fromPage(e) || !(await ownerGate('Quit Room Jukebox'))) return false;
    quitApp();
    return true;
  });
  ipcMain.handle('jukebox:checkForUpdates', async (e) => {
    if (!fromPage(e)) return { ok: false, message: 'denied' };
    if (!updater) return { ok: false, message: 'Updates are only available in the installed app.' };
    if (!(await ownerGate('Check for updates'))) return { ok: false, message: 'cancelled' };
    return updater.check();
  });
  ipcMain.handle('jukebox:installUpdate', async (e) => {
    if (!fromPage(e)) return { ok: false, message: 'denied' };
    if (!updater) return { ok: false, message: 'Updates are only available in the installed app.' };
    if (!(await ownerGate('Update now'))) return { ok: false, message: 'cancelled' };
    return updater.updateNow();
  });
  ipcMain.handle('jukebox:releaseNotes', (e) => (fromPage(e) ? releaseNotes : undefined));
  ipcMain.handle('jukebox:setupComplete', async (e, reply: unknown) => {
    if (!fromPage(e) || opts.mode !== 'hub') return false;
    if (await needsSetup()) return false;
    const r = (reply && typeof reply === 'object' ? reply : {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    // The server hook normally delivered the tokens already; the page's copy is the fallback.
    const tokens: SetupTokens = {};
    if (!state.adminToken && str(r.token)) tokens.token = str(r.token);
    if (!state.playerToken && str(r.playerToken)) tokens.playerToken = str(r.playerToken);
    if (!state.playerId && str(r.playerId)) tokens.playerId = str(r.playerId);
    completeSetup(tokens);
    return true;
  });
  ipcMain.on('jukebox:heartbeat', (e) => {
    if (tvWindow && e.sender === tvWindow.webContents) heartbeat.beat();
  });
}

function startUpdater(): void {
  if (!app.isPackaged) {
    log.info('updater disabled (not packaged)');
    return;
  }
  autoUpdater.logger = log;
  updater = new Updater({
    autoUpdater,
    log,
    // no-store: latest.yml must be the bytes the feed serves now, not Chromium's cached copy.
    fetch: (url) => net.fetch(url, { cache: 'no-store' }),
    publicKeyPem,
    currentVersion: app.getVersion(),
    toast,
    settings: updateSettings,
    saveSettings: saveUpdateSettings,
    quietStatus,
    sessionEnding: () => sessionEnding,
    setupOpen: () => setupMode,
    setPending: (pendingUpdate) => persist({ pendingUpdate }),
    beforeInstall: () => {
      quitting = true;
    },
  });
}

/** First launch of a new version: tell the TV, once, and point at the checklist. */
function announceUpdate(win: BrowserWindow): void {
  const version = app.getVersion();
  if (state.lastRunVersion === version) return;
  const previous = state.lastRunVersion;
  persist({ lastRunVersion: version });
  const notes = releaseNotes?.version === version ? releaseNotes : null;
  const message = updatedMessage(version, notes?.checklist.length ?? 0);
  log.info(`first run of ${version} (previous ${previous ?? 'unknown'}): ${message}`);
  // The page subscribes to toasts after it loads; give it a moment.
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => toast('info', message, 20_000), 3000);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  log.info(
    `Room Jukebox ${app.getVersion()} starting: mode=${opts.mode} port=${LAN_PORT} electron=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`,
    opts,
  );
  codec = secretsCodec();
  registerIpc();

  const root = webRoot();
  log.info(`web root ${root}`);

  const listener = startListener({ log });
  ipcMain.handle('jukebox:lastBeacon', (e) => (fromPage(e) ? listener.last() : undefined));

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
  ipcMain.handle('jukebox:selfcheck', (e) => (fromPage(e) ? selfCheck : undefined));

  releaseNotes = loadReleaseNotes(releaseNotesPath(), log);
  if (releaseNotes && releaseNotes.version !== app.getVersion()) {
    log.warn(`release notes are for ${releaseNotes.version}, this is ${app.getVersion()}`);
  }

  startUpdater();
  // An update downloaded in an earlier run installs before the TV window opens.
  const pending = state.pendingUpdate;
  if (updater && pending && state.updateMode !== 'off') {
    if (pending.version === app.getVersion()) persist({ pendingUpdate: undefined });
    else if (await updater.installAtLaunch(pending.version, 30_000)) return;
  }

  createTray();
  const started = opts.mode === 'hub' ? await startHub(root) : await startPlayer(root);
  if (!started) return;

  setupMode = await needsSetup();
  tvWindow = createTvWindow(tvUrl());
  announceUpdate(tvWindow);
  void applyServerSettings();

  let placeTimer: NodeJS.Timeout | undefined;
  const replace = (reason: string) => () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => {
      log.info(`display change (${reason})`, displaySummary());
      if (tvWindow && !tvWindow.isDestroyed() && !showingError) placeWindow(tvWindow);
      void updater?.tick();
    }, 500);
  };
  screen.on('display-added', replace('display-added'));
  screen.on('display-removed', replace('display-removed'));
  screen.on('display-metrics-changed', replace('display-metrics-changed'));

  const reloadOn = (event: string) => () => {
    log.info(`powerMonitor ${event}: reloading`);
    if (!showingError) tvWindow?.webContents.reload();
  };
  powerMonitor.on('resume', reloadOn('resume'));
  powerMonitor.on('unlock-screen', reloadOn('unlock-screen'));

  setInterval(() => {
    const win = tvWindow;
    if (!win || win.isDestroyed() || showingError || win.webContents.isLoading()) return;
    if (heartbeat.stale()) {
      log.warn('no renderer heartbeat for 30 s: reloading the TV window');
      heartbeat.beat();
      win.webContents.reload();
    }
  }, 5000);
  setInterval(sweepOwnerToken, 15_000);

  if (opts.mode === 'hub') {
    void pollActivity();
    setInterval(() => void pollActivity(), ACTIVITY_POLL_MS);
  }
  if (updater) {
    const u = updater;
    void u.tick();
    setInterval(() => void u.tick(), UPDATE_TICK_MS);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showTv());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => app.quit());
  main().catch((err: unknown) => fatal('startup failed', err));
}
