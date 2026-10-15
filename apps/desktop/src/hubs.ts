import { BeaconSchema } from '@room-jukebox/shared';
import type { Beacon } from '@room-jukebox/shared';
import { verifyBeacon } from './household';
import type { BeaconLastSeen } from './household';

/** A hub is dropped from the list 30 s after its last accepted beacon. */
export const HUB_EXPIRY_MS = 30_000;

export interface HubEntry {
  hubId: string;
  roomName: string;
  address: string;
  port: number;
  hubEpoch: number;
  keyEpoch: number;
  protocolVersion: number;
  version: string;
  /** ms epoch of the last accepted beacon. */
  lastSeen: number;
  /** Signature checked with our household key. Unpaired players list hubs unverified. */
  verified: boolean;
}

export type BeaconVerdict =
  | { ok: true; beacon: Beacon; entry: HubEntry }
  | { ok: false; reason: 'malformed' | 'address' | 'bad-sig' | 'replay' };

/**
 * Hubs heard via beacons, deduplicated by `hubId`. With a beacon key only signed, fresh beacons
 * whose `address` is the UDP source are accepted (contract §2); without one (unpaired) a
 * well-formed beacon is listed as unverified so the wizard can offer "Join <room>".
 */
export class HubDirectory {
  private readonly hubs = new Map<string, HubEntry>();
  private readonly seen = new Map<string, BeaconLastSeen>();

  private readonly beaconKey: () => Buffer | null;
  private readonly now: () => number;

  constructor(beaconKey: () => Buffer | null, now: () => number = Date.now) {
    this.beaconKey = beaconKey;
    this.now = now;
  }

  accept(raw: unknown, source: string): BeaconVerdict {
    const parsed = BeaconSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'malformed' };
    const beacon = parsed.data;
    if (beacon.address !== source) return { ok: false, reason: 'address' };
    const key = this.beaconKey();
    const last = this.seen.get(beacon.hubId);
    let verified = false;
    if (key) {
      // Signature alone first, so a bad signature and a replay are told apart in the logs.
      if (!verifyBeacon(beacon, key, undefined)) return { ok: false, reason: 'bad-sig' };
      if (!verifyBeacon(beacon, key, last)) return { ok: false, reason: 'replay' };
      verified = true;
    } else if (last && last.bootId === beacon.bootId && beacon.counter <= last.counter) {
      return { ok: false, reason: 'replay' };
    }
    this.seen.set(beacon.hubId, { bootId: beacon.bootId, counter: beacon.counter });
    const entry: HubEntry = {
      hubId: beacon.hubId,
      roomName: beacon.roomName,
      address: beacon.address,
      port: beacon.port,
      hubEpoch: beacon.hubEpoch,
      keyEpoch: beacon.keyEpoch,
      protocolVersion: beacon.protocolVersion,
      version: beacon.version,
      lastSeen: this.now(),
      verified,
    };
    this.hubs.set(beacon.hubId, entry);
    return { ok: true, beacon, entry };
  }

  /** Drops expired hubs; returns true when the list changed. */
  sweep(): boolean {
    const cutoff = this.now() - HUB_EXPIRY_MS;
    let changed = false;
    for (const [id, hub] of this.hubs) {
      if (hub.lastSeen < cutoff) {
        this.hubs.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Live hubs; once we hold a key, unverified entries (heard before pairing) are hidden. */
  list(): HubEntry[] {
    this.sweep();
    const keyed = this.beaconKey() !== null;
    return [...this.hubs.values()]
      .filter((h) => h.verified || !keyed)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
