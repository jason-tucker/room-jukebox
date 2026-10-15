import { z } from 'zod';
import { IdSchema } from '../m1/common.ts';

export const HubChallengeBodySchema = z.object({
  hubId: IdSchema,
  nonce: z.string().min(1),
});
export type HubChallengeBody = z.infer<typeof HubChallengeBodySchema>;

export const HubChallengeReplySchema = z.object({ proof: z.string().min(1) });
export type HubChallengeReply = z.infer<typeof HubChallengeReplySchema>;

export const HubJsonSchema = z.object({
  hubAddress: z.string().min(1),
  hubEpoch: z.number().int().nonnegative(),
  protocolVersion: z.number().int().nonnegative(),
  roomName: z.string(),
});
export type HubJson = z.infer<typeof HubJsonSchema>;

export const BecomeHubBodySchema = z.object({});
export type BecomeHubBody = z.infer<typeof BecomeHubBodySchema>;
