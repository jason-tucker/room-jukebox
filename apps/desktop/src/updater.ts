import type { UpdateStatus } from '@room-jukebox/shared';
import type { UpdateInfo } from 'electron-updater';
import { checkSignedFeed } from './feed-signature';
import type { FetchLike } from './feed-signature';
import {
  checkDue,
  clockSkewMs,
  countdownMessage,
  displayFeedUrl,
  feedConfig,
  INSTALL_COUNTDOWN_MS,
  installDecision,
  isUpdateFeed,
  isUpdateMode,
  normalizeFeedUrl,
  signatureBase,
} from './update-policy';
import type { FeedConfig, UpdateFeed, UpdateMode } from './update-policy';

interface Log {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

/** The slice of electron-updater's `autoUpdater` the updater drives (a fake in tests). */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: FeedConfig): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): unknown;
}

export interface UpdateSettings {
  mode: UpdateMode;
  feed: UpdateFeed;
  feedUrl: string;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  log: Log;
  fetch: FetchLike;
  publicKeyPem: string;
  currentVersion: string;
  toast: (level: 'info' | 'warn' | 'error', message: string, ttlMs?: number) => void;
  /** desktop-state.json `updateMode` / `updateFeed` / `updateFeedUrl`. */
  settings: () => UpdateSettings;
  saveSettings: (patch: Partial<UpdateSettings>) => void;
  quietStatus: () => { quiet: boolean; tvConnected: boolean };
  sessionEnding: () => boolean;
  /** The first-run setup wizard is on screen: automatic installs wait. */
  setupOpen: () => boolean;
  setPending: (pending: { version: string; downloadedAt: number } | undefined) => void;
  /** Lets the TV window close (it otherwise refuses without the owner password). */
  beforeInstall: () => void;
  now?: () => number;
  countdownMs?: number;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  version?: string;
}

/**
 * What the desktop hands `buildApp({ updater })`: the admin page's update status and buttons
 * (`GET /api/admin/update-status`, `POST /api/admin/update/{check,install,mode,feed}`).
 * `subscribe` pushes every status change (e.g. the 15 s install notice) so the server can
 * broadcast it to phones.
 */
export interface UpdaterControl {
  status(): UpdateStatus;
  checkNow(): Promise<void>;
  installNow(): Promise<void>;
  setMode(mode: UpdateMode): void;
  /** Throws on an unknown feed or a non-http(s) URL. */
  setFeed(feed: UpdateFeed, url?: string): void;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
}

/**
 * electron-updater with three modes:
 * - `immediate` (test phase): check at launch and every 10 min, download at once, show
 *   "Updating to x.y.z in 15 s" on every page, then install (never during the setup wizard).
 * - `quiet`: check at launch and every 6 h, download when quiet, install per `installDecision`.
 * - `off`: only "Update now".
 * Every offer's `latest.yml` is Ed25519-verified before anything is downloaded, on both feeds.
 * Never installs on session-end or on app quit. Failures log, set status `error` and toast once
 * per version; nothing here throws into the caller's timers.
 */
export class Updater implements UpdaterControl {
  private offered: UpdateInfo | undefined;
  private downloaded: UpdateInfo | undefined;
  private downloading: Promise<boolean> | undefined;
  private checking: Promise<UpdateResult> | undefined;
  private countdown: ReturnType<typeof setTimeout> | undefined;
  private installing = false;
  private skewMs: number | undefined;
  private lastCheckAt: number | undefined;
  /** Failures already toasted (a 10 min retry loop must not spam the TV). */
  private readonly toasted = new Set<string>();
  private readonly listeners = new Set<(s: UpdateStatus) => void>();
  private current: UpdateStatus;
  private readonly d: UpdaterDeps;
  private readonly au: AutoUpdaterLike;
  private readonly now: () => number;

  constructor(d: UpdaterDeps) {
    this.d = d;
    this.au = d.autoUpdater;
    this.now = d.now ?? Date.now;
    this.au.autoDownload = false;
    this.au.allowDowngrade = false;
    this.au.allowPrerelease = false;
    // Installing on quit would also install on Windows session-end; installs are explicit only.
    this.au.autoInstallOnAppQuit = false;
    this.au.on('error', (err: Error) => d.log.error('updater error', err.message));
    this.au.on('update-downloaded', (info: UpdateInfo) => {
      d.log.info(`update ${info.version} downloaded`);
      this.downloaded = info;
      d.setPending({ version: info.version, downloadedAt: this.now() });
    });
    const s = d.settings();
    this.current = {
      mode: s.mode,
      feed: s.feed,
      feedUrl: s.feedUrl,
      state: 'idle',
      current: d.currentVersion,
      available: null,
      message: null,
      lastCheckAt: null,
    };
    this.applyFeed();
  }

  status(): UpdateStatus {
    return { ...this.current };
  }

  subscribe(listener: (status: UpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch };
    const snapshot = this.status();
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch (err) {
        this.d.log.warn('update status listener failed', err);
      }
    }
  }

  private fail(message: string, version: string | undefined, toast: boolean): void {
    this.set({ state: 'error', message });
    const key = `${version ?? '?'}:${message}`;
    if (toast && !this.toasted.has(key)) {
      this.toasted.add(key);
      this.d.toast('error', message);
    }
  }

  private applyFeed(): void {
    const s = this.d.settings();
    try {
      this.au.setFeedURL(feedConfig(s.feed, s.feedUrl));
      const shown = displayFeedUrl(s.feed, s.feedUrl);
      this.set({ feed: s.feed, feedUrl: shown });
      this.d.log.info(`update feed: ${s.feed} ${shown}`);
    } catch (err) {
      this.d.log.error('setting the update feed failed', err);
      this.fail('The update feed address is invalid.', undefined, false);
    }
  }

  /** Checks the feed and verifies its signature; remembers a verified offer. */
  check(): Promise<UpdateResult> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateResult> {
    this.lastCheckAt = this.now();
    this.set({ state: 'checking', message: null, lastCheckAt: this.lastCheckAt });
    let info: UpdateInfo;
    try {
      const result = await this.au.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        this.offered = undefined;
        const message = 'Room Jukebox is up to date.';
        this.set({ state: 'up-to-date', available: null, message });
        return { ok: true, message };
      }
      info = result.updateInfo;
    } catch (err) {
      this.d.log.error('update check failed', err);
      const message = 'Could not check for updates (offline?).';
      this.fail(message, undefined, false);
      return { ok: false, message };
    }
    const s = this.d.settings();
    let feed;
    try {
      feed = await checkSignedFeed(
        signatureBase(s.feed, s.feedUrl, info.version),
        info,
        this.d.publicKeyPem,
        this.d.fetch,
      );
    } catch (err) {
      this.d.log.error('fetching latest.yml / latest.yml.sig failed', err);
      const message = 'Could not verify the update feed (offline?).';
      this.fail(message, info.version, false);
      return { ok: false, message };
    }
    this.skewMs = clockSkewMs(this.now(), feed.dateHeader);
    if (!feed.ok) {
      this.offered = undefined;
      const message = `Update ${info.version} refused: ${feed.error}.`;
      this.d.log.error(`UPDATE ABORTED: ${message}`);
      this.fail(message, info.version, true);
      return { ok: false, message, version: info.version };
    }
    this.offered = info;
    this.d.log.info(
      `update ${info.version} available, feed signature ok, clock skew ${this.skewMs ?? 'unknown'} ms`,
    );
    const message = `Update ${info.version} is available.`;
    const ready = this.downloaded?.version === info.version;
    this.set({ state: ready ? 'downloaded' : 'available', available: info.version, message });
    return { ok: true, message, version: info.version };
  }

  /** Downloads the verified offer; false (status `error`, one toast) when it fails. */
  private download(): Promise<boolean> {
    const offer = this.offered;
    if (!offer) return Promise.resolve(false);
    if (this.downloaded?.version === offer.version) return Promise.resolve(true);
    this.downloading ??= (async () => {
      this.set({ state: 'downloading', message: `Downloading ${offer.version}…` });
      try {
        await this.au.downloadUpdate();
      } catch (err) {
        this.d.log.error('update download failed', err);
      }
      if (this.downloaded?.version === offer.version) {
        this.set({ state: 'downloaded', message: `Update ${offer.version} is ready.` });
        return true;
      }
      // Re-offered by the next scheduled check rather than retried every tick.
      this.offered = undefined;
      this.fail(`Update ${offer.version} could not be downloaded.`, offer.version, true);
      return false;
    })().finally(() => {
      this.downloading = undefined;
    });
    return this.downloading;
  }

  private install(reason: string): boolean {
    if (this.installing || this.d.sessionEnding()) return false;
    this.cancelCountdown();
    const version = this.downloaded?.version ?? '?';
    this.installing = true;
    this.d.log.info(`installing update ${version} (${reason})`);
    this.set({ state: 'installing', message: `Installing ${version}…` });
    try {
      this.d.beforeInstall();
      this.au.quitAndInstall(true, true);
      return true;
    } catch (err) {
      this.installing = false;
      this.d.log.error('quitAndInstall failed', err);
      this.fail(`Update ${version} could not be installed.`, version, true);
      return false;
    }
  }

  /** True while the 15 s install notice is running. */
  countdownActive(): boolean {
    return this.countdown !== undefined;
  }

  private startCountdown(version: string): void {
    const ms = this.d.countdownMs ?? INSTALL_COUNTDOWN_MS;
    const message = countdownMessage(version, ms);
    this.d.log.info(message);
    this.d.toast('info', message, ms);
    this.set({ state: 'installing', available: version, message });
    this.countdown = setTimeout(() => {
      this.countdown = undefined;
      const s = this.d.settings();
      if (s.mode !== 'immediate' || this.d.sessionEnding() || this.d.setupOpen()) {
        this.d.log.info(`install of ${version} called off at the end of the notice`);
        this.set({ state: 'downloaded', message: `Update ${version} is ready.` });
        return;
      }
      this.install('immediate');
    }, ms);
  }

  private cancelCountdown(): void {
    if (this.countdown === undefined) return;
    clearTimeout(this.countdown);
    this.countdown = undefined;
    if (!this.installing && this.downloaded) {
      this.set({ state: 'downloaded', message: `Update ${this.downloaded.version} is ready.` });
    }
  }

  /** Called at launch and every minute: checks when due, then downloads/installs per mode. */
  async tick(): Promise<void> {
    try {
      await this.step();
    } catch (err) {
      this.d.log.error('updater tick failed', err);
      this.fail('The updater hit an unexpected error.', undefined, false);
    }
  }

  private async step(): Promise<void> {
    const { mode } = this.d.settings();
    if (mode === 'off' || this.installing || this.countdown !== undefined) return;
    if (checkDue(mode, this.lastCheckAt, this.now())) await this.check();
    if (!this.offered) return;
    if (mode === 'immediate') {
      if (this.d.setupOpen() || this.d.sessionEnding()) return;
      if (!(await this.download())) return;
      // Re-read: the mode, the wizard or a manual install may have changed during the download.
      if (this.d.settings().mode !== 'immediate' || this.installing || this.countdown) return;
      if (this.d.setupOpen() || this.d.sessionEnding() || !this.downloaded) return;
      this.startCountdown(this.downloaded.version);
      return;
    }
    const status = this.d.quietStatus();
    if (this.downloaded?.version !== this.offered.version) {
      if (!status.quiet || !(await this.download())) return;
    }
    const decision = installDecision({
      quiet: status.quiet,
      tvConnected: status.tvConnected,
      localHour: new Date(this.now()).getHours(),
      skewMs: this.skewMs,
      manual: false,
      sessionEnding: this.d.sessionEnding(),
    });
    if (decision.install && !this.d.setupOpen()) this.install(decision.reason);
  }

  /** "Update now": check, download and install right away (ignores the mode and quiet rule). */
  async updateNow(): Promise<UpdateResult> {
    this.cancelCountdown();
    const checked = await this.check();
    if (!this.offered) return checked;
    if (!(await this.download()) || !this.downloaded) {
      return { ok: false, message: 'The update could not be downloaded.' };
    }
    if (this.d.sessionEnding()) return { ok: false, message: 'Windows is shutting down.' };
    const version = this.downloaded.version;
    if (!this.install('manual')) return { ok: false, message: `Update ${version} did not start.` };
    return { ok: true, message: `Installing ${version}…` };
  }

  async checkNow(): Promise<void> {
    await this.check();
  }

  async installNow(): Promise<void> {
    await this.updateNow();
  }

  setMode(mode: UpdateMode): void {
    if (!isUpdateMode(mode)) throw new Error(`unknown update mode: ${String(mode)}`);
    this.d.saveSettings({ mode });
    this.d.log.info(`update mode: ${mode}`);
    if (mode !== 'immediate') this.cancelCountdown();
    this.set({ mode });
    void this.tick();
  }

  setFeed(feed: UpdateFeed, url?: string): void {
    if (!isUpdateFeed(feed)) throw new Error(`unknown update feed: ${String(feed)}`);
    const feedUrl = url === undefined ? undefined : normalizeFeedUrl(url);
    this.d.saveSettings(feedUrl === undefined ? { feed } : { feed, feedUrl });
    this.cancelCountdown();
    this.offered = undefined;
    this.lastCheckAt = undefined;
    this.set({ available: null, message: null, state: 'idle', lastCheckAt: null });
    this.applyFeed();
    void this.tick();
  }

  /**
   * Launch: a download finished in an earlier run installs before the TV window opens. The
   * check re-verifies the signature and electron-updater re-verifies the cached file's hash.
   * Returns true when the app is quitting to install.
   */
  async installAtLaunch(pendingVersion: string, timeoutMs: number): Promise<boolean> {
    let timedOut = false;
    const attempt = async (): Promise<boolean> => {
      await this.check();
      if (timedOut || !this.offered || this.offered.version !== pendingVersion) return false;
      await this.download();
      // Past the deadline the TV window is already up: leave it to the mode's rule.
      if (timedOut || !this.downloaded || this.d.sessionEnding()) return false;
      return this.install('downloaded in an earlier run');
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs);
    });
    const installing = await Promise.race([attempt().catch(() => false), timeout]);
    clearTimeout(timer);
    if (!installing) this.d.setPending(undefined);
    return installing;
  }
}

/** Stand-in for `buildApp({ updater })` outside the installed app (dev runs): settings only. */
export function inertUpdaterControl(
  currentVersion: string,
  settings: () => UpdateSettings,
  saveSettings: (patch: Partial<UpdateSettings>) => void,
): UpdaterControl {
  const status = (): UpdateStatus => {
    const s = settings();
    return {
      mode: s.mode,
      feed: s.feed,
      feedUrl: displayFeedUrl(s.feed, s.feedUrl),
      state: 'idle',
      current: currentVersion,
      available: null,
      message: 'Updates are only available in the installed app.',
      lastCheckAt: null,
    };
  };
  return {
    status,
    checkNow: async () => undefined,
    installNow: async () => undefined,
    setMode: (mode) => {
      if (!isUpdateMode(mode)) throw new Error(`unknown update mode: ${String(mode)}`);
      saveSettings({ mode });
    },
    setFeed: (feed, url) => {
      if (!isUpdateFeed(feed)) throw new Error(`unknown update feed: ${String(feed)}`);
      saveSettings(url === undefined ? { feed } : { feed, feedUrl: normalizeFeedUrl(url) });
    },
    subscribe: () => () => undefined,
  };
}
