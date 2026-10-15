import { z } from 'zod';
import { IdSchema } from '../m1/common.ts';
import { KeyEpochSchema } from './pairing.ts';

export const BeaconUnsignedSchema = z.object({
  v: z.literal(2),
  hubId: IdSchema,
  hubEpoch: z.number().int().nonnegative(),
  keyEpoch: KeyEpochSchema,
  roomName: z.string(),
  address: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  version: z.string().min(1),
  protocolVersion: z.number().int().nonnegative(),
  bootId: z.string().min(1),
  counter: z.number().int().nonnegative(),
});
export type BeaconUnsigned = z.infer<typeof BeaconUnsignedSchema>;

export const BeaconSchema = BeaconUnsignedSchema.extend({ sig: z.string().min(1) });
export type Beacon = z.infer<typeof BeaconSchema>;
