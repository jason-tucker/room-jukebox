import type { Entry, HistoryEntry } from '@room-jukebox/core';
import type { AppContext } from './context.ts';
import { HttpError } from './errors.ts';

export interface SubmitInput {
  videoId: string;
  idempotencyKey: string;
  /** `null` = owner add. */
  guestId: string | null;
  name: string | null;
  ip: string;
}

const STATUS: Record<string, number> = {
  duplicate: 409,
  'too-long': 422,
  'too-many-pending': 429,
  cooldown: 429,
  'queue-full': 429,
};

/**
 * One request end to end: idempotency, pre-screen (`videos.list` with a key, else oEmbed),
 * the room's limits (guests only), enqueue. Throws the contract's 409/422/429 errors.
 */
export async function submitRequest(
  ctx: AppContext,
  input: SubmitInput,
): Promise<{ entry: Entry | HistoryEntry; duplicate: boolean }> {
  const existing = ctx.session.findByKey(input.idempotencyKey);
  if (existing !== undefined) return { entry: existing, duplicate: true };

  const resolved = await ctx.youtube.resolve(input.videoId);
  const isOwner = input.guestId === null;
  if (!resolved.playable && !(isOwner && resolved.source === 'owner')) {
    throw new HttpError(
      422,
      resolved.reason ?? 'not-found',
      resolved.message ?? "This video can't be played.",
    );
  }

  // Re-check after the await: a retry of the same command may have landed meanwhile.
  const again = ctx.session.findByKey(input.idempotencyKey);
  if (again !== undefined) return { entry: again, duplicate: true };

  if (!isOwner) {
    const check = ctx.session.checkRequest({
      guestId: input.guestId as string,
      ip: input.ip,
      videoId: input.videoId,
      ...(resolved.durationSec != null ? { durationSec: resolved.durationSec } : {}),
    });
    if (!check.ok) {
      throw new HttpError(
        STATUS[check.reason] ?? 429,
        check.reason,
        check.message,
        check.retryAfterSec,
      );
    }
  }

  return ctx.session.enqueue({
    videoId: input.videoId,
    title: resolved.title,
    ...(resolved.channelTitle !== undefined ? { channelTitle: resolved.channelTitle } : {}),
    ...(resolved.thumbnail !== undefined ? { thumbnail: resolved.thumbnail } : {}),
    ...(resolved.durationSec != null ? { durationSec: resolved.durationSec } : {}),
    idempotencyKey: input.idempotencyKey,
    guestId: input.guestId,
    name: input.name,
    ip: input.ip,
  });
}
