/**
 * Household key and the M2 crypto (docs/contract-m2.md §1, §2, §4). Pure functions plus the
 * `Household` store; the desktop imports this file by path for beacons, pairing and join proofs.
 *
 * - The key is 32 random bytes, carried as standard base64 (44 characters).
 * - Subkeys: HKDF-SHA256(key, salt = empty, info = `rj/beacon` | `rj/player-proof` |
 *   `rj/hub-proof` | `rj/wrap`, 32 bytes).
 * - Proofs: base64url(HMAC-SHA256(subkey, parts.join('|'))); no part may contain `|`.
 * - Beacon `sig`: base64url(HMAC-SHA256(beaconKey, canonicalJson(unsigned fields))).
 * - Wrapped secrets: base64(iv[12] ‖ tag[16] ‖ AES-256-GCM ciphertext) under the wrap subkey.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  BeaconSchema,
  BeaconUnsignedSchema,
  type Beacon,
  type BeaconUnsigned,
  type HouseholdSubkeys,
} from '@room-jukebox/shared';
import type { Repos } from './db/repo.ts';
import type { Secrets } from './settings.ts';

export const HOUSEHOLD_KEY_BYTES = 32;

/** The four HKDF info strings (contract **HouseholdSubkeys**). */
export const SUBKEY_INFO = {
  beacon: 'rj/beacon',
  playerProof: 'rj/player-proof',
  hubProof: 'rj/hub-proof',
  wrap: 'rj/wrap',
} as const satisfies Record<string, HouseholdSubkeys>;

/** A household key as base64 or raw bytes. */
export type KeyInput = string | Buffer;

/** A fresh random household key (base64, 44 characters). */
export function generateHouseholdKey(): string {
  return randomBytes(HOUSEHOLD_KEY_BYTES).toString('base64');
}

/** The raw 32 bytes of a household key; throws on anything else. */
export function householdKeyBytes(key: KeyInput): Buffer {
  const buf = typeof key === 'string' ? Buffer.from(key, 'base64') : key;
  if (buf.length !== HOUSEHOLD_KEY_BYTES) throw new Error('household key must be 32 bytes');
  return buf;
}

/** HKDF-SHA256 subkey (32 bytes) for one purpose. */
export function subkey(key: KeyInput, info: HouseholdSubkeys): Buffer {
  return Buffer.from(hkdfSync('sha256', householdKeyBytes(key), Buffer.alloc(0), info, 32));
}

export interface HouseholdKeys {
  beacon: Buffer;
  playerProof: Buffer;
  hubProof: Buffer;
  wrap: Buffer;
}

/** All four subkeys of a household key. */
export function deriveKeys(key: KeyInput): HouseholdKeys {
  return {
    beacon: subkey(key, SUBKEY_INFO.beacon),
    playerProof: subkey(key, SUBKEY_INFO.playerProof),
    hubProof: subkey(key, SUBKEY_INFO.hubProof),
    wrap: subkey(key, SUBKEY_INFO.wrap),
  };
}

/** A random nonce for proofs and challenges (16 bytes, base64url). */
export const newNonce = (): string => randomBytes(16).toString('base64url');

/**
 * base64url (no padding) of HMAC-SHA256(subkey, parts.map(String).join('|')). Throws when a part
 * contains `|`.
 */
export function hmacProof(key: Buffer, parts: readonly (string | number)[]): string {
  const text = parts.map(String);
  for (const p of text) {
    if (p.includes('|')) throw new Error('proof parts must not contain "|"');
  }
  return createHmac('sha256', key).update(text.join('|')).digest('base64url');
}

/** Constant-time check of `proof` against `hmacProof(key, parts)` (false on any malformed input). */
export function verifyProof(
  key: Buffer,
  parts: readonly (string | number)[],
  proof: string,
): boolean {
  let expected: string;
  try {
    expected = hmacProof(key, parts);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(proof);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// The proof formulas (contract §1 and §4). Each starts with its own purpose label.

export interface PairProofInput {
  hubId: string;
  deviceId: string;
  nonceP: string;
  nonceH: string;
  hubAddress: string;
  hubPort: number;
}

/** `HMAC(hubProofKey, "pair" | hubId | deviceId | nonceP | nonceH | hubAddress | hubPort)`. */
export const pairProofParts = (i: PairProofInput): string[] => [
  'pair',
  i.hubId,
  i.deviceId,
  i.nonceP,
  i.nonceH,
  i.hubAddress,
  String(i.hubPort),
];
export const pairProof = (hubProofKey: Buffer, i: PairProofInput): string =>
  hmacProof(hubProofKey, pairProofParts(i));

export interface JoinProofInput {
  deviceId: string;
  hubId: string;
  nonceP: string;
  hubAddress: string;
  hubPort: number;
}

/** `HMAC(playerProofKey, "join" | deviceId | hubId | nonceP | hubAddress | hubPort)`. */
export const joinProofParts = (i: JoinProofInput): string[] => [
  'join',
  i.deviceId,
  i.hubId,
  i.nonceP,
  i.hubAddress,
  String(i.hubPort),
];
export const joinProof = (playerProofKey: Buffer, i: JoinProofInput): string =>
  hmacProof(playerProofKey, joinProofParts(i));

export interface JoinAckProofInput {
  hubId: string;
  deviceId: string;
  nonceP: string;
  nonceH: string;
}

/** `HMAC(hubProofKey, "join-ack" | hubId | deviceId | nonceP | nonceH)`. */
export const joinAckProofParts = (i: JoinAckProofInput): string[] => [
  'join-ack',
  i.hubId,
  i.deviceId,
  i.nonceP,
  i.nonceH,
];
export const joinAckProof = (hubProofKey: Buffer, i: JoinAckProofInput): string =>
  hmacProof(hubProofKey, joinAckProofParts(i));

export interface HubChallengeProofInput {
  /** The challenger's hubId (the body's `hubId`). */
  theirHubId: string;
  /** The answering hub's own hubId. */
  myHubId: string;
  nonce: string;
  /** The answering hub's `hubEpoch`. */
  epoch: number;
}

/** `HMAC(hubProofKey, "hub" | theirHubId | myHubId | nonce | epoch)`. */
export const hubChallengeProofParts = (i: HubChallengeProofInput): string[] => [
  'hub',
  i.theirHubId,
  i.myHubId,
  i.nonce,
  String(i.epoch),
];
export const hubChallengeProof = (hubProofKey: Buffer, i: HubChallengeProofInput): string =>
  hmacProof(hubProofKey, hubChallengeProofParts(i));

// ---------------------------------------------------------------------------------------------
// Beacons

/** JSON with object keys sorted at every level (no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const beaconSig = (beaconKey: Buffer, unsigned: BeaconUnsigned): string =>
  createHmac('sha256', beaconKey)
    .update(canonicalJson(BeaconUnsignedSchema.parse(unsigned)))
    .digest('base64url');

/** Signs a beacon with the `rj/beacon` subkey. */
export function signBeacon(unsigned: BeaconUnsigned, beaconKey: Buffer): Beacon {
  const clean = BeaconUnsignedSchema.parse(unsigned);
  return { ...clean, sig: beaconSig(beaconKey, clean) };
}

/** A fresh boot ID (base-36 boot time plus a random suffix). */
export function newBootId(now: number = Date.now()): string {
  return `${now.toString(36).padStart(10, '0')}-${randomBytes(4).toString('hex')}`;
}

/** Last accepted `(bootId, counter)` per hubId (the receiver keeps one per process). */
export type BeaconLastSeen = Map<string, { bootId: string; counter: number }>;

export type BeaconVerdict =
  | { ok: true; beacon: Beacon }
  | { ok: false; reason: 'malformed' | 'bad-sig' | 'address-mismatch' | 'replay' };

/**
 * Checks a received beacon: shape, signature, `address` = the UDP source address, and
 * `(bootId, counter)` above the last one accepted for that hubId: a different bootId is accepted
 * (the hub restarted), the same bootId needs a strictly higher counter. On success the pair is
 * recorded in `lastSeen`.
 */
export function verifyBeacon(
  beacon: unknown,
  beaconKey: Buffer,
  lastSeen: BeaconLastSeen,
  sourceAddress: string,
): BeaconVerdict {
  const parsed = BeaconSchema.safeParse(beacon);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const { sig, ...unsigned } = parsed.data;
  const expected = Buffer.from(beaconSig(beaconKey, unsigned));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad-sig' };
  }
  if (unsigned.address !== sourceAddress) return { ok: false, reason: 'address-mismatch' };
  const last = lastSeen.get(unsigned.hubId);
  if (last !== undefined && unsigned.bootId === last.bootId && unsigned.counter <= last.counter) {
    return { ok: false, reason: 'replay' };
  }
  lastSeen.set(unsigned.hubId, { bootId: unsigned.bootId, counter: unsigned.counter });
  return { ok: true, beacon: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Secret wrapping (replica)

/** AES-256-GCM under the wrap subkey: base64(iv ‖ tag ‖ ciphertext). */
export function wrapSecret(wrapKey: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Inverse of `wrapSecret`; throws when the key is wrong or the data was altered. */
export function unwrapSecret(wrapKey: Buffer, wrapped: string): string {
  const buf = Buffer.from(wrapped, 'base64');
  if (buf.length < 28) throw new Error('wrapped secret too short');
  const decipher = createDecipheriv('aes-256-gcm', wrapKey, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// The hub's stored key

export interface HouseholdDeps {
  repos: Repos;
  secrets: Secrets;
  now: () => number;
  /** Tests: deterministic keys. */
  generate?: () => string;
}

/**
 * The hub's household key: `settings.household_key_enc` (through `Secrets`) and `keyEpoch` in
 * the settings JSON. Created on first use (setup, or the first M2 start of an M1 hub).
 */
export class Household {
  #d: HouseholdDeps;
  #cache: { enc: string; key: string; keys: HouseholdKeys } | null = null;

  constructor(deps: HouseholdDeps) {
    this.#d = deps;
  }

  #store(key: string, keyEpoch: number): void {
    const { repos, secrets, now } = this.#d;
    const row = repos.settings.get();
    if (row === null) throw new Error('settings row missing');
    const enc = secrets.encrypt(key);
    repos.settings.setHouseholdKey(enc, { ...row.data, keyEpoch }, now());
    this.#cache = { enc, key, keys: deriveKeys(key) };
  }

  #load(): { key: string; keys: HouseholdKeys } {
    const row = this.#d.repos.settings.get();
    const enc = row?.householdKeyEnc ?? null;
    if (enc !== null && this.#cache?.enc === enc) return this.#cache;
    if (enc !== null) {
      try {
        const key = this.#d.secrets.decrypt(enc);
        householdKeyBytes(key);
        this.#cache = { enc, key, keys: deriveKeys(key) };
        return this.#cache;
      } catch {
        // Unreadable (at-rest key changed): fall through to a fresh key, which re-keys players.
      }
    }
    const key = (this.#d.generate ?? generateHouseholdKey)();
    this.#store(key, enc === null ? this.keyEpoch() : this.keyEpoch() + 1);
    return this.#cache as { key: string; keys: HouseholdKeys };
  }

  /** Creates the key when there is none (called at setup). */
  ensure(): void {
    this.#load();
  }

  /** The household key (base64). */
  key(): string {
    return this.#load().key;
  }

  keys(): HouseholdKeys {
    return this.#load().keys;
  }

  keyEpoch(): number {
    return this.#d.repos.settings.get()?.data.keyEpoch ?? 0;
  }

  /** A new key; bumps `keyEpoch`. The caller pushes `rekey` to the players. */
  rotateHouseholdKey(): { householdKey: string; keyEpoch: number } {
    const keyEpoch = this.keyEpoch() + 1;
    const key = (this.#d.generate ?? generateHouseholdKey)();
    this.#store(key, keyEpoch);
    return { householdKey: key, keyEpoch };
  }
}
