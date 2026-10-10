import type { Entry, HistoryEntry } from '@room-jukebox/core';
import type { EntryAdmin, EntryPublic } from '@room-jukebox/shared';

/** Internal guest ID of owner-added requests (shown as "Owner", never as a guest ID). */
export const OWNER_GUEST_ID = 'owner';
export const OWNER_NAME = 'Owner';

/** EntryPublic: never carries a guest ID, key or IP; `mine` only when `viewer` is given. */
export function toEntryPublic(e: Entry | HistoryEntry, viewer?: string | null): EntryPublic {
  const out: EntryPublic = {
    id: e.id,
    videoId: e.videoId,
    title: e.title,
    requesterName: e.requester ? (e.requester.name ?? null) : null,
    source: e.source,
    status: e.status,
    enqueuedAt: e.enqueuedAt,
  };
  if (e.thumbnail !== undefined) out.thumbnail = e.thumbnail;
  if (e.durationSec !== undefined) out.durationSec = e.durationSec;
  if (e.failReason !== undefined) out.failReason = e.failReason;
  if (e.startedAt !== undefined) out.startedAt = e.startedAt;
  if (viewer !== undefined) {
    out.mine = viewer !== null && e.requester !== null && e.requester.guestId === viewer;
  }
  return out;
}

export function toEntryAdmin(e: Entry | HistoryEntry): EntryAdmin {
  const guestId = e.requester?.guestId ?? null;
  return {
    ...toEntryPublic(e),
    requesterGuestId: guestId === OWNER_GUEST_ID ? null : guestId,
    ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
  };
}

/** Plain-words reasons for YouTube IFrame player error codes. */
export function playerErrorMessage(code: number | undefined): string {
  switch (code) {
    case 2:
      return 'The TV player rejected this video (error 2).';
    case 5:
      return "The TV player couldn't play this video (error 5).";
    case 100:
      return "This video isn't available on YouTube (removed or private).";
    case 101:
    case 150:
      return "The video's owner doesn't allow it to play outside YouTube.";
    case 153:
      return 'YouTube refused to play because the page sent no referrer (error 153).';
    default:
      return code === undefined
        ? "The TV player couldn't play this video."
        : `The TV player couldn't play this video (error ${code}).`;
  }
}
