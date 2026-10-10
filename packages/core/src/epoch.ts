/**
 * Hub epoch rules (plan §3.4, §3.5): which hub wins when two claim the same household.
 * `hubEpoch` is persisted in settings and starts at 1; Become hub sets it to `old + 1`; a restore
 * sets it to `max(backup, current) + 1`.
 */

export const INITIAL_HUB_EPOCH = 1;

export interface HubClaim {
  hubId: string;
  epoch: number;
}

export interface ResolveHubInput {
  mine: HubClaim;
  theirs: HubClaim;
  /** True only when `theirs` passed the mutual challenge-response. */
  theirsVerified: boolean;
}

/**
 * - `ignore`: unverified, ourselves, or an epoch jump larger than `mine.epoch + 1`;
 * - `yield`: a verified hub with epoch `mine.epoch + 1`, or an equal epoch and a lower `hubId`
 *   (plain code-unit string order, the same on every machine);
 * - `keep`: we stay hub (their epoch is lower, or equal with a higher `hubId`).
 */
export function resolveHub({
  mine,
  theirs,
  theirsVerified,
}: ResolveHubInput): 'keep' | 'yield' | 'ignore' {
  if (!theirsVerified || theirs.hubId === mine.hubId) return 'ignore';
  if (theirs.epoch > mine.epoch + 1) return 'ignore';
  if (theirs.epoch > mine.epoch) return 'yield';
  if (theirs.epoch < mine.epoch) return 'keep';
  return theirs.hubId < mine.hubId ? 'yield' : 'keep';
}

/** The epoch a player takes when the owner presses Become hub. */
export function nextEpochOnPromote(currentEpoch: number): number {
  return currentEpoch + 1;
}

/** The epoch after restoring a backup: `max(backup, current) + 1`. */
export function nextEpochAfterRestore(backupEpoch: number, currentEpoch: number): number {
  return Math.max(backupEpoch, currentEpoch) + 1;
}
