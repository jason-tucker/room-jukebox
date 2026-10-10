import { z } from 'zod';
import { EpochMsSchema, IdSchema } from './common.ts';
import { EntryPublicSchema } from './entries.ts';
import { PlayerInfoSchema, PlaylistInfoSchema } from './state.ts';

const NameSchema = z.string().trim().min(1).max(40);
const IdempotencyKeySchema = z.string().min(1);

export const PrescreenReasonSchema = z.enum([
  'not-found',
  'private',
  'not-embeddable',
  'age-restricted',
  'live',
  'region-blocked',
  'too-long',
]);
export type PrescreenReason = z.infer<typeof PrescreenReasonSchema>;

export const HelloBodySchema = z.object({ name: NameSchema.optional() });
export type HelloBody = z.infer<typeof HelloBodySchema>;
export const HelloReplySchema = z.object({
  guestId: IdSchema,
  name: z.string().nullable(),
  noticeAccepted: z.boolean(),
});
export type HelloReply = z.infer<typeof HelloReplySchema>;

const screenFields = {
  playable: z.boolean(),
  reason: PrescreenReasonSchema.optional(),
  source: z.enum(['youtube', 'owner']).optional(),
  message: z.string().optional(),
};

export const ResolveReplySchema = z.object({
  videoId: IdSchema,
  title: z.string(),
  thumbnail: z.string().optional(),
  channelTitle: z.string().optional(),
  durationSec: z.number().nonnegative().nullable().optional(),
  ...screenFields,
});
export type ResolveReply = z.infer<typeof ResolveReplySchema>;

export const RequestBodySchema = z.object({
  videoId: IdSchema,
  idempotencyKey: IdempotencyKeySchema,
  name: NameSchema.optional(),
});
export type RequestBody = z.infer<typeof RequestBodySchema>;
export const RequestReplySchema = z.object({
  entry: EntryPublicSchema,
  duplicate: z.boolean(),
});
export type RequestReply = z.infer<typeof RequestReplySchema>;

export const SearchBodySchema = z.object({ q: z.string().trim().min(1).max(200) });
export type SearchBody = z.infer<typeof SearchBodySchema>;
export const VideoCardSchema = z.object({
  videoId: IdSchema,
  title: z.string(),
  channelTitle: z.string(),
  thumbnail: z.string(),
  durationSec: z.number().nonnegative().nullable().optional(),
  ...screenFields,
});
export type VideoCard = z.infer<typeof VideoCardSchema>;
export const SearchReplySchema = z.object({
  results: z.array(VideoCardSchema),
  remaining: z.number().int().nonnegative().nullable(),
  cached: z.boolean(),
});
export type SearchReply = z.infer<typeof SearchReplySchema>;

export const LoginBodySchema = z.object({ password: z.string().min(1) });
export type LoginBody = z.infer<typeof LoginBodySchema>;
export const LoginReplySchema = z.object({ ok: z.literal(true), token: z.string().optional() });
export type LoginReply = z.infer<typeof LoginReplySchema>;

export const TransportBodySchema = z.object({
  action: z.enum(['play', 'pause', 'skip']),
  idempotencyKey: IdempotencyKeySchema,
});
export type TransportBody = z.infer<typeof TransportBodySchema>;

export const ReorderBodySchema = z.object({
  id: IdSchema,
  toIndex: z.number().int().nonnegative(),
  idempotencyKey: IdempotencyKeySchema,
});
export type ReorderBody = z.infer<typeof ReorderBodySchema>;

export const PlaylistBodySchema = z.object({ url: z.string().min(1) });
export type PlaylistBody = z.infer<typeof PlaylistBodySchema>;

export const PasswordChangeBodySchema = z.object({
  current: z.string().min(1),
  next: z.string().min(8),
});
export type PasswordChangeBody = z.infer<typeof PasswordChangeBodySchema>;

export const SearchesReplySchema = z.object({
  guests: z.number().int().nonnegative(),
  owner: z.number().int().nonnegative(),
  resetsAt: EpochMsSchema,
  dailyTotal: z.number().int().nonnegative(),
});
export type SearchesReply = z.infer<typeof SearchesReplySchema>;

export const BackupReplySchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  at: EpochMsSchema,
});
export type BackupReply = z.infer<typeof BackupReplySchema>;

const LanAddressSchema = z.object({
  interface: z.string(),
  address: z.string(),
  cidr: z.string(),
});
export const LanReplySchema = z.object({
  addresses: z.array(LanAddressSchema),
  chosen: z.string(),
  lanUrl: z.string(),
});
export type LanReply = z.infer<typeof LanReplySchema>;

export const SetupStatusReplySchema = z.object({
  needsSetup: z.boolean(),
  lan: LanReplySchema,
});
export type SetupStatusReply = z.infer<typeof SetupStatusReplySchema>;

export const SetupBodySchema = z.object({
  password: z.string().min(8),
  roomName: z.string().min(1),
  youtubeApiKey: z.string().optional(),
  fallbackPlaylistUrls: z.array(z.string()).optional(),
  wifi: z
    .object({
      ssid: z.string(),
      password: z.string(),
      security: z.enum(['WPA', 'WEP', 'nopass']),
      hidden: z.boolean(),
    })
    .optional(),
  noticeAccepted: z.literal(true),
});
export type SetupBody = z.infer<typeof SetupBodySchema>;
export const SetupReplySchema = z.object({
  ok: z.literal(true),
  token: z.string(),
  playerToken: z.string(),
});
export type SetupReply = z.infer<typeof SetupReplySchema>;

export const HealthReplySchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  protocolVersion: z.number().int(),
  needsSetup: z.boolean(),
});
export type HealthReply = z.infer<typeof HealthReplySchema>;

export const PrivacyReplySchema = z.object({
  updatedAt: z.string(),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
});
export type PrivacyReply = z.infer<typeof PrivacyReplySchema>;

export const LogsTailReplySchema = z.object({ lines: z.array(z.string()) });
export type LogsTailReply = z.infer<typeof LogsTailReplySchema>;

export const PlayersReplySchema = z.object({ players: z.array(PlayerInfoSchema) });
export type PlayersReply = z.infer<typeof PlayersReplySchema>;
export const PlaylistReplySchema = PlaylistInfoSchema;
