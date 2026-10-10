import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import publicKeyPem from '../build/release-public.pem';
import { checkSignedFeed } from './feed-signature';
import type { FetchLike } from './feed-signature';
import { clockSkewMs, installDecision } from './update-policy';

/** GitHub release assets of `jason-tucker/room-jukebox` (electron-builder tags `v<version>`). */
export const FEED_BASE = 'https://github.com/jason-tucker/room-jukebox/releases/download';

interface Log {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

export interface UpdaterDeps {
  log: Log;
  fetch: FetchLike;
  toast: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** `autoUpdate` toggle of desktop-state.json. */
  enabled: () => boolean;
  quietStatus: () => { quiet: boolean; tvConnected: boolean };
  sessionEnding: () => boolean;
  setPending: (pending: { version: string; downloadedAt: number } | undefined) => void;
  /** Lets the TV window close (it otherwise refuses without the owner password). */
  beforeInstall: () => void;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  version?: string;
}

/**
 * electron-updater with the quiet rule: check on launch and every 6 h, verify the Ed25519
 * signature of `latest.yml` before anything is downloaded, download when quiet, install when
 * `installDecision` allows (or on "Update now"), never on session-end, never on app quit.
 */
export class Updater {
  private offered: UpdateInfo | undefined;
  private downloaded: UpdateInfo | undefined;
  private downloading: Promise<void> | undefined;
  private skewMs: number | undefined;
  private readonly d: UpdaterDeps;

  constructor(d: UpdaterDeps) {
    this.d = d;
    autoUpdater.logger = d.log;
    autoUpdater.autoDownload = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    // Installing on quit would also install on Windows session-end; installs are explicit only.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('error', (err: Error) => d.log.error('updater error', err.message));
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      d.log.info(`update ${info.version} downloaded`);
      this.downloaded = info;
      d.setPending({ version: info.version, downloadedAt: Date.now() });
    });
  }

  /** Checks the feed and verifies its signature; remembers a verified offer. */
  async check(): Promise<UpdateResult> {
    let info: UpdateInfo;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        this.offered = undefined;
        return { ok: true, message: 'Room Jukebox is up to date.' };
      }
      info = result.updateInfo;
    } catch (err) {
      this.d.log.error('update check failed', err);
      return { ok: false, message: 'Could not check for updates (offline?).' };
    }
    let feed;
    try {
      feed = await checkSignedFeed(FEED_BASE, info, publicKeyPem, this.d.fetch);
    } catch (err) {
      this.d.log.error('fetching latest.yml / latest.yml.sig failed', err);
      return { ok: false, message: 'Could not verify the update feed (offline?).' };
    }
    this.skewMs = clockSkewMs(Date.now(), feed.dateHeader);
    if (!feed.ok) {
      this.offered = undefined;
      const message = `Update ${info.version} refused: ${feed.error}.`;
      this.d.log.error(`UPDATE ABORTED: ${message}`);
      this.d.toast('error', message);
      return { ok: false, message, version: info.version };
    }
    this.offered = info;
    this.d.log.info(
      `update ${info.version} available, feed signature ok, clock skew ${this.skewMs ?? 'unknown'} ms`,
    );
    return { ok: true, message: `Update ${info.version} is available.`, version: info.version };
  }

  private download(): Promise<void> {
    this.downloading ??= autoUpdater
      .downloadUpdate()
      .then(() => undefined)
      .catch((err: unknown) => this.d.log.error('update download failed', err))
      .finally(() => {
        this.downloading = undefined;
      });
    return this.downloading;
  }

  private install(reason: string): void {
    if (this.d.sessionEnding()) return;
    this.d.log.info(`installing update ${this.downloaded?.version} (${reason})`);
    this.d.beforeInstall();
    autoUpdater.quitAndInstall(true, true);
  }

  /** Scheduled check (launch and every 6 h). */
  async scheduledCheck(): Promise<void> {
    if (!this.d.enabled()) return;
    await this.check();
    await this.tick();
  }

  /** Every minute: download when quiet, install when the policy allows. */
  async tick(): Promise<void> {
    if (!this.d.enabled() || !this.offered) return;
    const status = this.d.quietStatus();
    if (!this.downloaded) {
      if (status.quiet) await this.download();
      if (!this.downloaded) return;
    }
    const decision = installDecision({
      quiet: status.quiet,
      tvConnected: status.tvConnected,
      localHour: new Date().getHours(),
      skewMs: this.skewMs,
      manual: false,
      sessionEnding: this.d.sessionEnding(),
    });
    if (decision.install) this.install(decision.reason);
  }

  /** "Update now": check, download and install right away (ignores the toggle and quiet rule). */
  async updateNow(): Promise<UpdateResult> {
    const checked = await this.check();
    if (!this.offered) return checked;
    await this.download();
    if (!this.downloaded) return { ok: false, message: 'The update could not be downloaded.' };
    if (this.d.sessionEnding()) return { ok: false, message: 'Windows is shutting down.' };
    this.install('manual');
    return { ok: true, message: `Installing ${this.downloaded.version}…` };
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
      // Past the deadline the TV window is already up: leave it to the quiet rule.
      if (timedOut || !this.downloaded || this.d.sessionEnding()) return false;
      this.install('downloaded in an earlier run');
      return true;
    };
    const timeout = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve(false);
      }, timeoutMs),
    );
    const installing = await Promise.race([attempt(), timeout]);
    if (!installing) this.d.setPending(undefined);
    return installing;
  }
}
