import { HouseholdKeySchema } from '@room-jukebox/shared';
import type { BeaconIdentity } from './beacon';
import { subkey } from './household';
import type { PlayerHubView } from './player-lan';

/*
 * ADAPTER for the M2 server surface the server lane adds in parallel. Declared here so this lane
 * compiles against the base server; at merge these collapse onto the server's own types.
 *
 * - `buildApp({ mode: 'player', hub })`: see `player-lan.ts` (probed, stub fallback).
 * - `app.jukebox.household()`: the hub's identity and household key, so the desktop can sign
 *   beacons and compute the hub TV window's own join proof. Expected shape below; when the
 *   method is missing (base server) the hub sends no beacons and `localPlayerAuth` returns null.
 */

export interface HubHousehold {
  hubId: string;
  hubEpoch: number;
  keyEpoch: number;
  /** base64, 32 bytes. */
  householdKey: string;
  roomName: string;
}

/** The M2 additions to `app.jukebox` this lane uses (all optional until the merge). */
export interface M2JukeboxApi {
  household?: () => HubHousehold | null;
}

/** M2 `BuildAppOptions` additions (contract "Desktop ↔ server"). */
export interface M2BuildAppOptions {
  mode?: 'hub' | 'player';
  hub?: PlayerHubView;
}

export function hubHousehold(api: unknown): HubHousehold | null {
  const fn = (api as M2JukeboxApi | undefined)?.household;
  if (typeof fn !== 'function') return null;
  try {
    const h = fn.call(api);
    if (!h || !HouseholdKeySchema.safeParse(h.householdKey).success) return null;
    return h;
  } catch {
    return null;
  }
}

export function beaconIdentity(h: HubHousehold | null): BeaconIdentity | null {
  if (!h) return null;
  return {
    hubId: h.hubId,
    hubEpoch: h.hubEpoch,
    keyEpoch: h.keyEpoch,
    roomName: h.roomName,
    beaconKey: subkey(h.householdKey, 'rj/beacon'),
  };
}
