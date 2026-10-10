import { describe, expect, it } from 'vitest';
import {
  ActivityTracker,
  clockSkewMs,
  installDecision,
  isQuiet,
  QUIET_AFTER_MS,
} from '../src/update-policy';
import type { InstallInput } from '../src/update-policy';

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);

describe('quiet rule', () => {
  const base = {
    now: NOW,
    lastRequestAt: NOW - 3 * H,
    nowPlayingSource: 'auto' as const,
    tvConnected: true,
  };

  it('is quiet after 2 h without requests while an auto track plays', () => {
    expect(isQuiet(base)).toBe(true);
    expect(isQuiet({ ...base, lastRequestAt: NOW - QUIET_AFTER_MS })).toBe(true);
  });

  it('is not quiet within 2 h of a request', () => {
    expect(isQuiet({ ...base, lastRequestAt: NOW - QUIET_AFTER_MS + 1 })).toBe(false);
  });

  it('is not quiet while a requested track plays, even after 2 h', () => {
    expect(isQuiet({ ...base, nowPlayingSource: 'request' })).toBe(false);
  });

  it('counts an idle hub (nothing playing) like an auto track', () => {
    expect(isQuiet({ ...base, nowPlayingSource: null })).toBe(true);
  });

  it('is never quiet on unknown state', () => {
    expect(isQuiet({ ...base, nowPlayingSource: undefined })).toBe(false);
    expect(isQuiet({ ...base, lastRequestAt: undefined })).toBe(false);
  });

  it('is always quiet with the TV display disconnected', () => {
    expect(
      isQuiet({ now: NOW, lastRequestAt: NOW, nowPlayingSource: 'request', tvConnected: false }),
    ).toBe(true);
    expect(
      isQuiet({
        now: NOW,
        lastRequestAt: undefined,
        nowPlayingSource: undefined,
        tvConnected: false,
      }),
    ).toBe(true);
  });
});

describe('install window and clock check', () => {
  const base: InstallInput = {
    quiet: true,
    tvConnected: true,
    localHour: 6,
    skewMs: 1000,
    manual: false,
    sessionEnding: false,
  };

  it('installs when quiet inside 05:00-12:00', () => {
    for (const localHour of [5, 6, 11]) {
      expect(installDecision({ ...base, localHour })).toEqual({
        install: true,
        reason: 'quiet-in-window',
      });
    }
  });

  it('waits when quiet outside the window', () => {
    for (const localHour of [0, 4, 12, 23]) {
      expect(installDecision({ ...base, localHour })).toEqual({
        install: false,
        reason: 'outside-window',
      });
    }
  });

  it('waits when not quiet, even inside the window', () => {
    expect(installDecision({ ...base, quiet: false })).toEqual({
      install: false,
      reason: 'not-quiet',
    });
  });

  it('ignores the window when the clock is more than 5 min off', () => {
    expect(installDecision({ ...base, localHour: 22, skewMs: 6 * 60 * 1000 })).toEqual({
      install: true,
      reason: 'quiet-clock-skewed',
    });
    expect(installDecision({ ...base, localHour: 22, skewMs: -6 * 60 * 1000 }).install).toBe(true);
    // Exactly 5 min is still trusted.
    expect(installDecision({ ...base, localHour: 22, skewMs: 5 * 60 * 1000 }).install).toBe(false);
    // Skewed clock but not quiet: still no.
    expect(installDecision({ ...base, quiet: false, skewMs: 60 * 60 * 1000 }).install).toBe(false);
  });

  it('trusts the local clock when the Date header was unavailable', () => {
    expect(installDecision({ ...base, localHour: 22, skewMs: undefined }).install).toBe(false);
    expect(installDecision({ ...base, localHour: 7, skewMs: undefined }).install).toBe(true);
  });

  it('installs at any hour with the TV disconnected', () => {
    expect(installDecision({ ...base, quiet: false, tvConnected: false, localHour: 21 })).toEqual({
      install: true,
      reason: 'tv-disconnected',
    });
  });

  it('installs immediately on Update now', () => {
    expect(installDecision({ ...base, quiet: false, localHour: 21, manual: true })).toEqual({
      install: true,
      reason: 'manual',
    });
  });

  it('never installs during session-end', () => {
    expect(installDecision({ ...base, sessionEnding: true }).install).toBe(false);
    expect(installDecision({ ...base, sessionEnding: true, manual: true }).install).toBe(false);
    expect(installDecision({ ...base, sessionEnding: true, tvConnected: false }).install).toBe(
      false,
    );
  });

  it('computes skew from the Date header', () => {
    const header = new Date(NOW).toUTCString();
    expect(clockSkewMs(NOW + 7 * 60 * 1000, header)).toBe(7 * 60 * 1000);
    expect(clockSkewMs(NOW - 1000, header)).toBe(-1000);
    expect(clockSkewMs(NOW, null)).toBeUndefined();
    expect(clockSkewMs(NOW, 'not a date')).toBeUndefined();
  });
});

describe('activity tracker', () => {
  it('starts at app start and keeps the newest request across polls', () => {
    const t = new ActivityTracker(NOW - 5 * H);
    expect(t.lastRequestAt).toBe(NOW - 5 * H);
    expect(t.nowPlayingSource).toBeUndefined();

    t.observe({
      playback: { nowPlaying: { source: 'request', enqueuedAt: NOW - 3 * H } },
      queue: [
        { source: 'request', enqueuedAt: NOW - 2.5 * H },
        { source: 'auto', enqueuedAt: NOW },
      ],
      recentHistory: [{ source: 'request', enqueuedAt: NOW - 4 * H }],
    });
    expect(t.lastRequestAt).toBe(NOW - 2.5 * H);
    expect(t.nowPlayingSource).toBe('request');

    // The request scrolled out of recentHistory: the tracker still remembers it.
    t.observe({
      playback: { nowPlaying: { source: 'auto', enqueuedAt: NOW } },
      queue: [],
      recentHistory: [],
    });
    expect(t.lastRequestAt).toBe(NOW - 2.5 * H);
    expect(t.nowPlayingSource).toBe('auto');

    t.observe({ playback: { nowPlaying: null }, queue: [], recentHistory: [] });
    expect(t.nowPlayingSource).toBeNull();

    t.unknown();
    expect(t.nowPlayingSource).toBeUndefined();
  });
});
