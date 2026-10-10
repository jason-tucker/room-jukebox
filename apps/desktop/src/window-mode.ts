import type { CliOptions } from './args';
import type { DesktopState } from './desktop-state';

export interface WindowMode {
  fullscreen: boolean;
  kiosk: boolean;
  displayId: number | undefined;
}

/**
 * TV window mode: `--windowed` wins (development), `--kiosk` forces kiosk, `--display` overrides
 * the saved TV display; otherwise the hub's settings (auto-fullscreen on by default, kiosk off).
 * During setup the window stays a normal window so the owner can type and switch apps.
 */
export function resolveWindowMode(
  opts: Pick<CliOptions, 'fullscreen' | 'kiosk' | 'display'>,
  state: Pick<DesktopState, 'autoFullscreen' | 'kiosk' | 'tvDisplayId'>,
  setup: boolean,
): WindowMode {
  const displayId = opts.display ?? state.tvDisplayId ?? undefined;
  if (setup || !opts.fullscreen) return { fullscreen: false, kiosk: false, displayId };
  const kiosk = opts.kiosk || state.kiosk === true;
  const fullscreen = kiosk || state.autoFullscreen !== false;
  return { fullscreen, kiosk, displayId };
}
