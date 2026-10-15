import { HouseholdKeySchema } from '@room-jukebox/shared';
import type { HouseholdInfo, JukeboxApi } from 'server/src/app.ts';
import type { BeaconIdentity } from './beacon';
import { subkey } from './household';

/*
 * The embedded hub's household identity (`app.jukebox.household()`), so the desktop can sign
 * beacons and compute the hub TV window's own join proof. Null before setup; beacons pause.
 */

export type HubHousehold = HouseholdInfo;

export function hubHousehold(api: JukeboxApi | null): HubHousehold | null {
  if (!api) return null;
  try {
    const h = api.household();
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
