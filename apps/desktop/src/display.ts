/** The subset of Electron's `Display` the TV display choice needs (kept pure for tests). */
export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  internal?: boolean;
}

/**
 * Picks the display the player window goes on: the override when it is connected, otherwise the
 * first display that is not the primary one (the TV on a laptop with HDMI), otherwise the primary.
 */
export function pickTvDisplay<T extends DisplayLike>(
  displays: readonly T[],
  primaryId: number,
  overrideId?: number,
): T | undefined {
  if (overrideId !== undefined) {
    const chosen = displays.find((d) => d.id === overrideId);
    if (chosen) return chosen;
  }
  return (
    displays.find((d) => d.id !== primaryId) ??
    displays.find((d) => d.id === primaryId) ??
    displays[0]
  );
}

/**
 * Whether the TV is plugged in: the configured display when one is set, otherwise any external
 * display (or more than one display, when Windows does not report `internal`).
 */
export function tvConnected(
  displays: readonly DisplayLike[],
  tvDisplayId: number | null | undefined,
): boolean {
  if (tvDisplayId !== null && tvDisplayId !== undefined)
    return displays.some((d) => d.id === tvDisplayId);
  return displays.length > 1 || displays.some((d) => d.internal === false);
}
