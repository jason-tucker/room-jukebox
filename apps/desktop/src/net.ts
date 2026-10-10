import type { NetworkInterfaceInfo } from 'node:os';

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`not an IPv4 address: ${address}`);
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** Directed broadcast address of the subnet `address`/`netmask` (e.g. 192.168.1.255). */
export function directedBroadcast(address: string, netmask: string): string {
  const addr = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  return intToIpv4((addr | ~mask) >>> 0);
}

export interface BeaconInterface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

/** Non-internal IPv4 interfaces with their directed broadcast addresses. */
export function beaconInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): BeaconInterface[] {
  const out: BeaconInterface[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      // A /32 (some VPN adapters) has no broadcast domain.
      if (info.netmask === '255.255.255.255') continue;
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        broadcast: directedBroadcast(info.address, info.netmask),
      });
    }
  }
  return out;
}

/** One LAN address as the server's `lan.addresses()` hook reports it (contract: `GET /api/admin/lan`). */
export interface LanAddress {
  interface: string;
  address: string;
  cidr: string;
}

/** Non-internal IPv4 addresses for the QR/LAN URL choice, in `os.networkInterfaces()` order. */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ interface: name, address: info.address, cidr: info.cidr ?? `${info.address}/32` });
    }
  }
  return out;
}
