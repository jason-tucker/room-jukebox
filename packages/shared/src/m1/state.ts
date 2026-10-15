import { z } from 'zod';
import { EpochMsSchema, IdSchema } from './common.ts';
import { EntryAdminSchema, EntryPublicSchema, PlaybackSchema } from './entries.ts';
import { LimitsSchema } from './limits.ts';

export const PlayerInfoSchema = z.object({
  id: IdSchema,
  name: z.string(),
  lanAddress: z.string().nullable(),
  status: z.enum(['online', 'delayed', 'reconnecting', 'blocked', 'offline']),
  role: z.enum(['leader', 'follower']),
  lastSeen: EpochMsSchema,
  drift: z.number().nullable(),
});
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;

export const PlaylistInfoSchema = z.object({
  id: IdSchema,
  playlistId: IdSchema,
  title: z.string(),
  url: z.string(),
  videoCount: z.number().int().nonnegative(),
  importedAt: EpochMsSchema,
  lastError: z.string().optional(),
});
export type PlaylistInfo = z.infer<typeof PlaylistInfoSchema>;

export const WifiSettingsSchema = z.object({
  ssid: z.string(),
  security: z.enum(['WPA', 'WEP', 'nopass', 'SAE']),
  hidden: z.boolean(),
});

/**
 * Where search goes: `page` = YouTube's public results page always (the API key, if any, is only
 * used for playlists and pre-checks); `api-first` = Data API, then the page once the quota is
 * used; `api-only` = Data API with no fallback.
 */
export const SearchSourceSchema = z.enum(['page', 'api-first', 'api-only']);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

/** A bare hostname: lowercase letters, digits, dots, hyphens; 1-63 chars per label; no scheme or port. */
export const FriendlyHostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/);

export const SettingsPublicSchema = z.object({
  roomName: z.string(),
  lanPort: z.number().int().nonnegative(),
  country: z.string(),
  limits: LimitsSchema,
  fallbackPlaylists: z.array(PlaylistInfoSchema),
  wifi: WifiSettingsSchema.nullable(),
  hasWifiPassword: z.boolean(),
  hasApiKey: z.boolean(),
  apiKeyLast4: z.string().nullable(),
  tvDisplayId: z.number().int().nullable(),
  autoStart: z.boolean(),
  autoFullscreen: z.boolean(),
  kiosk: z.boolean(),
  publicMode: z.boolean(),
  hubId: IdSchema,
  hubEpoch: z.number().int().nonnegative(),
  /** Optional friendly LAN name (a DNS record on the owner's router), e.g. `jukebox.home`. */
  friendlyHost: FriendlyHostSchema.nullable(),
  /**
   * Search source (owner setting; default `page`). `mirror`: embedded YouTube browsing through
   * the hub's `/yt/*` mirror (default true; absent from pre-0.0.9 hubs).
   */
  search: z.object({ source: SearchSourceSchema, mirror: z.boolean().optional() }).optional(),
});
export type SettingsPublic = z.infer<typeof SettingsPublicSchema>;

export const SettingsPatchSchema = SettingsPublicSchema.partial().extend({
  /** `{ source }`, or the pre-0.0.6 `{ unofficialFallback }` (true → api-first, false → api-only). */
  search: z
    .union([
      z.object({ source: SearchSourceSchema, mirror: z.boolean().optional() }),
      z.object({ unofficialFallback: z.boolean() }),
      z.object({ mirror: z.boolean() }),
    ])
    .optional(),
  youtubeApiKey: z.string().nullable().optional(),
  wifiPassword: z.string().nullable().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

const baseState = {
  revision: z.number().int().nonnegative(),
  changeSeq: z.number().int().nonnegative(),
  serverTime: EpochMsSchema,
  protocolVersion: z.number().int(),
  roomName: z.string(),
  playback: PlaybackSchema,
};

export const GuestStateSchema = z.object({
  ...baseState,
  queue: z.array(EntryPublicSchema),
  recentHistory: z.array(EntryPublicSchema),
  search: z.object({
    enabled: z.boolean(),
    remaining: z.number().int().nonnegative().nullable(),
    low: z.boolean(),
    /** Source the next search would use; absent means the official API (M1 clients). */
    provider: z.enum(['youtube-api', 'unofficial']).optional(),
  }),
  limits: z.object({
    maxPendingPerGuest: LimitsSchema.shape.maxPendingPerGuest,
    cooldownSec: LimitsSchema.shape.cooldownSec,
    maxDurationSec: LimitsSchema.shape.maxDurationSec,
    allowDuplicates: LimitsSchema.shape.allowDuplicates,
  }),
  flags: z.object({
    hasApiKey: z.boolean(),
    publicMode: z.boolean(),
    /** Embedded YouTube browsing (`/yt/*`) is on; absent from pre-0.0.9 hubs. */
    mirror: z.boolean().optional(),
  }),
});
export type GuestState = z.infer<typeof GuestStateSchema>;

export const AdminStateSchema = GuestStateSchema.extend({
  queue: z.array(EntryAdminSchema),
  recentHistory: z.array(EntryAdminSchema),
  players: z.array(PlayerInfoSchema),
  fallback: z.object({
    playlists: z.array(PlaylistInfoSchema),
    poolSize: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
  }),
  searchUsage: z.object({
    guests: z.number().int().nonnegative(),
    owner: z.number().int().nonnegative(),
    resetsAt: EpochMsSchema,
  }),
  settings: SettingsPublicSchema,
  lastErrors: z.array(
    z.object({
      at: EpochMsSchema,
      videoId: z.string(),
      code: z.string().optional(),
      message: z.string(),
    }),
  ),
});
export type AdminState = z.infer<typeof AdminStateSchema>;

export const PlayerStateSchema = z.object({
  ...baseState,
  upcoming: z.array(z.object({ title: z.string(), requesterName: z.string().nullable() })).max(5),
  qr: z.object({
    lanUrl: z.string(),
    /** What the TV prints and encodes: the friendly URL when it checks out, else `lanUrl`. */
    joinUrl: z.string(),
    publicUrl: z.string().nullable(),
    wifi: z.string().nullable(),
    wifiSsid: z.string().nullable(),
  }),
  partyCode: z.string().nullable(),
  me: z.object({ playerId: IdSchema, role: z.enum(['leader', 'follower']) }),
  status: PlayerInfoSchema.shape.status,
  lastError: z
    .object({ code: z.string().optional(), message: z.string(), at: EpochMsSchema })
    .nullable(),
  selfTest: z.object({ autoplayBlocked: z.boolean() }),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;
