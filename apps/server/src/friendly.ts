import { lookup } from 'node:dns/promises';
import type { LanReply } from '@room-jukebox/shared';
import type { SettingsData } from './db/repo.ts';
import { chooseAddress, safeAddresses } from './lan.ts';
import type { LanProvider } from './lan.ts';

/** Resolves a hostname to its IPv4 addresses. Rejects when the name does not resolve. */
export type HostResolver = (host: string) => Promise<string[]>;

export const dnsResolver: HostResolver = async (host) => {
  const all = await lookup(host, { all: true });
  return all.filter((a) => a.family === 4).map((a) => a.address);
};

export const FRIENDLY_INTERVAL_MS = 60_000;

export interface FriendlyDeps {
  lan: LanProvider;
  settings: () => SettingsData;
  resolve: HostResolver;
  now: () => number;
  intervalMs?: number;
  /** Called when a check changes the outcome (so the TV gets a fresh state). */
  onChange?: () => void;
}

/**
 * Checks that the owner's friendly name (a DNS record on the router) points at this laptop.
 * The lookup runs every 60 s and on `recheck()`; `ok`/`hint` are derived from the last lookup
 * and the current addresses, so a change of network shows up without waiting for a new lookup.
 */
export class FriendlyCheck {
  #d: FriendlyDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #host: string | null = null;
  #resolvesTo: string[] = [];
  #checkedAt: number | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: FriendlyDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.recheck();
    this.#timer = setInterval(
      () => void this.recheck(),
      this.#d.intervalMs ?? FRIENDLY_INTERVAL_MS,
    );
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Looks the configured host up now (no-op without one). Never rejects. */
  async recheck(): Promise<void> {
    // Serialise: a patch during a timer lookup waits, then looks up again with the new host.
    while (this.#running) await this.#running;
    this.#running = this.#lookup().finally(() => {
      this.#running = null;
    });
    await this.#running;
  }

  async #lookup(): Promise<void> {
    const host = this.#d.settings().friendlyHost ?? null;
    const before = JSON.stringify(this.status());
    let found: string[] = [];
    if (host !== null) {
      try {
        found = await this.#d.resolve(host);
      } catch {
        found = [];
      }
    }
    this.#host = host;
    this.#resolvesTo = found;
    this.#checkedAt = host === null ? null : this.#d.now();
    if (JSON.stringify(this.status()) !== before) this.#d.onChange?.();
  }

  status(): LanReply['friendly'] {
    const settings = this.#d.settings();
    const host = settings.friendlyHost ?? null;
    if (host === null)
      return { host: null, resolvesTo: [], ok: false, checkedAt: null, hint: null };
    // A host changed in settings but not yet looked up has no result.
    const known = this.#host === host;
    const resolvesTo = known ? this.#resolvesTo : [];
    const addresses = safeAddresses(this.#d.lan);
    const ok = resolvesTo.some((ip) => addresses.some((a) => a.address === ip));
    if (!known) return { host, resolvesTo, ok: false, checkedAt: null, hint: null };
    let hint: string | null = null;
    if (!ok) {
      hint =
        resolvesTo.length > 0
          ? `Name resolves to ${resolvesTo.join(', ')}, which is not this laptop`
          : `Add a DNS record on the UDM: ${host} → ${chooseAddress(addresses, settings.lanChosen)} (UniFi Network → Settings → Routing → DNS → Create New DNS Record, type A)`;
    }
    return { host, resolvesTo, ok, checkedAt: this.#checkedAt, hint };
  }
}
