/** Command-line flags of the M0 desktop shell. Unknown flags (Chromium's own) are ignored. */
export type Mode = 'hub' | 'player';

export interface CliOptions {
  /** `--mode`; undefined means "use the saved mode" (`desktop-state.mode`, default hub). */
  mode: Mode | undefined;
  /** Hub base URL for Player mode, e.g. `http://192.168.1.20:8080` (overrides the saved one). */
  hub: string | undefined;
  /** Electron display id that overrides the automatic TV display choice. */
  display: number | undefined;
  kiosk: boolean;
  /** `false` only with `--windowed` (development without a TV). */
  fullscreen: boolean;
  occlusionFix: boolean;
  /** Loopback host for the page origin. `localhost` by default: headless Chrome showed YouTube error 150 for label videos on `127.0.0.1` (M0 finding). */
  loopback: 'localhost' | '127.0.0.1';
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/i.exec(arg);
    if (match?.[1]) flags.set(match[1].toLowerCase(), match[2] ?? true);
  }
  const str = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  const modeFlag = str('mode');
  if (modeFlag !== undefined && modeFlag !== 'hub' && modeFlag !== 'player') {
    throw new Error(`--mode must be "hub" or "player", got "${modeFlag}"`);
  }
  const mode: Mode | undefined = modeFlag;

  const hubFlag = str('hub');
  const hub = hubFlag?.replace(/\/+$/, '');
  if (hub !== undefined && !/^https?:\/\/[^/]+$/i.test(hub)) {
    throw new Error(`--hub must be http://<hub-ip>:<port>, got "${hubFlag}"`);
  }

  const displayFlag = str('display');
  const display = displayFlag === undefined ? undefined : Number(displayFlag);
  if (display !== undefined && !Number.isFinite(display)) {
    throw new Error(`--display must be a numeric display id, got "${displayFlag}"`);
  }

  const loopbackFlag = str('loopback');
  if (loopbackFlag !== undefined && loopbackFlag !== 'localhost' && loopbackFlag !== '127.0.0.1') {
    throw new Error(`--loopback must be "localhost" or "127.0.0.1", got "${loopbackFlag}"`);
  }
  const loopback: 'localhost' | '127.0.0.1' = loopbackFlag ?? 'localhost';

  return {
    mode,
    hub,
    display,
    loopback,
    kiosk: flags.has('kiosk'),
    fullscreen: !flags.has('windowed'),
    occlusionFix: flags.has('occlusion-fix'),
  };
}
