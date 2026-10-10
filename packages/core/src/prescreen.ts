/**
 * Pre-screen at enqueue (plan §3.3): decides from `videos.list` metadata whether a video can be
 * queued. Pure; the server normalises the API response into `VideoMeta` first. Every rejection
 * carries a plain-English message that says whose rule it is (YouTube's or the room owner's).
 */
import { tooLongMessage } from './limits.ts';

export interface VideoMeta {
  /** True when the ID was absent from the `videos.list` response. */
  missing?: boolean;
  embeddable?: boolean;
  /** `public | unlisted | private` (anything else is treated as private). */
  privacyStatus?: string;
  /** `contentDetails.contentRating.ytRating`, e.g. `ytAgeRestricted`. */
  ytRating?: string;
  /** `none | live | upcoming`. */
  liveBroadcastContent?: string;
  regionRestriction?: { allowed?: readonly string[]; blocked?: readonly string[] };
  durationSec?: number | null;
  madeForKids?: boolean;
}

export type PrescreenReason =
  | 'not-found'
  | 'private'
  | 'not-embeddable'
  | 'age-restricted'
  | 'live'
  | 'region-blocked'
  | 'too-long';

export interface PrescreenOptions {
  maxDurationSec: number;
  /** ISO 3166-1 alpha-2 country from settings (default `US`). */
  country: string;
}

export type PrescreenResult =
  | { playable: true; flags: { madeForKids: boolean } }
  | { playable: false; reason: PrescreenReason; source: 'youtube' | 'owner'; message: string };

export const DEFAULT_COUNTRY = 'US';

const no = (reason: PrescreenReason, message: string, source: 'youtube' | 'owner' = 'youtube') =>
  ({ playable: false, reason, source, message }) as const;

/**
 * Checks, in order: not found, private, live/upcoming, not embeddable, age-restricted, region,
 * length. Fields the response did not include are not held against the video (play-time errors
 * still catch it). `null`/`undefined` meta means not found.
 */
export function evaluateVideo(
  meta: VideoMeta | null | undefined,
  options: PrescreenOptions,
): PrescreenResult {
  if (meta == null || meta.missing === true) {
    return no('not-found', "This video isn't available on YouTube (it may have been removed).");
  }
  if (
    meta.privacyStatus !== undefined &&
    meta.privacyStatus !== 'public' &&
    meta.privacyStatus !== 'unlisted'
  ) {
    return no('private', 'This video is private on YouTube.');
  }
  if (meta.liveBroadcastContent !== undefined && meta.liveBroadcastContent !== 'none') {
    return no(
      'live',
      meta.liveBroadcastContent === 'upcoming'
        ? "This is an upcoming premiere or live stream on YouTube; it can't be queued until it has finished."
        : "This is a live stream on YouTube; live videos never end, so they can't be queued.",
    );
  }
  if (meta.embeddable === false) {
    return no('not-embeddable', "The video's owner doesn't allow it to play outside YouTube.");
  }
  if (meta.ytRating === 'ytAgeRestricted') {
    return no(
      'age-restricted',
      "This video is age-restricted on YouTube, so it can't play on the TV.",
    );
  }
  const country = options.country.toUpperCase();
  const region = meta.regionRestriction;
  if (region !== undefined) {
    const allowed = region.allowed?.map((c) => c.toUpperCase());
    const blocked = region.blocked?.map((c) => c.toUpperCase());
    if ((allowed !== undefined && !allowed.includes(country)) || blocked?.includes(country)) {
      return no('region-blocked', `YouTube doesn't allow this video in this country (${country}).`);
    }
  }
  if (meta.durationSec != null && meta.durationSec > options.maxDurationSec) {
    return no('too-long', tooLongMessage(options.maxDurationSec), 'owner');
  }
  return { playable: true, flags: { madeForKids: meta.madeForKids === true } };
}
