import { z } from 'zod';

/*
 * M0 spike protocol (plan §5 gates 1, 3, 4, 11). Throwaway: replaced by SessionState in M1.
 * Commands go over HTTP (`/api/spike/*`), state comes back over the `/ws` socket.
 */

export const SpikeNowPlayingSchema = z.object({
  videoId: z.string().min(1),
  title: z.string().optional(),
  /** Server ms timestamp at which position 0 would have played (shifted by seeks). */
  startedAt: z.number(),
  /** Server ms timestamp of the current pause, or null while playing. */
  pausedAt: z.number().nullable(),
  /** Total ms spent paused since `startedAt` (excluding the current pause). */
  accumulatedPauseMs: z.number().nonnegative(),
});
export type SpikeNowPlaying = z.infer<typeof SpikeNowPlayingSchema>;

export const SpikePlayerStatusSchema = z.enum(['online', 'delayed', 'reconnecting', 'blocked']);
export type SpikePlayerStatus = z.infer<typeof SpikePlayerStatusSchema>;

export const SpikePlayerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Page origin of the player (from the WebSocket `Origin` header or the hello). */
  origin: z.string(),
  lastSeen: z.number(),
  /** Last reported `getCurrentTime()` in seconds, or null before the first report. */
  position: z.number().nullable(),
  /** position − expected position in seconds, computed by the server; null when unknown. */
  drift: z.number().nullable(),
  status: SpikePlayerStatusSchema,
  /** Last revision for which this player reported `playing` (used by the matrix run). */
  playingRevision: z.number().int().nullable(),
  lastError: z.object({ code: z.number().int(), revision: z.number().int() }).nullable(),
});
export type SpikePlayer = z.infer<typeof SpikePlayerSchema>;

export const SpikeStateSchema = z.object({
  /** Transition counter: bumps on play/next/committed ended|error only (not on pause/seek). */
  revision: z.number().int().nonnegative(),
  serverTime: z.number(),
  protocolVersion: z.number().int(),
  nowPlaying: SpikeNowPlayingSchema.nullable(),
  players: z.array(SpikePlayerSchema),
  /**
   * When false, `ended`/`error` are recorded but never advance (the matrix run turns this off so
   * one laptop's failure does not skip a video the other laptop is still being tested on).
   */
  autoAdvance: z.boolean(),
  /** Consecutive error-driven advances without any player reaching `playing`. */
  errorStreak: z.number().int().nonnegative(),
});
export type SpikeState = z.infer<typeof SpikeStateSchema>;

// ---- client -> server --------------------------------------------------------------------------

export const SpikeHelloSchema = z.object({
  type: z.literal('hello'),
  playerId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  /** Optional fallback when the socket has no Origin header. */
  origin: z.string().max(200).optional(),
});

export const SpikePositionSchema = z.object({
  type: z.literal('position'),
  playerId: z.string().min(1).max(100),
  position: z.number().finite(),
  /** YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  playerState: z.number().int(),
  revision: z.number().int(),
});

export const SpikeEventKindSchema = z.enum(['ended', 'error', 'autoplayBlocked', 'playing']);
export type SpikeEventKind = z.infer<typeof SpikeEventKindSchema>;

export const SpikeEventSchema = z.object({
  type: z.literal('event'),
  playerId: z.string().min(1).max(100),
  kind: SpikeEventKindSchema,
  code: z.number().int().optional(),
  revision: z.number().int(),
});

export const SpikePingSchema = z.object({ type: z.literal('ping'), t0: z.number() });

export const SpikeClientMessageSchema = z.discriminatedUnion('type', [
  SpikeHelloSchema,
  SpikePositionSchema,
  SpikeEventSchema,
  SpikePingSchema,
]);
export type SpikeClientMessage = z.infer<typeof SpikeClientMessageSchema>;

// ---- server -> client --------------------------------------------------------------------------

export const SpikeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: SpikeStateSchema }),
  z.object({ type: z.literal('heartbeat'), serverTime: z.number(), revision: z.number().int() }),
  z.object({ type: z.literal('pong'), t0: z.number(), serverTime: z.number() }),
]);
export type SpikeServerMessage = z.infer<typeof SpikeServerMessageSchema>;

// ---- HTTP bodies -------------------------------------------------------------------------------

export const SpikePlayBodySchema = z.object({
  videoId: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
});
export const SpikeAutoAdvanceBodySchema = z.object({ enabled: z.boolean() });
export const SpikeSeekBodySchema = z.object({ position: z.number().finite().nonnegative() });

export const SpikeReportBodySchema = z.object({
  playerId: z.string().min(1).max(100),
  videoId: z.string().min(1).max(64),
  event: z.string().min(1).max(40),
  code: z.number().int().optional(),
  note: z.string().max(500).optional(),
});
export type SpikeReportBody = z.infer<typeof SpikeReportBodySchema>;

export const SpikeResultSchema = SpikeReportBodySchema.extend({
  ts: z.number(),
  playerName: z.string().optional(),
  origin: z.string().optional(),
});
export type SpikeResult = z.infer<typeof SpikeResultSchema>;

/** Human sentence per YouTube IFrame API error code (plan §5 gate 3). */
export function describeYouTubeError(code: number): string {
  switch (code) {
    case 2:
      return 'The video ID is not valid (error 2).';
    case 5:
      return 'The browser could not play this video in its HTML5 player (error 5).';
    case 100:
      return 'This video was removed or is private (error 100).';
    case 101:
    case 150:
      return `The owner does not allow this video to play outside YouTube (error ${code}).`;
    case 153:
      return 'YouTube refused this page because no referrer/origin was sent (error 153). Load the TV page from http://127.0.0.1 or http://localhost.';
    default:
      return `The YouTube player reported error ${code}.`;
  }
}
