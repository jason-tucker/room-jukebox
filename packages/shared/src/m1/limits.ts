import { z } from 'zod';

export const SearchLimitsSchema = z.object({
  perGuestPerDay: z.number().int().nonnegative(),
  perGuestIntervalSec: z.number().nonnegative(),
  perIpPerDay: z.number().int().nonnegative(),
  publicPerDay: z.number().int().nonnegative(),
  ownerReserve: z.number().int().nonnegative(),
  dailyTotal: z.number().int().nonnegative(),
});
export type SearchLimits = z.infer<typeof SearchLimitsSchema>;

/** Mirrors `Limits` from @room-jukebox/core (shared does not import core). */
export const LimitsSchema = z.object({
  maxPendingPerGuest: z.number().int().nonnegative(),
  cooldownSec: z.number().nonnegative(),
  allowDuplicates: z.boolean(),
  maxDurationSec: z.number().nonnegative(),
  search: SearchLimitsSchema,
});
export type Limits = z.infer<typeof LimitsSchema>;
