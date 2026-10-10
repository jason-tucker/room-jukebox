import { z } from 'zod';

export const M1_PROTOCOL_VERSION = 1;

export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

export const EpochMsSchema = z.number().int().nonnegative();
export type EpochMs = z.infer<typeof EpochMsSchema>;

export const ApiErrorCodeSchema = z.enum([
  'too-many-pending',
  'cooldown',
  'duplicate',
  'too-long',
  'not-found',
  'private',
  'not-embeddable',
  'age-restricted',
  'live',
  'region-blocked',
  'queue-full',
  'search-budget',
  'daily-quota',
  'search-disabled',
  'bad-password',
  'login-throttled',
  'playlist-private',
  'playlist-not-found',
  'no-api-key',
  'bad-message',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryAfterSec: z.number().nonnegative().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
