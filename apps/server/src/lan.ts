import { networkInterfaces } from 'node:os';
import type { LanReply } from '@room-jukebox/shared';
import { inCidr } from './auth/gate.ts';
import type { SettingsData } from './db/repo.ts';
import type { FriendlyCheck } from './friendly.ts';

/** One IPv4 address of this machine (`cidr` = `address/prefix`). */
export interface LanAddress {
  interface: string;
  address: string;
  cidr: string;
}

export interface LanProvider {
  /** Non-internal IPv4 addresses, re-read on every call (networks change at the venue). */
  addresses(): LanAddress[];
}

export const osLan: LanProvider = {
  addresses() {
    const out: LanAddress[] = [];
    for (const [name, infos] of Object.entries(networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        out.push({
          interface: name,
          address: info.address,
          cidr: info.cidr ?? `${info.address}/32`,
        });
      }
    }
    return out;
  },
};

const VIRTUAL_NAME =
  /docker|veth|br-|vbox|virtualbox|vmware|vethernet|wsl|hyper-v|tailscale|zerotier/i;

/** Docker bridges (172.17–172.31) and similar host-only ranges look like LANs but are not. */
function looksVirtual(a: LanAddress): boolean {
  if (VIRTUAL_NAME.test(a.interface)) return true;
  const [, second] = a.address.split('.').map(Number);
  return a.address.startsWith('172.') && second !== undefined && second >= 17 && second <= 31;
}

/**
 * The QR address: the owner's override when it is still one of ours, else the first IPv4 that is
 * not link-local (169.254/16), loopback, or a Docker/VirtualBox-looking range; `127.0.0.1` when
 * there is nothing else.
 */
export function chooseAddress(addresses: readonly LanAddress[], override: string | null): string {
  if (override !== null && addresses.some((a) => a.address === override)) return override;
  const usable = addresses.filter(
    (a) => !inCidr(a.address, '169.254.0.0/16') && !inCidr(a.address, '127.0.0.0/8'),
  );
  return (usable.find((a) => !looksVirtual(a)) ?? usable[0])?.address ?? '127.0.0.1';
}

export const lanUrl = (address: string, port: number): string => `http://${address}:${port}/`;

export function lanReply(
  provider: LanProvider,
  settings: SettingsData,
  friendly?: FriendlyCheck,
): LanReply {
  const addresses = safeAddresses(provider);
  const chosen = chooseAddress(addresses, settings.lanChosen);
  return {
    addresses,
    chosen,
    lanUrl: lanUrl(chosen, settings.lanPort),
    friendly: friendly
      ? friendly.status()
      : {
          host: settings.friendlyHost ?? null,
          resolvesTo: [],
          ok: false,
          checkedAt: null,
          hint: null,
        },
  };
}

/** What the TV prints and the QR encodes: the friendly URL once it points here, else the IP URL. */
export function joinUrl(reply: LanReply, port: number): string {
  return reply.friendly.ok && reply.friendly.host !== null
    ? lanUrl(reply.friendly.host, port)
    : reply.lanUrl;
}

export function safeAddresses(provider: LanProvider): LanAddress[] {
  try {
    return provider.addresses();
  } catch {
    return [];
  }
}

/** Escapes `\ ; , : "` with a backslash (the WIFI: QR grammar). */
export const escapeWifi = (s: string): string => s.replace(/([\\;,:"])/g, '\\$1');

/** `WIFI:T:<WPA|WEP|nopass|SAE>;S:<ssid>;P:<password>;;` (`H:true;` only when hidden) or null without settings. */
export function wifiQrPayload(wifi: SettingsData['wifi'], password: string | null): string | null {
  if (wifi === null || wifi.ssid === '') return null;
  const pw = wifi.security === 'nopass' ? '' : `P:${escapeWifi(password ?? '')};`;
  return `WIFI:T:${wifi.security};S:${escapeWifi(wifi.ssid)};${pw}${wifi.hidden ? 'H:true;' : ''};`;
}
