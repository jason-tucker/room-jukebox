import { timingSafeEqual } from 'node:crypto';
import { subkey, hmacProof } from 'server/src/household.ts';

/*
 * Household-key crypto (docs/contract-m2.md §1–2). The four primitives come from the server's
 * `household.ts` (one implementation for hub and player; the fixtures in test/m2.test.ts check
 * it). Beacon checks use the server's `verifyBeacon(beacon, key, lastSeen, sourceAddress)`.
 */
export {
  canonicalJson,
  hmacProof,
  signBeacon,
  subkey,
  verifyBeacon,
  type BeaconLastSeen,
  type BeaconVerdict,
} from 'server/src/household.ts';

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
