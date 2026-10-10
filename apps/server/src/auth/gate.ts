/**
 * Household source gate (plan §3.3): admin, setup and player routes and the player/admin
 * WebSockets accept only loopback, the hub's own IPv4 subnets and the tailnet (100.64.0.0/10).
 * The Bot VPS proxy peer, link-local, ULA and anything carrying a proxy header are refused.
 */
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';

export const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'forwarded', 'via'];
/** Known proxy peers (Bot VPS on the tailnet). */
export const DENIED_PEERS: ReadonlySet<string> = new Set(['100.82.187.53']);

/** Lower-cases, strips an IPv6 zone and unwraps IPv4-mapped IPv6 (`::ffff:a.b.c.d`). */
export function normaliseIp(address: string | undefined | null): string {
  if (!address) return '';
  let ip = address.trim().toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) return mapped[1];
  return ip;
}

export function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** True when IPv4 `ip` is inside `cidr` (`a.b.c.d/n`). */
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (!base || !isIPv4(base) || !isIPv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isLoopback(ip: string): boolean {
  return (isIPv4(ip) && inCidr(ip, '127.0.0.0/8')) || ip === '::1';
}

/** First 16 bits of an IPv6 address (enough for fe80::/10 and fc00::/7). */
function ipv6Head(ip: string): number {
  const first = ip.startsWith('::') ? '0' : (ip.split(':')[0] ?? '0');
  return Number.parseInt(first || '0', 16);
}

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

export interface GateInput {
  ip: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The hub's own IPv4 subnets in CIDR form. */
  subnets: readonly string[];
}

export function checkHouseholdSource({ ip, headers, subnets }: GateInput): GateDecision {
  for (const h of PROXY_HEADERS) {
    if (headers[h] !== undefined) return { allowed: false, reason: `proxy header ${h}` };
  }
  if (ip === '') return { allowed: false, reason: 'unknown source' };
  if (DENIED_PEERS.has(ip)) return { allowed: false, reason: 'proxy peer' };
  if (isIPv4(ip)) {
    if (inCidr(ip, '127.0.0.0/8')) return { allowed: true };
    if (inCidr(ip, '169.254.0.0/16')) return { allowed: false, reason: 'link-local' };
    if (inCidr(ip, '100.64.0.0/10')) return { allowed: true };
    if (subnets.some((c) => inCidr(ip, c))) return { allowed: true };
    return { allowed: false, reason: 'outside the household' };
  }
  if (isIPv6(ip)) {
    if (ip === '::1') return { allowed: true };
    const head = ipv6Head(ip);
    if ((head & 0xffc0) === 0xfe80) return { allowed: false, reason: 'link-local' };
    if ((head & 0xfe00) === 0xfc00) return { allowed: false, reason: 'unique local' };
    return { allowed: false, reason: 'outside the household' };
  }
  return { allowed: false, reason: 'unknown source' };
}

/** The request's socket peer, normalised (Fastify runs without trustProxy, so never a header). */
export function sourceIp(request: FastifyRequest): string {
  return normaliseIp(request.socket?.remoteAddress);
}
