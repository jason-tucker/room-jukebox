import { z } from 'zod';

/** Wire protocol version. Bump on any breaking change to the schemas below. */
export const PROTOCOL_VERSION = 1;

export const NowPlayingSchema = z.object({
  videoId: z.string().min(1),
  title: z.string(),
  startedAt: z.number(),
  pausedAt: z.number().nullable(),
});
export type NowPlaying = z.infer<typeof NowPlayingSchema>;

export const QueueItemStatusSchema = z.enum(['queued', 'playing', 'played', 'skipped', 'removed']);
export type QueueItemStatus = z.infer<typeof QueueItemStatusSchema>;

export const QueueItemSchema = z.object({
  id: z.string().min(1),
  videoId: z.string().min(1),
  title: z.string(),
  requester: z.string().nullable(),
  source: z.enum(['request', 'auto']),
  status: QueueItemStatusSchema,
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const PlayerStatusSchema = z.enum(['online', 'offline', 'playing', 'idle']);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

export const PlayerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  lanAddress: z.string(),
  status: PlayerStatusSchema,
});
export type Player = z.infer<typeof PlayerSchema>;

export const SessionStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  serverTime: z.number(),
  protocolVersion: z.number().int(),
  nowPlaying: NowPlayingSchema.nullable(),
  queue: z.array(QueueItemSchema),
  players: z.array(PlayerSchema),
});
export type SessionState = z.infer<typeof SessionStateSchema>;
