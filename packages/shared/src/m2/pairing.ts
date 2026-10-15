import { z } from 'zod';
import { EpochMsSchema, IdSchema } from '../m1/common.ts';

export const KeyEpochSchema = z.number().int().nonnegative();
export type KeyEpoch = z.infer<typeof KeyEpochSchema>;

export const HouseholdKeySchema = z.string().length(44);
export type HouseholdKey = z.infer<typeof HouseholdKeySchema>;

export const HouseholdSubkeysSchema = z.enum([
  'rj/beacon',
  'rj/player-proof',
  'rj/hub-proof',
  'rj/wrap',
]);
export type HouseholdSubkeys = z.infer<typeof HouseholdSubkeysSchema>;

export const PairBodySchema = z.object({
  password: z.string().min(1),
  deviceName: z.string().min(1),
  deviceId: IdSchema,
  nonceP: z.string().min(1),
});
export type PairBody = z.infer<typeof PairBodySchema>;

export const PairReplySchema = z.object({
  ok: z.literal(true),
  playerId: IdSchema,
  deviceToken: z.string().min(1),
  householdKey: HouseholdKeySchema,
  hubId: IdSchema,
  hubEpoch: EpochMsSchema,
  roomName: z.string(),
  protocolVersion: z.number().int().nonnegative(),
  nonceH: z.string().min(1),
  proof: z.string().min(1),
});
export type PairReply = z.infer<typeof PairReplySchema>;
