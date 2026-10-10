import { describe, expect, it } from 'vitest';
import { evaluateVideo, type VideoMeta } from './prescreen.ts';

const ok: VideoMeta = {
  embeddable: true,
  privacyStatus: 'public',
  liveBroadcastContent: 'none',
  durationSec: 200,
  madeForKids: false,
};
const opts = { maxDurationSec: 480, country: 'US' };
const ev = (over: Partial<VideoMeta>) => evaluateVideo({ ...ok, ...over }, opts);

describe('evaluateVideo', () => {
  it('accepts a normal public or unlisted video and reports madeForKids', () => {
    expect(ev({})).toEqual({ playable: true, flags: { madeForKids: false } });
    expect(ev({ privacyStatus: 'unlisted', madeForKids: true })).toEqual({
      playable: true,
      flags: { madeForKids: true },
    });
    expect(evaluateVideo({}, opts).playable).toBe(true);
  });

  it('not-found for missing IDs or no metadata', () => {
    for (const r of [
      ev({ missing: true }),
      evaluateVideo(null, opts),
      evaluateVideo(undefined, opts),
    ]) {
      expect(r).toMatchObject({ playable: false, reason: 'not-found', source: 'youtube' });
    }
  });

  it('private for anything but public/unlisted', () => {
    expect(ev({ privacyStatus: 'private' })).toMatchObject({
      reason: 'private',
      source: 'youtube',
    });
  });

  it('live for live streams and upcoming premieres', () => {
    expect(ev({ liveBroadcastContent: 'live' })).toMatchObject({ reason: 'live' });
    const r = ev({ liveBroadcastContent: 'upcoming', durationSec: 0 });
    expect(r).toMatchObject({ reason: 'live' });
    expect(!r.playable && r.message).toContain('premiere');
  });

  it('not-embeddable', () => {
    const r = ev({ embeddable: false });
    expect(r).toMatchObject({ reason: 'not-embeddable', source: 'youtube' });
    expect(!r.playable && r.message).toContain('outside YouTube');
  });

  it('age-restricted names YouTube', () => {
    const r = ev({ ytRating: 'ytAgeRestricted' });
    expect(r).toMatchObject({ reason: 'age-restricted', source: 'youtube' });
    expect(!r.playable && r.message).toContain('age-restricted on YouTube');
  });

  it('region-blocked against the allow and block lists, case-insensitively', () => {
    expect(ev({ regionRestriction: { blocked: ['us'] } })).toMatchObject({
      reason: 'region-blocked',
    });
    expect(ev({ regionRestriction: { allowed: ['GB', 'DE'] } })).toMatchObject({
      reason: 'region-blocked',
    });
    expect(ev({ regionRestriction: { allowed: ['US'] } }).playable).toBe(true);
    expect(ev({ regionRestriction: { blocked: ['GB'] } }).playable).toBe(true);
    expect(
      evaluateVideo({ ...ok, regionRestriction: { blocked: ['GB'] } }, { ...opts, country: 'gb' }),
    ).toMatchObject({
      reason: 'region-blocked',
    });
  });

  it("too-long names the owner's limit", () => {
    expect(ev({ durationSec: 481 })).toEqual({
      playable: false,
      reason: 'too-long',
      source: 'owner',
      message: "This song is over this room's 8-minute limit, set by the owner.",
    });
    expect(ev({ durationSec: 480 }).playable).toBe(true);
    expect(ev({ durationSec: null }).playable).toBe(true);
  });

  it('YouTube rules win over the owner rule (order of checks)', () => {
    expect(ev({ embeddable: false, durationSec: 9999 })).toMatchObject({
      reason: 'not-embeddable',
    });
    expect(ev({ missing: true, privacyStatus: 'private' })).toMatchObject({ reason: 'not-found' });
  });
});
