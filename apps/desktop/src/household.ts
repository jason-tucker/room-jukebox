import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Beacon, BeaconUnsigned, HouseholdSubkeys } from '@room-jukebox/shared';

/*
 * Household-key crypto (docs/contract-m2.md §1–2).
 *
 * ADAPTER: the server lane owns `apps/server/src/household.ts` with the same four primitives
 * (`subkey`, `hmacProof`, `signBeacon`, `verifyBeacon`). It did not exist at this lane's base, so
 * they are implemented here with the formulas below; at merge, replace the four bodies with
 *   export { subkey, hmacProof, signBeacon, verifyBeacon } from 'server/src/household.ts';
 * and keep the desktop-only helpers further down (they are written only in terms of the four).
 *
 * Formulas (must match the server):
 * - key: 32 bytes, base64 on the wire (44 chars).
 * - subkey(key, info) = HKDF-SHA256(ikm = key bytes, salt = empty, info = utf8(info), 32 bytes).
 * - hmacProof(subkey, parts) = base64url(HMAC-SHA256(subkey, parts.map(String).join('|'))).
 * - beacon sig = base64url(HMAC-SHA256(beaconKey, canonicalJson(beacon without sig))), where
 *   canonicalJson = JSON.stringify with object keys sorted (recursively).
 * - verifyBeacon: sig matches (constant time) and `(bootId, counter)` is above `lastSeen`: a new
 *   bootId is accepted (the hub restarted), the same bootId needs a strictly higher counter.
 */

export function keyBytes(key: Buffer | string): Buffer {
  return typeof key === 'string' ? Buffer.from(key, 'base64') : key;
}

export function subkey(key: Buffer | string, info: HouseholdSubkeys): Buffer {
  return Buffer.from(hkdfSync('sha256', keyBytes(key), Buffer.alloc(0), info, 32));
}

export function hmacProof(sub: Buffer, parts: readonly (string | number)[]): string {
  return createHmac('sha256', sub).update(parts.map(String).join('|')).digest('base64url');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signBeacon(unsigned: BeaconUnsigned, beaconKey: Buffer): Beacon {
  const sig = createHmac('sha256', beaconKey).update(canonicalJson(unsigned)).digest('base64url');
  return { ...unsigned, sig };
}

export interface BeaconLastSeen {
  bootId: string;
  counter: number;
}

export function verifyBeacon(
  beacon: Beacon,
  beaconKey: Buffer,
  lastSeen: BeaconLastSeen | undefined,
): boolean {
  const { sig, ...unsigned } = beacon;
  if (!proofEquals(signBeacon(unsigned, beaconKey).sig, sig)) return false;
  if (lastSeen && lastSeen.bootId === beacon.bootId && beacon.counter <= lastSeen.counter) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Desktop helpers (pairing and join proofs), built on the primitives above.

export function proofEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The `hubAddress | hubPort` pair the proofs bind to: host and port of the hub URL dialled. */
export interface HubEndpoint {
  host: string;
  port: number;
}

export function hubEndpoint(hubUrl: string): HubEndpoint {
  const u = new URL(hubUrl);
  return { host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 };
}

/** `HMAC(hubProofKey, "pair" | hubId | deviceId | nonceP | nonceH | hubAddress | hubPort)`. */
export function pairProof(
  key: Buffer | string,
  p: { hubId: string; deviceId: string; nonceP: string; nonceH: string; hub: HubEndpoint },
): string {
  return hmacProof(subkey(key, 'rj/hub-proof'), [
    'pair',
    p.hubId,
    p.deviceId,
    p.nonceP,
    p.nonceH,
    p.hub.host,
    p.hub.port,
  ]);
}

/** `HMAC(playerProofKey, "join" | deviceId | hubId | nonceP | hubAddress | hubPort)`. */
export function joinProof(
  key: Buffer | string,
  p: { deviceId: string; hubId: string; nonceP: string; hub: HubEndpoint },
): string {
  return hmacProof(subkey(key, 'rj/player-proof'), [
    'join',
    p.deviceId,
    p.hubId,
    p.nonceP,
    p.hub.host,
    p.hub.port,
  ]);
}

/** `HMAC(hubProofKey, "join-ack" | hubId | deviceId | nonceP | nonceH)`. */
export function joinAckProof(
  key: Buffer | string,
  p: { hubId: string; deviceId: string; nonceP: string; nonceH: string },
): string {
  return hmacProof(subkey(key, 'rj/hub-proof'), [
    'join-ack',
    p.hubId,
    p.deviceId,
    p.nonceP,
    p.nonceH,
  ]);
}
