import { z } from 'zod';
import { EpochMsSchema, IdSchema } from './common.ts';

export const EntryStatusSchema = z.enum(['queued', 'playing', 'done', 'skipped', 'failed']);
export type EntryStatus = z.infer<typeof EntryStatusSchema>;

export const EntryPublicSchema = z.object({
  id: IdSchema,
  videoId: IdSchema,
  title: z.string(),
  thumbnail: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  requesterName: z.string().nullable(),
  source: z.enum(['request', 'auto']),
  status: EntryStatusSchema,
  failReason: z.string().optional(),
  enqueuedAt: EpochMsSchema,
  startedAt: EpochMsSchema.optional(),
  mine: z.boolean().optional(),
});
export type EntryPublic = z.infer<typeof EntryPublicSchema>;

export const EntryAdminSchema = EntryPublicSchema.extend({
  requesterGuestId: z.string().nullable(),
  idempotencyKey: z.string().optional(),
});
export type EntryAdmin = z.infer<typeof EntryAdminSchema>;

export const NowPlayingSchema = EntryPublicSchema.extend({
  startedAt: EpochMsSchema,
  pausedAt: EpochMsSchema.nullable(),
  accumulatedPauseMs: z.number().nonnegative(),
});
export type NowPlaying = z.infer<typeof NowPlayingSchema>;

export const PlaybackSchema = z.object({
  state: z.enum(['playing', 'paused', 'idle', 'blocked']),
  nowPlaying: NowPlayingSchema.nullable(),
});
export type Playback = z.infer<typeof PlaybackSchema>;
