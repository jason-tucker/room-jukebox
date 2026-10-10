import { z } from 'zod';
import { EpochMsSchema } from './common.ts';
import { AdminStateSchema, GuestStateSchema, PlayerStateSchema } from './state.ts';

export const RoleSchema = z.enum(['guest', 'admin', 'player']);
export type Role = z.infer<typeof RoleSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state'),
    state: z.union([AdminStateSchema, PlayerStateSchema, GuestStateSchema]),
  }),
  z.object({
    type: z.literal('heartbeat'),
    serverTime: EpochMsSchema,
    changeSeq: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('pong'), t0: z.number(), serverTime: EpochMsSchema }),
  z.object({
    type: z.literal('toast'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    ttlMs: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('bye'), reason: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), t0: z.number() }),
  z.object({
    type: z.literal('position'),
    position: z.number(),
    playerState: z.number().int(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('event'),
    kind: z.enum(['ended', 'error', 'autoplayBlocked', 'playing', 'stalled']),
    code: z.number().int().optional(),
    revision: z.number().int().nonnegative(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
